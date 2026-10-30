const norm = (s) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();

const STOP = new Set(['the', 'a', 'an', 'of', 'and']);
// cs/sk spelling differs (posledny/posledni) -> compare 5-char stems for longer words
const same = (a, b) => a === b || (a.length >= 6 && b.length >= 6 && a.slice(0, 5) === b.slice(0, 5));
const tokens = (s) => norm(s).split(' ').filter((t) => t && !STOP.has(t));

function episodeMatch(name, season, episode) {
  const n = name.toLowerCase();
  const S = `0*${season}`, E = `0*${episode}`;
  // S01E01, s01x01, 01x01, 1x1, "S01E01 - S01E02", "01x01,02", "01x01 a 01x02", "1. epizoda"
  const pats = [
    new RegExp(`s${S}\\s*[ ._-]?[ex]${E}(?!\\d)`),
    new RegExp(`(?<!\\d)${S}x${E}(?!\\d)`),
    new RegExp(`s${S}\\s*[ex]\\s*0*\\d+\\s*[,&+-]\\s*(?:e|x)?${E}(?!\\d)`), // S01x01,02 / S01E01-E02
    new RegExp(`(?<!\\d)${S}x0*\\d+\\s*(?:,|a|and|-|&)\\s*(?:${S}x)?${E}(?!\\d)`),
    new RegExp(`(?<!\\d)${episode}\\.?\\s*(?:epizod|dil|cast|episode)`),
  ];
  return pats.some((p) => p.test(n));
}

// Quality from file name, falling back to the site's badge (HD / fullhd icon).
function resolution(name, r) {
  const n = name.toLowerCase();
  if (/2160p|\b4k\b|uhd/.test(n)) return '2160p';
  if (/1080p|1080i|fullhd|full hd|\bfhd\b/.test(n)) return '1080p';
  if (/720p|\bhd ?rip\b/.test(n)) return '720p';
  if (/480p|dvdrip|tvrip|\bsd\b/.test(n)) return '480p';
  // Site badge (<span class="format__text">). Observed live: only "HD" (+ fullhd.svg icon) or nothing,
  // so it is a generic HD flag, not an exact resolution -> show the text as is.
  const badge = ((r && r.format) || '').trim();
  return badge ? badge.toUpperCase() : null;
}

// Languages from the file name. "CZ titulky" -> subtitles, remaining CZ/SK/EN tokens -> audio.
const LANGS = {
  CZ: '(?:cz|cs|cesk[a-z]*|czech|cestina)',
  SK: '(?:sk|slovensk[a-z]*|slovak|slovencina)',
  EN: '(?:en|eng|english|angl[a-z]*)',
};
const SUB = '(?:tit[a-z]*|sub[a-z]*|cc)';
function languages(name) {
  let n = ' ' + norm(name) + ' ';
  const subs = [], audio = [];
  for (const [code, re] of Object.entries(LANGS)) {
    const l = `(?<![a-z])${re}(?![a-z])`;
    const sub = new RegExp(`${l}\\s*${SUB}(?![a-z])|(?<![a-z])${SUB}\\s*${l}`, 'g');
    if (sub.test(n)) { subs.push(code); n = n.replace(sub, ' '); }
  }
  for (const [code, re] of Object.entries(LANGS)) {
    // also "skdab" / "czdab"
    if (new RegExp(`(?<![a-z])${re}(?![a-z])|(?<![a-z])${re}(?=dab|dub)`).test(n)) audio.push(code);
  }
  const dub = /(?<![a-z])(?:dab[a-z]*|dub[a-z]*)(?![a-z])|(?:cz|sk)dab/.test(n);
  if (!subs.length && !audio.length && /(?<![a-z])tit[a-z]*/.test(n)) subs.push('?');
  return { audio, subs, dub };
}

function quality(name, r) {
  const n = name.toLowerCase();
  const bad = /\b(cam|camrip|hdcam|ts|telesync|hdts|tc)\b/.test(n);
  const { audio, subs, dub } = languages(name);
  return { q: resolution(name, r), audio, subs, dub, lang: [...audio, ...subs.map((s) => s + ' tit.')], bad };
}

// Returns scored candidates, best first. meta = {titles, year, season, episode}
function rank(results, meta, type) {
  const titleToks = meta.titles.map(tokens).filter((t) => t.length);
  const out = [];
  for (const r of results) {
    const nameArr = tokens(r.title);
    const nameNorm = ' ' + norm(r.title) + ' ';
    // best title variant: all tokens must appear
    let best = 0;
    for (const t of titleToks) {
      if (t.every((x) => nameArr.some((n) => same(n, x)))) best = Math.max(best, 40 + t.length * 2);
    }
    if (!best) continue;
    let score = best;
    // Reject results with lots of extra words (e.g. different movie sharing a word)
    const extra = nameArr.filter((x) => !/^\d+$/.test(x) && !titleToks.some((t) => t.some((y) => same(x, y)))).length;
    score -= Math.min(extra, 12);
    if (type === 'movie') {
      if (meta.year) {
        if (nameNorm.includes(` ${meta.year} `)) score += 25;
        else if ([meta.year - 1, meta.year + 1].some((y) => nameNorm.includes(` ${y} `))) score += 5;
        else if (/ (19|20)\d{2} /.test(nameNorm)) score -= 30; // explicit different year
      }
    } else {
      if (!episodeMatch(r.title, meta.season, meta.episode)) continue;
      score += 30;
    }
    const info = quality(r.title, r);
    if (info.bad) score -= 40;
    score += { '2160p': 6, '1080p': 8, '720p': 4, HD: 3, '480p': 0 }[info.q] || 0;
    if (info.audio.some((l) => l === 'CZ' || l === 'SK')) score += 6;
    else if (info.subs.length) score += 2;
    out.push({ ...r, score, info });
  }
  return out.filter((r) => r.score > 35).sort((a, b) => b.score - a.score);
}

function queriesFor(meta, type) {
  const qs = [];
  for (const t of meta.titles) {
    if (type === 'movie') {
      qs.push(meta.year ? `${t} ${meta.year}` : t);
      qs.push(t);
    } else {
      const s = String(meta.season).padStart(2, '0'), e = String(meta.episode).padStart(2, '0');
      qs.push(`${t} S${s}E${e}`);
    }
  }
  return [...new Set(qs)].slice(0, 6);
}

module.exports = { rank, queriesFor, tokens, norm, episodeMatch, quality };
