import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const storeUrl = pathToFileURL(path.join(root, 'store.js')).href;

function isolatedConfig() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-migration-test-'));
}

function runStoreResult(configDir, source) {
  const env = { ...process.env, CONFIG_DIR: configDir };
  delete env.CACHE_DB;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
  return result;
}

function runStore(configDir, source) {
  const result = runStoreResult(configDir, source);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

test('a fresh CONFIG_DIR creates a versioned SQLite database and retains state across restart', () => {
  const configDir = isolatedConfig();
  runStore(configDir, `
    const store = await import(${JSON.stringify(storeUrl)});
    store.write('persistence-check', { retained: true });
    console.log(JSON.stringify(store.databaseLifecycle()));
    store.close();
  `);

  const database = path.join(configDir, 'cache.db');
  assert.ok(fs.existsSync(database));
  const db = new DatabaseSync(database, { readOnly: true });
  // Not a hard-coded list: that only ever asserted "somebody edited this test
  // too". What has to hold is that every migration ran, in order, with no gap
  // -- a gap is how a half-migrated database gets mistaken for a current one.
  const applied = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((row) => row.version);
  assert.ok(applied.length >= 4, 'no migrations were recorded');
  assert.deepEqual(applied, applied.map((_, index) => index + 1), 'migration versions must be gapless and start at 1');
  db.close();

  const output = runStore(configDir, `
    const store = await import(${JSON.stringify(storeUrl)});
    console.log(JSON.stringify(store.read('persistence-check')));
    store.close();
  `);
  assert.match(output, /"retained":true/);
});

test('a legacy database is migrated in place with a pre-migration backup', () => {
  const configDir = isolatedConfig();
  const database = path.join(configDir, 'cache.db');
  const legacy = new DatabaseSync(database);
  legacy.exec(`
    CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE TABLE events (key TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, detail TEXT, at INTEGER NOT NULL);
    INSERT INTO cache VALUES ('legacy', '{"kept":true}', 1);
  `);
  legacy.close();

  const output = runStore(configDir, `
    const store = await import(${JSON.stringify(storeUrl)});
    console.log(JSON.stringify(store.read('legacy')));
    store.close();
  `);

  assert.match(output, /"kept":true/);
  assert.match(output, /pre-migration backup/);
  assert.equal(fs.readdirSync(path.join(configDir, 'backups')).filter((name) => name.endsWith('.db')).length, 1);

  const migrated = new DatabaseSync(database, { readOnly: true });
  assert.ok(migrated.prepare('PRAGMA table_info(events)').all().some((column) => column.name === 'when_local'));
  assert.ok(migrated.prepare("SELECT value FROM application_settings WHERE key = 'installation'").get());
  migrated.close();
});

test('a database from a newer schema refuses to start instead of downgrading', () => {
  const configDir = isolatedConfig();
  const database = path.join(configDir, 'cache.db');
  const newer = new DatabaseSync(database);
  newer.exec(`
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL);
    INSERT INTO schema_migrations VALUES (999, 'future-release', 1);
  `);
  newer.close();

  const result = runStoreResult(configDir, `await import(${JSON.stringify(storeUrl)});`);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /newer than this Inkwell release/);
});

test('an unavailable persistent path fails with an actionable startup error', () => {
  const parent = isolatedConfig();
  const invalidConfig = path.join(parent, 'not-a-directory');
  fs.writeFileSync(invalidConfig, 'not a directory');
  const result = runStoreResult(invalidConfig, `await import(${JSON.stringify(storeUrl)});`);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /cannot open its persistent SQLite database.*Ensure \/config is mounted, writable/i);
});
