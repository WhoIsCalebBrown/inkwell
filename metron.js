// Metron provider (metron.cloud).
//
// A community-curated comic database with cleaner relationships than ComicVine —
// notably real story arcs, which is where ComicVine is weakest.
//
// Metron sits behind an anti-bot layer (Anubis) and will block an IP at the TCP
// level for bursty traffic; that is not a theoretical risk, it happened while
// this was being built. So every request goes through a single-flight queue with
// a minimum gap between calls, and answers are cached on disk for a long time.
// Treat it as a slow, precious source: ask rarely, remember for ages.
//
// Optional. Without METRON_TOKEN every call resolves empty and callers fall
// back to ComicVine.

import { cached } from './store.js';

const BASE = 'https://metron.cloud/api';
// Read this lazily. In direct local Node development, server.js loads the
// gitignored .env after module resolution has begun; capturing it at import time
// would permanently see an empty value even though the token is available by
// the first request.
const token = () => (process.env.METRON_TOKEN || '').trim();

// Their docs describe HTTP basic auth; the API actually accepts a bearer token
// and rejects basic with "Invalid username/password".
const authHeader = () => {
  const value = token();
  return value ? `Bearer ${value}` : '';
};

export const available = () => Boolean(token());

const MIN_GAP_MS = 1500;
let lastCall = 0;
let chain = Promise.resolve();

// Serialise every call and space them out. Concurrency here is what gets the
// host banned, so there is deliberately no parallelism available.
function schedule(work) {
  const run = chain.then(async () => {
    const wait = Math.max(0, MIN_GAP_MS - (Date.now() - lastCall));
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    try {
      return await work();
    } finally {
      lastCall = Date.now();
    }
  });
  // Keep the chain alive even when a call rejects.
  chain = run.then(() => {}, () => {});
  return run;
}

async function call(path, params = {}, { timeout = 20_000 } = {}) {
  if (!available()) return null;
  const query = new URLSearchParams(params);
  return schedule(async () => {
    const response = await fetch(`${BASE}/${path}?${query}`, {
      headers: { Authorization: authHeader(), Accept: 'application/json' },
      signal: AbortSignal.timeout(timeout),
    });
    if (response.status === 401) throw new Error('Metron rejected the token.');
    if (response.status === 429) throw new Error('Metron is rate-limiting; back off.');
    if (!response.ok) throw new Error(`Metron returned HTTP ${response.status}`);
    return response.json();
  });
}

// Standard DRF envelope: { count, next, previous, results }.
const results = (page) => page?.results ?? [];

export async function seriesByName(name) {
  if (!available() || !name) return [];
  return cached(`metron:series:${name.toLowerCase()}`, 30 * 24 * 60 * 60_000, async () =>
    results(await call('series/', { name })).slice(0, 20));
}

export async function arcsByName(name) {
  if (!available() || !name) return [];
  return cached(`metron:arc:${name.toLowerCase()}`, 30 * 24 * 60 * 60_000, async () =>
    results(await call('arc/', { name })).slice(0, 20));
}

// Reachability probe used by /api/health, so a block or outage is visible
// rather than showing up as mysteriously missing sections.
export async function status() {
  if (!available()) return { available: false, reason: 'no-token' };
  try {
    // A reachability probe, not a data fetch: fail fast rather than holding a
    // diagnostic open for twenty seconds against a host that is not answering.
    const page = await call('series/', { name: 'batman' }, { timeout: 5_000 });
    return { available: true, reachable: true, sample: page?.count ?? 0 };
  } catch (error) {
    return { available: true, reachable: false, reason: error.message };
  }
}
