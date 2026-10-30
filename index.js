require('dotenv').config?.();
const express = require('express');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const { Readable } = require('stream');
const crypto = require('crypto');
const prehraj = require('./lib/prehrajto');
const meta = require('./lib/meta');
const { rank, queriesFor } = require('./lib/match');
const cache = require('./lib/cache');

const PORT = +process.env.PORT || 7000;
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://127.0.0.1:${PORT}`).replace(/\/$/, '');
// Default: proxy bytes through the addon, so the tokenised CDN URL is fetched from the same IP that loaded the page.
const TOKEN = process.env.ADDON_TOKEN || '';
const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(PUBLIC_URL);
if (!TOKEN && !isLocal) {
  console.error('Refusing to start: PUBLIC_URL is not local but ADDON_TOKEN is empty. Set ADDON_TOKEN in .env (e.g. `openssl rand -hex 24`).');
  process.exit(1);
}
if (TOKEN && TOKEN.length < 24) { console.error('ADDON_TOKEN too short (min 24 chars).'); process.exit(1); }
// All addon URLs live under /<token>/...; Stremio keeps this prefix for every request derived from the manifest URL.
const STREAM_BASE = PUBLIC_URL + (TOKEN ? '/' + TOKEN : '');
const PROXY = process.env.PROXY_STREAMS !== 'false';
const MAX_STREAMS = 15;

const manifest = {
  id: 'community.prehrajto',
  version: '0.1.0',
  name: 'Prehraj.to',
  description: 'Streamy z prehrajto.cz, hledané podle IMDb ID (české a slovenské názvy z Wikidat / TMDB).',
  resources: ['stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [],
};

const builder = new addonBuilder(manifest);

builder.defineStreamHandler(async ({ type, id }) => {
  try {
    const m = await meta.resolve(type, id);
    console.log(`[stream] ${type} ${id} year=${m.year} titles=${JSON.stringify(m.titles)}${m.partial ? ' (no cs/sk titles!)' : ''}`);
    // Cache the ranked list only if all searches succeeded (a 429/timeout must not be remembered as "no streams")
    let failed = false;
    let results = cache.get(`search:${id}`);
    if (!results) {
      // Sequential, stop early once we have enough good matches (fewer requests -> no 429)
      const seen = new Map();
      let ranked = [];
      for (const q of queriesFor(m, type)) {
        try { for (const r of await prehraj.search(q, 1)) seen.set(r.path, r); } catch (e) { failed = true; console.warn('search failed', q, e.message); }
        ranked = rank([...seen.values()], m, type);
        if (ranked.length >= 3) break;
      }
      results = rank([...seen.values()], m, type).slice(0, MAX_STREAMS);
      if (!failed || results.length) cache.set(`search:${id}`, results, 30 * 60 * 1000);
    }
    const incomplete = failed || (!results.length && m.partial);
    console.log(`[stream] ${id} -> ${results.length} streams${failed ? ' (some searches failed)' : ''}${incomplete ? ' [short cache]' : ''}`);
    const streams = results.map((r) => {
      const i = r.info;
      const facts = [i.q && `🎞 ${i.q}`, r.size && `💾 ${r.size}`, r.duration && `⏱ ${r.duration}`].filter(Boolean).join('  ·  ');
      const audio = i.audio.length ? `🔊 ${i.audio.join(' + ')}${i.dub ? ' (dabing)' : ''}` : (i.dub ? '🔊 dabing' : '');
      const subs = i.subs.length ? `💬 titulky ${i.subs.filter((x) => x !== '?').join(', ')}`.trim() : '';
      return {
        name: ['Prehraj.to', i.q, i.audio.join('+')].filter(Boolean).join('\n'),
        title: [r.title, facts, [audio, subs].filter(Boolean).join('  ·  ')].filter(Boolean).join('\n'),
        url: `${STREAM_BASE}/resolve?p=${encodeURIComponent(r.path)}`,
        behaviorHints: { bingeGroup: 'prehrajto-' + (i.q || 'x') + '-' + i.audio.join(''), notWebReady: false },
      };
    });
    // Stremio caches the answer; after an error / missing cs titles keep it short so a retry happens soon
    return incomplete ? { streams, cacheMaxAge: 60 } : { streams, cacheMaxAge: 6 * 3600, staleRevalidate: 24 * 3600 };
  } catch (e) {
    console.error('[stream] handler error', id, e.message);
    return { streams: [], cacheMaxAge: 60 };
  }
});

// ---- Manual variant: own search catalog, no automatic lookups on title pages ----
// Install .../manual/manifest.json instead of (not together with) the auto one.
const manualBuilder = new addonBuilder({
  id: 'community.prehrajto.manual',
  version: '0.1.0',
  name: 'Prehraj.to (ručně)',
  description: 'Ruční hledání na prehrajto.cz: napiš hledaný text do vyhledávacího pole Stremia, výsledky jsou v řádku Prehraj.to. Nic se nevolá samo.',
  resources: ['catalog', 'meta', 'stream'],
  types: ['movie'],
  idPrefixes: ['prehrajto:'],
  catalogs: [{ type: 'movie', id: 'prehrajto-search', name: 'Prehraj.to', extra: [{ name: 'search', isRequired: true }] }],
});
const enc = (p) => 'prehrajto:' + Buffer.from(p).toString('base64url');
const dec = (id) => Buffer.from(id.slice('prehrajto:'.length), 'base64url').toString();
const toMeta = (r) => ({ id: enc(r.path), type: 'movie', name: r.title, description: [r.size, r.duration].filter(Boolean).join(' · ') });

manualBuilder.defineCatalogHandler(async ({ extra }) => {
  const q = ((extra && extra.search) || '').trim();
  if (!q) return { metas: [] };
  try {
    const metas = (await cache.wrap(`manual:${q.toLowerCase()}`, 30 * 60 * 1000, () => prehraj.search(q, 1))).map(toMeta);
    for (const m of metas) cache.set('mm:' + m.id, m, 3600 * 1000);
    return { metas, cacheMaxAge: 1800 };
  } catch (e) { console.warn('manual search failed', e.message); return { metas: [] }; }
});
manualBuilder.defineMetaHandler(async ({ id }) => {
  const m = cache.get('mm:' + id) || { id, type: 'movie', name: dec(id).split('/')[1] };
  return { meta: m, cacheMaxAge: 3600 };
});
manualBuilder.defineStreamHandler(async ({ id }) => {
  const m = cache.get('mm:' + id);
  return { streams: [{ name: 'Prehraj.to', title: m ? m.name : 'Přehrát', url: `${STREAM_BASE}/resolve?p=${encodeURIComponent(dec(id))}` }], cacheMaxAge: 600 };
});

const app = express();
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY); // e.g. "1" behind the NAS reverse proxy

// Access log (token redacted). Also shows rejected requests (404 = wrong/missing token).
app.use((req, res, next) => {
  const t0 = Date.now();
  res.on('finish', () => {
    const safe = (TOKEN ? req.originalUrl.split(TOKEN).join('<token>') : req.originalUrl).slice(0, 200);
    console.log(`[http] ${req.method} ${safe} -> ${res.statusCode} ${Date.now() - t0}ms`);
  });
  next();
});

if (TOKEN) {
  const sha = (x) => crypto.createHash('sha256').update(x).digest();
  const tokenHash = sha(TOKEN);
  const fails = new Map(); // ip -> {n, reset}
  app.use((req, res, next) => {
    const f = fails.get(req.ip);
    if (f && f.reset > Date.now() && f.n >= 20) return res.status(429).end();
    const seg = req.url.split(/[/?#]/)[1] || '';
    if (!crypto.timingSafeEqual(sha(seg), tokenHash)) {
      const cur = f && f.reset > Date.now() ? f : { n: 0, reset: Date.now() + 10 * 60 * 1000 };
      cur.n++; fails.set(req.ip, cur);
      return res.status(404).end(); // indistinguishable from a non-existing site
    }
    let rest = req.url.slice(seg.length + 1);
    req.url = rest.startsWith('/') ? rest : '/' + rest;
    next();
  });
}

// Tokens in prehrajto URLs expire -> resolve lazily at play time.
app.all('/resolve', async (req, res) => {
  const p = String(req.query.p || '');
  if (!/^\/[^/?#]+\/[0-9a-f]{8,}$/i.test(p)) return res.status(400).send('bad path');
  try {
    const { sources } = await prehraj.resolveVideo(p);
    console.log(`[resolve] ${req.method} ${p} -> ${sources.length} sources`, sources.map((s) => s.label));
    if (!sources.length) return res.status(404).send('no source found');
    sources.sort((a, b) => (parseInt(b.label) || 0) - (parseInt(a.label) || 0));
    const url = sources[0].url;
    if (!PROXY) return res.redirect(302, url);
    const headers = { 'User-Agent': 'Mozilla/5.0', Referer: prehraj.BASE + '/' };
    if (req.headers.range) headers.Range = req.headers.range;
    const up = await fetch(url, { headers, method: req.method === 'HEAD' ? 'HEAD' : 'GET' });
    console.log(`[resolve] upstream ${up.status} range=${req.headers.range || '-'} len=${up.headers.get('content-length')}`);
    res.status(up.status);
    for (const h of ['content-type', 'content-length', 'content-range']) {
      if (up.headers.get(h)) res.setHeader(h, up.headers.get(h));
    }
    res.setHeader('Accept-Ranges', 'bytes');
    if (req.method === 'HEAD' || !up.body) return res.end();
    const body = Readable.fromWeb(up.body);
    body.on('error', () => res.destroy());
    res.on('close', () => up.body.cancel().catch(() => {}));
    body.pipe(res);
  } catch (e) {
    console.error('resolve error', e.message);
    res.status(502).send('resolve failed: ' + e.message);
  }
});

if (process.env.DEBUG) {
  app.get('/debug/search', async (req, res) => res.json(await prehraj.search(String(req.query.q || ''))));
  app.get('/debug/video', async (req, res) => {
    const { sources, html } = await prehraj.resolveVideo(String(req.query.p));
    res.json({ sources, htmlLength: html.length, htmlHead: html.slice(0, 3000) });
  });
  app.get('/debug/streams', async (req, res) => {
    const m = await meta.resolve(req.query.type || 'movie', String(req.query.id));
    const all = [];
    for (const q of queriesFor(m, req.query.type || 'movie')) all.push({ q, n: (await prehraj.search(q)).length });
    const uniq = [...new Map((await Promise.all(queriesFor(m, req.query.type || 'movie').map((q) => prehraj.search(q)))).flat().map((r) => [r.path, r])).values()];
    res.json({ meta: m, perQuery: all, candidates: uniq.length, ranked: rank(uniq, m, req.query.type || 'movie').map((r) => [r.score, r.title]) });
  });
  app.get('/debug/match', async (req, res) => {
    const m = await meta.resolve(req.query.type || 'movie', String(req.query.id));
    res.json({ m, queries: queriesFor(m, req.query.type || 'movie') });
  });
}

app.use('/manual', getRouter(manualBuilder.getInterface()));
app.use(getRouter(builder.getInterface()));
app.listen(PORT, () => console.log(`Config: token=${TOKEN ? 'set' : 'NOT set'} proxy=${PROXY} gap=${process.env.REQUEST_GAP_MS || 1500}ms tmdb=${process.env.TMDB_API_KEY ? 'set' : 'off'} trustProxy=${process.env.TRUST_PROXY || 'off'}`) || console.log(`Addon: ${PUBLIC_URL}${TOKEN ? '/<ADDON_TOKEN>' : ''}/manifest.json (auto) | .../manual/manifest.json (ruční)`));
