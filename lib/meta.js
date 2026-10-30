const cache = require('./cache');

const DAY = 24 * 3600 * 1000;
const TMDB_KEY = process.env.TMDB_API_KEY;

async function json(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url.replace(/api_key=[^&]+/, 'api_key=***')}`);
  return r.json();
}

// Parse Stremio id: tt0123456 (movie) or tt0123456:S:E (series)
function parseId(id) {
  const [imdb, s, e] = id.split(':');
  return { imdb, season: s ? +s : null, episode: e ? +e : null };
}

async function cinemeta(type, imdb) {
  return cache.wrap(`cm:${type}:${imdb}`, DAY, async () => {
    const d = await json(`https://v3-cinemeta.strem.io/meta/${type}/${imdb}.json`);
    const m = d.meta || {};
    const year = parseInt(m.year || m.releaseInfo, 10) || null;
    return { name: m.name, year, titles: [m.name].filter(Boolean) };
  });
}

// Optional: localized titles via TMDB (cs-CZ, sk-SK) using IMDb id.
async function tmdbTitles(type, imdb) {
  if (!TMDB_KEY) return [];
  return cache.wrap(`tmdb:${type}:${imdb}`, DAY, async () => {
    try {
      const f = await json(`https://api.themoviedb.org/3/find/${imdb}?external_source=imdb_id&api_key=${TMDB_KEY}`);
      const hit = type === 'movie' ? f.movie_results[0] : f.tv_results[0];
      if (!hit) return [];
      const kind = type === 'movie' ? 'movie' : 'tv';
      const out = [hit.title || hit.name, hit.original_title || hit.original_name];
      const tr = await json(`https://api.themoviedb.org/3/${kind}/${hit.id}/translations?api_key=${TMDB_KEY}`);
      for (const t of tr.translations || []) {
        if (['cs', 'sk'].includes(t.iso_639_1)) out.push(t.data.title || t.data.name);
      }
      return out.filter(Boolean);
    } catch (e) {
      console.warn('TMDB failed:', e.message);
      throw e; // not cached by wrap
    }
  }).catch(() => []);
}

// Keyless Czech/Slovak titles from Wikidata (IMDb id = P345). Used always; TMDB adds more if key is set.
// Success is cached 7 days; failure (timeout) is cached only briefly and never as "no titles".
async function wikidataTitles(imdb) {
  const hit = cache.get(`wd:${imdb}`);
  if (hit) return hit;
  if (cache.get(`wd-fail:${imdb}`)) return [];
  try {
    const q = `SELECT ?cs ?sk WHERE { ?i wdt:P345 "${imdb.replace(/[^a-z0-9]/gi, '')}". OPTIONAL{?i rdfs:label ?cs FILTER(lang(?cs)="cs")} OPTIONAL{?i rdfs:label ?sk FILTER(lang(?sk)="sk")} } LIMIT 1`;
    const r = await fetch('https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(q), {
      headers: { Accept: 'application/sparql-results+json', 'User-Agent': 'stremio-prehrajto/0.1 (personal addon)' },
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const b = (await r.json()).results.bindings[0] || {};
    return cache.set(`wd:${imdb}`, [b.cs && b.cs.value, b.sk && b.sk.value].filter(Boolean), 7 * DAY);
  } catch (e) {
    console.warn('Wikidata failed:', e.message);
    cache.set(`wd-fail:${imdb}`, true, 5 * 60 * 1000); // retry in 5 min, don't block every request
    return [];
  }
}

async function resolve(type, id) {
  const { imdb, season, episode } = parseId(id);
  // independent lookups in parallel (was sequential: a slow Wikidata delayed everything)
  const [cm, wd, tm] = await Promise.all([cinemeta(type, imdb), wikidataTitles(imdb), tmdbTitles(type, imdb)]);
  // Czech first: prehrajto files are named in Czech; English/original last
  const titles = [...new Set([...wd, ...tm, ...cm.titles])];
  return { imdb, season, episode, year: cm.year, titles, partial: !wd.length && !tm.length };
}

module.exports = { parseId, resolve };
