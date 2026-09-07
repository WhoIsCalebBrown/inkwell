// Disk-backed cache. ComicVine is slow (~2-4s a call) and exposes no server-side
// sort, so some answers cost dozens of calls to assemble. An in-memory cache
// loses all of that on every restart, which for a single-user server means the
// expensive path is effectively always cold. This keeps it on disk instead.

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const file = process.env.CACHE_DB || path.join(root, 'data', 'cache.db');
fs.mkdirSync(path.dirname(file), { recursive: true });

const db = new DatabaseSync(file);
db.exec('PRAGMA journal_mode = WAL');
// Single-user server, and every table here is a rebuildable cache of ComicVine
// or Mylar. NORMAL fsyncs at checkpoints rather than every commit, which is the
// difference between a snappy enrichment pass and one that stalls on disk.
db.exec('PRAGMA synchronous = NORMAL');
db.exec('PRAGMA temp_store = MEMORY');
db.exec('PRAGMA busy_timeout = 5000');
// The catalogue is read far more than written; mapping it and giving SQLite a
// real page cache keeps the browse queries off the disk entirely.
db.exec('PRAGMA mmap_size = 268435456');
db.exec('PRAGMA cache_size = -32000');
db.exec('CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, at INTEGER NOT NULL)');
// The response cache makes repeat URLs fast; this mirror makes the catalogue
// itself queryable. It grows only from data Inkwell has legitimately fetched, so
// it never tries to bulk-scrape ComicVine or burn an API allowance rebuilding
// information that is already on disk.
db.exec(`CREATE TABLE IF NOT EXISTS catalogue_volumes (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  title_normalized TEXT NOT NULL,
  aliases_normalized TEXT NOT NULL DEFAULT '',
  publisher TEXT,
  publisher_normalized TEXT NOT NULL DEFAULT '',
  start_year TEXT,
  issue_count INTEGER NOT NULL DEFAULT 0,
  fetched_at INTEGER NOT NULL,
  payload TEXT NOT NULL
)`);
db.exec('CREATE INDEX IF NOT EXISTS catalogue_volumes_title_idx ON catalogue_volumes(title_normalized)');
db.exec('CREATE INDEX IF NOT EXISTS catalogue_volumes_publisher_idx ON catalogue_volumes(publisher_normalized)');
db.exec(`CREATE TABLE IF NOT EXISTS catalogue_objects (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  name_normalized TEXT NOT NULL,
  aliases_normalized TEXT NOT NULL DEFAULT '',
  publisher TEXT,
  publisher_normalized TEXT NOT NULL DEFAULT '',
  fetched_at INTEGER NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (kind, id)
)`);
db.exec('CREATE INDEX IF NOT EXISTS catalogue_objects_name_idx ON catalogue_objects(kind, name_normalized)');
db.exec(`CREATE TABLE IF NOT EXISTS catalogue_links (
  from_kind TEXT NOT NULL,
  from_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  to_kind TEXT NOT NULL,
  to_id TEXT NOT NULL,
  to_name TEXT,
  PRIMARY KEY (from_kind, from_id, relation, to_kind, to_id)
)`);
db.exec('CREATE INDEX IF NOT EXISTS catalogue_links_target_idx ON catalogue_links(to_kind, to_id, relation)');
db.exec(`CREATE TABLE IF NOT EXISTS mylar_series (
  comic_id TEXT PRIMARY KEY,
  name TEXT,
  publisher TEXT,
  year TEXT,
  status TEXT,
  updated_at INTEGER NOT NULL
)`);
db.exec(`CREATE TABLE IF NOT EXISTS mylar_parts (
  comic_id TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  number TEXT,
  name TEXT,
  status TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (comic_id, issue_id)
)`);
db.exec('CREATE INDEX IF NOT EXISTS mylar_parts_comic_idx ON mylar_parts(comic_id, number)');
// Things that happened while nobody was looking. A single-user server that has
// to be watched to be useful is not much of a server: this is what the page
// can show on the reader's return, and what gets pushed if a notify URL is
// set. `key` is what makes an event happen once -- the watcher re-reads the
// same rows every few minutes and must not announce them twice.
db.exec(`CREATE TABLE IF NOT EXISTS events (
  key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT,
  at INTEGER NOT NULL,
  when_local TEXT
)`);
// `at` is Inkwell's own clock -- when it noticed. `when_local` is Mylar's wall
// clock verbatim, for events that come from Mylar's records: it is written in
// Mylar's timezone, which this container does not share and the reader's
// browser does. Displaying the former for a Mylar event is how a book that
// arrived at noon came to be listed at eight in the morning.
try { db.exec('ALTER TABLE events ADD COLUMN when_local TEXT'); } catch { /* already there */ }
db.exec('CREATE INDEX IF NOT EXISTS events_at_idx ON events(at DESC)');
db.exec(`CREATE TABLE IF NOT EXISTS catalogue_covers (
  volume_id TEXT PRIMARY KEY,
  source_url TEXT NOT NULL,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL
)`);
// This is intentionally a queue, not a crawler. Rows arrive only from a title
// someone searched for, opened, requested, or a thread they chose to follow.
// The server claims one row at a time and records both successful and delayed
// work, so a ComicVine cooldown survives a restart without a retry storm.
db.exec(`CREATE TABLE IF NOT EXISTS catalogue_enrichment (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  reason TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_error TEXT,
  PRIMARY KEY (kind, id)
)`);
db.exec('CREATE INDEX IF NOT EXISTS catalogue_enrichment_ready_idx ON catalogue_enrichment(state, available_at)');

const selectOne = db.prepare('SELECT value, at FROM cache WHERE key = ?');
const upsert = db.prepare(
  'INSERT INTO cache (key, value, at) VALUES (?, ?, ?) ' +
  'ON CONFLICT(key) DO UPDATE SET value = excluded.value, at = excluded.at'
);
const removeOne = db.prepare('DELETE FROM cache WHERE key = ?');
const cacheSummary = db.prepare('SELECT COUNT(*) AS entries, COALESCE(MIN(at), 0) AS oldest, COALESCE(MAX(at), 0) AS newest FROM cache');
const catalogueSummary = db.prepare('SELECT COUNT(*) AS volumes, COALESCE(MIN(fetched_at), 0) AS oldest, COALESCE(MAX(fetched_at), 0) AS newest FROM catalogue_volumes');
const objectSummary = db.prepare('SELECT COUNT(*) AS objects FROM catalogue_objects');
const linkSummary = db.prepare('SELECT COUNT(*) AS links FROM catalogue_links');
const mylarPartSummary = db.prepare('SELECT COUNT(*) AS parts FROM mylar_parts');
const coverSummary = db.prepare('SELECT COUNT(*) AS covers, COALESCE(SUM(byte_size), 0) AS bytes FROM catalogue_covers');
const upsertVolume = db.prepare(`INSERT INTO catalogue_volumes
  (id, title, title_normalized, aliases_normalized, publisher, publisher_normalized, start_year, issue_count, fetched_at, payload)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    title=excluded.title, title_normalized=excluded.title_normalized,
    aliases_normalized=excluded.aliases_normalized, publisher=excluded.publisher,
    publisher_normalized=excluded.publisher_normalized, start_year=excluded.start_year,
    issue_count=excluded.issue_count, fetched_at=excluded.fetched_at, payload=excluded.payload`);
const selectLocalVolumes = db.prepare(`SELECT payload FROM catalogue_volumes
  WHERE title_normalized LIKE ? OR aliases_normalized LIKE ? OR publisher_normalized LIKE ?
  ORDER BY fetched_at DESC LIMIT ?`);
const cachedPayloads = db.prepare('SELECT value FROM cache');
const selectVolume = db.prepare('SELECT payload FROM catalogue_volumes WHERE id = ?');
const selectObject = db.prepare('SELECT payload FROM catalogue_objects WHERE kind = ? AND id = ?');
const selectLocalObjects = db.prepare(`SELECT kind, payload FROM catalogue_objects
  WHERE kind IN (SELECT value FROM json_each(?))
    AND (name_normalized LIKE ? OR aliases_normalized LIKE ? OR publisher_normalized LIKE ?)
  ORDER BY fetched_at DESC LIMIT ?`);
// Threads have a browse destination, not just a search result, so they need a
// listing that is not driven by a query.
// Ranked by how many catalogued volumes actually credit the thread, then by
// ComicVine's appearance count. Ordering people by "most recently cached" put
// whoever last matched a search at the top -- a letterer picked up from a
// credits list outranked Brian K. Vaughan.
const selectObjectsByKind = db.prepare(`SELECT o.payload, COUNT(l.from_id) AS credits
  FROM catalogue_objects o
  LEFT JOIN catalogue_links l
    ON l.to_kind = o.kind AND l.to_id = o.id AND l.from_kind = 'volume'
  WHERE o.kind = ? AND (? = '' OR o.publisher_normalized LIKE ?)
  GROUP BY o.kind, o.id
  ORDER BY credits DESC,
           CAST(json_extract(o.payload, '$.count_of_issue_appearances') AS INTEGER) DESC,
           o.fetched_at DESC
  LIMIT ?`);
// Art for the browse tiles, straight from the local mirror -- no ComicVine call
// and no new cache. Only ids are returned; the client renders them through
// /api/cover/:id, which is already on disk and served immutable.
const selectPublisherArt = db.prepare(`SELECT id FROM catalogue_volumes
  WHERE publisher_normalized LIKE ?
    AND json_extract(payload, '$.image.medium_url') IS NOT NULL
  ORDER BY issue_count DESC, fetched_at DESC
  LIMIT ?`);
const upsertObject = db.prepare(`INSERT INTO catalogue_objects
  (kind, id, name, name_normalized, aliases_normalized, publisher, publisher_normalized, fetched_at, payload)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(kind, id) DO UPDATE SET
    name=excluded.name, name_normalized=excluded.name_normalized,
    aliases_normalized=excluded.aliases_normalized, publisher=excluded.publisher,
    publisher_normalized=excluded.publisher_normalized, fetched_at=excluded.fetched_at,
    payload=excluded.payload`);
const upsertLink = db.prepare(`INSERT INTO catalogue_links (from_kind, from_id, relation, to_kind, to_id, to_name)
  VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(from_kind, from_id, relation, to_kind, to_id)
  DO UPDATE SET to_name=excluded.to_name`);
const deleteLinksForRelation = db.prepare(`DELETE FROM catalogue_links
  WHERE from_kind = ? AND from_id = ? AND relation = ? AND to_kind = ?`);
const selectMylarSeries = db.prepare('SELECT comic_id, name, publisher, year, status, updated_at FROM mylar_series WHERE comic_id = ?');
const selectMylarParts = db.prepare('SELECT issue_id, number, name, status, updated_at FROM mylar_parts WHERE comic_id = ? ORDER BY CAST(number AS REAL), number');
const upsertMylarSeries = db.prepare(`INSERT INTO mylar_series (comic_id, name, publisher, year, status, updated_at)
  VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(comic_id) DO UPDATE SET name=excluded.name,
  publisher=excluded.publisher, year=excluded.year, status=excluded.status, updated_at=excluded.updated_at`);
const upsertMylarPart = db.prepare(`INSERT INTO mylar_parts (comic_id, issue_id, number, name, status, updated_at)
  VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(comic_id, issue_id) DO UPDATE SET number=excluded.number,
  name=excluded.name, status=excluded.status, updated_at=excluded.updated_at`);
const updateMylarPart = db.prepare('UPDATE mylar_parts SET status = ?, updated_at = ? WHERE comic_id = ? AND issue_id = ?');
const selectEvent = db.prepare('SELECT key FROM events WHERE key = ?');
const insertEvent = db.prepare('INSERT INTO events (key, kind, title, detail, at, when_local) VALUES (?, ?, ?, ?, ?, ?)');
const selectEvents = db.prepare('SELECT key, kind, title, detail, at, when_local FROM events ORDER BY at DESC LIMIT ?');
const trimEvents = db.prepare('DELETE FROM events WHERE key NOT IN (SELECT key FROM events ORDER BY at DESC LIMIT 200)');
const deleteMylarParts = db.prepare('DELETE FROM mylar_parts WHERE comic_id = ?');
const deleteMylarSeries = db.prepare('DELETE FROM mylar_series WHERE comic_id = ?');
const selectCover = db.prepare('SELECT source_url, file_name, mime_type, byte_size, fetched_at FROM catalogue_covers WHERE volume_id = ?');
const selectRequestParts = db.prepare(`SELECT p.comic_id, p.issue_id, p.number, p.name, p.status, p.updated_at,
  s.name AS series_name, s.publisher, s.year
  FROM mylar_parts p LEFT JOIN mylar_series s ON s.comic_id = p.comic_id
  ORDER BY p.updated_at DESC, CAST(p.number AS REAL), p.number`);
const upsertCover = db.prepare(`INSERT INTO catalogue_covers (volume_id, source_url, file_name, mime_type, byte_size, fetched_at)
  VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(volume_id) DO UPDATE SET source_url=excluded.source_url,
    file_name=excluded.file_name, mime_type=excluded.mime_type, byte_size=excluded.byte_size, fetched_at=excluded.fetched_at`);
const queueEnrichment = db.prepare(`INSERT INTO catalogue_enrichment
  (kind, id, reason, state, attempts, available_at, updated_at, last_error)
  VALUES (?, ?, ?, 'pending', 0, ?, ?, NULL)
  ON CONFLICT(kind, id) DO UPDATE SET
    reason=excluded.reason,
    state=CASE WHEN catalogue_enrichment.state='done' THEN 'done' ELSE 'pending' END,
    available_at=CASE WHEN catalogue_enrichment.state='done' THEN catalogue_enrichment.available_at ELSE MIN(catalogue_enrichment.available_at, excluded.available_at) END,
    updated_at=excluded.updated_at`);
const claimEnrichment = db.prepare(`SELECT kind, id, reason, attempts FROM catalogue_enrichment
  WHERE state='pending' AND available_at <= ? ORDER BY available_at, updated_at LIMIT 1`);
const markEnrichmentRunning = db.prepare(`UPDATE catalogue_enrichment SET state='running', attempts=attempts+1, updated_at=?
  WHERE kind=? AND id=? AND state='pending'`);
const finishEnrichment = db.prepare(`UPDATE catalogue_enrichment SET state='done', updated_at=?, last_error=NULL
  WHERE kind=? AND id=?`);
const delayEnrichment = db.prepare(`UPDATE catalogue_enrichment SET state='pending', available_at=?, updated_at=?, last_error=?
  WHERE kind=? AND id=?`);
const resetRunningEnrichment = db.prepare("UPDATE catalogue_enrichment SET state='pending', available_at=?, updated_at=? WHERE state='running'");
const enrichmentSummary = db.prepare(`SELECT
  SUM(CASE WHEN state='pending' THEN 1 ELSE 0 END) AS pending,
  SUM(CASE WHEN state='running' THEN 1 ELSE 0 END) AS running,
  SUM(CASE WHEN state='done' THEN 1 ELSE 0 END) AS done,
  MIN(CASE WHEN state='pending' THEN available_at END) AS next_at
  FROM catalogue_enrichment`);
const selectRelatedVolumes = db.prepare(`SELECT v.payload FROM catalogue_links l
  JOIN catalogue_volumes v ON v.id = l.from_id
  WHERE l.from_kind = 'volume' AND l.to_kind = ? AND l.to_id = ? AND l.from_id != ?
  ORDER BY v.fetched_at DESC LIMIT ?`);
// A character may be learned only as a credit on a volume, long before its own
// ComicVine object has been opened. Lore line-ups can still use that real id;
// throwing it away made X-Men resolve only Wolverine and Storm, then gave one
// member's books the whole team shelf.
const selectLinkedObjectIdByName = db.prepare(`SELECT to_id AS id FROM catalogue_links
  WHERE to_kind = ? AND lower(to_name) = lower(?)
  ORDER BY rowid DESC LIMIT 1`);

export function findLinkedObjectIdByName(kind, name) {
  const value = String(name || '').trim();
  if (!kind || !value) return null;
  return selectLinkedObjectIdByName.get(String(kind), value)?.id ?? null;
}

function normalise(value = '') {
  return String(value ?? '').toLowerCase().normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function aliasesOf(item) {
  return Array.isArray(item.aliases) ? item.aliases.join(' ') : String(item.aliases ?? '');
}

function mergedPayload(previous, next) {
  // Search records are intentionally thin; never let one erase creators,
  // character links, long descriptions, or any other richer detail we already
  // paid to retrieve. Fresh non-empty values still win.
  const merged = { ...(previous ?? {}) };
  for (const [key, value] of Object.entries(next ?? {})) {
    if (value !== null && value !== undefined && value !== ''
      && (!Array.isArray(value) || value.length)) merged[key] = value;
  }
  return merged;
}

// The only records eligible for this table are ComicVine volume records. Other
// search resources (characters, people, events) have different identity rules.
export function rememberVolumes(items) {
  const rows = Array.isArray(items) ? items : [items];
  let stored = 0;
  const now = Date.now();
  db.exec('BEGIN');
  try {
    for (const item of rows) {
      if (!item?.id || !item?.name || (item.resource_type && item.resource_type !== 'volume')) continue;
      const old = selectVolume.get(String(item.id));
      let previous = null;
      try { previous = old ? JSON.parse(old.payload) : null; } catch { /* replace corrupt data */ }
      const payload = mergedPayload(previous, item);
      const publisher = payload.publisher?.name ?? payload.publisher ?? null;
      upsertVolume.run(
        String(payload.id), String(payload.name), normalise(payload.name), normalise(aliasesOf(payload)), publisher,
        normalise(publisher), payload.start_year == null ? null : String(payload.start_year),
        Number(payload.count_of_issues) || 0, now, JSON.stringify(payload),
      );
      stored += 1;
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return stored;
}

function kindOf(item, fallback = 'unknown') {
  const raw = String(item?.resource_type || fallback).toLowerCase();
  const aliases = { volumes: 'volume', publishers: 'publisher', characters: 'character', teams: 'team', people: 'person', story_arcs: 'story_arc' };
  return aliases[raw] ?? raw;
}

function rememberLinks(kind, id, payload) {
  const linkSets = [
    ['people', 'created_by', 'person'], ['characters', 'features', 'character'],
    ['teams', 'member_of', 'team'], ['character_friends', 'related_to', 'character'],
    ['character_enemies', 'opposes', 'character'],
  ];
  for (const [field, relation, targetKind] of linkSets) {
    // A lightweight search result omits these fields entirely; it must never
    // erase richer links learned from an opened detail sheet. A detail payload
    // that *does* include a field is authoritative for that relation, so clear
    // stale rows before replacing them with its current explicit credits.
    if (!(field in payload)) continue;
    deleteLinksForRelation.run(kind, String(id), relation, targetKind);
    for (const target of payload[field] ?? []) {
      if (target?.id == null) continue;
      upsertLink.run(kind, String(id), relation, targetKind, String(target.id), target.name ?? null);
    }
  }
}

// Retain every object returned by ComicVine, not only volumes. This gives the
// app a durable identity store for people, characters, teams, events and
// publishers as browsing expands naturally over time.
export function rememberObjects(resource, items) {
  const fallback = String(resource || '').split('/')[0].replace(/s$/, '') || 'unknown';
  const rows = Array.isArray(items) ? items : [items];
  const now = Date.now();
  db.exec('BEGIN');
  try {
    for (const item of rows) {
      if (!item?.id || !item?.name) continue;
      const kind = kindOf(item, fallback);
      const old = selectObject.get(kind, String(item.id));
      let previous = null;
      try { previous = old ? JSON.parse(old.payload) : null; } catch { /* replace corrupt data */ }
      const payload = mergedPayload(previous, item);
      const publisher = payload.publisher?.name ?? payload.publisher ?? null;
      upsertObject.run(kind, String(payload.id), String(payload.name), normalise(payload.name),
        normalise(aliasesOf(payload)), publisher, normalise(publisher), now, JSON.stringify(payload));
      rememberLinks(kind, payload.id, payload);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function getVolume(id) {
  const row = selectVolume.get(String(id));
  try { return row ? JSON.parse(row.payload) : null; } catch { return null; }
}

export function getObject(kind, id) {
  const row = selectObject.get(String(kind), String(id));
  try { return row ? JSON.parse(row.payload) : null; } catch { return null; }
}

export function findObjects(query, kinds, limit = 100) {
  const terms = normalise(query).split(' ').filter(Boolean);
  if (!terms.length || !Array.isArray(kinds) || !kinds.length) return [];
  const phrase = `%${terms.join('%')}%`;
  const rows = selectLocalObjects.all(JSON.stringify(kinds), phrase, phrase, phrase,
    Math.min(500, Math.max(1, Number(limit) || 100)));
  return rows.flatMap(({ kind, payload }) => {
    try {
      const item = JSON.parse(payload);
      return [{ ...item, resource_type: item.resource_type || kind }];
    } catch { return []; }
  });
}

// Everything Inkwell has learned of one kind, for the Threads browse page. This
// reads only the local catalogue: the page shows what you have actually
// explored rather than a keyword guess at what exists.
export function listObjects(kind, { publisher = '', limit = 60 } = {}) {
  const phrase = publisher ? `%${normalise(publisher)}%` : '';
  const rows = selectObjectsByKind.all(String(kind), phrase, phrase,
    Math.min(200, Math.max(1, Number(limit) || 60)));
  return rows.flatMap(({ payload, credits }) => {
    try { return [{ ...JSON.parse(payload), credits: Number(credits) || 0 }]; } catch { return []; }
  });
}

export function publisherArt(publisher, limit = 3) {
  if (!publisher) return [];
  const cap = Math.min(24, Math.max(1, Number(limit) || 3));
  const run = (pattern) => selectPublisherArt.all(pattern, cap).map((row) => String(row.id));
  // ComicVine's own spelling is not always ours: it files Image Comics as
  // "Image", so the full-name match returned nothing and that tile had no art
  // at all. Fall back to the leading word, but only when the exact name misses
  // -- matching "marvel%" up front would drag in Marvel UK's reprints.
  const exact = run(`%${normalise(publisher)}%`);
  if (exact.length) return exact;
  const lead = normalise(publisher).split(' ')[0];
  return lead ? run(`${lead}%`) : [];
}

// Browsing by decade is pure local SQLite: no ComicVine call, so it keeps
// working through a rate limit — which is exactly when a reader still wants
// something to look at.
const selectDecades = db.prepare(`SELECT (CAST(start_year AS INTEGER) / 10) * 10 AS decade,
    COUNT(*) AS titles
  FROM catalogue_volumes
  WHERE start_year GLOB '[0-9][0-9][0-9][0-9]'
  GROUP BY decade HAVING titles >= 3 ORDER BY decade DESC`);

const selectDecadeArt = db.prepare(`SELECT id FROM catalogue_volumes
  WHERE start_year GLOB '[0-9][0-9][0-9][0-9]'
    AND CAST(start_year AS INTEGER) BETWEEN ? AND ?
    AND json_extract(payload, '$.image.medium_url') IS NOT NULL
  ORDER BY issue_count DESC, fetched_at DESC LIMIT ?`);

const selectDecadeVolumes = db.prepare(`SELECT payload FROM catalogue_volumes
  WHERE start_year GLOB '[0-9][0-9][0-9][0-9]'
    AND CAST(start_year AS INTEGER) BETWEEN ? AND ?
  ORDER BY issue_count DESC, fetched_at DESC LIMIT ? OFFSET ?`);

const countDecadeVolumes = db.prepare(`SELECT COUNT(*) AS total FROM catalogue_volumes
  WHERE start_year GLOB '[0-9][0-9][0-9][0-9]'
    AND CAST(start_year AS INTEGER) BETWEEN ? AND ?`);

export function decades(artPerDecade = 8) {
  return selectDecades.all().map(({ decade, titles }) => ({
    decade: Number(decade),
    titles: Number(titles),
    art: selectDecadeArt.all(Number(decade), Number(decade) + 9, artPerDecade).map((r) => String(r.id)),
  }));
}

export function decadeVolumes(decade, { limit = 48, offset = 0 } = {}) {
  const from = Number(decade);
  if (!Number.isFinite(from)) return { items: [], total: 0 };
  const size = Math.min(96, Math.max(1, Number(limit) || 48));
  const rows = selectDecadeVolumes.all(from, from + 9, size, Math.max(0, Number(offset) || 0));
  return {
    total: Number(countDecadeVolumes.get(from, from + 9)?.total) || 0,
    items: rows.flatMap(({ payload }) => {
      try { return [JSON.parse(payload)]; } catch { return []; }
    }),
  };
}

// Lore names an entity; ComicVine gives it an id we can navigate to. This is
// the bridge between the two: an exact name match in what we already hold.
const selectObjectByName = db.prepare(`SELECT payload FROM catalogue_objects
  WHERE kind = ? AND name_normalized = ? LIMIT 1`);

export function findObjectByName(kind, name) {
  const row = selectObjectByName.get(String(kind), normalise(name));
  if (!row) return null;
  try { return JSON.parse(row.payload); } catch { return null; }
}

// A curated seed names a record rather than describing one, so an exact name
// already in the mirror answers it without spending a provider call. Several
// records can share a name -- ComicVine files a 38-appearance bit part called
// "Superman" too -- so the most-published wins, the same tiebreak the search
// path applies to its own matches.
const selectObjectsByExactName = db.prepare(`SELECT payload FROM catalogue_objects
  WHERE kind = ? AND name_normalized = ?
  ORDER BY COALESCE(json_extract(payload, '$.count_of_issue_appearances'), 0) DESC
  LIMIT 8`);

export function findObjectsByName(kind, name) {
  return selectObjectsByExactName.all(String(kind), normalise(name)).flatMap(({ payload }) => {
    try { return [JSON.parse(payload)]; } catch { return []; }
  });
}

// Relationship rails only use observed credits from stored volume details.
// They never pretend a keyword match is a genuine creator/character credit.
export function relatedVolumes(kind, id, exceptVolumeId = '', limit = 12) {
  const rows = selectRelatedVolumes.all(String(kind), String(id), String(exceptVolumeId),
    Math.min(48, Math.max(1, Number(limit) || 12)));
  return rows.flatMap(({ payload }) => {
    try { return [JSON.parse(payload)]; } catch { return []; }
  });
}

// A deliberately broad candidate retrieval; Inkwell's transparent relevance
// scorer still supplies the final ordering. SQLite serves this even when the
// provider is limited or offline.
export function findVolumes(query, limit = 300) {
  const terms = normalise(query).split(' ').filter(Boolean);
  if (!terms.length) return [];
  const phrase = `%${terms.join('%')}%`;
  const rows = selectLocalVolumes.all(phrase, phrase, phrase, Math.min(500, Math.max(1, Number(limit) || 300)));
  return rows.flatMap(({ payload }) => {
    try { return [JSON.parse(payload)]; } catch { return []; }
  });
}

// Mylar's issue IDs are the IDs its queue API accepts. Persisting them means a
// collection picker can reopen instantly and keeps its prior statuses even if
// Mylar is temporarily slow or unavailable.
export function rememberMylarParts(comicId, data) {
  const comic = Array.isArray(data?.comic) ? data.comic[0] : data?.comic;
  const issues = Array.isArray(data?.issues) ? data.issues : [];
  if (!comic?.id && !issues.length) return false;
  const now = Date.now();
  db.exec('BEGIN');
  try {
    if (comic) {
      upsertMylarSeries.run(String(comicId), comic.name ?? null, comic.publisher ?? null,
        comic.year == null ? null : String(comic.year), comic.status ?? null, now);
    }
    for (const issue of issues) {
      if (issue?.id == null) continue;
      upsertMylarPart.run(String(comicId), String(issue.id), issue.number == null ? null : String(issue.number),
        issue.name ?? null, String(issue.status || 'Skipped'), now);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return Boolean(comic);
}

export function getMylarParts(comicId) {
  const series = selectMylarSeries.get(String(comicId));
  const parts = selectMylarParts.all(String(comicId)).map((part) => ({
    id: String(part.issue_id), number: String(part.number ?? ''), name: part.name ?? null,
    status: String(part.status || 'Skipped'), updatedAt: Number(part.updated_at),
  }));
  return { tracked: Boolean(series), parts, updatedAt: Number(series?.updated_at || 0) };
}

export function setMylarPartStatus(comicId, issueId, status) {
  updateMylarPart.run(String(status), Date.now(), String(comicId), String(issueId));
}

// Mylar has been told to forget this series; Inkwell's copy of its parts is now
// a fiction. Only the mirror of Mylar's state goes -- the catalogue entry and
// its covers are ComicVine's, and the reader may well request it again.
// Returns false when this exact event was already recorded, so a caller can
// skip the push without a second lookup.
export function recordEvent({ key, kind, title, detail = null, at = Date.now(), whenLocal = null }) {
  const existing = selectEvent.get(String(key));
  if (existing) return false;
  insertEvent.run(String(key), String(kind), String(title), detail == null ? null : String(detail),
    Number(at), whenLocal == null ? null : String(whenLocal));
  // A log nobody prunes becomes a table nobody reads. Recent history is all
  // this is for; Mylar keeps the authoritative record.
  trimEvents.run();
  return true;
}

export function listEvents(limit = 12) {
  return selectEvents.all(Math.min(100, Math.max(1, Number(limit) || 12))).map((row) => ({
    key: row.key, kind: row.kind, title: row.title, detail: row.detail,
    at: Number(row.at), whenLocal: row.when_local ?? null,
  }));
}

export function forgetMylarSeries(comicId) {
  db.exec('BEGIN');
  try {
    deleteMylarParts.run(String(comicId));
    deleteMylarSeries.run(String(comicId));
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function listMylarParts() {
  return selectRequestParts.all().map((part) => ({
    comicId: String(part.comic_id), issueId: String(part.issue_id), number: String(part.number ?? ''),
    name: part.name ?? null, status: String(part.status || 'Skipped'), updatedAt: Number(part.updated_at),
    series: part.series_name ?? 'Unknown series', publisher: part.publisher ?? null, year: part.year ?? null,
  }));
}

export function getCover(volumeId) {
  const row = selectCover.get(String(volumeId));
  return row ? {
    sourceUrl: row.source_url, fileName: row.file_name, mimeType: row.mime_type,
    byteSize: Number(row.byte_size), fetchedAt: Number(row.fetched_at),
  } : null;
}

export function rememberCover(volumeId, cover) {
  upsertCover.run(String(volumeId), cover.sourceUrl, cover.fileName, cover.mimeType,
    Number(cover.byteSize), Date.now());
}

export function enqueueEnrichment(kind, ids, reason = 'browse') {
  const allowed = new Set(['volume', 'person', 'character', 'team', 'story_arc', 'seed']);
  if (!allowed.has(String(kind))) return 0;
  const unique = [...new Set((Array.isArray(ids) ? ids : [ids])
    .map((id) => String(id ?? ''))
    .filter((id) => String(kind) === 'seed'
      ? id.trim().length >= 2 && id.length <= 120
      : /^\d+$/.test(id)))].slice(0, 100);
  const now = Date.now();
  db.exec('BEGIN');
  try {
    for (const id of unique) queueEnrichment.run(String(kind), id, String(reason).slice(0, 40), now, now);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return unique.length;
}

// One Node process owns this queue. A row marked running after an unclean
// shutdown is harmlessly made eligible again on the next boot.
resetRunningEnrichment.run(Date.now(), Date.now());

export function claimNextEnrichment() {
  const row = claimEnrichment.get(Date.now());
  if (!row) return null;
  const changed = markEnrichmentRunning.run(Date.now(), row.kind, row.id);
  return changed.changes ? { kind: row.kind, id: String(row.id), reason: row.reason, attempts: Number(row.attempts) + 1 } : null;
}

export function completeEnrichment(kind, id) {
  finishEnrichment.run(Date.now(), String(kind), String(id));
}

export function postponeEnrichment(kind, id, error, delayMs = 60_000) {
  const safeDelay = Math.max(5_000, Math.min(24 * 60 * 60_000, Number(delayMs) || 60_000));
  delayEnrichment.run(Date.now() + safeDelay, Date.now(), String(error || 'Temporary provider error').slice(0, 400), String(kind), String(id));
}

export function enrichmentStats() {
  const row = enrichmentSummary.get();
  return {
    pending: Number(row.pending || 0), running: Number(row.running || 0), done: Number(row.done || 0),
    nextAt: Number(row.next_at || 0),
  };
}

// A one-time-on-startup migration path for the cache Inkwell already accumulated
// before the mirror existed. Invalid/non-volume payloads are ignored by
// rememberVolumes, and nothing here reaches the network.
function hydrateMirrorFromCachedResponses() {
  for (const { value } of cachedPayloads.all()) {
    try {
      const payload = JSON.parse(value);
      rememberVolumes(payload);
      rememberObjects('cached', payload);
    } catch { /* old cache data is optional */ }
  }
}

hydrateMirrorFromCachedResponses();

export function read(key) {
  const row = selectOne.get(key);
  if (!row) return null;
  try {
    return { value: JSON.parse(row.value), at: Number(row.at) };
  } catch {
    removeOne.run(key);
    return null;
  }
}

export function write(key, value) {
  upsert.run(key, JSON.stringify(value), Date.now());
  return value;
}

export function drop(key) {
  removeOne.run(key);
}

export function stats() {
  const row = cacheSummary.get();
  const catalogue = catalogueSummary.get();
  const objects = objectSummary.get();
  const links = linkSummary.get();
  const mylar = mylarPartSummary.get();
  const covers = coverSummary.get();
  const enrichment = enrichmentStats();
  return {
    entries: Number(row.entries), oldest: Number(row.oldest), newest: Number(row.newest),
    volumes: Number(catalogue.volumes), objects: Number(objects.objects), links: Number(links.links),
    mylarParts: Number(mylar.parts), covers: Number(covers.covers), coverBytes: Number(covers.bytes),
    catalogueOldest: Number(catalogue.oldest), catalogueNewest: Number(catalogue.newest), enrichment,
  };
}

// Cache entries are derived ComicVine/Metron responses only, never watchlist or
// request data. This is intentionally a separate explicit user action.
export function clear() {
  db.exec('DELETE FROM cache');
}

// In-flight work, so a slow producer is never started twice concurrently.
const running = new Map();

function start(key, produce) {
  if (running.has(key)) return running.get(key);
  const task = Promise.resolve()
    .then(produce)
    .then((value) => write(key, value))
    .finally(() => running.delete(key));
  running.set(key, task);
  return task;
}

// Await a fresh value; serve a stale one instantly and refresh behind it.
export async function cached(key, maxAge, produce) {
  const hit = read(key);
  if (hit && Date.now() - hit.at < maxAge) return hit.value;
  if (hit) {
    start(key, produce).catch(() => {});
    return hit.value;
  }
  return start(key, produce);
}

// Never block. Returns what is on disk (possibly nothing) and warms behind it,
// so an expensive answer costs one slow visit ever rather than one per restart.
export function eager(key, maxAge, produce) {
  const hit = read(key);
  const stale = !hit || Date.now() - hit.at >= maxAge;
  if (stale) start(key, produce).catch(() => {});
  return {
    value: hit?.value ?? null,
    at: hit?.at ?? null,
    pending: !hit,
    refreshing: stale && Boolean(hit),
  };
}
