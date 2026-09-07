// Marvel Developer API provider.
//
// ComicVine is broad but cannot sort, cannot filter by publisher, has no format
// field worth trusting, and its character→volume link is broken (volume_credits
// returns 1 for Spider-Man). Marvel's own API fixes all four for Marvel books:
// real orderBy, a formatType=collection filter that actually means "collected
// edition", /characters/{id}/comics as a genuine link, and /events — crossovers
// as first-class objects with their own characters and comics.
//
// Entirely optional. Without keys every call resolves empty and callers fall
// back to ComicVine, so the app behaves identically to before.

import crypto from 'node:crypto';
import { cached } from './store.js';

const BASE = 'https://gateway.marvel.com/v1/public';
const publicKey = (process.env.MARVEL_PUBLIC_KEY || '').trim();
const privateKey = (process.env.MARVEL_PRIVATE_KEY || '').trim();

export const available = () => Boolean(publicKey && privateKey);

// Marvel authenticates with a timestamp plus md5(ts + private + public).
function auth() {
  const ts = String(Date.now());
  return {
    ts,
    apikey: publicKey,
    hash: crypto.createHash('md5').update(ts + privateKey + publicKey).digest('hex'),
  };
}

async function call(path, params = {}) {
  if (!available()) return [];
  const query = new URLSearchParams({ ...params, ...auth() });
  const response = await fetch(`${BASE}/${path}?${query}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401) throw new Error('Marvel rejected the API keys.');
  if (!response.ok) throw new Error(`Marvel returned HTTP ${response.status}`);
  const body = await response.json();
  return body?.data?.results ?? [];
}

// Marvel splits the image across two fields and uses a known placeholder path
// for "no picture", which is worth dropping rather than rendering.
function image(thumbnail, variant = 'portrait_uncanny') {
  if (!thumbnail?.path || /image_not_available/i.test(thumbnail.path)) return null;
  return `${thumbnail.path.replace(/^http:/, 'https:')}/${variant}.${thumbnail.extension}`;
}

export async function findCharacter(name) {
  if (!available() || !name) return null;
  return cached(`marvel:char:${name.toLowerCase()}`, 30 * 24 * 60 * 60_000, async () => {
    const exact = await call('characters', { name, limit: '1' });
    if (exact.length) return { id: exact[0].id, name: exact[0].name };
    const near = await call('characters', { nameStartsWith: name.slice(0, 24), limit: '1' });
    return near.length ? { id: near[0].id, name: near[0].name } : null;
  });
}

// Crossovers, properly: an event is a real object with its own cast, so this is
// the question ComicVine could never answer.
export async function events(characterId) {
  if (!available()) return [];
  return cached(`marvel:events:${characterId}`, 7 * 24 * 60 * 60_000, async () => {
    const rows = await call(`characters/${characterId}/events`, { limit: '20', orderBy: '-startDate' });
    return rows.map((event) => ({
      id: String(event.id),
      title: event.title,
      description: event.description || null,
      image: image(event.thumbnail, 'portrait_incredible'),
      start: event.start ? String(event.start).slice(0, 4) : null,
      characters: (event.characters?.items ?? []).slice(0, 8).map((c) => c.name),
      comics: event.comics?.available ?? 0,
    }));
  });
}

// formatType=collection is the piece ComicVine has no equivalent for: it means
// omnibuses, hardcovers and trade paperbacks rather than single issues.
export async function collections(characterId) {
  if (!available()) return [];
  return cached(`marvel:collections:${characterId}`, 7 * 24 * 60 * 60_000, async () => {
    const rows = await call(`characters/${characterId}/comics`, {
      formatType: 'collection', noVariants: 'true', limit: '40', orderBy: '-onsaleDate',
    });
    return rows.map((comic) => ({
      id: String(comic.id),
      title: comic.title,
      format: comic.format || null,
      pages: comic.pageCount || null,
      image: image(comic.thumbnail),
      onSale: comic.dates?.find((d) => d.type === 'onsaleDate')?.date?.slice(0, 4) || null,
      issues: comic.issueNumber || null,
      url: comic.urls?.find((u) => u.type === 'detail')?.url || null,
    }));
  });
}
