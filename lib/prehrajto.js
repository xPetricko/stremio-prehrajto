const cheerio = require('cheerio');
const cache = require('./cache');

const BASE = 'https://prehrajto.cz';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const UA_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const CH = '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"';
// Client "profiles": the site serves some clients a card-less shell (no "Filtry vyhledávání", no results).
// If a profile gets the shell we try the next one and remember the one that works.
const PROFILES = [
  { name: 'mac', ua: UA, platform: '"macOS"', suffix: '' },
  { name: 'win', ua: UA_WIN, platform: '"Windows"', suffix: '' },
  { name: 'win-signal', ua: UA_WIN, platform: '"Windows"', suffix: 'do=videoListing-setFilter' }, // URL form seen in the browser
];
let goodProfile = 0;

// Site rate-limits (HTTP 429). One shared queue + a GLOBAL cooldown: after a 429 nobody hits the site until it ends.
const MIN_GAP_MS = +process.env.REQUEST_GAP_MS || 1500;
let chain = Promise.resolve();
let lastAt = 0;
let cooldownUntil = 0;
let strikes = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_QUEUE_WAIT_MS = 15000;
// Minimal cookie jar: the site sets session cookies; a cookieless bot-like client gets 429 sooner.
const jar = new Map();
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
function storeCookies(res) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const c of list) { const [kv] = c.split(';'); const i = kv.indexOf('='); if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim()); }
}
// A real page (also a search with 0 hits, ~50 kB) vs. a bare rate-limit response.
const isRealPage = (b) => b.length > 20000 && /<\/html>/i.test(b) && /Přehraj/i.test(b);

function throttled(fn) {
  const run = chain.then(async () => {
    const wait = Math.max(lastAt + MIN_GAP_MS, cooldownUntil) - Date.now();
    if (cooldownUntil - Date.now() > MAX_QUEUE_WAIT_MS) throw new Error('rate-limit cooldown active, try later'); // fail fast instead of hanging Stremio
    if (wait > 0) await sleep(wait);
    try { return await fn(); } finally { lastAt = Date.now(); }
  });
  chain = run.catch(() => {});
  return run;
}

async function getHtml(url, tries = 3, profile = PROFILES[0]) {
  for (let i = 0; i < tries; i++) {
    const res = await throttled(() => fetch(url, {
      headers: {
        'User-Agent': profile.ua,
        'sec-ch-ua': CH,
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': profile.platform,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'cs,sk;q=0.9,en;q=0.5',
        Referer: BASE + '/',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-User': '?1',
        ...(jar.size ? { Cookie: cookieHeader() } : {}),
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    }));
    storeCookies(res);
    if (res.ok) { strikes = 0; return res.text(); }
    // The site answers some requests with HTTP 429 but still sends the full page -> use the body if it has content.
    const body = await res.text().catch(() => '');
    const hasContent = /video--link|var sources/.test(body);
    console.warn(`[prehraj] HTTP ${res.status} ${url.replace(BASE, '')} len=${body.length} cards=${hasContent}`);
    // A 429 page WITHOUT cards looks like an empty search but is a rate-limit page -> must count as failure
    // (accepting it silently produced "0 streams"). Only a non-ok page that still carries results is used.
    if (hasContent) { strikes = 0; return body; }
    if (res.status === 429 || res.status >= 500) {
      strikes++;
      const ra = parseInt(res.headers.get('retry-after'), 10);
      const delay = Math.min(ra ? ra * 1000 : 5000 * 2 ** (strikes - 1), 60000); // 5s,10s,20s,40s,60s
      cooldownUntil = Math.max(cooldownUntil, Date.now() + delay);
      console.warn(`HTTP ${res.status} ${url} -> global cooldown ${delay}ms (strike ${strikes})`);
      if (i < tries - 1 && delay <= 20000) continue;
    }
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
}

const inflight = new Map();
function once(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// Verified live (2026-10): cards are server-rendered `a.video.video--link[title][href=/slug/hexid]`
// with .video__tag--time / .video__tag--size. Video page inlines `var sources=[{file,label}]` in raw HTML (no login).
// Video detail links look like /<slug>/<hex id>
const VIDEO_HREF = /^\/?([^/?#]+)\/([0-9a-f]{8,})(?:[?#].*)?$/i;
const RESERVED = new Set(['hledej', 'profil', 'front', 'assets', 'faq', 'jak-na-to', 'podminky', 'cenik']);

function parseSearch(html) {
  const $ = cheerio.load(html);
  const out = [];
  const seen = new Set();
  $('a[href]').each((_, a) => {
    const $a = $(a);
    let href = ($a.attr('href') || '').replace(BASE, '');
    const m = href.match(VIDEO_HREF);
    if (!m || RESERVED.has(m[1])) return;
    const path = `/${m[1]}/${m[2]}`;
    if (seen.has(path)) return;
    // `title` attr holds the full name; h3.video__title is truncated with "…"
    const title =
      $a.attr('title') || $a.find('.video__title, h3, h2').first().text().trim() || $a.text().trim();
    if (!title) return;
    seen.add(path);
    out.push({
      path,
      title: title.replace(/\s+/g, ' '),
      duration: $a.find('.video__tag--time, [class*=time]').first().text().trim() || null,
      size: $a.find('.video__tag--size, [class*=size]').first().text().trim() || null,
      // badge: <span class="format__text">HD</span> + <img class="format__icon" src="/assets/ico/fullhd.svg">
      format: $a.find('.format__text').first().text().trim() || null,
      formatIcon: (($a.find('img.format__icon').attr('src') || '').match(/([a-z0-9]+)\.svg/i) || [])[1] || null,
    });
  });
  return out;
}

// Site search is fuzzy/language-agnostic text search (paginated: ?videoListing-visualPaginator-page=N)
async function search(query, pages = 2) {
  return cache.wrap(`s:${query}:${pages}`, 30 * 60 * 1000, () => once(`s:${query}:${pages}`, () => searchRaw(query, pages)));
}
const isListingPage = (html) => /Filtry vyhledávání/.test(html); // desktop template, present even for 0 hits

async function searchRaw(query, pages) {
  const out = [];
  for (let p = 1; p <= pages; p++) {
    const base = `${BASE}/hledej/${encodeURIComponent(query)}`;
    let items = [];
    // try the remembered profile first, then the others (only while we get the card-less shell)
    const order = PROFILES.map((_, i) => (i + goodProfile) % PROFILES.length);
    for (const idx of order) {
      const pr = PROFILES[idx];
      const qs = [p > 1 ? `videoListing-visualPaginator-page=${p}` : '', pr.suffix].filter(Boolean).join('&');
      const html = await getHtml(base + (qs ? '?' + qs : ''), 3, pr);
      items = parseSearch(html);
      console.log(`[prehraj] search "${query}" p${p} profile=${pr.name} -> ${items.length} cards, ${html.length} B${isListingPage(html) ? '' : ' (shell page)'}`);
      if (items.length || isListingPage(html)) { goodProfile = idx; break; }
      const $ = cheerio.load(html);
      $('script,style,noscript').remove();
      console.warn(`[prehraj] shell page; title="${$('title').text().trim().slice(0, 60)}" text="${$('body').text().replace(/\s+/g, ' ').trim().slice(120, 330)}"`);
    }
    out.push(...items);
    if (items.length < 15) break; // last page
  }
  return out;
}

const clean = (s) => s.replace(/\\\//g, '/').replace(/\\u0026/g, '&').replace(/&amp;/g, '&');

// Pull stream URL(s) out of a video detail page. The player is video.js
// (<video id="content_video">), sources are normally inlined in JS or <source>.
function parseVideoPage(html) {
  const found = [];
  const push = (url, label) => {
    url = clean(url);
    if (/^\/\//.test(url)) url = 'https:' + url;
    if (/^https?:\/\//.test(url) && !found.some((f) => f.url === url)) found.push({ url, label: label || null });
  };

  // 1) JS objects: {file:"...", label:"720p"} / {src:"...", type:"video/mp4", res:720}
  const objRe = /\{[^{}]*?\b(?:file|src)\s*:\s*["']([^"']+)["'][^{}]*?\}/g;
  let m;
  while ((m = objRe.exec(html))) {
    const url = m[1];
    if (!/\.(mp4|m3u8|webm|mkv)(\?|$)/i.test(url) && !/premiumcdn|storage/i.test(url)) continue;
    const lbl = m[0].match(/\b(?:label|res|quality)\s*:\s*["']?([^"',}\s]+)/);
    push(url, lbl && lbl[1]);
  }
  // 2) <source src=...> / <video src=...>
  const $ = cheerio.load(html);
  $('video[src], source[src]').each((_, el) => push($(el).attr('src'), $(el).attr('label') || $(el).attr('res')));
  // 3) any direct mp4 URL with token
  const rawRe = /https?:\\?\/\\?\/[^"'\s<>\\]+(?:\\\/[^"'\s<>\\]+)*\.mp4\?[^"'\s<>]+/g;
  for (const u of html.match(rawRe) || []) push(u);
  return found;
}

// Stremio/players probe the URL several times -> cache the page parse briefly, share in-flight requests.
async function resolveVideo(path) {
  return cache.wrap(`v:${path}`, 3 * 60 * 1000, () => once(`v:${path}`, async () => {
    const html = await getHtml(BASE + path);
    return { sources: parseVideoPage(html), html };
  }));
}

module.exports = { isRealPage, BASE, search, parseSearch, parseVideoPage, resolveVideo, getHtml };
