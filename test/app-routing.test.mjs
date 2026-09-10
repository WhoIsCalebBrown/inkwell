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

test('a filter that empties a page says so instead of drawing an empty grid', () => {
  const books = app.slice(app.indexOf('const filteredOut ='), app.indexOf("routes.library"));

  // The bug this guards: the branch keyed off `items.length`, the page the
  // server sent, so a standing format filter rendered the note, the filter row
  // and two pagers around nothing at all.
  assert.match(books, /const filteredOut = Boolean\(items\.length\) && !shown\.length/);
  assert.match(books, /filteredOut\s*\?\s*`\$\{note\}\$\{filterBar\(items\.length, 0\)\}\$\{filteredEmpty\}`/);
  assert.doesNotMatch(books, /innerHTML = items\.length/);
  // It must offer the way out, and admit the filter only saw this page.
  assert.match(books, /data-clear-filter/);
  assert.match(books, /on this page/);
});
