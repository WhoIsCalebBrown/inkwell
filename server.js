import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cached, eager, read as cacheRead } from './store.js';

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

function normalise(text = '') {
  return text.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

// A deliberately transparent fuzzy scorer: exact series names win, then word
// prefixes and compact subsequence matches. ComicVine's native order is noisy.
function relevance(item, query) {
  const q = normalise(query);
  const title = normalise(item.name);
  const publisher = normalise(item.publisher?.name ?? item.publisher);
  if (!q) return 0;
  if (title === q) return 10_000;
  let score = title.startsWith(q) ? 5_000 : title.includes(q) ? 3_000 : 0;
  const words = q.split(' ');
  score += words.reduce((sum, word) => sum + (title.split(' ').some((x) => x.startsWith(word)) ? 350 : 0), 0);
  if (publisher.includes(q)) score += 150;
  const compactTitle = title.replaceAll(' ', '');
  let index = 0;
  for (const char of q.replaceAll(' ', '')) {
    index = compactTitle.indexOf(char, index);
    if (index < 0) return score;
    index += 1;
  }
  return score + 100 - Math.min(index, 99);
}

function plainText(value = '') {
  return String(value).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function catalogueShape(item, watchedIds) {
  const image = item.image || {};
  const titleText = String(item.name || '').toLowerCase();
  // Descriptions frequently list every available format (even on a regular
  // series), so classify from the listing title/type rather than its blurb.
  const edition = /\bomnibus\b/.test(titleText) ? 'Omnibus'
    : /\b(tp\s?b|trade paperback|hardcover|hard cover|deluxe|compendium|complete collection|collected edition|library edition)\b/.test(titleText) || item.type === 'TPB' ? 'Collected edition'
      : 'Series';
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
  try { res.json({ ok: true, watchlist: (await watchlist()).length }); }
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
// ComicVine has no imprint/universe resource, so tier 2 of the browse chain is
// a small curated map. Unknown publishers simply skip the tier.
const LINES = {
  Marvel: ['Earth-616', 'Ultimate', 'MAX', 'Star Wars'],
  'DC Comics': ['Prime Earth', 'Vertigo', 'Black Label', 'Absolute'],
  'Image Comics': ['Skybound', 'Top Cow', 'Creator-owned'],
  'Dark Horse Comics': ['Mignolaverse', 'Berger Books', 'Licensed'],
  'Boom! Studios': ['BOOM! Box', 'Archaia'],
};

app.get('/api/lines', (_req, res) => res.json({ lines: LINES }));

app.get('/api/search', async (req, res, next) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ items: [] });
  try {
    const [raw, library] = await Promise.all([
      cached(`search:${normalise(q)}`, 24 * 60 * 60_000, () => comicVine('search', { query: q, resources: 'volume', limit: 100 })), watchlist(),
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
      .slice(0, 60).map(({ item }) => item);
    res.json({ items });
  } catch (error) { next(error); }
});

const rails = [
  { id: 'omnibus', title: 'Omnibuses', resource: 'volumes', params: { filter: 'name:omnibus', limit: 20, sort: 'date_last_updated:desc' } },
  { id: 'superheroes', title: 'Superhero essentials', resource: 'search', params: { query: 'Batman', resources: 'volume', limit: 20 } },
  { id: 'science-fiction', title: 'Science-fiction worlds', resource: 'search', params: { query: 'science fiction', resources: 'volume', limit: 20 } },
  { id: 'horror', title: 'Horror & supernatural', resource: 'search', params: { query: 'horror', resources: 'volume', limit: 20 } },
  { id: 'manga', title: 'Manga collections', resource: 'search', params: { query: 'manga omnibus', resources: 'volume', limit: 20 } },
];

app.get('/api/discover', async (_req, res, next) => {
  try {
    const library = await watchlist(); const watchedIds = new Set(library.map((item) => item.id));
    const sections = await Promise.all(rails.map(async (rail) => ({
      id: rail.id, title: rail.title,
      items: (await cached(`rail:${rail.id}`, 7 * 24 * 60 * 60_000, () => comicVine(rail.resource, rail.params))).slice(0, 16).map((item) => catalogueShape(item, watchedIds)),
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
