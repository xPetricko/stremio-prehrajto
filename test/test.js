const assert = require('assert');
const { parseSearch, parseVideoPage } = require('../lib/prehrajto');
const { rank, queriesFor } = require('../lib/match');

// Synthetic markup (real selectors must be verified against the live site, see README)
const html = `<a class="video video--small video--link" title="Můj.přítel.Monk-Poslední.případ.FHD.WEB-DL.CZ.EN.2023.1080p" href="/muj-pritel-monk-fhd/67bc78732fa92"><div class="video__tag video__tag--time">01:33:20</div><div class="video__tag video__tag--size">3.96 GB</div><h3 class="video__title">Můj.přítel…</h3></a>
<a class="video video--link" href="/monk-posledni-pripad-2023-cz/6a1b2c3d4e5f6"><h3 class="video__title">Monk posledni pripad 2023 CZ dabing 1080p</h3><div class="video__tag--time">1:50:00</div><div class="video__tag--size">3.2 GB</div></a>
<a href="/monk-s08e05-cz/aaaaaaaa11112222"><h3>Monk S08E05 CZ</h3></a>
<a href="/hledej/monk">x</a>`;
const r = parseSearch(html);
assert.strictEqual(r.length, 3);
assert.strictEqual(r[0].size, '3.96 GB');
assert.ok(r[0].title.includes('FHD'));
const cs = rank([r[0]], { titles: ['Můj přítel Monk: Poslední případ'], year: 2023 }, 'movie');
assert.strictEqual(cs.length, 1);
r.shift();

const meta = { titles: ['Mr. Monk\'s Last Case: A Monk Movie', 'Monk: Posledný prípad'], year: 2023 };
const ranked = rank([
  ...r,
  { path: '/x/1', title: 'Monk posledni pripad 2019 720p' },
  { path: '/x/2', title: 'Monk Posledny pripad 2023 CAM' },
], { titles: ['Monk: Posledný prípad'], year: 2023 }, 'movie');
console.log(ranked.map((x) => [x.title, x.score]));
assert.strictEqual(ranked[0].path, r[0].path);

const ep = rank([{ path: '/a/1', title: 'Monk S08E05 CZ' }, { path: '/a/2', title: 'Monk S08E06 CZ' }, { path: '/a/3', title: 'Monk 8x05 SK' }],
  { titles: ['Monk'], season: 8, episode: 5 }, 'series');
assert.deepStrictEqual(ep.map((x) => x.path).sort(), ['/a/1', '/a/3']);
assert.deepStrictEqual(queriesFor({ titles: ['Monk'], season: 8, episode: 5 }, 'series'), ['Monk S08E05']);

const v = parseVideoPage(`<script>var sources=[{file:"https:\\/\\/pf-storage5.premiumcdn.net\\/1\\/abc.mp4?token=x&amp;expires=1",label:"720p"}];</script>`);
assert.strictEqual(v[0].url, 'https://pf-storage5.premiumcdn.net/1/abc.mp4?token=x&expires=1');
const v2 = parseVideoPage(`<video id="content_video_html5_api" src="https://pf-storage5.premiumcdn.net/1/abc.mp4?token=y"></video>`);
assert.strictEqual(v2.length, 1);
console.log('OK');

const { episodeMatch } = require('../lib/match');
for (const [n, s, e, ok] of [['Monk - 03x12 - 12',3,12,true],['Monk S03E01 SKdab',3,1,true],['MONK S01x01,02, CZ dabing',1,2,true],['Monk 01x01 a 01x02',1,2,true],
  ['Muj pritel Monk S01E01 - S01E02 CZ',1,2,true],['Monk 1x1',1,1,true],['Monk 1x11',1,1,false],['Monk - 11x01',1,1,false],['Monk S02E05',2,6,false]])
  assert.strictEqual(episodeMatch(n, s, e), ok, n);
console.log('episodes OK');

const { quality } = require('../lib/match');
const L = (n, r) => quality(n, r);
assert.deepStrictEqual(L('Monk S03E01 SKdab').audio, ['SK']);
assert.ok(L('Monk S03E01 SKdab').dub);
assert.deepStrictEqual(L('Muj pritel Monk FHD WEB-DL CZ EN 2023 1080p').audio, ['CZ', 'EN']);
assert.strictEqual(L('Muj pritel Monk FHD WEB-DL CZ EN 2023 1080p').q, '1080p');
const t1 = L('Film 2020 1080p CZ titulky'); assert.deepStrictEqual(t1.subs, ['CZ']); assert.deepStrictEqual(t1.audio, []);
const t2 = L('Film 2020 EN + titulky SK'); assert.deepStrictEqual(t2.subs, ['SK']); assert.deepStrictEqual(t2.audio, ['EN']);
assert.deepStrictEqual(L('Monk - 03x12 - 12').audio, []);
assert.strictEqual(L('Monk - 03x12 - 12', { format: 'HD', formatIcon: 'fullhd' }).q, 'HD');
assert.strictEqual(L('Monk 03x12 1080p', { format: 'HD' }).q, '1080p');
assert.strictEqual(L('Monk 03x12', {}).q, null);
assert.deepStrictEqual(L('Muj pritel Monk cz dabing').audio, ['CZ']);
assert.deepStrictEqual(L('Monk Pan Monk a kandidat 1 cast byDejv').audio, []);
console.log('lang OK');

const { isRealPage } = require('../lib/prehrajto');
assert.ok(isRealPage('<html><title>x - Přehraj.to</title>' + 'a'.repeat(30000) + '</html>'));
assert.ok(!isRealPage('429 Too Many Requests'));
assert.ok(!isRealPage('<html>Přehraj</html>'));
console.log('page OK');
