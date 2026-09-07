import express from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cached, read as cacheRead, write as cacheWrite, clear as clearCache, stats as cacheStats,
  findVolumes, rememberVolumes, findObjects, listObjects, publisherArt, volumesForCharacters,
  decades, decadeVolumes, findObjectByName, findObjectsByName, findLinkedObjectIdByName, getObject, getVolume, rememberObjects, relatedVolumes,
  getMylarParts, rememberMylarParts, setMylarPartStatus, listMylarParts, forgetMylarSeries, getCover, rememberCover,
  enqueueEnrichment, claimNextEnrichment, completeEnrichment, postponeEnrichment, enrichmentStats,
  recordEvent, listEvents,
} from './store.js';
import * as metron from './metron.js';
import * as lore from './lore.js';
import { supplement } from './enrich.js';

const app = express();

// Panel's JSON is long lists of volumes -- a 96-title page runs to ~150KB of
// highly repetitive text that compresses by roughly 85%. Express ships no
// compression, and on a phone or iPad over WiFi that transfer, not the query,
// is what the reader waits for. zlib is built in, so this costs no dependency.
const COMPRESSIBLE = /^(?:application\/json|text\/|application\/javascript|image\/svg)/;
const COMPRESS_MIN_BYTES = 1024;

function negotiateEncoding(req) {
  const accept = String(req.headers['accept-encoding'] || '');
  if (/\bbr\b/.test(accept)) return 'br';
  if (/\bgzip\b/.test(accept)) return 'gzip';
  return null;
}

function compressSync(buffer, encoding) {
  return encoding === 'br'
    // Quality 5 is the knee of the curve: near-gzip CPU for better ratios.
    ? zlib.brotliCompressSync(buffer, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 5,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buffer.length,
      },
    })
    : zlib.gzipSync(buffer, { level: 6 });
}

app.use((req, res, next) => {
  const encoding = negotiateEncoding(req);
  if (!encoding) return next();
  const send = res.send.bind(res);
  res.send = (body) => {
    if (typeof body !== 'string' || res.getHeader('Content-Encoding')) return send(body);
    const buffer = Buffer.from(body, 'utf8');
    if (buffer.length < COMPRESS_MIN_BYTES) return send(body);
    if (!COMPRESSIBLE.test(String(res.getHeader('Content-Type') || ''))) return send(body);
    res.setHeader('Content-Encoding', encoding);
    res.setHeader('Vary', 'Accept-Encoding');
    res.removeHeader('Content-Length');
    return send(compressSync(buffer, encoding));
  };
  next();
});
const root = path.dirname(fileURLToPath(import.meta.url));
// Docker Compose supplies production secrets as environment variables. For
// direct local `node server.js` development, load the gitignored .env file so
// optional providers (such as Metron) behave exactly as they do in Docker.
if (!process.env.METRON_TOKEN && fs.existsSync(path.join(root, '.env'))) {
  try { process.loadEnvFile(path.join(root, '.env')); } catch { /* local env is optional */ }
}
const port = Number(process.env.PORT || 3000);
const mylarUrl = process.env.MYLAR_URL || 'http://192.168.40.44:8090/api';
const configPath = process.env.MYLAR_CONFIG || '/run/mylar/config.ini';
const komgaConfigPath = process.env.KOMGA_CONFIG || '';

// Komga credentials are read from Komf's mounted config for the same reason the
// Mylar key is: the secret stays on the server and never enters this checkout.
function komgaCredentials() {
  if (process.env.KOMGA_USER && process.env.KOMGA_PASSWORD) {
    // Compose supplies KOMGA_URL explicitly. The LAN default keeps direct
    // local `node server.js` development aligned with the Unraid deployment.
    return { user: process.env.KOMGA_USER, password: process.env.KOMGA_PASSWORD, url: process.env.KOMGA_URL || 'http://192.168.40.44:25600' };
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
// Panel's own requests reach Komga over the LAN; the reader's browser might be
// coming through a proxy instead, so the link they follow is configurable.
const komgaPublicUrl = (process.env.KOMGA_PUBLIC_URL || komgaUrl).replace(/\/$/, '');
const komgaAuth = komgaCreds
  ? `Basic ${Buffer.from(`${komgaCreds.user}:${komgaCreds.password}`).toString('base64')}`
  : '';
const cache = new Map();
// Covers are media, not API responses. Keep them on the same persistent data
// volume as SQLite, fetched lazily only when a card enters the viewport.
const coverDir = process.env.COVER_DIR || path.join(root, 'data', 'covers');
fs.mkdirSync(coverDir, { recursive: true });
const coverInflight = new Map();

// ComicVine detail responses are enormous — a single character document is
// ~4.9 MB unfiltered and ~218 KB with field_list. Always send one.
// first_issue/last_issue carry issue_number, which is the only thing that tells
// six volumes all called "The Amazing Spider-Man" apart.
const VOLUME_FIELDS = 'id,name,aliases,start_year,count_of_issues,image,publisher,description,deck,site_detail_url,resource_type,first_issue,last_issue';
// Only for the single-volume sheet: creators and cast are genuinely useful and
// come free in the same call, but they are far too heavy for list responses.
// ComicVine has no genre field -- its `concepts` are cover-variant bookkeeping
// ("Variant Cover", "Homage Covers"), not subject matter -- so there is nothing
// to build a genre facet from.
const VOLUME_DETAIL_FIELDS = `${VOLUME_FIELDS},people,characters,teams`;
// The field that proves a stored object came from a detail call, not a search.
const THREAD_DETAIL_MARKER = {
  character: 'teams', team: 'characters', person: 'created_characters', story_arc: 'first_appeared_in_issue',
};
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
  // A few Mylar write commands legitimately answer with plain "OK" rather
  // than JSON. Treat that as success; trying response.json() made a successful
  // per-part queue look like a Panel error.
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { return text.trim(); }
  if (body?.success === false) throw new Error(body.error?.message || 'Mylar rejected the request.');
  return body.data ?? body;
}

// ComicVine documents an hourly allowance, but its throttling is also sensitive
// to bursts. One globally paced lane is deliberately conservative: a page with
// several catalogue widgets cannot turn into dozens of simultaneous requests.
// Cached responses remain instant, so this only affects a genuinely new lookup.
const CV_MIN_INTERVAL_MS = 1_250;
const CV_COOLDOWN_MS = 60 * 60_000;
let cvTail = Promise.resolve();
let cvLastStartedAt = 0;
let cvQueued = 0;
let cvLimitedUntil = 0;

const comicVineStatus = () => ({
  limited: Date.now() < cvLimitedUntil,
  retryInSeconds: Math.max(0, Math.ceil((cvLimitedUntil - Date.now()) / 1000)),
  queued: cvQueued,
});

// The mirror gets richer in the background, but only along paths the reader
// has already taken. It deliberately processes one record every 15 seconds;
// that is slow enough to be a good neighbour to ComicVine and leaves normal
// foreground searches ahead of it in the same paced lane.
const ENRICHMENT_INTERVAL_MS = 15_000;
let enrichmentRunning = false;
const THREAD_DETAIL_PATHS = { character: '4005', team: '4060', person: '4040', story_arc: '4045' };
// The sole deliberate exception to reader-led enrichment: a new installation
// deserves a real Discover page. These are a small, curated onboarding set,
// not a catalogue scrape; each query is persisted and runs through the same
// one-at-a-time lane as every other enrichment job.
const FIRST_RUN_DISCOVERY_SEEDS = [
  'batman omnibus', 'spider-man omnibus', 'x-men omnibus',
  'compendium', 'epic collection', 'absolute edition',
  'saga', 'hellboy', 'invincible',
  'berserk', 'one piece', 'fullmetal alchemist',
];

async function runEnrichmentOnce() {
  if (enrichmentRunning || comicVineStatus().limited) return;
  const job = claimNextEnrichment();
  if (!job) return;
  enrichmentRunning = true;
  try {
    if (job.kind === 'seed') {
      const rows = await comicVine('search', { query: job.id, resources: 'volume', limit: '100', field_list: VOLUME_FIELDS });
      rememberVolumes(rows); rememberObjects('volume', rows);
    } else if (job.kind === 'volume') {
      const known = getVolume(job.id);
      // An opened sheet has already fetched this exact rich document. Mark the
      // queued intent complete without spending a second API call just because
      // the queue woke up after the foreground response was stored.
      if (known && ('people' in known || 'characters' in known)) {
        completeEnrichment(job.kind, job.id);
        return;
      }
      const item = await comicVine(`volume/4050-${job.id}`, { field_list: VOLUME_DETAIL_FIELDS });
      rememberVolumes(item); rememberObjects('volume', item);
    } else {
      const prefix = THREAD_DETAIL_PATHS[job.kind];
      if (!prefix) throw new Error(`No enrichment route for ${job.kind}`);
      const known = getObject(job.kind, job.id);
      if (known && (known.deck || known.description || known.teams || known.created_characters)) {
        completeEnrichment(job.kind, job.id);
        return;
      }
      const item = await comicVine(`${job.kind}/${prefix}-${job.id}`, { field_list: THREAD_FIELDS[job.kind] });
      rememberObjects(job.kind, item);
    }
    completeEnrichment(job.kind, job.id);
  } catch (error) {
    const delay = comicVineStatus().limited ? Math.max(60_000, cvLimitedUntil - Date.now()) : 5 * 60_000;
    postponeEnrichment(job.kind, job.id, error.message, delay);
  } finally {
    enrichmentRunning = false;
  }
}

function wakeEnrichment() {
  setTimeout(() => runEnrichmentOnce().catch(() => {}), 250).unref?.();
}
setInterval(() => runEnrichmentOnce().catch(() => {}), ENRICHMENT_INTERVAL_MS).unref();

function bootstrapDiscoveryIfEmpty() {
  const mirror = cacheStats();
  if (mirror.volumes > 0 || mirror.enrichment.done > 0 || mirror.enrichment.pending > 0) return;
  enqueueEnrichment('seed', FIRST_RUN_DISCOVERY_SEEDS, 'first-run-discovery');
  wakeEnrichment();
}
// Let the server begin listening before an initial remote request, while still
// making a clean install useful within its first moments.
setTimeout(bootstrapDiscoveryIfEmpty, 300).unref?.();

async function cvAcquire() {
  let release;
  const previous = cvTail;
  cvTail = new Promise((resolve) => { release = resolve; });
  cvQueued += 1;
  await previous;
  cvQueued -= 1;
  const wait = Math.max(0, cvLastStartedAt + CV_MIN_INTERVAL_MS - Date.now());
  if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
  cvLastStartedAt = Date.now();
  return release;
}

async function comicVine(resource, params = {}) {
  // Do not add more work behind a known cooldown. The second check below still
  // covers requests that were already waiting when the 420/429 arrived.
  if (Date.now() < cvLimitedUntil) {
    throw new Error('ComicVine is rate-limiting us; cached results only for a while.');
  }
  const query = new URLSearchParams({ api_key: comicVineKey(), format: 'json', ...params });
  if (!query.has('field_list')) query.set('field_list', VOLUME_FIELDS);
  const release = await cvAcquire();
  try {
    if (Date.now() < cvLimitedUntil) {
      throw new Error('ComicVine is rate-limiting us; cached results only for a while.');
    }
    return await comicVineFetch(resource, query);
  } finally {
    release();
  }
}

async function comicVineFetch(resource, query) {
  const response = await fetch(`https://comicvine.gamespot.com/api/${resource}/?${query}`, {
    headers: { 'User-Agent': 'ComicRequester/1.0 (personal media server)' }, signal: AbortSignal.timeout(20_000),
  });
  // ComicVine rate-limits with 420 ("enhance your calm") and 429. Naming it
  // matters: a bare status looks like a bug rather than throttling, and the
  // answer is to lean harder on the cache, not to retry into the limit.
  if (response.status === 420 || response.status === 429) {
    // Back off rather than keep asking: further calls make the window longer.
    const retryAfter = Number(response.headers.get('retry-after'));
    cvLimitedUntil = Date.now() + (Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1_000
      : CV_COOLDOWN_MS);
    throw new Error('ComicVine is rate-limiting us; cached results only for a while.');
  }
  if (!response.ok) throw new Error(`ComicVine returned HTTP ${response.status}`);
  const body = await response.json();
  if (body.status_code !== 1) throw new Error(body.error || 'ComicVine rejected the request.');
  const results = body.results || [];
  // Build the local mirror opportunistically from every volume response. This
  // turns yesterday's searches, publisher pages and detail sheets into today's
  // offline-first catalogue without a separate crawl.
  if (resource !== 'issues') {
    rememberVolumes(results);
    rememberObjects(resource, results);
  }
  return results;
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

// ComicVine's returned order is not a relevance order. Treat the query like a
// reader's intent instead: an exact (including punctuation-free) title wins;
// then an ordered title phrase; then all of the requested words. Publisher,
// year, aliases, and the size of a run resolve ties without ever outranking a
// more specific title. This is intentionally inspectable rather than a fake
// "AI" score with no way to explain why Spider-Man landed where it did.
const SEARCH_NOISE = new Set(['a', 'an', 'and', 'comic', 'comics', 'edition', 'for', 'of', 'series', 'the', 'volume', 'vol']);

function searchIntent(query) {
  const raw = normalise(query);
  const year = raw.match(/\b(?:18|19|20)\d{2}\b/)?.[0] ?? '';
  const publisher = Object.keys(PUBLISHER_WEIGHT)
    .find((name) => raw.includes(normalise(name))) ?? '';
  const withoutPublisher = publisher ? raw.replace(normalise(publisher), ' ') : raw;
  const title = withoutPublisher
    .replace(year, ' ')
    .replace(/\b(?:comic|comics|series|volume|vol)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const words = title.split(' ').filter((word) => word && !SEARCH_NOISE.has(word));
  return { title, words, year, publisher };
}

function titleScore(titleValue, query) {
  const title = normalise(titleValue);
  const intent = searchIntent(query);
  const wanted = intent.title;
  if (!wanted || !title) return 0;
  // "spiderman" and "Spider-Man" are the same reader query.
  const tight = (value) => value.replaceAll(' ', '');
  if (title === wanted || tight(title) === tight(wanted)) return 100_000;

  let score = 0;
  if (title.startsWith(wanted) || tight(title).startsWith(tight(wanted))) score += 30_000;
  else if (title.includes(wanted) || tight(title).includes(tight(wanted))) score += 18_000;

  const titleWords = title.split(' ');
  let exactWords = 0;
  let prefixWords = 0;
  for (const word of intent.words) {
    if (titleWords.includes(word)) exactWords += 1;
    else if (titleWords.some((part) => part.startsWith(word))) prefixWords += 1;
  }
  if (exactWords === intent.words.length) score += 12_000;
  else score += exactWords * 1_600 + prefixWords * 700;

  // Keep a genuinely fuzzy fallback for spelling and hyphen variants, but it
  // is always far below a title containing all of the requested words.
  let position = 0;
  for (const char of tight(wanted)) {
    position = tight(title).indexOf(char, position);
    if (position < 0) return score;
    position += 1;
  }
  return score + 250 - Math.min(position, 249);
}

function relevance(item, query) {
  const intent = searchIntent(query);
  const publisher = normalise(item.publisher?.name ?? item.publisher);
  const title = titleScore(item.name, query);
  const aliases = String(item.aliases ?? '').split(/\r?\n|;/).map((alias) => titleScore(alias, query));
  let score = Math.max(title, ...aliases, 0);
  // A named publisher/year is a hard intent signal. A wrong year should not
  // beat the requested run merely because it has more issues.
  if (intent.publisher) score += publisher.startsWith(normalise(intent.publisher)) ? 8_000 : -4_000;
  if (intent.year) score += String(item.start_year ?? '') === intent.year ? 8_000 : -3_000;
  return score;
}

// Relevance ties constantly on a character search -- every one of these volumes
// is literally called "Spider-Man". This is a modest tie-breaker only: publisher
// provenance first, then diminishing returns for a substantial established run.
function notability(item) {
  const publisher = item.publisher?.name ?? item.publisher ?? '';
  const issues = Number(item.count_of_issues) || 0;
  const year = Number(item.start_year) || new Date().getFullYear();
  const legacy = Math.min(180, Math.max(0, new Date().getFullYear() - year) * 3);
  return weightOf(publisher) * 100 + Math.min(600, Math.sqrt(issues) * 30) + legacy;
}

function truncate(text, limit) {
  if (!text) return null;
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[,;:]$/, '')}…`;
}

// One plain sentence is enough to say what a book is; ComicVine descriptions
// run to several paragraphs of solicitation copy.
function firstSentence(text = '', cap = 190) {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  const stop = clean.search(/[.!?](?:\s|$)/);
  const sentence = stop > 0 ? clean.slice(0, stop + 1) : clean;
  return sentence.length > cap ? `${sentence.slice(0, cap - 1).trimEnd()}…` : sentence;
}

function plainText(value = '') {
  const entities = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };
  return String(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (_all, decimal, hex, named) => {
      if (decimal) return String.fromCodePoint(Number(decimal));
      if (hex) return String.fromCodePoint(parseInt(hex, 16));
      return entities[String(named).toLowerCase()] ?? `&${named};`;
    })
    .replace(/\s+/g, ' ').trim();
}

function synopsisOf(item) {
  const deck = plainText(item.deck);
  // "Volume 1." and similar database labels are technically a deck but not a
  // synopsis. Prefer it only when it actually tells a reader something.
  if (deck.length >= 40) return truncate(deck, 420);
  const description = plainText(item.description);
  // ComicVine descriptions often append unbounded credit/appearance dumps.
  // Keep the introductory editorial copy and stop before that database tail.
  const tail = description.search(/\b(?:writers?|artists?|most written issues|collected editions?|appearances?)\b/i);
  return truncate(tail >= 0 ? description.slice(0, tail).trim() : description, 420);
}

// Manga and Western comics answer different questions -- you browse manga by
// creator and series, comics by character and publisher -- and ComicVine has no
// medium field, so it is inferred from the publisher. Japanese houses plus the
// English-language manga imprints.
const MANGA_PUBLISHERS = [
  'shueisha', 'kodansha', 'shogakukan', 'square enix', 'kadokawa', 'hakusensha',
  'futabasha', 'houbunsha', 'akita shoten', 'coremagazine', 'asahi sonorama',
  'jitsugyo no nihon sha', 'ascii media works', 'ichijinsha', 'media factory',
  'viz', 'seven seas', 'yen press', 'dark horse manga', 'vertical', 'tokyopop',
  'kodansha comics', 'denpa', 'ghost ship', 'j-novel', 'star fruit',
];

function mediumOf(publisher = '') {
  const name = String(publisher || '').toLowerCase();
  return MANGA_PUBLISHERS.some((p) => name.includes(p)) ? 'manga' : 'comic';
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

const editionOf = (title = '') =>
  EDITIONS.find(([, pattern]) => pattern.test(String(title).toLowerCase()))?.[0] ?? 'Series';

function catalogueShape(item, watchedIds) {
  const image = item.image || {};
  // Descriptions frequently list every available format (even on a regular
  // series), so classify from the listing title/type rather than its blurb.
  const edition = editionOf(item.name);
  const firstNo = item.first_issue?.issue_number;
  const lastNo = item.last_issue?.issue_number;
  // "#1-700.1" says more about which run this is than any other single field.
  const range = firstNo && lastNo
    ? (String(firstNo) === String(lastNo) ? `#${firstNo}` : `#${firstNo}–${lastNo}`)
    : null;
  return {
    id: String(item.id), title: item.name, year: item.start_year, publisher: item.publisher?.name,
    medium: mediumOf(item.publisher?.name),
    issueRange: range,
    issues: Number(item.count_of_issues) || 0,
    // A local endpoint takes care of durable media caching. medium_url is more
    // than sharp enough for this UI and avoids storing enormous poster files.
    cover: image.medium_url || image.super_url || image.small_url ? `/api/cover/${encodeURIComponent(String(item.id))}` : null,
    description: synopsisOf(item), type: 'Volume', edition, imprint: null,
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

const COMPLETED_ISSUE_STATES = new Set(['Archived', 'Downloaded', 'Snatched', 'Wanted']);

// Mylar owns the authoritative per-part IDs. ComicVine's catalogue tells us a
// collection has six entries, but Mylar is the service that knows which of
// those entries is already downloaded, wanted, or safe to queue.
function shapedMylarParts(local) {
  return {
    tracked: local.tracked,
    parts: local.parts.map((issue) => {
      const status = String(issue.status || 'Skipped');
      return { ...issue, status, requestable: !COMPLETED_ISSUE_STATES.has(status) };
    }),
  };
}

async function mylarParts(comicId, { refresh = false } = {}) {
  const local = getMylarParts(comicId);
  // The persisted list is the normal fast path. Mutating actions request a
  // refresh so the final queue operation never relies on a stale status.
  if (local.tracked && local.parts.length && !refresh) return shapedMylarParts(local);
  const data = await mylar('getComic', { id: comicId });
  rememberMylarParts(comicId, data);
  return shapedMylarParts(getMylarParts(comicId));
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
          id: String(s.id),
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

// "Do I already have this?" asked of a title rather than a watchlist entry.
// Komga's names carry a trailing year that Mylar's do not, which shelfKey
// already settles; this is the same match, exposed to the pages that need to
// warn a reader before they queue four gigabytes they own.
async function ownedTitle(title) {
  if (!title) return null;
  const present = await komgaShelf();
  const found = present.get(shelfKey(title));
  if (!found?.id) return null;
  return {
    books: found.books ?? 0, read: found.read ?? 0, unread: found.unread ?? 0,
    readUrl: `${komgaPublicUrl}/series/${encodeURIComponent(found.id)}`,
  };
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
      inProgress: found?.inProgress ?? 0,
      // The point of the whole app is to end up reading the book. Komga runs
      // on the same LAN as this server, so its own URL is the reader's too --
      // unless Panel is reached from outside, which is what the override is
      // for. Without an id there is nothing to link to and the button is
      // simply absent rather than pointing at a search page.
      readUrl: found?.id ? `${komgaPublicUrl}/series/${encodeURIComponent(found.id)}` : null,
      state: found ? 'In library' : 'Searching',
    };
  });
}

app.use(express.json({ limit: '32kb' }));
// Container health must answer without reaching Mylar, Komga or Metron. Those
// providers are intentionally diagnosed by /api/health, but a slow optional
// metadata service must not make an otherwise healthy web server look dead.
app.get('/api/ready', (_req, res) => res.json({ ok: true }));
app.get('/api/health', async (_req, res) => {
  try {
    res.json({
      ok: true,
      watchlist: (await watchlist()).length,
      komga: Boolean(komgaUrl && komgaAuth),
      comicvine: comicVineStatus(),
      cache: cacheStats(),
      enrichment: enrichmentStats(),
      // Reports reachability, not just configuration: Metron blocks an IP
      // outright for bursty traffic, and that should be visible here rather
      // than showing up as quietly missing data.
      metron: await metron.status(),
    });
  }
  catch (error) { res.status(503).json({ ok: false, error: error.message }); }
});

app.post('/api/cache/clear', (_req, res) => {
  clearCache();
  cache.clear();
  res.json({ ok: true, cache: cacheStats() });
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
      comicvine: comicVineStatus(),
    });
  } catch (error) { next(error); }
});

function requestSummary(items) {
  const status = (value) => String(value || '').toLowerCase();
  return {
    wanted: items.filter((item) => status(item.status) === 'wanted').length,
    snatched: items.filter((item) => status(item.status) === 'snatched').length,
    downloaded: items.filter((item) => ['downloaded', 'archived'].includes(status(item.status))).length,
    failed: items.filter((item) => ['failed', 'error'].includes(status(item.status))).length,
    skipped: items.filter((item) => status(item.status) === 'skipped').length,
  };
}

async function refreshRequestParts() {
  // This is an explicit user action, never a page-load fan-out. Mylar is the
  // authority for its states, so refresh each known series serially.
  const ids = [...new Set(listMylarParts().map((item) => item.comicId))].slice(0, 200);
  for (const id of ids) {
    try { await mylarParts(id, { refresh: true }); } catch { /* retain last known status */ }
  }
}

// Between them, Mylar's API and its web UI still cannot answer the question a
// waiting reader actually has: has anything looked for this, and when will it
// look again? That lives only in its own SQLite, which Panel opens read-only.
// The file is `journal_mode=delete`, so a reader needs no write access to it
// or its directory -- which is what makes a `:ro` mount into a read-only
// container safe. If the file is not there the feature is simply absent; every
// caller degrades to null rather than failing a page.
const mylarDbPath = process.env.MYLAR_DB || path.join(path.dirname(configPath), 'mylar.db');
let mylarDbHandle = null;
let mylarDbCheckedAt = 0;

function mylarDb() {
  if (mylarDbHandle) return mylarDbHandle;
  // Re-check occasionally rather than per request: a missing file usually
  // means local development, and stat-ing it on every page load is pointless.
  if (Date.now() - mylarDbCheckedAt < 60_000) return null;
  mylarDbCheckedAt = Date.now();
  try {
    mylarDbHandle = new DatabaseSync(mylarDbPath, { readOnly: true });
  } catch { mylarDbHandle = null; }
  return mylarDbHandle;
}

function mylarQuery(sql, ...params) {
  const db = mylarDb();
  if (!db) return null;
  try { return db.prepare(sql).all(...params); } catch (error) {
    // A schema change upstream must never take a page down with it.
    console.warn(`Mylar database read failed: ${error.message}`);
    mylarDbHandle = null;
    return null;
  }
}

// Mylar is inconsistent about time in three different ways: the DDL queue
// writes local wall clock, jobhistory writes UTC, and `next_run_timestamp` is
// a real epoch for some jobs and a UTC datetime string for others. Normalise
// all of it to an ISO instant here so nothing downstream has to know.
function instant(value) {
  if (value == null || value === '') return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
  const text = String(value).trim().replace(' ', 'T');
  const at = new Date(/[Z+]|-\d{2}:\d{2}$/.test(text) ? text : `${text}Z`);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

// Why a part is still waiting: who has looked, when, and when the standing
// sweep comes round again. Mylar searches every Wanted issue in one pass, so
// the provider times are the same for all of them -- which is exactly the
// point. "Nothing has searched since yesterday" is the answer.
function searchState() {
  const providers = mylarQuery(
    'SELECT provider, type, lastrun, hits FROM provider_searches ORDER BY lastrun DESC',
  );
  if (!providers) return null;
  const job = mylarQuery(
    "SELECT next_run_timestamp, prev_run_timestamp, status FROM jobhistory WHERE JobName = 'Auto-Search'",
  )?.[0];
  const lastRun = providers.reduce((newest, row) => Math.max(newest, Number(row.lastrun) || 0), 0);
  return {
    providers: providers.map((row) => ({
      name: String(row.provider), type: String(row.type || ''),
      lastRun: instant(row.lastrun), hits: Number(row.hits) || 0,
    })),
    lastRun: instant(lastRun),
    nextSweep: instant(job?.next_run_timestamp),
    // Paused means the scheduled sweep will never come; only a manual search
    // will move anything, and the page has to say so.
    sweepPaused: String(job?.status || '') === 'Paused',
  };
}

// When each waiting part was first asked for, straight from Mylar's own
// issues table. Panel's copy only knows when it last polled.
function wantedSince() {
  const rows = mylarQuery("SELECT IssueID, DateAdded FROM issues WHERE Status = 'Wanted'");
  return new Map((rows ?? []).map((row) => [String(row.IssueID), String(row.DateAdded || '')]));
}

// Mylar's API answers for what was asked for and what eventually arrived, but
// it has no command for the part in between. Its direct-download queue lives
// only behind the web UI -- so Panel reads that page's own JSON feed, on the
// same host and port as the API, and uses the button beside it to retry.
//
// This matters more than it sounds. The queue is served by a single worker: if
// Mylar restarts mid-download the row stays marked Downloading forever, no
// worker ever picks the rest up, and every later request simply sits at Queued
// behind it. From the outside that looks exactly like a request that was never
// searched for. Panel could not tell the difference until now.
const mylarWebUrl = (process.env.MYLAR_WEB_URL || mylarUrl).replace(/\/api\/?$/, '');

async function mylarWeb(pathname, params = {}) {
  const query = new URLSearchParams(params);
  const response = await fetch(`${mylarWebUrl}/${pathname}?${query}`, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Mylar returned HTTP ${response.status}`);
  const text = await response.text();
  try { return JSON.parse(text); } catch { return text.trim(); }
}

// Mylar's own words for a queue row, in the reader's. "Snatched" and "Queued"
// already mean something else on the requests page -- there they describe a
// part's search, here a file's transfer -- so these deliberately do not reuse
// them.
const DOWNLOAD_STATES = {
  Queued: 'Waiting its turn',
  Downloading: 'Downloading',
  Completed: 'Downloaded',
  Failed: 'Failed',
  Aborted: 'Stopped',
};

// Mylar abbreviates the GetComics mirrors; these are the names the hosts
// themselves use, which is what a reader would recognise.
const DOWNLOAD_SOURCES = {
  'GC-Mega': 'Mega', 'GC-Pixel': 'PixelDrain', 'GC-Media': 'MediaFire',
  'GC-Main': 'GetComics', 'GC-Mirror': 'GetComics mirror',
};

// The DataTables feed behind Manage → Download queue. Its rows are positional:
// [series, size, progress, status, updated, queueId, issueId, comicId, link].
async function downloadQueue() {
  const data = await mylarWeb('queueManageIt', { iDisplayStart: '0', iDisplayLength: '300' });
  const rows = Array.isArray(data?.aaData) ? data.aaData : [];
  return rows.map(([title, size, progress, status, updated, queueId, issueId, comicId, linkType]) => ({
    id: String(queueId ?? ''),
    title: String(title ?? '').trim(),
    size: String(size ?? '').trim() || null,
    state: String(status ?? '').trim(),
    label: DOWNLOAD_STATES[String(status ?? '').trim()] ?? String(status ?? '').trim(),
    // Mylar only ever reports 100% or nothing at all: it does not track bytes
    // for a running transfer. Passing its own value through keeps that honest
    // rather than inventing a bar that does not move.
    progress: String(progress ?? '').trim() || null,
    // Left as Mylar wrote it, in Mylar's local time. The browser shares that
    // clock and the container does not, so the elapsed time is worked out
    // there rather than here.
    changed: String(updated ?? '').trim() || null,
    issueId: String(issueId ?? ''), comicId: String(comicId ?? ''),
    // Which mirror it is coming from. Mega refuses whole evenings at a time
    // with ETOOMANY, and knowing that is the difference between "Panel is
    // broken" and "that host is busy, it will fall through to the next one".
    source: DOWNLOAD_SOURCES[String(linkType ?? '').trim()] ?? null,
  })).filter((item) => item.id && item.title);
}

// The queue rows carry Mylar's comic id, so "is this already downloading?" is
// an exact match rather than another go at matching titles.
async function queuedFor(comicId) {
  const items = await memo('downloads:queue', 15_000, downloadQueue).catch(() => []);
  return items.filter((item) => item.comicId === String(comicId) && item.state !== 'Completed');
}

app.get('/api/downloads', async (_req, res, next) => {
  try {
    const items = await downloadQueue();
    const counted = (state) => items.filter((item) => item.state === state).length;
    res.json({
      items,
      counts: {
        downloading: counted('Downloading'), waiting: counted('Queued'),
        done: counted('Completed'), failed: counted('Failed'),
      },
    });
  } catch (error) { next(error); }
});

// Panel has been a page you have to visit. That is how a download queue sat
// wedged for a day: everything needed to notice was on screen, and nobody was
// looking at the screen. The watcher below turns state into events, which the
// requests page shows on your return and which are pushed if a URL is set.
//
// It reads only what Mylar has already written. It never searches, never
// queues, and never touches ComicVine.
const NOTIFY_URL = (process.env.PANEL_NOTIFY_URL || '').trim();
const NOTIFY_FORMAT = (process.env.PANEL_NOTIFY_FORMAT || 'auto').trim().toLowerCase();
const WATCH_INTERVAL_MS = 5 * 60_000;
// One warning per stall, not one every five minutes for a day.
const STALL_QUIET_MS = 6 * 60 * 60_000;
const STALL_AFTER_MS = 3 * 60 * 60_000;

function notifyShape(event) {
  const text = event.detail ? `${event.title}\n${event.detail}` : event.title;
  const discord = NOTIFY_FORMAT === 'discord'
    || (NOTIFY_FORMAT === 'auto' && /discord(app)?\.com\/api\/webhooks/i.test(NOTIFY_URL));
  if (discord) {
    return { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: text }) };
  }
  if (NOTIFY_FORMAT === 'json') {
    return {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: event.kind, title: event.title, detail: event.detail, at: event.at, text }),
    };
  }
  // ntfy's own shape, which is a plain body plus headers. Generic receivers
  // read the body and ignore the rest, so this is the least surprising default.
  return {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', Title: event.title,
      Tags: event.kind === 'stalled' ? 'warning' : 'books' },
    body: event.detail || event.title,
  };
}

async function pushEvent(event) {
  if (!NOTIFY_URL) return;
  try {
    const { headers, body } = notifyShape(event);
    const response = await fetch(NOTIFY_URL, { method: 'POST', headers, body, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    // A notifier that is down must never be able to stop the watcher.
    console.warn(`Could not push a notification: ${error.message}`);
  }
}

async function announce(event) {
  if (!recordEvent(event)) return;
  await pushEvent(event);
}

// Mylar writes a post-processed row the moment a book lands in the library, so
// that table is the arrival bell. The key pins the row so a restart cannot
// re-announce yesterday's books. DateAdded is Mylar's local wall clock: it is
// carried through untouched for the browser to read, and never parsed here,
// where the container's idea of local time is UTC.
function arrivals() {
  const rows = mylarQuery(
    "SELECT IssueID, ComicName, Issue_Number, DateAdded FROM snatched WHERE Status = 'Post-Processed' ORDER BY DateAdded DESC LIMIT 25",
  );
  return (rows ?? []).map((row) => ({
    key: `arrived:${row.IssueID}:${row.DateAdded}`,
    kind: 'arrived',
    // The part number belongs in the title: three volumes of the same omnibus
    // arriving read as one event repeated three times without it.
    title: `${row.ComicName ?? 'A book'}${row.Issue_Number ? ` #${row.Issue_Number}` : ''} arrived`,
    detail: 'Finished downloading and is in your library.',
    at: Date.now(),
    whenLocal: String(row.DateAdded ?? '') || null,
  }));
}

let watching = false;

async function watchForEvents() {
  if (watching) return;
  watching = true;
  try {
    // Arrivals first: on a cold database this records the recent history
    // silently the first time, which is deliberate. There is no useful moment
    // to tell a reader about a book that landed last week.
    const known = listEvents(200);
    const cold = !known.length;
    for (const event of arrivals()) {
      if (cold) { recordEvent(event); continue; }
      await announce(event);
    }

    const queue = await downloadQueue().catch(() => []);
    const waiting = queue.filter((item) => item.state === 'Queued');
    const running = queue.filter((item) => item.state === 'Downloading');
    // How long a file has been running is measured by Panel's own observations,
    // never by Mylar's wall clock: that clock belongs to another timezone, and
    // reading it as if it were this one reported a healthy transfer as stalled
    // within minutes of a deploy. This also measures the right thing -- how
    // long *we* have watched it sit there.
    const seen = cacheRead('downloads:running')?.value ?? {};
    const now = Date.now();
    const stillRunning = Object.fromEntries(running.map((item) => [item.id, seen[item.id] ?? now]));
    cacheWrite('downloads:running', stillRunning);
    const stuck = (waiting.length && !running.length)
      || Object.values(stillRunning).some((firstSeen) => now - firstSeen > STALL_AFTER_MS);
    if (stuck) {
      const recent = listEvents(50).find((event) => event.kind === 'stalled');
      if (!recent || Date.now() - recent.at > STALL_QUIET_MS) {
        await announce({
          key: `stalled:${Math.floor(Date.now() / STALL_QUIET_MS)}`,
          kind: 'stalled',
          title: 'The download queue has stopped',
          detail: `${waiting.length} file${waiting.length === 1 ? '' : 's'} waiting and ${
            running.length ? 'one held for hours' : 'nothing downloading'}. Open My requests and restart the queue.`,
        });
      }
    }
  } catch (error) {
    console.warn(`Watcher pass failed: ${error.message}`);
  } finally {
    watching = false;
  }
}

setInterval(() => { watchForEvents(); }, WATCH_INTERVAL_MS).unref();
// Not at boot: let the server start listening first, and give Mylar a moment
// if both containers came up together.
setTimeout(() => { watchForEvents(); }, 20_000).unref?.();

app.get('/api/events', (_req, res) => {
  res.json({ items: listEvents(10), pushing: Boolean(NOTIFY_URL) });
});

// Nothing about a request was reversible from here: a wrong pick meant opening
// Mylar. These are the three ways out, smallest first.

// One part: Mylar marks it Skipped, which is its word for "tracked but not
// wanted". The series stays, and the part can be requested again later.
app.post('/api/request/:comicId/part/:issueId/cancel', async (req, res, next) => {
  const comicId = String(req.params.comicId);
  const issueId = String(req.params.issueId);
  if (!/^\d+$/.test(comicId) || !/^\d+$/.test(issueId)) {
    return res.status(400).json({ error: 'A numeric series and part id are required.' });
  }
  try {
    await mylar('unqueueIssue', { id: issueId });
    await mylarParts(comicId, { refresh: true });
    res.json({ ok: true, message: 'Panel stopped waiting for that part.' });
  } catch (error) { next(error); }
});

// One file, mid-flight: Mylar's own abort marks the row Failed and stops it;
// remove deletes the row outright. Abort is the safer default, and it leaves
// evidence of what happened.
app.post('/api/downloads/abort', async (req, res, next) => {
  const id = String(req.body?.id ?? '').trim();
  const mode = req.body?.remove ? 'remove' : 'abort';
  if (!/^\d+$/.test(id)) return res.status(400).json({ error: 'That download id is not valid.' });
  try {
    const result = await mylarWeb('ddl_requeue', { mode, id });
    cache.delete('downloads:queue');
    res.json({ ok: true, message: typeof result === 'object' && result?.message ? String(result.message) : 'Mylar stopped that download.' });
  } catch (error) { next(error); }
});

// The whole series: Mylar forgets it and everything under it. The files it has
// already delivered are never touched -- directory deletion is deliberately
// not offered here, because this app has no business deleting a reader's
// comics, and Mylar's own page is one click away for that.
app.post('/api/request/:id/stop', async (req, res, next) => {
  const id = requestId(req, res);
  if (!id) return;
  try {
    await mylar('delComic', { id, directory: 'false' });
    cache.delete('watchlist');
    cache.delete('komga:series');
    forgetMylarSeries(id);
    res.json({ ok: true, message: 'Mylar is no longer tracking that series. Files already downloaded are untouched.' });
  } catch (error) { next(error); }
});

// The standing sweep runs once a day at most, and after a Mylar restart the
// next one can be two days out. This is the "look again now" the requests page
// offers instead of waiting for it.
app.post('/api/requests/search', async (_req, res, next) => {
  try {
    await mylar('forceSearch');
    res.json({ ok: true, message: 'Mylar is searching for everything you are waiting on.' });
  } catch (error) { next(error); }
});

// Hand a stalled queue back to Mylar. With no id this restarts every waiting
// row, which is the only way out of the wedged-worker state above; with one it
// restarts that row alone, which also covers the item the restart left behind.
app.post('/api/downloads/retry', async (req, res, next) => {
  const id = String(req.body?.id ?? '').trim();
  if (id && !/^\d+$/.test(id)) return res.status(400).json({ error: 'That download id is not valid.' });
  try {
    const result = await mylarWeb('ddl_requeue', id ? { mode: 'restart', id } : { mode: 'restart_queue' });
    const message = typeof result === 'object' && result?.message ? String(result.message) : 'Mylar restarted the queue.';
    res.json({ ok: true, message });
  } catch (error) { next(error); }
});

app.get('/api/requests', async (req, res, next) => {
  try {
    if (req.query.refresh === '1') await refreshRequestParts();
    // Opening a part picker caches every part Mylar knows about, most of which
    // were never asked for. This page is "My requests", so it lists only parts
    // that were actually requested -- a 192-issue watchlisted series otherwise
    // buries the two volumes you really are waiting on.
    const items = listMylarParts().filter((part) => String(part.status || '').toLowerCase() !== 'skipped');
    // Waiting parts carry Mylar's own "asked for on" date; Panel's copy only
    // knows when it last polled, which is not the same question.
    const asked = wantedSince();
    const present = await komgaShelf();
    const shaped = items.map((part) => {
      const found = present.get(shelfKey(part.series));
      return {
        ...part,
        ...(asked.has(part.issueId) ? { wantedSince: asked.get(part.issueId) } : {}),
        // Where to actually read it. The request list is the only place a
        // reader sees a finished book, so it is the place that has to offer.
        readUrl: found?.id ? `${komgaPublicUrl}/series/${encodeURIComponent(found.id)}` : null,
      };
    });
    res.json({
      items: shaped, counts: requestSummary(items), refreshed: req.query.refresh === '1',
      // Null when Mylar's database is not readable from here: the page then
      // says nothing about searching rather than guessing at it. `waiting` is
      // Mylar's own count, not Panel's copy of it -- a part queued from another
      // device, or before Panel last polled, is still a part nothing has found.
      search: searchState() && { ...searchState(), waiting: asked.size },
      explanation: {
        Wanted: 'Panel asked Mylar to search this part. It is waiting on Mylar’s indexers and download client.',
        Snatched: 'Mylar found a release and handed it to the download client.',
        Downloaded: 'Mylar marked the part as downloaded. Komga may take a moment to scan it into the library.',
        Archived: 'Mylar considers this part present in your comic library.',
        Failed: 'Mylar could not complete its last attempt. Retry sends this exact part back to Mylar’s search queue.',
        Skipped: 'This part is tracked by Mylar but has not been requested.',
      },
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
    // A thread first learned from a search result carries only the list fields,
    // so trusting any cached object here silently served a detail page with no
    // line-up and no relationships. Fetch unless the stored copy actually has
    // the field this kind's page is built on.
    const storedObject = getObject(kind, id);
    // Thread buttons carry their visible name as a fallback. That lets a team
    // or character still open its Wikidata graph during a ComicVine cooldown
    // even when this browser has never fetched its detail document.
    const fallbackName = String(req.query.name || '').trim().slice(0, 160);
    const stored = storedObject || (
      ['team', 'character'].includes(kind) && fallbackName
        ? { id: String(id), name: fallbackName }
        : null
    );
    let data = stored && THREAD_DETAIL_MARKER[kind] in stored ? stored : null;
    if (!data) {
      try {
        data = await memo(`thread:${kind}:${id}`, 12 * 60 * 60_000, () =>
          comicVine(`${kind}/${prefix}-${id}`, { field_list: THREAD_FIELDS[kind] }));
      } catch (error) {
        // A relationship card already gave us its identity. Its team/character
        // graph belongs to Wikidata, so a ComicVine cooldown must not turn that
        // click into a blank error page merely because comic metadata is
        // temporarily unavailable.
        if (['team', 'character'].includes(kind) && stored?.name) data = stored;
        else throw error;
      }
    }
    rememberObjects(kind, data);
    enqueueEnrichment(kind, id, 'followed'); wakeEnrichment();
    const image = data.image || {};
    // character_friends/character_enemies come back unranked and alphabetical
    // (1,081 entries for Spider-Man), and ComicVine exposes no co-appearance
    // count — so these are surfaced as "related", never as "shares N volumes".

    const shaped = {
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
      // For a team this is replaced below by the lore provider; ComicVine's own
      // team membership is unusable (it files Spider-Man under the X-Men).
      teams: (data.teams ?? data.characters ?? [])
        .filter((x) => x && x.name)
        .map((x) => {
          const targetKind = data.teams ? 'team' : 'character';
          const known = getObject(targetKind, x.id);
          return {
            id: String(x.id),
            name: x.name,
            kind: targetKind,
            fame: Number(known?.count_of_issue_appearances) || 0,
          };
        })
        .sort((a, b) => b.fame - a.fame)
        .slice(0, 14)
        .map(({ fame, ...rest }) => rest),
    };

    // ComicVine is authoritative about the books and hopeless about the
    // stories. Who is actually in a team is a lore question, so it goes to
    // Wikidata; the names come back as lore entities and are mapped onto
    // ComicVine ids from the local catalogue so they stay navigable. Anything
    // we cannot map is still shown -- it is true, just not clickable yet.
    if (kind === 'team') {
      const members = await teamLineUp(data.name);
      if (members.length) {
        shaped.teams = members;
        // Wikidata's curated line-up is the useful current/core view. ComicVine
        // retains a much wider, time-spanning cast (Jubilee, Rogue and other
        // eras of the X-Men), but it is too noisy to replace the core roster.
        // Return it separately and label it honestly in the UI instead of
        // silently dropping everyone who was not in one canonical snapshot.
        const core = new Set(members.map((member) => normalise(member.name)));
        shaped.historicMembers = (data.characters ?? [])
          .filter((member) => member?.id != null && member.name && !core.has(normalise(member.name)))
          .map((member) => ({ id: String(member.id), name: member.name, kind: 'character' }));
      }
      shaped.lineUpSource = members.length ? 'lore' : 'comicvine';
    }
    res.json(shaped);
  } catch (error) { next(error); }
});

// Cached hard: a team's roster is not news, and the endpoint is a shared public
// service. Failure is always silent -- the ComicVine list stands.
async function teamLineUp(name) {
  if (!name) return [];
  try {
    // v2 also resolves ids learned through volume credits, not only profiles
    // opened directly by the reader. The original cached roster was therefore
    // far too sparse to build a balanced team shelf.
    return await cached(`lore:lineup:v2:${normalise(name)}`, 30 * 24 * 60 * 60_000, async () => {
      const entity = await lore.resolve(name, 'team');
      if (!entity) return [];
      const members = await lore.teamMembers(entity.id, 18);
      return members.map((member) => {
        // Credits carry the ComicVine id even if the character card itself has
        // never been opened. Use it before giving up: a roster of one known
        // Wolverine is exactly how an X-Men shelf became all Wolverine books.
        const known = findObjectByName('character', member.name);
        const linkedId = known ? null : findLinkedObjectIdByName('character', member.name);
        return {
          id: known ? String(known.id) : linkedId ? String(linkedId) : null,
          name: member.name,
          kind: 'character',
        };
      });
    });
  } catch { return []; }
}

// The profile page must paint from ComicVine before this begins. Wikidata is a
// shared public service and its two cached lookups can take a couple of seconds
// on a cold request; a separately loaded lore section makes that enrichment
// feel additive instead of turning every character page into a spinner.
//
// A Wikidata relationship is only a Panel link when the matching ComicVine
// object has already been legitimately learned. Everything else stays useful
// as a search, never a guessed id or an invented volume relationship.
function mapLoreItems(items, kind = null) {
  return (items || []).map((item) => {
    const known = kind ? findObjectByName(kind, item.name) : null;
    return {
      name: item.name,
      relation: item.relation,
      wikidata: item.id,
      thread: known ? { kind, id: String(known.id) } : null,
    };
  });
}

app.get('/api/thread/:kind/:id/lore', async (req, res, next) => {
  const { kind, id } = req.params;
  if (!['character', 'team'].includes(kind) || !/^\d+$/.test(id)) return res.json({ available: false });
  try {
    // This route is only called after the page profile loaded, which has saved
    // the actual ComicVine object. Refusing to fetch here preserves the rule
    // that a lore enhancement must never make an extra physical-catalogue call.
    const object = getObject(kind, id);
    if (!object?.name) return res.json({ available: false });
    const entity = await lore.resolve(object.name, kind);
    if (!entity) return res.json({ available: false });
    const profile = kind === 'team'
      ? await lore.teamProfile(entity.id)
      : await lore.characterProfile(entity.id);
    if (!profile) return res.json({ available: false });
    const groups = [
      { key: 'creators', label: 'Created by', items: mapLoreItems(profile.creators, 'person') },
      { key: 'universes', label: 'Universe', items: mapLoreItems(profile.universes) },
      { key: 'affiliations', label: 'Affiliations', items: mapLoreItems(profile.affiliations, 'team') },
      { key: 'family', label: 'Family', items: mapLoreItems(profile.family, 'character') },
      { key: 'locations', label: 'Headquarters', items: mapLoreItems(profile.locations) },
    ].filter((group) => group.items.length);
    res.json({
      available: Boolean(groups.length || profile.description),
      source: 'Wikidata', entity: entity.id, description: profile.description,
      groups,
    });
  } catch (error) {
    // Lore is enrichment, not a reason to make a reader's character page fail.
    // The client treats unavailable exactly like a character without data.
    if (error?.message) console.warn(`Lore profile unavailable for ${kind}/${id}: ${error.message}`);
    res.json({ available: false });
  }
});

// This is intentionally separate from the thread profile. Its books are only
// volumes carrying an actual stored ComicVine credit/appearance link — no
// title-token guesses. The number tells the reader how much of the relationship
// catalogue has been learned so far rather than pretending it is complete.
app.get('/api/thread/:kind/:id/volumes', async (req, res) => {
  const { kind, id } = req.params;
  if (!THREAD_KINDS[kind] || !/^\d+$/.test(id)) return res.status(400).json({ error: 'A valid saved thread is required.' });
  const library = await watchlist().catch(() => []);
  let volumes = relatedVolumes(kind, id, '', 48);
  let source = 'stored-links';
  // A team has two complementary book paths. ComicVine has no team-level
  // credit graph, so its *series* need a title lookup; its members' own books
  // come from saved, explicit character credits. Keeping these paths separate
  // prevents an X-Men page becoming a Wolverine page merely because Wolverine
  // was explored first, without calling an X-Men title a Cyclops appearance.
  if (kind === 'team') {
    const team = getObject('team', id);
    // The ComicVine record's `characters` list is uncurated (X-Men has 300
    // entries), so it cannot define a team shelf. Wikidata's smaller, typed
    // line-up does; ComicVine remains the source of the actual volume credits.
    const loreMembers = await teamLineUp(team?.name);
    const members = loreMembers.map((row) => row.id).filter(Boolean);
    const memberVolumes = volumesForCharacters(members, 32);
    let teamSeries = team?.name ? findVolumes(team.name, 120) : [];
    // A team page is an explicit request to learn that team's actual series.
    // One cached search is deliberately bounded; unlike a title detail crawl,
    // it does not fan out across a team's full history on every page view.
    if (team?.name && teamSeries.length < 12 && !comicVineStatus().limited) {
      try {
        const remote = await cached(`team-series:v1:${normalise(team.name)}`, 7 * 24 * 60 * 60_000,
          () => searchVolumes(team.name));
        rememberVolumes(remote);
        teamSeries = [...teamSeries, ...remote];
      } catch { /* saved member credits remain useful during a provider cooldown */ }
    }
    const teamWords = normalise(team?.name).split(' ').filter(Boolean);
    const seenSeries = new Set();
    const matchingSeries = teamSeries
      .filter((item) => {
        const title = normalise(item?.name);
        return title && teamWords.length && teamWords.every((word) => title.includes(word));
      })
      .sort((a, b) => relevance(b, team.name) - relevance(a, team.name)
        || notability(b) - notability(a))
      .filter((item) => !seenSeries.has(String(item.id)) && seenSeries.add(String(item.id)))
      .slice(0, 16);

    // A result-list response only has a title and cover. Queue a deliberately
    // small first page of team series for their richer detail documents, where
    // ComicVine finally supplies the actual character links. Those documents
    // are persisted by rememberVolumes, so later team/character pages become
    // SQLite reads rather than repeat provider calls.
    if (matchingSeries.length) {
      enqueueEnrichment('volume', matchingSeries.slice(0, 12).map((item) => item.id), 'team-series');
      wakeEnrichment();
    }

    // Alternate the two honest paths. This gives the group books equal visual
    // weight while preserving a member's actual credited work for discovery.
    const seen = new Set();
    const mixed = [];
    for (let index = 0; mixed.length < 48 && (index < matchingSeries.length || index < memberVolumes.length); index += 1) {
      for (const item of [matchingSeries[index], memberVolumes[index]]) {
        if (item && !seen.has(String(item.id)) && mixed.length < 48) {
          seen.add(String(item.id)); mixed.push(item);
        }
      }
    }
    volumes = mixed;
    if (matchingSeries.length && memberVolumes.length) source = 'team-series-and-line-up';
    else if (matchingSeries.length) source = 'team-series';
    else if (memberVolumes.length) source = 'line-up';
  }
  res.json({
    items: volumes.map((item) => catalogueShape(item, new Set(library.map((x) => x.id)))),
    source,
    observed: volumes.length,
  });
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
  // Manga had no house to browse from at all, which left Junji Ito and Naoki
  // Urasawa reachable only as creators.
  'VIZ Media': ['Shonen Jump', 'VIZ Signature', 'Shojo Beat'],
  Kodansha: ['Kodansha Comics', 'Vertical'],
};

// Volumes are what you request; threads are what you follow. Browse needs to
// reach the latter, so this searches characters, teams, creators and arcs.
const SEARCH_RESOURCES = { character: 'character', team: 'team', person: 'person', story_arc: 'story_arc' };
// The reader-facing name for each thread kind. "Thread" is Panel's own word
// for the tier and stays in the code; the interface says what the thing is.
const THREAD_LABELS = { character: 'Characters', person: 'Creators', team: 'Teams', story_arc: 'Events' };

app.get('/api/threads', async (req, res, next) => {
  const q = String(req.query.q || '').trim();
  const publisher = String(req.query.publisher || '').trim();
  if (q.length < 2) return res.json({ groups: [], total: 0 });
  try {
    const local = findObjects(q, Object.values(SEARCH_RESOURCES));
    const shouldExpand = local.length < 20 && !comicVineStatus().limited;
    let remote = [];
    if (shouldExpand) {
      try {
        remote = await cached(`threads:${normalise(q)}:${normalise(publisher)}`, 24 * 60 * 60_000, () =>
          comicVine('search', {
            query: q,
            resources: Object.values(SEARCH_RESOURCES).join(','),
            limit: '40',
            field_list: 'id,name,deck,image,publisher,count_of_issue_appearances,resource_type',
          }));
      } catch (error) {
        // A provider outage should not erase a search result the local mirror
        // already knows. With no local answer at all, preserve the error so the
        // UI does not misleadingly claim the query matched nothing.
        if (!local.length) throw error;
      }
    }
    rememberObjects('search', remote);
    const unique = new Map();
    for (const row of [...local, ...remote]) unique.set(`${row.resource_type}:${row.id}`, row);
    const rows = [...unique.values()];
    const items = (rows ?? [])
      .filter((x) => SEARCH_RESOURCES[x.resource_type] && x.name)
      .map((x) => ({
        id: String(x.id),
        kind: x.resource_type,
        name: x.name,
        deck: plainText(x.deck || '').slice(0, 160) || null,
        publisher: x.publisher?.name ?? null,
        medium: mediumOf(x.publisher?.name),
        appearances: Number(x.count_of_issue_appearances) || 0,
        image: x.image?.medium_url ?? null,
      }))
      .filter((x) => !publisher || String(x.publisher || '').startsWith(publisher))
      .sort((a, b) => b.appearances - a.appearances);
    // Bucket by kind before trimming. Creators and story arcs carry no issue
    // appearance count, so a single global sort by prominence buries them
    // entirely -- searching "junji ito" returned characters named Ito and not
    // the man himself.
    const quota = { character: 10, person: 6, team: 5, story_arc: 5 };
    const groups = Object.keys(quota)
      .map((kind) => ({ kind, label: THREAD_LABELS[kind], items: items.filter((x) => x.kind === kind).slice(0, quota[kind]) }))
      .filter((g) => g.items.length);
    res.json({ groups, total: groups.reduce((n, g) => n + g.items.length, 0) });
  } catch (error) { next(error); }
});

// The local catalogue only knows the people and teams a reader has already
// stumbled across, which on a fresh install is close to nobody. These are the
// names worth offering on a browse page. Not a crawl: one search per name, one
// result kept from each, cached for a week -- the same shape as the publisher
// character strips that have always worked this way.
const CHARACTER_SEEDS = [
  'batman', 'superman', 'spider-man', 'wonder woman', 'wolverine', 'hulk',
  'iron man', 'captain america', 'thor', 'barry allen', 'hal jordan',
  'daredevil', 'deadpool', 'black panther', 'joker', 'harley quinn', 'venom',
  'doctor strange', 'aquaman', 'nightwing',
];
// Household names first. The local catalogue knows whoever happened to be
// credited on a stored volume, which is mostly inkers and cover artists.
const CREATOR_SEEDS = [
  'stan lee', 'jack kirby', 'steve ditko', 'chris claremont', 'john byrne',
  'frank miller', 'alan moore', 'neil gaiman', 'grant morrison', 'todd mcfarlane',
  'jim lee', 'brian michael bendis', 'ed brubaker', 'geoff johns', 'mark waid',
  'robert kirkman', 'warren ellis', 'garth ennis', 'jonathan hickman',
  'brian k. vaughan', 'scott snyder', 'tom king', 'jeff lemire',
  'kelly sue deconnick', 'gail simone', 'fiona staples',
  'junji ito', 'naoki urasawa', 'osamu tezuka', 'kentaro miura',
  'rumiko takahashi', 'akira toriyama',
];
const TEAM_BROWSE_SEEDS = [
  'x-men', 'justice league of america', 'avengers', 'teen titans',
  'fantastic four', 'suicide squad', 'guardians of the galaxy', 'birds of prey',
  'defenders', 'doom patrol', 'thunderbolts', 'green lantern corps',
  'inhumans', 'justice society of america', 'runaways', 'legion of super-heroes',
  'x-force', 'young avengers', 'new mutants', 'sinister six',
];
// Interleaved by house rather than Marvel-then-DC, so the section does not read
// as one publisher's shelf.
const EVENT_SEEDS = [
  'secret wars', 'crisis on infinite earths', 'civil war', 'blackest night',
  'house of m', 'flashpoint', 'infinity gauntlet', 'death of superman',
  'dark phoenix saga', 'knightfall', 'days of future past', 'final crisis',
  'annihilation', 'sinestro corps war', 'age of ultron', 'identity crisis',
];
const THREAD_SEEDS = {
  character: CHARACTER_SEEDS, person: CREATOR_SEEDS,
  team: TEAM_BROWSE_SEEDS, story_arc: EVENT_SEEDS,
};

// One search returns thirty near-misses; only the one the seed actually names
// is worth keeping. Searching "alan moore" otherwise files four other Moores
// beside him, which is exactly the noise this page had. Among inexact matches,
// the most-published wins -- otherwise "justice league" returned the 3000 spinoff.
function bestSeedMatch(rows, seed) {
  const wanted = normalise(seed);
  const usable = (rows ?? []).filter((row) => row?.name && row.image?.medium_url);
  const byFame = (a, b) => ((Number(b.count_of_issue_appearances) || 0)
    - (Number(a.count_of_issue_appearances) || 0))
    || (row(a) - row(b));
  const row = (x) => String(x.name).length;
  // Even the exact-name bucket needs ranking: ComicVine holds several records
  // literally called "Superman", and the first one returned was a 38-appearance
  // bit part with the wrong portrait.
  return usable.filter((row) => normalise(row.name) === wanted).sort(byFame)[0]
    ?? usable.filter((row) => normalise(row.name).startsWith(wanted)).sort(byFame)[0]
    ?? usable.filter((row) => normalise(row.name).includes(wanted)).sort(byFame)[0]
    ?? null;
}

// ComicVine's unified /search endpoint returns nothing at all for story_arc --
// it simply does not index them. The dedicated /story_arcs list does, via a
// name filter, and reports arcs as '"Green Lantern" Blackest Night': the parent
// title quoted in front. Strip that for display; the publisher line already
// says where it ran.
const ARC_PREFIX = /^"[^"]+"\s*/;

// A curated rail is two costs wearing one name: working out which ComicVine
// record a seed means, and drawing it. The first is a search per seed and
// never changes -- an id does not move -- so it is resolved once and written
// to the cache; the second is a read of the mirror those searches already
// filled. Browse therefore paints from SQLite, and only a genuinely unseen
// seed costs a provider call.
const SEED_ID_TTL = 180 * 24 * 60 * 60_000;
const SEED_REFRESH_MS = 7 * 24 * 60 * 60_000;
const SEED_FIELDS = 'id,name,deck,image,publisher,count_of_issue_appearances';
// The plural list endpoints. They accept filter=id:a|b|c -- verified against
// the live API -- so a whole rail refreshes in one request instead of twenty.
const SEED_LIST_RESOURCES = {
  character: 'characters', person: 'people', team: 'teams', story_arc: 'story_arcs',
};
const seedKey = (kind, seed) => `seed:${kind}:${normalise(seed)}`;

async function seedStoryArc(seed) {
  const rows = await comicVine('story_arcs', {
    filter: `name:${seed}`, limit: '10',
    field_list: `${SEED_FIELDS},resource_type`,
  });
  const wanted = normalise(seed);
  const usable = (rows ?? [])
    .filter((row) => row?.name && row.image?.medium_url)
    .map((row) => ({ ...row, name: String(row.name).replace(ARC_PREFIX, '').trim() }))
    .filter((row) => normalise(row.name).includes(wanted));
  return usable.find((row) => normalise(row.name) === wanted) ?? usable[0] ?? null;
}

function seedCard(kind, row) {
  if (!row?.name || !row.image?.medium_url) return null;
  return {
    id: String(row.id), kind,
    // Arc names carry their parent title quoted in front, on both paths.
    name: String(row.name).replace(ARC_PREFIX, '').trim(),
    publisher: row.publisher?.name ?? row.publisher ?? null,
    appearances: Number(row.count_of_issue_appearances) || 0,
    image: row.image.medium_url,
  };
}

// What the curated list holds right now, and which seeds are still unknown.
// Synchronous on purpose: no rail may wait on ComicVine's paced lane.
function seededThreads(kind) {
  const seen = new Set();
  const items = [];
  const missing = [];
  const thin = [];
  for (const seed of THREAD_SEEDS[kind] ?? []) {
    const hit = cacheRead(seedKey(kind, seed));
    const id = hit && Date.now() - hit.at < SEED_ID_TTL ? hit.value : null;
    const card = id ? seedCard(kind, getObject(kind, id)) : null;
    if (!card) {
      // A known id whose record cannot draw a card is a different problem from
      // an unknown name: the answer is one batched hydrate, not a fresh search.
      if (id) thin.push(id); else missing.push(seed);
      continue;
    }
    const key = normalise(card.name);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(card);
  }
  return { items, missing, thin };
}

// Whatever the catalogue happens to know, so a rail that is still filling
// shows books' worth of real names rather than one lonely cached card.
function localThreads(kind, exclude = []) {
  const taken = new Set(exclude.map((item) => String(item.id)));
  // ComicVine files several records under one name -- two Battleworlds, three
  // Identity Crises -- and a rail that shows a name twice looks broken rather
  // than thorough. Names are the reader's handle on these, so they are the key.
  const names = new Set(exclude.map((item) => normalise(item.name)));
  const cards = [];
  for (const item of listObjects(kind, { limit: 24 })) {
    const card = seedCard(kind, item);
    if (!card || taken.has(card.id) || names.has(normalise(card.name))) continue;
    names.add(normalise(card.name));
    cards.push(card);
    if (cards.length === 12) break;
  }
  return cards;
}

async function resolveSeed(kind, seed) {
  if (kind === 'story_arc') return seedStoryArc(seed);
  const rows = await comicVine('search', {
    query: seed, resources: kind, limit: '10', field_list: SEED_FIELDS,
  });
  return bestSeedMatch(rows, seed);
}

const seedSweeps = new Map();
const seedRetryAt = new Map();
// A seed ComicVine simply does not have under that name -- it files the Flash
// as "Flash", never "the flash" -- must not cost a search on every Browse
// visit forever. This records that we asked, not that the answer was nothing:
// the seed is retried tomorrow, and a cooldown never gets this far.
const SEED_ATTEMPT_TTL = 24 * 60 * 60_000;
// Curated seeds are all household names; nothing this published is ambiguous.
const SEED_MIRROR_FLOOR = 1000;
const seedAttemptKey = (kind, seed) => `seed:asked:${kind}:${normalise(seed)}`;

// One sweep per kind at a time, one request at a time inside it. Sequential is
// the point: a reader's own click shares this paced lane, and queueing seventy
// seed searches at once is exactly what left Browse on skeletons for a minute.
function sweepSeeds(kind) {
  if (seedSweeps.has(kind)) return seedSweeps.get(kind);
  if (Date.now() < (seedRetryAt.get(kind) ?? 0)) return null;
  const task = runSeedSweep(kind)
    .catch((error) => {
      // Never silently. A rail that cannot fill used to be indistinguishable
      // from a catalogue that knows nobody, with nothing in the log either way.
      seedRetryAt.set(kind, Date.now() + 60_000);
      console.warn(`Seed sweep for ${kind} stopped: ${error.message}`);
    })
    .finally(() => seedSweeps.delete(kind));
  seedSweeps.set(kind, task);
  return task;
}

async function runSeedSweep(kind) {
  const { missing, thin } = seededThreads(kind);
  for (const seed of missing) {
    // The mirror usually already holds the famous names, and an exact name of
    // the right kind is an identity, not a guessed relationship, so taking it
    // from SQLite keeps a warm install off ComicVine entirely. It is only
    // trusted for a record notable enough that it cannot be a homonym bit
    // part: ComicVine has six characters called "Flash", and the mirror held
    // only the 74-appearance one. Teams report no appearance count at all, so
    // they always go to the search, which ranks the whole result set.
    const known = findObjectsByName(kind, seed)
      .find((row) => Number(row.count_of_issue_appearances) >= SEED_MIRROR_FLOOR && seedCard(kind, row));
    if (known) { cacheWrite(seedKey(kind, seed), String(known.id)); continue; }
    // A cooldown ends the pass rather than spending the rest of the list on
    // certain failures. Each seed already resolved is on disk, so the next
    // visit resumes where this one stopped instead of starting over.
    if (comicVineStatus().limited) return;
    const asked = cacheRead(seedAttemptKey(kind, seed));
    if (asked && Date.now() - asked.at < SEED_ATTEMPT_TTL) continue;
    const row = await resolveSeed(kind, seed);
    // No negative caching, ever: an unmatched seed is retried on a later
    // visit, and a rate-limited pass must not be remembered as "nobody here".
    if (row?.id) cacheWrite(seedKey(kind, seed), String(row.id));
    else cacheWrite(seedAttemptKey(kind, seed), true);
  }
  await refreshSeeds(kind, thin.length > 0);
}

// Portraits and appearance counts do go stale, but not one name at a time.
async function refreshSeeds(kind, force = false) {
  const resource = SEED_LIST_RESOURCES[kind];
  const swept = cacheRead(`seeds:swept:${kind}`);
  if (!resource || (!force && swept && Date.now() - swept.at < SEED_REFRESH_MS)) return;
  const ids = (THREAD_SEEDS[kind] ?? [])
    .map((seed) => cacheRead(seedKey(kind, seed))?.value)
    .filter(Boolean);
  if (!ids.length || comicVineStatus().limited) return;
  // comicVineFetch mirrors every row it sees, so the refreshed records land in
  // the catalogue and the next seededThreads read picks them up.
  await comicVine(resource, {
    filter: `id:${ids.join('|')}`, limit: String(ids.length), field_list: SEED_FIELDS,
  });
  cacheWrite(`seeds:swept:${kind}`, ids.length);
}

// Fetched separately from the local list so the page paints immediately and
// only the well-known names arrive late. `pending` says the rail is still
// filling, so the browser can come back for the rest instead of leaving a cold
// install looking like an empty catalogue.
app.get('/api/threads/seeded/:kind', (req, res) => {
  const kind = String(req.params.kind);
  if (!THREAD_SEEDS[kind]) return res.json({ kind, items: [] });
  const { items, missing } = seededThreads(kind);
  // The local tail is a stopgap for a rail still filling; once the curated
  // names are all there they stand on their own.
  const tail = missing.length ? localThreads(kind, items) : [];
  sweepSeeds(kind);
  res.json({
    kind, label: THREAD_LABELS[kind], items: [...items, ...tail],
    pending: missing.length, source: items.length ? 'curated' : 'local-cache',
  });
});

// Threads are the tier the whole model is built on, so they get a destination
// rather than only appearing as a by-product of searching. This lists what the
// local catalogue already holds; it never invents a thread from a keyword.
app.get('/api/threads/browse', (req, res, next) => {
  const publisher = String(req.query.publisher || '').trim();
  try {
    const groups = Object.entries(THREAD_LABELS)
      .map(([kind, label]) => ({
        kind,
        label,
        items: listObjects(kind, { publisher, limit: 60 })
          // A thread with no portrait renders as a bare tint tile, and in
          // practice those are search residue rather than people worth
          // browsing. Creators additionally need a real credit behind them.
          .filter((x) => x && x.name && x.image?.medium_url)
          .filter((x) => kind !== 'person' || x.credits > 0)
          .slice(0, 24)
          .map((x) => ({
            id: String(x.id),
            kind,
            name: kind === 'story_arc' ? String(x.name).replace(ARC_PREFIX, '').trim() : x.name,
            publisher: x.publisher?.name ?? null,
            appearances: Number(x.count_of_issue_appearances) || 0,
            image: x.image?.medium_url ?? null,
          })),
      }))
      .filter((group) => group.items.length);
    res.json({ groups });
  } catch (error) { next(error); }
});

// Eras, straight from the local mirror. Cheap, offline, and unaffected by a
// ComicVine cooldown.
const DECADE_NAMES = {
  1930: 'The Golden Age begins', 1940: 'Golden Age', 1950: 'Atom Age',
  1960: 'Silver Age', 1970: 'Bronze Age', 1980: 'The Dark Age',
  1990: 'Boom and bust', 2000: 'Modern Age', 2010: 'The shared-universe era',
  2020: 'Now',
};

app.get('/api/decades', (_req, res, next) => {
  try {
    res.json({
      items: decades(8).map((row) => ({ ...row, label: DECADE_NAMES[row.decade] ?? null })),
    });
  } catch (error) { next(error); }
});

app.get('/api/decade/:decade/volumes', async (req, res, next) => {
  const decade = Number(req.params.decade);
  if (!Number.isFinite(decade)) return res.status(400).json({ error: 'A decade like 1980 is required.' });
  const size = Math.max(6, Math.min(96, Number(req.query.size) || 48));
  const page = Math.max(1, Number(req.query.page) || 1);
  try {
    const library = await watchlist().catch(() => []);
    const owned = new Set(library.map((x) => x.id));
    const { items, total } = decadeVolumes(decade, { limit: size, offset: (page - 1) * size });
    res.json({
      decade, label: DECADE_NAMES[decade] ?? null, total,
      pages: Math.max(1, Math.ceil(total / size)), page,
      items: items.map((item) => catalogueShape(item, owned)),
    });
  } catch (error) { next(error); }
});

// Browsing a publisher should show that publisher's characters. ComicVine's
// publisher filter is ignored (asking for Marvel returns DC), and searching the
// publisher's name just matches characters with it in their title -- which is
// how DC heroes ended up filed under Marvel. So: seed with the names a reader
// would recognise, then keep only the ones the API confirms belong to the house,
// ranked by how much they actually appear.
const PUBLISHER_SEEDS = {
  Marvel: ['spider-man', 'x-men', 'avengers', 'iron man', 'captain america', 'hulk',
           'thor', 'wolverine', 'fantastic four', 'daredevil', 'deadpool', 'black panther'],
  'DC Comics': ['batman', 'superman', 'wonder woman', 'flash', 'green lantern', 'aquaman',
                'joker', 'harley quinn', 'justice league', 'nightwing', 'swamp thing'],
  'Image Comics': ['spawn', 'invincible', 'saga', 'the walking dead', 'witchblade', 'monstress'],
  'Dark Horse Comics': ['hellboy', 'sin city', 'umbrella academy', 'the mask', 'concrete'],
  'Boom! Studios': ['lumberjanes', 'something is killing the children', 'once and future'],
};

// Characters and teams share a shape: seed with recognisable names, then keep
// only what the API confirms belongs to the house.
async function publisherThreads(name, resource, seeds) {
  const local = listObjects(resource, { publisher: name, limit: 24 });
  let remote = [];
  try {
    remote = await cached(`publisher:${normalise(name)}:${resource}`, 7 * 24 * 60 * 60_000, async () =>
      gatherOrFail(seeds.map((seed) => comicVine('search', {
        query: seed, resources: resource, limit: '30',
        field_list: 'id,name,deck,image,publisher,count_of_issue_appearances',
      })), `${name} ${resource}s`));
  } catch (error) {
    // A publisher page is still useful with the people/groups Panel already
    // knows. Only surface the provider failure when the local mirror has no
    // honest answer at all.
    if (!local.length) throw error;
  }
  const seen = new Set();
  return [...local, ...remote]
      .filter((x) => x && x.name && x.image?.medium_url)
      .filter((x) => String(x.publisher?.name || '').startsWith(name.split(' ')[0]))
      .filter((x) => {
        const key = normalise(x.name);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => (Number(b.count_of_issue_appearances) || 0) - (Number(a.count_of_issue_appearances) || 0))
      .slice(0, 24)
      .map((x) => ({
        id: String(x.id), kind: resource, name: x.name,
        publisher: x.publisher?.name ?? null,
        appearances: Number(x.count_of_issue_appearances) || 0,
        image: x.image?.medium_url ?? null,
      }));
}

const TEAM_SEEDS = {
  Marvel: ['avengers', 'x-men', 'fantastic four', 'guardians of the galaxy', 'defenders', 'inhumans'],
  'DC Comics': ['justice league', 'teen titans', 'suicide squad', 'green lantern corps', 'legion of super-heroes'],
  'Image Comics': ['savage dragon', 'youngblood', 'cyberforce'],
  'Dark Horse Comics': ['b.p.r.d.', 'the umbrella academy'],
  'Boom! Studios': ['lumberjanes'],
};

app.get('/api/publisher/:name/teams', async (req, res, next) => {
  const name = String(req.params.name);
  const seeds = TEAM_SEEDS[name];
  if (!seeds) return res.json({ publisher: name, items: [] });
  try { res.json({ publisher: name, items: await publisherThreads(name, 'team', seeds) }); }
  catch (error) { next(error); }
});

app.get('/api/publisher/:name/characters', async (req, res, next) => {
  const name = String(req.params.name);
  const seeds = PUBLISHER_SEEDS[name];
  if (!seeds) return res.status(404).json({ error: `No seed list for "${name}".` });
  const local = listObjects('character', { publisher: name, limit: 24 });
  try {
    const remote = await cached(`publisher:${normalise(name)}:characters`, 7 * 24 * 60 * 60_000, async () => {
      const pages = await Promise.all(seeds.map((seed) =>
        comicVine('search', {
          query: seed, resources: 'character', limit: '30',
          field_list: 'id,name,deck,image,publisher,count_of_issue_appearances',
        }).catch(() => [])));
      const seen = new Set();
      return pages.flat()
        .filter((x) => x && x.name && x.image?.medium_url)
        // The house is confirmed from the record, never assumed from the query.
        .filter((x) => String(x.publisher?.name || '').startsWith(name.split(' ')[0]))
        .filter((x) => {
          const key = normalise(x.name);
          if (!key || seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .sort((a, b) => (Number(b.count_of_issue_appearances) || 0) - (Number(a.count_of_issue_appearances) || 0))
        .slice(0, 24)
        .map((x) => ({
          id: String(x.id), kind: 'character', name: x.name,
          publisher: x.publisher?.name ?? null,
          appearances: Number(x.count_of_issue_appearances) || 0,
          image: x.image?.medium_url ?? null,
        }));
    });
    const seen = new Set();
    const items = [...local, ...remote].filter((item) => {
      const key = normalise(item?.name);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 24).map((item) => ({
      id: String(item.id), kind: 'character', name: item.name,
      publisher: item.publisher?.name ?? item.publisher ?? null,
      appearances: Number(item.count_of_issue_appearances) || Number(item.appearances) || 0,
      image: item.image?.medium_url ?? item.image ?? null,
    }));
    res.json({ publisher: name, items });
  } catch (error) {
    if (!local.length) return next(error);
    res.json({
      publisher: name,
      items: local.map((item) => ({
        id: String(item.id), kind: 'character', name: item.name,
        publisher: item.publisher?.name ?? item.publisher ?? null,
        appearances: Number(item.count_of_issue_appearances) || 0,
        image: item.image?.medium_url ?? null,
      })),
      source: 'local-cache',
    });
  }
});

// Publishers with their lines, logos and character counts. ComicVine's
// publisher search matches loosely -- "Marvel" also returns Marvel Italia and
// Marvel UK/Panini UK -- so the exact name wins, falling back to the first hit.
// Hand-picked so a house is represented by its landmark runs rather than by
// whatever the catalogue happened to cache. Marvel was showing two Spider-Man
// books and a Fantastic Four; DC was Superman three times over.
const PUBLISHER_ART_SEEDS = {
  Marvel: ['amazing spider-man omnibus', 'uncanny x-men omnibus', 'daredevil by frank miller omnibus',
           'infinity gauntlet', 'thor by walter simonson', 'black panther by christopher priest',
           'immortal hulk', 'captain america by ed brubaker omnibus'],
  'DC Comics': ['batman year one', 'watchmen', 'sandman omnibus', 'all-star superman',
                'the flash by mark waid', 'wonder woman by george perez omnibus',
                'swamp thing by alan moore', 'batman the long halloween'],
  'Image Comics': ['saga', 'the walking dead compendium', 'invincible compendium',
                   'monstress', 'east of west', 'paper girls', 'the department of truth', 'deadly class'],
  'Dark Horse Comics': ['hellboy omnibus', 'sin city', 'berserk deluxe', 'the umbrella academy',
                        'lone wolf and cub', 'black hammer library edition', 'usagi yojimbo', 'the goon'],
  'Boom! Studios': ['something is killing the children', 'lumberjanes', 'once and future',
                    'bone', 'mouse guard', 'giant days', 'grass kings', 'the woods'],
  'VIZ Media': ['naruto', 'one piece', 'death note', 'bleach', 'dragon ball',
                'jujutsu kaisen', 'uzumaki', 'monster'],
  Kodansha: ['akira', 'attack on titan', 'sailor moon', 'ghost in the shell',
             'vinland saga', 'fairy tail', 'parasyte', 'blame!'],
};

// Resolved to volume ids once a month; the client renders them through the
// local cover proxy, so the tiles cost no ComicVine call on a normal page load.
async function publisherShowcase(name) {
  const seeds = PUBLISHER_ART_SEEDS[name];
  if (!seeds) return [];
  return cached(`publisher:${normalise(name)}:art:v2`, 30 * 24 * 60 * 60_000, async () => {
    const found = await Promise.all(seeds.map(async (seed) => {
      const rows = await comicVine('search', {
        query: seed, resources: 'volume', limit: '10', field_list: VOLUME_FIELDS,
      }).catch(() => []);
      const usable = (rows ?? []).filter((row) => row?.id && row.image?.medium_url);
      const wanted = normalise(seed);
      return usable.find((row) => normalise(row.name) === wanted)
        ?? usable.find((row) => normalise(row.name).includes(wanted))
        ?? usable[0] ?? null;
    }));
    const seen = new Set();
    const ids = found.filter(Boolean).filter((row) => {
      if (seen.has(String(row.id))) return false;
      seen.add(String(row.id));
      return true;
    }).map((row) => String(row.id));
    // A rate-limited pass resolves to an empty list, and caching that leaves the
    // tile blank for a month. Fail instead so the next open retries.
    if (!ids.length) throw new Error(`No showcase art resolved for ${name}.`);
    return ids;
  });
}

// Wordmarks pulled once from Wikimedia Commons (Wikidata P154) and committed
// to public/logos, because ComicVine only carries each house's square badge and
// hotlinking it left blank plates whenever the fetch failed. Local, versionless,
// and no network call at page time.
// `invert` is for the marks that are solid black artwork and would otherwise be
// invisible on this ground. The rest carry their own brand colour and are left
// alone — inverting DC's blue roundel turns it orange.
const PUBLISHER_WORDMARKS = {
  Marvel: { file: 'marvel' },
  'DC Comics': { file: 'dc-comics' },
  'VIZ Media': { file: 'viz-media' },
  'Image Comics': { file: 'image-comics', invert: true },
  'Dark Horse Comics': { file: 'dark-horse-comics', invert: true },
  Kodansha: { file: 'kodansha', invert: true },
};

async function loadPublishers() {
  return cached('publishers:v2', 30 * 24 * 60 * 60_000, async () => {
    const names = Object.keys(LINES);
    // ComicVine's own spelling does not always match ours.
    const CV_NAME = { 'Image Comics': 'Image', 'VIZ Media': 'Viz', Kodansha: 'Kodansha Comics' };
    const found = await Promise.all(names.map((name) =>
      comicVine('publishers', {
        filter: `name:${CV_NAME[name] ?? name}`, limit: '10', field_list: 'id,name,image,deck',
      }).catch(() => [])));
    return names.map((name, index) => {
      const rows = found[index] ?? [];
      const wanted = CV_NAME[name] ?? name;
      // "Marvel" also matches Marvel Italia and Marvel UK, so prefer the exact name.
      const exact = rows.find((r) => r.name === wanted) ?? rows[0] ?? null;
      return {
        name,
        comicvineId: exact?.id ?? null,
        lines: LINES[name],
        logo: exact?.image?.super_url ?? exact?.image?.medium_url ?? null,
        // A house with no wordmark simply sets its name in the display face.
        wordmark: PUBLISHER_WORDMARKS[name] ? `/logos/${PUBLISHER_WORDMARKS[name].file}.svg` : null,
        wordmarkInvert: Boolean(PUBLISHER_WORDMARKS[name]?.invert),
        deck: plainText(exact?.deck || '').slice(0, 140) || null,
        browsable: Boolean(PUBLISHER_SEEDS[name]),
      };
    });
  });
}

app.get('/api/publishers', async (_req, res, next) => {
  try {
    const saved = cacheRead('publishers:v2')?.value;
    // The Browse landing page needs names, lines and locally-held cover ids —
    // none require a provider call. A cold installation gets honest shells
    // immediately; publisher detail can resolve its ComicVine id only after a
    // reader actually chooses that house.
    const houses = saved?.length ? saved : Object.keys(LINES).map((name) => ({
      name, comicvineId: null, lines: LINES[name], logo: null,
      wordmark: PUBLISHER_WORDMARKS[name] ? `/logos/${PUBLISHER_WORDMARKS[name].file}.svg` : null,
      wordmarkInvert: Boolean(PUBLISHER_WORDMARKS[name]?.invert), deck: null,
      browsable: Boolean(PUBLISHER_SEEDS[name]),
    }));
    const items = houses.map((house) => ({
      ...house,
      // Never make a landing-page render wait for showcase searches. Local
      // covers are instant; an initials tile is a deliberate graceful fallback.
      art: publisherArt(house.name, 8),
    }));
    res.json({ items, source: saved?.length ? 'cache' : 'local-shell' });
  } catch (error) { next(error); }
});

// A publisher's whole catalogue.
//
// ComicVine cannot filter volumes by publisher -- filter=publisher:31 returns
// the same 160,366 rows as no filter at all -- but the publisher DETAIL
// resource carries its full volume list: 14,156 entries for Marvel, as bare
// {id, name} in a 3 MB payload. So membership comes from there, and a page of
// it is hydrated with one id-filtered call (40 volumes in under a second).
const DEFAULT_PAGE_SIZE = 48;
const DISCOVER_RAIL_CAP = 72;

async function publisherVolumeIds(comicvineId) {
  return cached(`publisher:${comicvineId}:volumeids`, 30 * 24 * 60 * 60_000, async () => {
    const data = await comicVine(`publisher/4010-${comicvineId}`, { field_list: 'id,name,volumes' });
    // Ids ascend with age, so newest-first is simply the reverse.
    return (data.volumes ?? []).map((v) => String(v.id)).reverse();
  });
}

app.get('/api/publisher/:name/volumes', async (req, res, next) => {
  const name = String(req.params.name);
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(12, Number(req.query.size) || DEFAULT_PAGE_SIZE));
  const local = findVolumes(name, 500)
    .filter((item) => String(item.publisher?.name || item.publisher || '').startsWith(name.split(' ')[0]));
  try {
    const house = (await loadPublishers()).find((p) => p.name === name);
    if (!house?.comicvineId) return res.status(404).json({ error: `Unknown publisher "${name}".` });
    const ids = await publisherVolumeIds(house.comicvineId);
    const slice = ids.slice((page - 1) * pageSize, page * pageSize);
    const [rows, library] = await Promise.all([
      slice.length
        ? cached(`volumes:batch:${slice[0]}:${slice.length}`, 7 * 24 * 60 * 60_000, () =>
            comicVine('volumes', { filter: `id:${slice.join('|')}`, limit: String(pageSize), field_list: VOLUME_FIELDS }))
        : [],
      watchlist(),
    ]);
    const watchedIds = new Set(library.map((x) => x.id));
    // The batch comes back in ComicVine's order, not ours; restore the page order.
    const byId = new Map((rows ?? []).map((r) => [String(r.id), r]));
    const items = slice.map((id) => byId.get(id)).filter(Boolean).map((r) => catalogueShape(r, watchedIds));
    res.json({
      publisher: name,
      page,
      pageSize,
      total: ids.length,
      pages: Math.ceil(ids.length / pageSize),
      items,
    });
  } catch (error) {
    // Publisher membership needs a ComicVine detail document. During a
    // cooldown, a smaller truthful local shelf is better than an empty page;
    // it is explicitly marked so the client never mistakes it for the full
    // publisher catalogue.
    if (!local.length) return next(error);
    const library = await watchlist().catch(() => []);
    const watchedIds = new Set(library.map((x) => x.id));
    const total = local.length;
    res.json({
      publisher: name, page, pageSize, total, pages: Math.max(1, Math.ceil(total / pageSize)),
      items: local.slice((page - 1) * pageSize, page * pageSize)
        .map((item) => catalogueShape(item, watchedIds)),
      source: 'local-cache',
    });
  }
});

// Formats with a representative cover, so browse shows real books rather than
// only drawn shapes. One cached search per format.
const FORMAT_BLURBS = {
  Omnibus: 'A brick. One oversized hardcover swallowing a whole run, often 700+ pages.',
  Compendium: 'Phone-book thick and cheap. Huge page count, softcover, small print.',
  'Library edition': 'Oversized hardcover, complete runs, made to sit on a shelf for years.',
  Absolute: 'DC at its most lavish: slipcased, oversized, remastered art.',
  'Epic Collection': 'Marvel in order, in paperback. The cheapest way to read a long run.',
  Masterworks: 'Marvel’s archival hardcovers. Early issues, restored colour.',
  'Deluxe edition': 'Hardcover, bigger trim, sketches and scripts in the back.',
  Hardcover: 'A bound collection at normal size. A few issues, not a run.',
  'Collected edition': 'The everyday trade paperback: one story arc, one book.',
};
const FORMAT_SPINES = {
  Omnibus: 46, Compendium: 42, 'Library edition': 32, Absolute: 34, 'Epic Collection': 22,
  Masterworks: 20, 'Deluxe edition': 18, Hardcover: 14, 'Collected edition': 9,
};

app.get('/api/formats', async (_req, res, next) => {
  try {
    const items = await cached('formats:v2', 30 * 24 * 60 * 60_000, async () => {
      const names = Object.keys(FORMAT_BLURBS);
      const covers = await Promise.all(names.map(async (name) => {
        const terms = FORMAT_QUERIES[name] ?? [name.toLowerCase()];
        const rows = await comicVine('search', {
          query: terms[0], resources: 'volume', limit: '30', field_list: VOLUME_FIELDS,
        }).catch(() => []);
        // Prefer a well-known house with real art, so the shelf looks like a shelf.
        const best = (rows ?? [])
          .filter((r) => r.image?.super_url && EDITIONS.find(([e]) => e === name)?.[1].test(String(r.name).toLowerCase()))
          .sort((a, b) => (weightOf(b.publisher?.name) - weightOf(a.publisher?.name))
            || ((Number(b.count_of_issues) || 0) - (Number(a.count_of_issues) || 0)));
        return best.slice(0, 3).map((r) => String(r.id));
      }));
      return names.map((name, i) => ({
        name, blurb: FORMAT_BLURBS[name], spine: FORMAT_SPINES[name],
        art: covers[i] ?? [], cover: null,
      }));
    });
    res.json({ items });
  } catch (error) { next(error); }
});

app.get('/api/lines', (_req, res) => res.json({ lines: LINES }));

// ComicVine caps a page at 100 and does not provide a useful server-side sort.
// One broad result page is enough for a title search once we rank it locally;
// asking for several pages (and several format synonyms) was the main source of
// avoidable quota use and made a simple search feel arbitrarily slow.
//
// A format filter is a *single* more-specific query. It is not a post-filter on
// the generic search, because ComicVine often buries collected editions there.
const FORMAT_QUERIES = {
  Omnibus: ['omnibus'],
  Compendium: ['compendium'],
  Absolute: ['absolute edition'],
  'Epic Collection': ['epic collection'],
  Masterworks: ['masterworks'],
  'Deluxe edition': ['deluxe edition', 'oversized'],
  'Library edition': ['library edition', 'complete collection'],
  Hardcover: ['hardcover'],
  'Collected edition': ['tpb', 'trade paperback', 'graphic novel', 'collection'],
  Annual: ['annual'],
  'One-shot': ['one-shot', 'special', 'giant-size'],
};

// Swallowing per-request failures and returning [] means a rate-limited fetch
// is indistinguishable from "no results" -- and then gets cached as emptiness
// for a day. Anything that fans out must fail when EVERYTHING failed.
async function gatherOrFail(tasks, what) {
  const settled = await Promise.allSettled(tasks);
  const ok = settled.filter((r) => r.status === 'fulfilled');
  // Failing only when EVERYTHING failed is not enough: if most requests are
  // rate-limited, the survivors produce a thin result that then gets cached for
  // days as though it were the real answer. Half is the line.
  if (ok.length * 2 <= settled.length) {
    throw new Error(settled.find((r) => r.status === 'rejected')?.reason?.message
      || `Could not reach ComicVine for ${what}.`);
  }
  return ok.flatMap((r) => r.value ?? []);
}

async function searchVolumes(q, edition = '') {
  const term = FORMAT_QUERIES[edition]?.[0];
  const query = term ? `${q} ${term}` : q;
  return comicVine('search', { query, resources: 'volume', limit: '100', page: '1' });
}

app.get('/api/search', async (req, res, next) => {
  const q = String(req.query.q || '').trim();
  const edition = EDITIONS.some(([name]) => name === req.query.edition) ? String(req.query.edition) : '';
  const medium = ['comic', 'manga'].includes(req.query.medium) ? String(req.query.medium) : '';
  // Imprint chips search terms like "Marvel Earth-616", which ComicVine happily
  // answers with DC characters. Scoping by publisher makes that impossible.
  const publisher = String(req.query.publisher || '').trim();
  const size = Math.min(120, Math.max(12, Number(req.query.size) || 48));
  if (q.length < 2) return res.json({ items: [], editions: EDITIONS.map(([name]) => name) });
  try {
    const local = findVolumes(q);
    // A local candidate set is ranked below exactly like a fresh provider
    // result. Only ask ComicVine when this mirror has not seen enough related
    // titles yet; cached provider results still count as local once read.
    const shouldExpand = local.length < 40 && !comicVineStatus().limited;
    let remote = [];
    const library = await watchlist();
    if (shouldExpand) {
      try {
        remote = await cached(`search:${normalise(q)}:${edition}`, 24 * 60 * 60_000, () => searchVolumes(q, edition));
      } catch (error) {
        // Same offline-first contract as thread search: a rate limit never
        // hides saved books, but an entirely cold search still reports why it
        // could not find anything rather than showing a dishonest empty state.
        if (!local.length) throw error;
      }
    }
    rememberVolumes(remote);
    const raw = [...local, ...remote];
    const watchedIds = new Set(library.map((item) => item.id));
    const deduped = new Map();
    for (const item of raw) {
      const key = `${normalise(item.name)}|${normalise(item.publisher?.name)}|${item.start_year}`;
      const previous = deduped.get(key);
      if (!previous || relevance(item, q) > relevance(previous, q)) deduped.set(key, item);
    }
    const items = [...deduped.values()]
      .map((item) => ({
        item: catalogueShape(item, watchedIds),
        score: relevance(item, q),
        notability: notability(item),
      }))
      .filter(({ score }) => score > 0)
      // Narrow by format BEFORE trimming. Collected editions score below the
      // plainly-titled series -- "The Amazing Spider-Man Omnibus" is a weaker
      // text match for "spiderman" than "Spider-Man" is -- so trimming first
      // discarded every one of them before the filter could see them.
      .filter(({ item }) => !edition || item.edition === edition)
      .filter(({ item }) => !medium || item.medium === medium)
      .filter(({ item }) => !publisher || String(item.publisher || '').startsWith(publisher))
      .sort((a, b) => b.score - a.score
        || b.notability - a.notability
        || b.item.issues - a.item.issues)
      .slice(0, size)
      // Expose the ranking inputs so the client can re-sort without another
      // round trip, and so "best match" is not an unexplainable black box.
      .map(({ item, score, notability: note }) => ({ ...item, score, notability: note }));
    // A search is consent to learn about the few results we actually surfaced,
    // not every loose candidate the provider happened to return.
    // Keep a broad search from becoming a hidden 48-title crawl: the first
    // screen gets preference, and opening a title adds it explicitly.
    enqueueEnrichment('volume', items.slice(0, 12).map((item) => item.id), 'searched'); wakeEnrichment();
    res.json({
      items,
      edition,
      medium,
      publisher,
      size,
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
    queries: ['spider-man omnibus', 'batman omnibus', 'x-men omnibus'] },
  { id: 'collections', title: 'Big collections', majorsOnly: true,
    queries: ['compendium', 'epic collection', 'absolute edition'] },
  { id: 'superheroes', title: 'Superhero essentials', majorsOnly: true,
    queries: ['batman', 'x-men', 'avengers', 'superman'] },
  { id: 'creator-owned', title: 'Creator-owned', hub: 'creator-owned',
    queries: ['saga', 'hellboy', 'invincible', 'monstress', 'paper girls'], matchTitleStart: true,
    publishers: ['Image', 'Dark Horse Comics', 'Boom! Studios', 'IDW Publishing'], strictVariety: true },
  { id: 'manga', title: 'Manga collections',
    queries: ['berserk', 'vagabond', 'one piece', 'fullmetal alchemist'], matchTitleStart: true, strictVariety: true },
];

// These are reader-first launch points, not an assertion that ComicVine has a
// reliable global "most read" score (it does not). They use only volumes Panel
// already knows, then their links become richer as a reader opens titles.
const STARTER_PATHS = [
  { id: 'batman-first', title: 'Best first Batman omnibuses', queries: ['batman omnibus'], edition: 'Omnibus', search: 'Batman' },
  { id: 'marvel-cosmic', title: 'Marvel cosmic', queries: ['guardians', 'thanos', 'silver surfer', 'nova'], search: 'Marvel cosmic' },
  { id: 'creator-owned', hub: 'creator-owned', title: 'Standalone creator-owned', queries: ['saga', 'hellboy', 'monstress', 'paper girls'], search: 'creator owned', matchTitleStart: true, publishers: ['Image', 'Dark Horse Comics', 'Boom! Studios', 'IDW Publishing'], strictVariety: true },
  { id: 'manga', title: 'Manga to try', queries: ['berserk', 'one piece', 'vagabond', 'fullmetal alchemist'], search: 'manga', matchTitleStart: true, strictVariety: true },
  { id: 'x-men', title: 'X-Men reading paths', queries: ['x men', 'wolverine', 'new mutants'], search: 'X-Men' },
];

app.get('/api/discover/paths', async (_req, res) => {
  const library = await watchlist().catch(() => []);
  const watchedIds = new Set(library.map((item) => item.id));
  res.json({ paths: STARTER_PATHS.map((path) => {
    const seen = new Set();
    const tagged = path.queries.flatMap((query) => findVolumes(query, 40).map((item) => ({ item, query })));
    const items = curateRail({ ...path, majorsOnly: false }, tagged)
      .filter((item) => {
        if (seen.has(String(item.id))) return false;
        seen.add(String(item.id)); return true;
      }).slice(0, 12).map((item) => catalogueShape(item, watchedIds));
    return { ...path, items };
  }) });
});

function franchiseOf(name = '') {
  const title = normalise(name);
  // A tiny explicit set handles the franchises that otherwise eat an entire
  // shelf. Everything else falls back to its first meaningful title words;
  // this is a variety guard, not fake metadata.
  const known = ['star wars', 'batman', 'superman', 'x men', 'spider man', 'wolverine',
    'avengers', 'justice league', 'green lantern', 'fantastic four', 'walking dead',
    'saga', 'hellboy', 'one piece', 'fullmetal alchemist', 'berserk', 'vagabond'];
  const matched = known.find((key) => title.includes(key));
  if (matched) return matched;
  return title.replace(/\b(?:the|a|an|omnibus|compendium|absolute|edition|collection|volume|vol)\b/g, ' ')
    .trim().split(' ').slice(0, 3).join(' ');
}

// One title per name, and deliberate source/family variety, so a rail never
// becomes nine Star Wars books merely because that search result had the most
// long-running volumes. Query labels are the rail's editorial lanes.
function curateRail(rail, tagged, cap = 18) {
  const seen = new Set();
  const candidates = tagged
    .filter(({ item }) => item && item.name && item.image?.super_url)
    .filter(({ item, query }) => !rail.matchTitleStart || normalise(item.name).startsWith(normalise(query)))
    .filter(({ item }) => !rail.publishers?.length
      || rail.publishers.some((publisher) => String(item.publisher?.name || '').startsWith(publisher)))
    .filter(({ item }) => {
      if (rail.edition && !new RegExp(`\\b${rail.edition}\\b`, 'i').test(item.name)) return false;
      const publisher = item.publisher?.name || '';
      if (rail.majorsOnly && !MAJOR_PUBLISHERS.some((p) => publisher.startsWith(p))) return false;
      const key = normalise(item.name);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const rank = (a, b) => (rail.majorsOnly
      ? (weightOf(b.item.publisher?.name) - weightOf(a.item.publisher?.name))
      : (relevance(b.item, b.query) - relevance(a.item, a.query)))
      || ((Number(b.item.count_of_issues) || 0) - (Number(a.item.count_of_issues) || 0));
  const lanes = new Map();
  for (const candidate of candidates) {
    const lane = candidate.query || 'catalogue';
    if (!lanes.has(lane)) lanes.set(lane, []);
    lanes.get(lane).push(candidate);
  }
  for (const items of lanes.values()) items.sort(rank);
  const selected = [];
  const familyCounts = new Map();
  // These broad discovery shelves are where repetition feels most broken.
  // Keep their first pass to one book per franchise; narrower format shelves
  // can reasonably show two Spider-Man omnibuses side by side.
  const familyLimit = ['collections', 'superheroes'].includes(rail.id) ? 1 : 2;
  const take = (enforceVariety) => {
    let progress = false;
    for (const items of lanes.values()) {
      const index = items.findIndex(({ item }) => {
        const family = franchiseOf(item.name);
        return !enforceVariety || (familyCounts.get(family) || 0) < familyLimit;
      });
      if (index < 0) continue;
      const [candidate] = items.splice(index, 1);
      const family = franchiseOf(candidate.item.name);
      familyCounts.set(family, (familyCounts.get(family) || 0) + 1);
      selected.push(candidate); progress = true;
      if (selected.length >= cap) return true;
    }
    return progress;
  };
  // First pass balances the editorial lanes and prevents any franchise from
  // occupying more than two early slots. If a small catalogue only has one
  // family, the second pass still fills the shelf rather than looking broken.
  while (selected.length < cap && take(true)) { /* one item per lane per round */ }
  if (!rail.strictVariety) {
    while (selected.length < cap && take(false)) { /* graceful sparse fallback */ }
  }
  return selected.map(({ item }) => item);
}

async function railRows(rail) {
  // Keep the query that found each row: for rails that are not about the big
  // two, relevance to that query orders far better than publisher standing --
  // weighting alone put Batman at the top of the manga rail.
  const results = await gatherOrFail(
    rail.queries.map(async (query) => {
      const rows = await comicVine('search', { query, resources: 'volume', limit: '100' });
      return rows.map((item) => ({ item, query }));
    }),
    `the ${rail.title} rail`);
  return curateRail(rail, results);
}

function localRailRows(rail, cap = 18) {
  const tagged = rail.queries.flatMap((query) =>
    findVolumes(query, 100).map((item) => ({ item, query })));
  return curateRail(rail, tagged, cap);
}

app.get('/api/discover', async (_req, res, next) => {
  try {
    const library = await watchlist(); const watchedIds = new Set(library.map((item) => item.id));
    // Discover is a local reading room, not a silent provider crawler. Its
    // shelves grow from titles a reader has deliberately explored elsewhere.
    // A blank shelf gives a search launch point in the client, never a hidden
    // request burst to ComicVine.
    const sections = rails.map((rail) => {
      const allItems = localRailRows(rail, DISCOVER_RAIL_CAP);
      const items = allItems.slice(0, 18);
      return {
        id: rail.id, title: rail.title,
        query: rail.queries[0], hub: rail.hub ?? null,
        items: items.map((item) => catalogueShape(item, watchedIds)),
        hasMore: allItems.length > items.length,
        pending: false,
        refreshing: false,
      };
    });
    const mirror = cacheStats();
    res.json({ sections, bootstrapping: mirror.volumes === 0 && mirror.enrichment.pending > 0 });
  } catch (error) { next(error); }
});

// Rails deliberately page from SQLite only. Reaching the end feels like a
// Netflix shelf, without turning a horizontal scroll into background provider
// traffic. A hard cap keeps every rail bounded even as the local mirror grows.
app.get('/api/discover/rail/:id', async (req, res, next) => {
  const rail = rails.find((item) => item.id === req.params.id);
  if (!rail) return res.status(404).json({ error: 'Unknown discovery shelf.' });
  const offset = Math.max(0, Math.min(DISCOVER_RAIL_CAP - 12, Number(req.query.offset) || 0));
  const size = Math.max(6, Math.min(18, Number(req.query.size) || 12));
  try {
    const [library, rows] = await Promise.all([watchlist(), Promise.resolve(localRailRows(rail, DISCOVER_RAIL_CAP))]);
    const page = rows.slice(offset, offset + size);
    res.json({
      id: rail.id, offset, items: page.map((item) => catalogueShape(item, new Set(library.map((x) => x.id)))),
      hasMore: offset + page.length < rows.length && offset + page.length < DISCOVER_RAIL_CAP,
      capped: offset + page.length >= DISCOVER_RAIL_CAP,
    });
  } catch (error) { next(error); }
});

// Supplement providers, consulted only on detail views. Each returns a partial
// record in this app's own shape, or null. Metron is absent until its payloads
// have actually been observed -- its field names are not documented well enough
// to map from the docs alone, and guessing is how the Marvel provider went in
// and straight back out.
async function supplementsFor(item) {
  const providers = [];
  const settled = await Promise.allSettled(providers.map((p) => p(item)));
  return settled
    .filter((r) => r.status === 'fulfilled' && r.value)
    .map((r) => r.value);
}

app.get('/api/volume/:id', async (req, res, next) => {
  const { id } = req.params;
  if (!/^\d+$/.test(id)) return res.status(400).json({ error: 'A numeric ComicVine volume id is required.' });
  try {
    const local = getVolume(id);
    const cachedDetail = cacheRead(`volume:detail:${id}`)?.value ?? null;
    const hasDetail = (value) => Boolean(value && ('people' in value || 'characters' in value));
    const watchedTask = watchlist();
    let data;
    try {
      // A detail opened once is a local detail from then on. The mirror merges
      // rich fields into a volume record so a later lightweight search cannot
      // erase its creators/characters/description.
      data = hasDetail(local) ? local : cachedDetail ?? await cached(`volume:detail:${id}`, 7 * 24 * 60 * 60_000, () =>
        comicVine(`volume/4050-${id}`, { field_list: VOLUME_DETAIL_FIELDS }));
    } catch (error) {
      // The title card already has enough saved metadata to open a useful
      // basic sheet. Do not make a ComicVine cooldown erase that local card;
      // it simply has no fresh cast/creator expansion this time.
      if (!local) throw error;
      data = local;
    }
    const watched = await watchedTask;
    rememberVolumes(data);
    rememberObjects('volume', data);
    enqueueEnrichment('volume', id, 'opened'); wakeEnrichment();
    const shaped = catalogueShape(data, new Set(watched.map((x) => x.id)));
    // Requesting something you already own is the easiest mistake this app can
    // let you make, and the most expensive: these are four-gigabyte books.
    shaped.owned = await ownedTitle(shaped.title);
    // Credits are ordered by ComicVine's own prominence, so the first few are
    // the ones a reader would recognise.
    shaped.creators = (data.people ?? []).slice(0, 8)
      .map((x) => ({ id: String(x.id), name: x.name, kind: 'person' }));
    shaped.characters = (data.characters ?? []).slice(0, 12)
      .map((x) => ({ id: String(x.id), name: x.name, kind: 'character' }));
    const related = (items, kind) => items.map((thread) => ({
      ...thread,
      items: relatedVolumes(kind, thread.id, id, 8)
        .map((volume) => catalogueShape(volume, new Set(watched.map((x) => x.id)))),
    })).filter((group) => group.items.length);
    shaped.related = {
      creators: related(shaped.creators.slice(0, 3), 'person'),
      characters: related(shaped.characters.slice(0, 3), 'character'),
    };
    // ComicVine stays authoritative for identity; a supplement only fills gaps.
    res.json(supplement(shaped, await supplementsFor(shaped)));
  } catch (error) { next(error); }
});

function requestId(req, res) {
  const id = String(req.params.id ?? req.body?.id ?? '');
  if (/^\d+$/.test(id)) return id;
  res.status(400).json({ error: 'A valid ComicVine series id is required.' });
  return null;
}

// Mylar names an omnibus part "Volume 2" and nothing else. ComicVine usually
// has the real title and a description, so the requests list can say what the
// book actually is. Cached hard: this never changes for a published issue.
app.get('/api/volume/:id/issues', async (req, res, next) => {
  const id = String(req.params.id);
  if (!/^\d+$/.test(id)) return res.status(400).json({ error: 'Unknown volume.' });
  try {
    const items = await cached(`volume:${id}:issues`, 30 * 24 * 60 * 60_000, async () => {
      const rows = await comicVine('issues', {
        filter: `volume:${id}`,
        field_list: 'id,name,issue_number,description,resource_type',
        sort: 'issue_number:asc',
        limit: '100',
      });
      return rows.map((row) => ({
        number: row.issue_number == null ? null : String(row.issue_number),
        name: row.name || null,
        blurb: firstSentence(plainText(row.description || '')),
      }));
    });
    res.json({ items });
  } catch (error) {
    // The list is an enhancement; never fail the requests page over it.
    res.json({ items: [], reason: error.message });
  }
});

app.get('/api/request/:id/options', async (req, res, next) => {
  const id = requestId(req, res);
  if (!id) return;
  try {
    const [parts, queued] = await Promise.all([mylarParts(id), queuedFor(id)]);
    // Both answers a reader needs before choosing parts: whether this book is
    // already on the shelf, and whether it is already on its way. Neither
    // blocks the request -- a second copy is sometimes exactly what is wanted
    // -- but neither should be a surprise afterwards.
    res.json({ ...parts, owned: await ownedTitle(getVolume(id)?.name), queued });
  } catch (error) { next(error); }
});

// Adding a series makes Mylar import its own issue list. It deliberately does
// not queue anything: Panel shows that list first, then queues only the reader's
// chosen parts. This matters because this Mylar uses autowant_all = false.
app.post('/api/request/:id/prepare', async (req, res, next) => {
  const id = requestId(req, res);
  if (!id) return;
  try {
    const existing = await mylarParts(id);
    if (existing.tracked) return res.json(existing);
    await mylar('addComic', { id });
    cache.delete('watchlist');
    res.status(202).json({ tracked: false, parts: [], pending: true });
  } catch (error) { next(error); }
});

app.post('/api/request/:id/parts', async (req, res, next) => {
  const id = requestId(req, res);
  if (!id) return;
  const selectedNumbers = [...new Set((Array.isArray(req.body?.partNumbers) ? req.body.partNumbers : [])
    .map((value) => String(value).trim()))]
    .filter((value) => /^\d+(?:\.\d+)?$/.test(value));
  if (!selectedNumbers.length || selectedNumbers.length > 500) {
    return res.status(400).json({ error: 'Choose at least one valid issue or volume.' });
  }
  try {
    let collection = await mylarParts(id, { refresh: true });
    if (!collection.tracked) {
      // The parent series is an implementation detail. Add it only after a
      // reader committed a selection, then wait for Mylar to expose the IDs
      // required by queueIssue. No preliminary "setup" click is needed.
      await mylar('addComic', { id });
      cache.delete('watchlist');
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        collection = await mylarParts(id, { refresh: true });
        if (collection.tracked && collection.parts.length) break;
      }
      if (!collection.tracked || !collection.parts.length) {
        return res.status(202).json({ ok: false, pending: true, queued: 0,
          message: 'Mylar is importing this series. Your selection is not queued yet; try again shortly.' });
      }
    }
    const byNumber = new Map(collection.parts.map((part) => [String(part.number).trim(), part]));
    const requested = selectedNumbers.map((number) => byNumber.get(number)).filter(Boolean);
    if (requested.length !== selectedNumbers.length) {
      return res.status(409).json({ error: 'Mylar has not exposed one or more selected issues yet. Try again shortly.' });
    }
    const queueable = requested.filter((part) => part.requestable);
    // Mylar's queue command immediately hands each part to its search pipeline.
    // Keep this serial so selecting a whole omnibus line does not stampede the
    // indexers the same way an old ComicVine fan-out did.
    for (const part of queueable) {
      await mylar('queueIssue', { id: part.id });
      setMylarPartStatus(id, part.id, 'Wanted');
    }
    enqueueEnrichment('volume', id, 'requested'); wakeEnrichment();
    cache.delete('watchlist');
    res.status(201).json({
      ok: true,
      queued: queueable.length,
      alreadyQueued: requested.length - queueable.length,
    });
  } catch (error) { next(error); }
});

app.post('/api/request/:comicId/part/:issueId/retry', async (req, res, next) => {
  const { comicId, issueId } = req.params;
  if (!/^\d+$/.test(comicId) || !/^\d+$/.test(issueId)) {
    return res.status(400).json({ error: 'A valid Mylar series and part id is required.' });
  }
  const part = getMylarParts(comicId).parts.find((item) => item.id === String(issueId));
  if (!part) return res.status(404).json({ error: 'That part is not in Panel’s request history yet.' });
  const state = String(part.status || '').toLowerCase();
  if (['downloaded', 'archived', 'snatched'].includes(state)) {
    return res.status(409).json({ error: 'Mylar is already handling or has completed this part.' });
  }
  try {
    // queueIssue changes exactly this IssueID to Wanted and starts its search;
    // it does not re-add a whole series or touch neighbouring volumes.
    await mylar('queueIssue', { id: issueId });
    setMylarPartStatus(comicId, issueId, 'Wanted');
    res.json({ ok: true, status: 'Wanted' });
  } catch (error) { next(error); }
});

// A regular ongoing series does not have a finite, reader-friendly collection
// picker. Preserve its existing watchlist behavior, but surface it as exactly
// that in the UI rather than implying every historical issue was requested.
app.post('/api/request', async (req, res, next) => {
  const id = requestId(req, res);
  if (!id) return;
  try {
    const library = await watchlist();
    if (library.some((item) => item.id === id)) return res.status(409).json({ error: 'That series is already in your library.' });
    await mylar('addComic', { id });
    cache.delete('watchlist');
    enqueueEnrichment('volume', id, 'requested'); wakeEnrichment();
    res.status(201).json({ ok: true, id });
  } catch (error) { next(error); }
});

function coverSourceFor(volume) {
  const image = volume?.image || {};
  return image.medium_url || image.super_url || image.small_url || null;
}

function imageMimeType(bytes, declared = '') {
  const type = String(declared).split(';')[0].toLowerCase();
  if (type.startsWith('image/')) return type;
  // ComicVine's image CDN occasionally calls an ordinary JPEG
  // application/octet-stream. Trust the actual small file signature, never the
  // filename or URL extension, so this exception cannot turn into arbitrary
  // response caching.
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return '';
}

async function cachedCover(volumeId) {
  const volume = getVolume(volumeId);
  const sourceUrl = coverSourceFor(volume);
  if (!sourceUrl) throw new Error('No cover image is available for this title.');
  const existing = getCover(volumeId);
  const fileName = `${volumeId}.img`;
  const destination = path.join(coverDir, fileName);
  if (existing?.sourceUrl === sourceUrl && existing.fileName === fileName && fs.existsSync(destination)) {
    return { path: destination, mimeType: existing.mimeType };
  }
  if (coverInflight.has(volumeId)) return coverInflight.get(volumeId);
  const task = (async () => {
    const url = new URL(sourceUrl);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('The cover URL is invalid.');
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Panel/1.0 (personal media server)' }, signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`The cover host returned HTTP ${response.status}`);
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > 15 * 1024 * 1024) throw new Error('The cover image is too large to cache.');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 15 * 1024 * 1024) throw new Error('The cover image is too large to cache.');
    const mimeType = imageMimeType(bytes, response.headers.get('content-type') || '');
    if (!mimeType) throw new Error('The cover host did not return an image.');
    const temporary = path.join(coverDir, `.${fileName}.${process.pid}.tmp`);
    await fsp.writeFile(temporary, bytes);
    await fsp.rename(temporary, destination);
    rememberCover(volumeId, { sourceUrl, fileName, mimeType, byteSize: bytes.length });
    return { path: destination, mimeType };
  })().finally(() => coverInflight.delete(volumeId));
  coverInflight.set(volumeId, task);
  return task;
}

app.get('/api/cover/:id', async (req, res, next) => {
  const { id } = req.params;
  if (!/^\d+$/.test(id)) return res.status(400).end();
  try {
    const cover = await cachedCover(id);
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.type(cover.mimeType);
    res.sendFile(cover.path);
  } catch (error) {
    // A missing cover should fall back to Panel's title tile, not make the
    // card unusable. Keep the diagnostic in logs without leaking it into img.
    console.warn(`Cover ${id}: ${error.message}`);
    res.status(404).end();
  }
});

// app.js and styles.css are requested with a ?v= cache-buster, so the bytes at
// a given version never change and may be cached forever. They are also the
// only two blocking resources on the page, so they are compressed once and held
// in memory -- keyed by mtime, which keeps front-end edits hot-reloading.
const TEXT_ASSETS = { '/app.js': 'text/javascript; charset=utf-8', '/styles.css': 'text/css; charset=utf-8' };
const assetCache = new Map();

app.get(Object.keys(TEXT_ASSETS), (req, res, next) => {
  const file = path.join(root, 'public', path.basename(req.path));
  let stat;
  try { stat = fs.statSync(file); } catch { return next(); }
  const encoding = negotiateEncoding(req);
  const key = `${req.path}:${encoding || 'identity'}:${stat.mtimeMs}:${stat.size}`;
  let entry = assetCache.get(key);
  if (!entry) {
    const raw = fs.readFileSync(file);
    entry = { body: encoding ? compressSync(raw, encoding) : raw, etag: `W/"${stat.mtimeMs}-${stat.size}"` };
    // Only the current build of each asset is worth holding.
    for (const other of assetCache.keys()) {
      if (other.startsWith(`${req.path}:`)) assetCache.delete(other);
    }
    assetCache.set(key, entry);
  }
  res.set('Content-Type', TEXT_ASSETS[req.path]);
  res.set('Vary', 'Accept-Encoding');
  res.set('ETag', entry.etag);
  // Versioned by query string, so a year is safe; a bare request revalidates.
  res.set('Cache-Control', req.query.v ? 'public, max-age=31536000, immutable' : 'no-cache');
  if (encoding) res.set('Content-Encoding', encoding);
  if (req.headers['if-none-match'] === entry.etag) return res.status(304).end();
  return res.end(entry.body);
});

app.use(express.static(path.join(root, 'public'), {
  index: 'index.html',
  etag: true,
  // index.html carries the asset version numbers, so it must never be stale.
  setHeaders: (res, filePath) => {
    res.set('Cache-Control', filePath.endsWith('.html') ? 'no-cache' : 'public, max-age=604800');
  },
}));
app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(502).json({ error: error.message || 'The comic service could not complete that request.' });
});
app.listen(port, '0.0.0.0', () => console.log(`Comic Requester listening on :${port}`));
