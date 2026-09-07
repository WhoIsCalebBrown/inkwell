// Offline integrity audit for Inkwell's persisted ComicVine mirror.
//
// This intentionally does not call any provider. It proves that every saved
// relationship is backed by the field in the cached source document that
// created it, so a “Sabretooth” rail can never be a loose title match.

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const file = process.env.CACHE_DB || path.join(root, 'data', 'cache.db');
const db = new DatabaseSync(file, { readOnly: true });

const fieldForRelation = {
  created_by: 'people', features: 'characters', member_of: 'teams',
  related_to: 'character_friends', opposes: 'character_enemies',
};

const sources = db.prepare(`SELECT l.from_kind, l.from_id, l.relation, l.to_kind, l.to_id, l.to_name,
  COALESCE(v.payload, o.payload) AS payload
  FROM catalogue_links l
  LEFT JOIN catalogue_volumes v ON l.from_kind = 'volume' AND v.id = l.from_id
  LEFT JOIN catalogue_objects o ON l.from_kind <> 'volume' AND o.kind = l.from_kind AND o.id = l.from_id`).all();
const volumes = db.prepare('SELECT id, payload FROM catalogue_volumes').all();

const failures = [];
for (const row of volumes) {
  try {
    if (String(JSON.parse(row.payload).id) !== String(row.id)) failures.push({ type: 'volume-id', id: row.id });
  } catch { failures.push({ type: 'invalid-volume-payload', id: row.id }); }
}
for (const edge of sources) {
  const field = fieldForRelation[edge.relation];
  if (!field) { failures.push({ type: 'unknown-relation', edge }); continue; }
  let payload;
  try { payload = JSON.parse(edge.payload); } catch { failures.push({ type: 'missing-source', edge }); continue; }
  const found = (payload[field] || []).some((item) => String(item?.id) === String(edge.to_id));
  if (!found) failures.push({ type: 'unbacked-link', from: `${edge.from_kind}/${edge.from_id}`, relation: edge.relation, to: `${edge.to_kind}/${edge.to_id}`, name: edge.to_name });
}

const report = { database: file, volumes: volumes.length, links: sources.length, failures: failures.length, samples: failures.slice(0, 12) };
console.log(JSON.stringify(report, null, 2));
if (failures.length) process.exitCode = 1;
