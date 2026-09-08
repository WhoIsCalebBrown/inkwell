import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');

test('part picker state cannot be mistaken for a discovery collection route', () => {
  const volumeSheet = app.slice(app.indexOf('async function openVolume'), app.indexOf('const pause ='));
  const picker = app.slice(app.indexOf('function renderPartPicker'), app.indexOf('async function openPartPicker'));

  assert.match(volumeSheet, /id="collection-request"[^>]*data-preselect-parts=/);
  assert.doesNotMatch(volumeSheet, /id="collection-request"[^>]*data-collection=/);
  assert.match(picker, /slot\.dataset\.preselectParts === 'true'/);
});
