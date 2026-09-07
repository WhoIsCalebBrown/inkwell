import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cached, eager, read as cacheRead } from './store.js';
import * as marvel from './marvel.js';

const app = express();
const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3000);
const mylarUrl = process.env.MYLAR_URL || 'http://192.168.40.44:8090/api';
const configPath = process.env.MYLAR_CONFIG || '/run/mylar/config.ini';
const komgaConfigPath = process.env.KOMGA_CONFIG || '';

// Komga credentials are read from Komf's mounted config for the same reason the
// Mylar key is: the secret stays on the server and never enters this checkout.
function komgaCredentials() {
  if (process.env.KOMGA_USER && process.env.KOMGA_PASSWORD) {
    return { user: process.env.KOMGA_USER, password: process.env.KOMGA_PASSWORD, url: process.env.KOMGA_URL || '' };
  }
  if (!komgaConfigPath) return null;
  try {
    const text = fs.readFileSync(komgaConfigPath, 'utf8');
    const pick = (field) => text.match(new RegExp(`^\\s*${field}\\s*:\\s*"?(.+?)"?\\s*$`, 'im'))?.[1];
    const user = pick('komgaUser');
    const password = pick('komgaPassword');
    const url = process.env.KOMGA_URL || pick('baseUri');
    return user && password && url ? { user, password, url } : null;
  } catch {
    return null;
  }
}

const komgaCreds = komgaCredentials();
const komgaUrl = (komgaCreds?.url || '').replace(/\/$/, '');
const komgaAuth = komgaCreds
  ? `Basic ${Buffer.from(`${komgaCreds.user}:${komgaCreds.password}`).toString('base64')}`
  : '';
const cache = new Map();

// ComicVine detail responses are enormous — a single character document is
// ~4.9 MB unfiltered and ~218 KB with field_list. Always send one.
const VOLUME_FIELDS = 'id,name,start_year,count_of_issues,image,publisher,description,deck,site_detail_url,resource_type';
const THREAD_FIELDS = {
  character: 'id,name,real_name,aliases,deck,image,publisher,count_of_issue_appearances,first_appeared_in_issue,teams,character_friends,character_enemies',
  team: 'id,name,aliases,deck,image,publisher,count_of_issue_appearances,characters,first_appeared_in_issue',
  person: 'id,name,aliases,deck,image,count_of_issue_appearances,birth,country,created_characters',
  story_arc: 'id,name,aliases,deck,image,publisher,count_of_issue_appearances,first_appeared_in_issue',
};

function apiKey() {
  if (process.env.MYLAR_API_KEY) return process.env.MYLAR_API_KEY.trim();
  const match = fs.readFileSync(configPath, 'utf8').match(/^\s*api_key\s*=\s*(.+)\s*$/im);
  if (!match) throw new Error('Could not find Mylar api_key in the mounted configuration file.');
  return match[1].trim();
}

function comicVineKey() {
  if (process.env.COMICVINE_API_KEY) return process.env.COMICVINE_API_KEY.trim();
  const match = fs.readFileSync(configPath, 'utf8').match(/^\s*comicvine_api\s*=\s*(.+)\s*$/im);
  if (!match) throw new Error('Could not find the ComicVine key in the mounted Mylar configuration file.');
  return match[1].trim();
}

async function mylar(command, params = {}) {
  const query = new URLSearchParams({ apikey: apiKey(), cmd: command, ...params });
  const response = await fetch(`${mylarUrl}?${query}`, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Mylar returned HTTP ${response.status}`);
  const body = await response.json();
  if (body?.success === false) throw new Error(body.error?.message || 'Mylar rejected the request.');
  return body.data ?? body;
}

async function comicVine(resource, params = {}) {
  const query = new URLSearchParams({ api_key: comicVineKey(), format: 'json', ...params });
  if (!query.has('field_list')) query.set('field_list', VOLUME_FIELDS);
  const response = await fetch(`https://comicvine.gamespot.com/api/${resource}/?${query}`, {
    headers: { 'User-Agent': 'ComicRequester/1.0 (personal media server)' }, signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`ComicVine returned HTTP ${response.status}`);
  const body = await response.json();
  if (body.status_code !== 1) throw new Error(body.error || 'ComicVine rejected the request.');
  return body.results || [];
}

function memo(key, maxAge, get) {
  const old = cache.get(key);
  if (old && Date.now() - old.at < maxAge) return old.value;
  const value = Promise.resolve().then(get);
  cache.set(key, { at: Date.now(), value });
  value.catch(() => cache.delete(key));
  return value;
}

function normalise(text) {
  // Callers pass ComicVine fields straight in, and a missing publisher arrives
  // as null rather than undefined, so a default parameter is not enough.
  return String(text ?? '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

// A deliberately transparent fuzzy scorer: exact series names win, then word
// prefixes and compact subsequence matches. ComicVine's native order is noisy.
function relevance(item, query) {
  const q = normalise(query);
  const title = normalise(item.name);
  const publisher = normalise(item.publisher?.name ?? item.publisher);
  if (!q) return 0;
  // Compare with separators stripped too, so "spiderman" matches "Spider-Man".
  const qTight = q.replaceAll(' ', '');
  const titleTight = title.replaceAll(' ', '');
  if (title === q || titleTight === qTight) return 10_000;
  let score = 0;
  if (title.startsWith(q) || titleTight.startsWith(qTight)) score = 5_000;
  else if (title.includes(q) || titleTight.includes(qTight)) score = 3_000;
  const words = q.split(' ');
  score += words.reduce((sum, word) => sum + (title.split(' ').some((x) => x.startsWith(word)) ? 350 : 0), 0);
  if (publisher.includes(q)) score += 150;
  let index = 0;
  for (const char of qTight) {
    index = titleTight.indexOf(char, index);
    if (index < 0) return score;
    index += 1;
  }
  return score + 100 - Math.min(index, 99);
}

function plainText(value = '') {
  return String(value).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

// Ordered most-specific first: a "Deluxe Edition Omnibus" is an omnibus.
// ComicVine has no format field worth trusting, and descriptions list every
// edition a book was ever printed in, so this reads the title only.
const EDITIONS = [
  ['Omnibus', /\bomnibus\b/],
  ['Compendium', /\bcompendium\b/],
  ['Absolute', /\babsolute\b/],
  ['Epic Collection', /\bepic collection\b/],
  ['Masterworks', /\b(masterworks|marvel masterworks)\b/],
  ['Deluxe edition', /\b(deluxe|oversized|treasury|artist.s edition|gallery edition)\b/],
  ['Library edition', /\b(library edition|complete collection|the complete|ultimate collection)\b/],
  ['Hardcover', /\b(hardcover|hard cover|\bhc\b)\b/],
  ['Collected edition', /\b(tpb|trade paperback|collected edition|collection|graphic novel|\bogn\b)\b/],
  ['Annual', /\bannual\b/],
  ['One-shot', /\b(one.shot|special|giant.size)\b/],
];

function catalogueShape(item, watchedIds) {
  const image = item.image || {};
  const titleText = String(item.name || '').toLowerCase();
  // Descriptions frequently list every available format (even on a regular
  // series), so classify from the listing title/type rather than its blurb.
  const edition = EDITIONS.find(([, pattern]) => pattern.test(titleText))?.[0] ?? 'Series';
  return {
    id: String(item.id), title: item.name, year: item.start_year, publisher: item.publisher?.name,
    issues: Number(item.count_of_issues) || 0, cover: image.super_url || image.medium_url || image.small_url || null,
    description: plainText(item.description || item.deck), type: 'Volume', edition, imprint: null,
    url: item.site_detail_url, requested: watchedIds.has(String(item.id)),
  };
}

async function watchlist() {
  return memo('watchlist', 30_000, async () => {
    const list = await mylar('getIndex');
    return (Array.isArray(list) ? list : []).map((item) => ({
      id: String(item.id ?? item.comicid), title: item.name, year: item.comicyear ?? item.year,
      publisher: item.publisher, issues: Number(item.issues) || 0, cover: item.imageURL ?? item.comicimage ?? null,
      status: item.status || 'Active', latestIssue: item.latestissue ?? item.lastissue ?? null,
    }));
  });
}

// Komga is optional. Without it the shelf still renders — it just cannot tell
// "requested" from "actually on disk", because Mylar reports every watched
// series as 'Active' regardless of whether anything was ever downloaded.
async function komga(pathname, params = {}) {
  if (!komgaUrl || !komgaAuth) return null;
  const query = new URLSearchParams(params);
  const response = await fetch(`${komgaUrl}/api/v1/${pathname}?${query}`, {
    headers: { Authorization: komgaAuth, Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Komga returned HTTP ${response.status}`);
  return response.json();
}

// Komga titles carry a trailing year ("... Omnibus (2019)") that Mylar's do not.
function shelfKey(title = '') {
  return normalise(title).replace(/\b(?:19|20)\d\d\b/g, '').replace(/\s+/g, ' ').trim();
}

async function komgaShelf() {
  return memo('komga:series', 60_000, async () => {
    try {
      const page = await komga('series', { size: '500' });
      const map = new Map();
      for (const s of page?.content ?? []) {
        map.set(shelfKey(s.name), {
          books: s.booksCount ?? 0,
          read: s.booksReadCount ?? 0,
          unread: s.booksUnreadCount ?? 0,
          inProgress: s.booksInProgressCount ?? 0,
        });
      }
      return map;
    } catch {
      return new Map();
    }
  });
}

// The shelf is the join of the two systems: Mylar knows what was asked for,
// Komga knows what actually arrived.
async function shelf() {
  const [watched, present] = await Promise.all([watchlist(), komgaShelf()]);
  return watched.map((item) => {
    const found = present.get(shelfKey(item.title));
    return {
      ...item,
      inLibrary: Boolean(found),
      books: found?.books ?? 0,
      read: found?.read ?? 0,
      unread: found?.unread ?? 0,
      state: found ? 'In library' : 'Searching',
    };
  });
}

app.use(express.json({ limit: '32kb' }));
app.get('/api/health', async (_req, res) => {
  try { res.json({ ok: true, watchlist: (await watchlist()).length, marvel: marvel.available(), komga: Boolean(komgaUrl && komgaAuth) }); }
  catch (error) { res.status(503).json({ ok: false, error: error.message }); }
});

app.get('/api/library', async (_req, res, next) => {
  try {
    const items = await shelf();
    res.json({
      items,
      counts: {
        watching: items.length,
        inLibrary: items.filter((x) => x.inLibrary).length,
        searching: items.filter((x) => !x.inLibrary).length,
      },
      komga: Boolean(komgaUrl && komgaAuth),
    });
  } catch (error) { next(error); }
});

// ComicVine resource prefixes. A thread is whatever a reader follows: a
// character for superhero books, a creator for manga and creator-owned work,
// a team or an event where those fit better.
const THREAD_KINDS = { character: '4005', team: '4060', person: '4040', story_arc: '4045' };

app.get('/api/thread/:kind/:id', async (req, res, next) => {
  const { kind, id } = req.params;
  const prefix = THREAD_KINDS[kind];
  if (!prefix) return res.status(400).json({ error: `Unknown thread kind "${kind}".` });
  if (!/^\d+$/.test(id)) return res.status(400).json({ error: 'A numeric ComicVine id is required.' });
  try {
    const data = await memo(`thread:${kind}:${id}`, 12 * 60 * 60_000, () =>
      comicVine(`${kind}/${prefix}-${id}`, { field_list: THREAD_FIELDS[kind] }));
    const image = data.image || {};
    // character_friends/character_enemies come back unranked and alphabetical
    // (1,081 entries for Spider-Man), and ComicVine exposes no co-appearance
    // count — so these are surfaced as "related", never as "shares N volumes".

    res.json({
      kind,
      id: String(data.id),
      name: data.name,
      realName: data.real_name ?? null,
      aliases: String(data.aliases ?? '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean).slice(0, 6),
      deck: data.deck ?? null,
      image: image.super_url || image.medium_url || image.screen_url || null,
      publisher: data.publisher?.name ?? null,
      appearances: Number(data.count_of_issue_appearances) || 0,
      firstAppearance: (data.first_appeared_in_issue?.name ?? '').split(';')[0].trim() || null,
      // Teams are the honest adjacency: they ship in this same call, and unlike
      // character_friends (2,551 unranked entries that file Batman under
      // Spider-Man) they actually mean something. Members of a team for a team
      // thread, teams-belonged-to for a character.
      teams: (data.teams ?? data.characters ?? []).slice(0, 14)
        .filter((x) => x && x.name)
        .map((x) => ({ id: String(x.id), name: x.name, kind: data.teams ? 'team' : 'character' })),
    });
  } catch (error) { next(error); }
});

// Ranking every related character costs ~26 ComicVine calls and about a minute
// cold, so it is its own endpoint: the card paints immediately and this fills in
// behind it. Cached for a week, after which it is instant.
// Marvel's own API answers what ComicVine cannot: real crossover events and a
// formatType=collection filter that actually means omnibuses and hardcovers.
// Only meaningful for Marvel threads, and only when keys are configured — the
// endpoint is always present so the client needs no feature detection.
app.get('/api/thread/:kind/:id/marvel', async (req, res, next) => {
  const { kind, id } = req.params;
  const prefix = THREAD_KINDS[kind];
  if (!prefix) return res.status(400).json({ error: `Unknown thread kind "${kind}".` });
  if (!marvel.available()) return res.json({ available: false, reason: 'no-keys' });
  try {
    const thread = await cached(`thread:${kind}:${id}`, 7 * 24 * 60 * 60_000, () =>
      comicVine(`${kind}/${prefix}-${id}`, { field_list: THREAD_FIELDS[kind] }));
    if (!/^marvel/i.test(thread.publisher?.name ?? '')) {
      return res.json({ available: false, reason: 'not-marvel' });
    }
    // Marvel answers 500 (not 401) for bad keys, so any failure here is treated
    // as "no enrichment" rather than surfaced: the page must render regardless.
    const match = await marvel.findCharacter(thread.name).catch(() => null);
    if (!match) return res.json({ available: false, reason: 'no-match' });
    const [events, collections] = await Promise.all([
      marvel.events(match.id).catch(() => []),
      marvel.collections(match.id).catch(() => []),
    ]);
    res.json({ available: true, character: match, events, collections });
  } catch {
    res.json({ available: false, reason: 'error' });
  }
});

// ComicVine has no imprint/universe resource, so tier 2 of the browse chain is
// a small curated map. Unknown publishers simply skip the tier.
const LINES = {
  Marvel: ['Earth-616', 'Ultimate', 'MAX', 'Star Wars'],
  'DC Comics': ['Prime Earth', 'Vertigo', 'Black Label', 'Absolute'],
  'Image Comics': ['Skybound', 'Top Cow', 'Creator-owned'],
  'Dark Horse Comics': ['Mignolaverse', 'Berger Books', 'Licensed'],
  'Boom! Studios': ['BOOM! Box', 'Archaia'],
};

// Volumes are what you request; threads are what you follow. Browse needs to
// reach the latter, so this searches characters, teams, creators and arcs.
const SEARCH_RESOURCES = { character: 'character', team: 'team', person: 'person', story_arc: 'story_arc' };

app.get('/api/threads', async (req, res, next) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ items: [] });
  try {
    const rows = await cached(`threads:${normalise(q)}`, 24 * 60 * 60_000, () =>
      comicVine('search', {
        query: q,
        resources: Object.values(SEARCH_RESOURCES).join(','),
        limit: '40',
        field_list: 'id,name,deck,image,publisher,count_of_issue_appearances,resource_type',
      }));
    const items = (rows ?? [])
      .filter((x) => SEARCH_RESOURCES[x.resource_type] && x.name)
      .map((x) => ({
        id: String(x.id),
        kind: x.resource_type,
        name: x.name,
        deck: plainText(x.deck || '').slice(0, 160) || null,
        publisher: x.publisher?.name ?? null,
        appearances: Number(x.count_of_issue_appearances) || 0,
        image: x.image?.medium_url ?? null,
      }))
      .sort((a, b) => b.appearances - a.appearances);
    // Bucket by kind before trimming. Creators and story arcs carry no issue
    // appearance count, so a single global sort by prominence buries them
    // entirely -- searching "junji ito" returned characters named Ito and not
    // the man himself.
    const quota = { character: 10, person: 6, team: 5, story_arc: 5 };
    const LABEL = { character: 'Characters', person: 'Creators', team: 'Teams', story_arc: 'Events' };
    const groups = Object.keys(quota)
      .map((kind) => ({ kind, label: LABEL[kind], items: items.filter((x) => x.kind === kind).slice(0, quota[kind]) }))
      .filter((g) => g.items.length);
    res.json({ groups, total: groups.reduce((n, g) => n + g.items.length, 0) });
  } catch (error) { next(error); }
});

app.get('/api/lines', (_req, res) => res.json({ lines: LINES }));

// ComicVine caps a page at 100 and ignores every sort parameter, so breadth has
// to come from paging and the ordering has to be ours. "spiderman" alone matches
// 1,426 volumes -- reading only the first page hid nearly every omnibus.
const SEARCH_PAGES = 3;

async function searchVolumes(q, edition = '') {
  // ComicVine buries collected editions: query=spider-man returns exactly one
  // omnibus on page one. Asking for the format by name is the only way to
  // surface them, so a format filter becomes part of the query rather than a
  // filter applied to whatever the generic search happened to return.
  const queries = edition ? [q, `${q} ${edition}`] : [q];
  const pages = await Promise.all(queries.flatMap((query) =>
    Array.from({ length: SEARCH_PAGES }, (_, i) =>
      comicVine('search', { query, resources: 'volume', limit: '100', page: String(i + 1) })
        .catch(() => []))));
  return pages.flat();
}

app.get('/api/search', async (req, res, next) => {
  const q = String(req.query.q || '').trim();
  const edition = EDITIONS.some(([name]) => name === req.query.edition) ? String(req.query.edition) : '';
  if (q.length < 2) return res.json({ items: [], editions: EDITIONS.map(([name]) => name) });
  try {
    const [raw, library] = await Promise.all([
      cached(`search:${normalise(q)}:${edition}`, 24 * 60 * 60_000, () => searchVolumes(q, edition)), watchlist(),
    ]);
    const watchedIds = new Set(library.map((item) => item.id));
    const deduped = new Map();
    for (const item of raw) {
      const key = `${normalise(item.name)}|${normalise(item.publisher?.name)}|${item.start_year}`;
      const previous = deduped.get(key);
      if (!previous || relevance(item, q) > relevance(previous, q)) deduped.set(key, item);
    }
    const items = [...deduped.values()]
      .map((item) => ({ item: catalogueShape(item, watchedIds), score: relevance(item, q) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || b.item.issues - a.item.issues)
      .slice(0, 120).map(({ item }) => item);
    res.json({
      items: edition ? items.filter((x) => x.edition === edition) : items,
      edition,
      // Every format the classifier knows, so the filter is not limited to
      // whatever happens to be in this one result set.
      editions: EDITIONS.map(([name]) => name),
    });
  } catch (error) { next(error); }
});

// ComicVine ignores both sort and publisher filters, so a rail is: cast a wide
// net across several pages, then do the curation here. Without it "Superhero
// essentials" was sixteen different volumes all called Batman, and "Omnibuses"
// was whatever Dark Horse last touched.
const MAJOR_PUBLISHERS = [
  'Marvel', 'DC Comics', 'Image', 'Dark Horse Comics', 'IDW Publishing',
  'Boom! Studios', 'Dynamite Entertainment', 'Valiant', 'Vertigo', 'Wildstorm',
];

// Publisher weighting stands in for the relevance ComicVine will not provide.
const PUBLISHER_WEIGHT = {
  Marvel: 100, 'DC Comics': 100, Image: 80, 'Dark Horse Comics': 60,
  'IDW Publishing': 50, 'Boom! Studios': 40, Vertigo: 70, Wildstorm: 40,
  Valiant: 40, 'Dynamite Entertainment': 30,
};
const weightOf = (name = '') =>
  Object.entries(PUBLISHER_WEIGHT).find(([p]) => name.startsWith(p))?.[1] ?? 0;

const rails = [
  { id: 'omnibus', title: 'Omnibuses', edition: 'Omnibus', majorsOnly: true,
    queries: ['spider-man omnibus', 'batman omnibus', 'x-men omnibus', 'avengers omnibus', 'superman omnibus'] },
  { id: 'collections', title: 'Big collections', majorsOnly: true,
    queries: ['compendium', 'epic collection', 'absolute edition', 'masterworks'] },
  { id: 'superheroes', title: 'Superhero essentials', majorsOnly: true,
    queries: ['batman', 'x-men', 'avengers', 'superman', 'justice league', 'fantastic four'] },
  { id: 'creator-owned', title: 'Creator-owned',
    queries: ['saga brian k vaughan', 'invincible compendium', 'the sandman', 'hellboy library', 'monstress', 'paper girls'] },
  { id: 'manga', title: 'Manga collections',
    queries: ['berserk deluxe', 'vagabond vizbig', 'one piece omnibus', 'fullmetal alchemist omnibus',
              'naruto 3-in-1', 'death note black edition', 'uzumaki'] },
];

// One title per name, so a rail never shows the same book five times over.
function curateRail(rail, tagged) {
  const seen = new Set();
  return tagged
    .filter(({ item }) => item && item.name && item.image?.super_url)
    .filter(({ item }) => {
      if (rail.edition && !new RegExp(`\\b${rail.edition}\\b`, 'i').test(item.name)) return false;
      const publisher = item.publisher?.name || '';
      if (rail.majorsOnly && !MAJOR_PUBLISHERS.some((p) => publisher.startsWith(p))) return false;
      const key = normalise(item.name);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    // No server-side sort exists, so ordering is ours. Majors-only rails rank by
    // publisher standing then heft; the rest rank by how well the book actually
    // matches the query that found it.
    .sort((a, b) => (rail.majorsOnly
      ? (weightOf(b.item.publisher?.name) - weightOf(a.item.publisher?.name))
      : (relevance(b.item, b.query) - relevance(a.item, a.query)))
      || ((Number(b.item.count_of_issues) || 0) - (Number(a.item.count_of_issues) || 0)))
    .slice(0, 18)
    .map(({ item }) => item);
}

async function railRows(rail) {
  // Keep the query that found each row: for rails that are not about the big
  // two, relevance to that query orders far better than publisher standing --
  // weighting alone put Batman at the top of the manga rail.
  const results = await Promise.all(rail.queries.flatMap((query) => [1, 2].map(async (page) => {
    const rows = await comicVine('search', { query, resources: 'volume', limit: '100', page: String(page) })
      .catch(() => []);
    return rows.map((item) => ({ item, query }));
  })));
  return curateRail(rail, results.flat());
}

app.get('/api/discover', async (_req, res, next) => {
  try {
    const library = await watchlist(); const watchedIds = new Set(library.map((item) => item.id));
    const sections = await Promise.all(rails.map(async (rail) => ({
      id: rail.id, title: rail.title,
      items: (await cached(`rail:${rail.id}:v4`, 7 * 24 * 60 * 60_000, () => railRows(rail)))
        .map((item) => catalogueShape(item, watchedIds)),
    })));
    res.json({ sections });
  } catch (error) { next(error); }
});

app.get('/api/volume/:id', async (req, res, next) => {
  const { id } = req.params;
  if (!/^\d+$/.test(id)) return res.status(400).json({ error: 'A numeric ComicVine volume id is required.' });
  try {
    const [data, watched] = await Promise.all([
      cached(`volume:${id}`, 7 * 24 * 60 * 60_000, () =>
        comicVine(`volume/4050-${id}`, { field_list: VOLUME_FIELDS })),
      watchlist(),
    ]);
    res.json(catalogueShape(data, new Set(watched.map((x) => x.id))));
  } catch (error) { next(error); }
});

app.post('/api/request', async (req, res, next) => {
  const id = String(req.body?.id || '');
  if (!/^\d+$/.test(id)) return res.status(400).json({ error: 'A valid ComicVine series id is required.' });
  try {
    const library = await watchlist();
    if (library.some((item) => item.id === id)) return res.status(409).json({ error: 'That series is already in your library.' });
    await mylar('addComic', { id });
    cache.delete('watchlist');
    res.status(201).json({ ok: true, id });
  } catch (error) { next(error); }
});

app.use(express.static(path.join(root, 'public'), { index: 'index.html', maxAge: 0, etag: true }));
app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(502).json({ error: error.message || 'The comic service could not complete that request.' });
});
app.listen(port, '0.0.0.0', () => console.log(`Comic Requester listening on :${port}`));
