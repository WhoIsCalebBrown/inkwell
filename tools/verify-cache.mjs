// Offline integrity audit for Inkwell's persisted ComicVine mirror.
//
// This intentionally does not call any provider. It proves that every saved
// relationship is backed by the field in the cached source document that
// created it, so a "Sabretooth" rail can never be a loose title match.
//
// It reads in pages, holding one source document at a time. The first version
// joined every link to its source in one query, which meant a copy of an
// omnibus payload — hundreds of characters each — for every one of its
// hundreds of links: 26,000 links was enough to exhaust a 4GB heap.

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const file = process.env.CACHE_DB || path.join(root, 'data', 'cache.db');
const db = new DatabaseSync(file, { readOnly: true });
const PAGE = 2000;

const fieldForRelation = {
  created_by: 'people', features: 'characters', member_of: 'teams',
  related_to: 'character_friends', opposes: 'character_enemies',
};

const failures = [];
const note = (failure) => { if (failures.length < 5000) failures.push(failure); };

// A volume's payload must be parseable and must be the volume it is filed as.
// json_extract does that in SQLite, so no payload crosses into JS at all.
const volumeCount = db.prepare('SELECT COUNT(*) AS n FROM catalogue_volumes').get().n;
for (const row of db.prepare(`SELECT id, json_valid(payload) AS valid,
    json_extract(payload, '$.id') AS payload_id FROM catalogue_volumes`).all()) {
  if (!row.valid) note({ type: 'invalid-volume-payload', id: row.id });
  else if (String(row.payload_id) !== String(row.id)) note({ type: 'volume-id', id: row.id });
}

// Links, ordered so every edge out of one document arrives together and its
// payload is parsed once.
const linkCount = db.prepare('SELECT COUNT(*) AS n FROM catalogue_links').get().n;
const linkPage = db.prepare(`SELECT from_kind, from_id, relation, to_kind, to_id, to_name
  FROM catalogue_links ORDER BY from_kind, from_id LIMIT ? OFFSET ?`);
const volumePayload = db.prepare('SELECT payload FROM catalogue_volumes WHERE id = ?');
const objectPayload = db.prepare('SELECT payload FROM catalogue_objects WHERE kind = ? AND id = ?');

let loadedKey = null;
let loaded = null;
for (let offset = 0; offset < linkCount; offset += PAGE) {
  for (const edge of linkPage.all(PAGE, offset)) {
    const field = fieldForRelation[edge.relation];
    if (!field) { note({ type: 'unknown-relation', edge }); continue; }
    const key = `${edge.from_kind}/${edge.from_id}`;
    if (key !== loadedKey) {
      loadedKey = key;
      const row = edge.from_kind === 'volume'
        ? volumePayload.get(String(edge.from_id))
        : objectPayload.get(String(edge.from_kind), String(edge.from_id));
      try { loaded = row ? JSON.parse(row.payload) : null; } catch { loaded = null; }
    }
    if (!loaded) { note({ type: 'missing-source', from: key, relation: edge.relation }); continue; }
    const found = (loaded[field] || []).some((item) => String(item?.id) === String(edge.to_id));
    if (!found) {
      note({ type: 'unbacked-link', from: key, relation: edge.relation,
        to: `${edge.to_kind}/${edge.to_id}`, name: edge.to_name });
    }
  }
}

const report = {
  database: file, volumes: volumeCount, links: linkCount,
  failures: failures.length, samples: failures.slice(0, 12),
};
console.log(JSON.stringify(report, null, 2));
if (failures.length) process.exitCode = 1;
