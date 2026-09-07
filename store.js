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
db.exec('CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, at INTEGER NOT NULL)');

const selectOne = db.prepare('SELECT value, at FROM cache WHERE key = ?');
const upsert = db.prepare(
  'INSERT INTO cache (key, value, at) VALUES (?, ?, ?) ' +
  'ON CONFLICT(key) DO UPDATE SET value = excluded.value, at = excluded.at'
);
const removeOne = db.prepare('DELETE FROM cache WHERE key = ?');

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
