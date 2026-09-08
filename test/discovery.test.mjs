import assert from 'node:assert/strict';
import test from 'node:test';
import {
  allRailDefinitions, buildDiscoveryCatalogue, buildDiscoveryContext,
  generatedRailDefinitions, personalizedRailDefinitions, resolveRail, selectRails,
} from '../discovery.js';

function volume(id, {
  name = `Book ${id}`, publisher = 'Marvel', year = 2005, issues = 12,
} = {}) {
  return {
    id: String(id), resource_type: 'volume', name, publisher: { name: publisher },
    start_year: String(year), count_of_issues: issues,
    image: { medium_url: `https://covers.example/${id}.jpg` },
  };
}

function catalogue(volumes, links = []) {
  return buildDiscoveryCatalogue({ volumes, links });
}

const rail = (id, filters, options = {}) => ({
  id, title: id, filters, topics: [id], ranking: 'notability',
  display: { preview: 14, minimum: 2, explore: true }, ...options,
});

test('composite filters require every metadata and relationship condition', () => {
  const data = catalogue([
    volume(1, { name: 'Spider-Man Omnibus', year: 2004 }),
    volume(2, { name: 'Spider-Man Omnibus', year: 1994 }),
    volume(3, { name: 'Batman Omnibus', year: 2004 }),
  ], [
    { fromKind: 'volume', fromId: '1', toKind: 'character', toId: '99', toName: 'Spider-Man' },
    { fromKind: 'volume', fromId: '2', toKind: 'character', toId: '99', toName: 'Spider-Man' },
    { fromKind: 'volume', fromId: '3', toKind: 'character', toId: '1', toName: 'Batman' },
  ]);
  const result = resolveRail(rail('modern-spider-man', { all: [
    { field: 'character', op: 'is', value: '99' },
    { field: 'edition', op: 'is', value: 'Omnibus' },
    { field: 'year', op: 'gte', value: 2000 },
  ] }, { display: { preview: 14, minimum: 1 } }), data);
  assert.deepEqual(result.items.map((item) => item.id), ['1']);
  assert.equal(result.total, 1);
});

test('character rails prefer a character-titled series over a minor crossover appearance', () => {
  const ironMan = volume(1, { name: 'Iron Man' });
  ironMan.characters = [{ id: '99', name: 'Spider-Man', count: '40' }];
  const spiderMan = volume(2, { name: 'The Amazing Spider-Man' });
  spiderMan.characters = [{ id: '99', name: 'Spider-Man', count: '2' }];
  const data = catalogue([ironMan, spiderMan], [
    { fromKind: 'volume', fromId: '1', toKind: 'character', toId: '99', toName: 'Spider-Man' },
    { fromKind: 'volume', fromId: '2', toKind: 'character', toId: '99', toName: 'Spider-Man' },
  ]);
  const result = resolveRail(rail('spider-man', { field: 'character', op: 'is', value: '99' }, {
    ranking: 'relationship-relevance', relationship: { kind: 'character', id: '99', name: 'Spider-Man' },
    display: { preview: 14, minimum: 1 },
  }), data);
  assert.deepEqual(result.items.map((item) => item.id), ['2', '1']);
});

test('preview diversification does not corrupt the collection total', () => {
  const data = catalogue(Array.from({ length: 8 }, (_, index) => volume(index + 1)));
  const result = resolveRail(rail('all-books', { field: 'year', op: 'gte', value: 2000 }, {
    display: { preview: 3, minimum: 1 },
  }), data);
  assert.equal(result.items.length, 3);
  assert.equal(result.total, 8);
});

test('stable-random ordering remains stable for the same rail and session seed', () => {
  const data = catalogue(Array.from({ length: 8 }, (_, index) => volume(index + 1)));
  const definition = rail('stable', { field: 'year', op: 'gte', value: 2000 }, {
    ranking: 'stable-random', display: { preview: 4, minimum: 1 },
  });
  const first = resolveRail(definition, data, {}, { seed: 'one-session' });
  const second = resolveRail(definition, data, {}, { seed: 'one-session' });
  assert.deepEqual(first.items.map((item) => item.id), second.items.map((item) => item.id));
});

test('non-volume mirror rows never become discovery cards', () => {
  const data = catalogue([
    volume(1, { name: 'Valid Omnibus' }),
    { id: '2', kind: 'team', name: 'Avengers', image: { medium_url: 'https://covers.example/2.jpg' } },
    { id: '3', resource_type: 'character', name: 'Spider-Man', image: { medium_url: 'https://covers.example/3.jpg' } },
    { id: '4', name: 'Unclassified object', image: { medium_url: 'https://covers.example/4.jpg' } },
  ]);
  const result = resolveRail(rail('all', { any: [
    { field: 'year', op: 'gte', value: 1900 }, { field: 'year', op: 'lte', value: 2100 },
  ] }, { display: { preview: 14, minimum: 1 } }), data);
  assert.deepEqual(result.items.map((item) => item.id), ['1']);
});

test('thin rails are skipped by the selector', () => {
  const data = catalogue([volume(1), volume(2), volume(3)]);
  const thin = rail('thin', { field: 'year', op: 'gte', value: 2000 }, { display: { preview: 14, minimum: 4 } });
  const usable = rail('usable', { field: 'year', op: 'gte', value: 2000 });
  const selected = selectRails([thin, usable], data, {}, { batchSize: 2 });
  assert.deepEqual(selected.map((item) => item.id), ['usable']);
});

test('served definitions are not returned by later batches', () => {
  const data = catalogue([volume(1), volume(2), volume(3)]);
  const first = rail('first', { field: 'year', op: 'gte', value: 2000 });
  const second = rail('second', { field: 'year', op: 'gte', value: 2000 });
  const selected = selectRails([first, second], data, {}, { servedIds: ['first'], batchSize: 2 });
  assert.deepEqual(selected.map((item) => item.id), ['second']);
});

test('near-identical neighbouring previews are deferred in favour of a distinct rail', () => {
  const data = catalogue([
    ...Array.from({ length: 7 }, (_, index) => volume(`m${index}`, { publisher: 'Marvel' })),
    ...Array.from({ length: 6 }, (_, index) => volume(`d${index}`, { publisher: 'DC Comics' })),
  ]);
  const marvel = rail('marvel', { field: 'publisher', op: 'starts-with', value: 'Marvel' }, { priority: 3 });
  const sameMarvelAgain = rail('marvel-again', { field: 'publisher', op: 'starts-with', value: 'Marvel' }, { priority: 2 });
  const dc = rail('dc', { field: 'publisher', op: 'starts-with', value: 'DC Comics' }, { priority: 1 });
  const selected = selectRails([marvel, sameMarvelAgain, dc], data, {}, { batchSize: 3 });
  assert.deepEqual(selected.map((item) => item.id), ['marvel', 'dc']);
});

test('generated entity rails are capped and require recorded volume relationships', () => {
  const volumes = Array.from({ length: 7 }, (_, index) => volume(index + 1));
  const links = volumes.map((item) => ({
    fromKind: 'volume', fromId: item.id, toKind: 'character', toId: '777', toName: 'Catalogue Hero',
  }));
  const generated = generatedRailDefinitions(catalogue(volumes, links));
  assert.ok(generated.some((definition) => definition.id === 'character:777'));
  assert.ok(generated.filter((definition) => definition.id.startsWith('character:')).length <= 12);
});

test('metadata buckets generate reusable composite publisher-format definitions', () => {
  const data = catalogue(Array.from({ length: 6 }, (_, index) => volume(index + 1, {
    name: `Marvel Epic Collection ${index + 1}`, publisher: 'Marvel',
  })));
  const definition = generatedRailDefinitions(data)
    .find((item) => item.id === 'publisher:marvel:edition:epic-collection');
  assert.ok(definition);
  assert.deepEqual(resolveRail(definition, data).items.map((item) => item.id).sort(), ['1', '2', '3', '4', '5', '6']);
});

test('a new reader receives general definitions while personal rails fall back cleanly', () => {
  const data = catalogue([volume(1), volume(2)]);
  const context = buildDiscoveryContext(data, []);
  assert.deepEqual(personalizedRailDefinitions(data, context), []);
  assert.ok(allRailDefinitions(data, context).some((item) => item.id === 'omnibus'));
});

test('a tracked publisher produces a truthful personal rail before detail enrichment finishes', () => {
  const data = catalogue([volume(1), volume(2)]);
  const context = buildDiscoveryContext(data, [{ id: 'not-yet-mirrored', publisher: 'Marvel' }]);
  assert.ok(personalizedRailDefinitions(data, context)
    .some((item) => item.title === 'Continue Exploring Marvel'));
});

test('personal character rails require the character in both the record and title', () => {
  const owned = volume(1, { name: 'Amazing Spider-Man' });
  const crossover = volume(2, { name: 'Avengers' });
  const stories = Array.from({ length: 6 }, (_, index) => volume(index + 3, {
    name: `Spider-Man Story ${index + 1}`, year: 2001 + index,
  }));
  const volumes = [owned, crossover, ...stories];
  const links = volumes.map((item) => ({
    fromKind: 'volume', fromId: item.id, toKind: 'character', toId: '99', toName: 'Spider-Man',
  }));
  const data = catalogue(volumes, links);
  const context = buildDiscoveryContext(data, [{ id: '1', publisher: 'Marvel' }]);
  const definition = personalizedRailDefinitions(data, context).find((item) => item.id === 'because:character:99');
  assert.ok(definition);
  assert.deepEqual(resolveRail(definition, data, context, { preview: 14 }).items.map((item) => item.id).sort(),
    stories.map((item) => item.id).sort());
});

test('personal affinities remain scoped to the request library', () => {
  const data = catalogue([volume(1), volume(2), volume(3)], [
    { fromKind: 'volume', fromId: '1', toKind: 'character', toId: '99', toName: 'Spider-Man' },
    { fromKind: 'volume', fromId: '2', toKind: 'character', toId: '99', toName: 'Spider-Man' },
    { fromKind: 'volume', fromId: '3', toKind: 'character', toId: '5', toName: 'Batman' },
  ]);
  const readerA = buildDiscoveryContext(data, [{ id: '1' }]);
  const readerB = buildDiscoveryContext(data, [{ id: '3' }]);
  assert.match(personalizedRailDefinitions(data, readerA)[0].title, /Spider-Man/);
  assert.match(personalizedRailDefinitions(data, readerB)[0].title, /Batman/);
});
