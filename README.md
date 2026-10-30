# stremio-prehrajto

Stremio addon: IMDb id (Cinemeta, optional TMDB cs/sk titles) -> search on prehrajto.cz -> ranked streams.

## Run
    npm install
    cp .env.example .env      # set TMDB_API_KEY (optional), PUBLIC_URL
    node --env-file=.env index.js
Install in Stremio: Addons -> paste `http://127.0.0.1:7000/manifest.json`.
Remote use needs an HTTPS `PUBLIC_URL` (deploy on a server/reverse proxy).

## How it works
- `lib/meta.js`    stremio id (`tt…` / `tt…:S:E`) -> titles + year.
- `lib/prehrajto.js` search `https://prehrajto.cz/hledej/<q>`, parse result cards, parse video page for the mp4 URL.
- `lib/match.js`   title/year/episode scoring (prehrajto has no IMDb ids, so matching is heuristic; CAM/TS penalised, 1080p/CZ/SK boosted).
- `/resolve?p=/slug/id` is the stream URL handed to Stremio: it fetches the video page at play time (tokens expire) and 302-redirects to the signed mp4 (or proxies it with `PROXY_STREAMS=true`).

## Verified on live site
Search cards and `var sources` (720p\/1080p mp4, tokenised) confirmed in raw server HTML, no login needed. Titles on prehrajto are Czech: Czech/Slovak names come keyless from Wikidata (by IMDb id, e.g. tt0312172 -> "Můj přítel Monk"), `TMDB_API_KEY` is an optional extra. Czech names are searched first, English last.

## Still to check
Selectors are written from the described structure and tested only on synthetic HTML.
Run with `DEBUG=1` and check:
- `/debug/search?q=Monk%20posledny%20pripad` returns items,
- `/debug/video?p=/slug/id` returns `sources` (if empty, inspect `htmlHead`; the URL in `#content_video_html5_api` may be injected by JS/AJAX after the Play click, then `parseVideoPage` needs the real XHR endpoint).
CSFD has no public API, so only IMDb/TMDB are used.

## Provoz na NASu (přístup zvenčí)
1. `cp .env.example .env`, vyplň `PUBLIC_URL` (např. `https://prehraj.tvoje-domena.tld`), `ADDON_TOKEN` (`openssl rand -hex 24`), `TRUST_PROXY=1`.
2. `docker compose up -d --build`.
3. Reverzní proxy s HTTPS (Synology: Control Panel > Login Portal > Advanced > Reverse Proxy + Let's Encrypt certifikát) -> `http://<nas>:7000`. Stremio vyžaduje HTTPS pro vzdálené addony.
4. Do Stremia vlož `PUBLIC_URL/<ADDON_TOKEN>/manifest.json`. Cokoliv bez správného tokenu vrací 404; po 20 chybných pokusech z jedné IP za 10 min 429.
Token drž jen v `.env` (je v .gitignore). Při úniku vygeneruj nový a addon přeinstaluj ve Stremiu.

## Auto vs. ruční režim
- `/<token>/manifest.json` - automaticky se ptá na streamy u každého titulu (odpovědi se cachují 6 h).
- `/<token>/manual/manifest.json` - nic se nevolá samo; hledáš ručně v horním vyhledávacím poli Stremia (řádek „Prehraj.to“ mezi výsledky; v Objevit se nezobrazí, protože katalog vyžaduje hledaný text) a text se hledá přímo na prehrajto. Instaluj jen jeden z nich.
