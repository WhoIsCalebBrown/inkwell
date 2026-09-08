// Discovery is intentionally a local, deterministic layer. ComicVine is a
// source of facts Inkwell already learned, not something scrolling Discover is
// allowed to query. This module knows how to combine those facts into rails;
// server.js owns provider calls and presentation shaping.

const MINIMUM_ITEMS = 6;
const DEFAULT_PREVIEW = 14;

const MANGA_PUBLISHERS = [
  'shueisha', 'kodansha', 'shogakukan', 'square enix', 'kadokawa', 'hakusensha',
  'futabasha', 'houbunsha', 'akita shoten', 'coremagazine', 'asahi sonorama',
  'jitsugyo no nihon sha', 'ascii media works', 'ichijinsha', 'media factory',
  'viz', 'seven seas', 'yen press', 'dark horse manga', 'vertical', 'tokyopop',
  'kodansha comics', 'denpa', 'ghost ship', 'j-novel', 'star fruit',
];

const EDITIONS = [
  ['Omnibus', /\bomnibus\b/],
  ['Compendium', /\bcompendium\b/],
  ['Absolute', /\babsolute\b/],
  ['Epic Collection', /\bepic collection\b/],
  ['Masterworks', /\b(masterworks|marvel masterworks)\b/],
  ['Deluxe edition', /\b(deluxe|oversized|treasury|artist.s edition|gallery edition)\b/],
  ['Library edition', /\b(library edition|complete collection|the complete|ultimate collection)\b/],
  ['Hardcover', /\b(hardcover|hard cover|\bhc\b)\b/],
  ['Collected edition', /\b(tpb|trade paperback|collected edition|collection|graphic novel|\bogn\b)/],
  ['Annual', /\bannual\b/],
  ['One-shot', /\b(one.shot|special|giant.size)\b/],
];

const PUBLISHER_WEIGHT = {
  Marvel: 100, 'DC Comics': 100, Image: 80, 'Dark Horse Comics': 60,
  'IDW Publishing': 50, 'Boom! Studios': 40, Vertigo: 70, Wildstorm: 40,
  Valiant: 40, 'Dynamite Entertainment': 30,
};

const CHARACTER_SEEDS = [
  'Batman', 'Spider-Man', 'Wolverine', 'X-Men', 'Fantastic Four', 'Avengers',
  'Justice League', 'Daredevil', 'Guardians of the Galaxy', 'Superman',
  'Wonder Woman', 'Deadpool',
];

const CREATOR_SEEDS = [
  'Jonathan Hickman', 'Brian Michael Bendis', 'Grant Morrison', 'Alan Moore',
  'Frank Miller', 'Robert Kirkman', 'Chris Claremont', 'Ed Brubaker',
  'Brian K. Vaughan', 'Junji Ito', 'Naoki Urasawa',
];

export const discoveryVersion = 'v1';

export function normalise(value = '') {
  return String(value ?? '').toLowerCase().normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function slug(value = '') {
  return normalise(value).replaceAll(' ', '-');
}

export function mediumOf(publisher = '') {
  const name = String(publisher || '').toLowerCase();
  return MANGA_PUBLISHERS.some((item) => name.includes(item)) ? 'manga' : 'comic';
}

export function editionOf(title = '') {
  return EDITIONS.find(([, pattern]) => pattern.test(String(title).toLowerCase()))?.[0] ?? 'Series';
}

function publisherOf(item) {
  return item.publisher?.name ?? item.publisher ?? '';
}

function coverOf(item) {
  const image = item.image || {};
  return image.medium_url || image.super_url || image.small_url || null;
}

function numberOf(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function volumeIdentity(item) {
  // This is deliberately conservative. ComicVine does not give Inkwell a
  // reliable work/edition graph, so a same-title, same-publisher, same-year
  // identity is only used to avoid obvious duplicates in one rail.
  return `${normalise(item.name)}|${normalise(publisherOf(item))}|${numberOf(item.start_year) || ''}`;
}

function franchiseOf(name = '') {
  const title = normalise(name);
  const known = ['star wars', 'batman', 'superman', 'x men', 'spider man', 'wolverine',
    'avengers', 'justice league', 'green lantern', 'fantastic four', 'walking dead',
    'saga', 'hellboy', 'one piece', 'fullmetal alchemist', 'berserk', 'vagabond'];
  const matched = known.find((key) => title.includes(key));
  if (matched) return matched;
  return title.replace(/\b(?:the|a|an|omnibus|compendium|absolute|edition|collection|volume|vol)\b/g, ' ')
    .trim().split(' ').slice(0, 3).join(' ');
}

function stableHash(value) {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function publisherWeight(name = '') {
  return Object.entries(PUBLISHER_WEIGHT).find(([publisher]) => String(name).startsWith(publisher))?.[1] ?? 0;
}

function notability(item) {
  const year = numberOf(item.start_year) || new Date().getFullYear();
  const legacy = Math.min(180, Math.max(0, new Date().getFullYear() - year) * 3);
  return publisherWeight(publisherOf(item)) * 100
    + Math.min(600, Math.sqrt(numberOf(item.count_of_issues)) * 30) + legacy;
}

function validVolume(item) {
  if (!item?.id || !item?.name) return false;
  if (item.kind && item.kind !== 'volume') return false;
  if (item.resource_type && item.resource_type !== 'volume') return false;
  if (!Object.hasOwn(item, 'count_of_issues')
    && !Object.hasOwn(item, 'first_issue') && !Object.hasOwn(item, 'last_issue')) return false;
  return Boolean(coverOf(item));
}

function observedRelationshipCounts(raw, kind, linkedIds) {
  const source = kind === 'character' ? raw.characters : raw.people;
  const counts = new Map();
  for (const entry of source || []) {
    if (!entry?.id) continue;
    counts.set(String(entry.id), Math.max(1, numberOf(entry.count) || 1));
  }
  // Older cached details may retain the relationship link without ComicVine's
  // optional count field. Presence is still real evidence, just weaker.
  for (const id of linkedIds || []) if (!counts.has(String(id))) counts.set(String(id), 1);
  return counts;
}

/**
 * Normalise one local SQLite snapshot into a catalogue the resolver can use.
 * Links are copied from the source table only when they originate at a volume;
 * no relationship is guessed from a title.
 */
export function buildDiscoveryCatalogue(snapshot = {}) {
  const linksByVolume = new Map();
  const entities = { character: new Map(), person: new Map() };
  for (const link of snapshot.links || []) {
    if (link.fromKind !== 'volume' || !['character', 'person'].includes(link.toKind)) continue;
    if (!linksByVolume.has(String(link.fromId))) linksByVolume.set(String(link.fromId), new Map());
    const byKind = linksByVolume.get(String(link.fromId));
    if (!byKind.has(link.toKind)) byKind.set(link.toKind, new Set());
    byKind.get(link.toKind).add(String(link.toId));
    if (link.toName) entities[link.toKind].set(String(link.toId), String(link.toName));
  }

  const volumes = (snapshot.volumes || [])
    .filter(validVolume)
    .map((raw) => {
      const links = linksByVolume.get(String(raw.id)) || new Map();
      return {
        raw,
        id: String(raw.id),
        title: String(raw.name),
        publisher: publisherOf(raw),
        year: numberOf(raw.start_year),
        issues: numberOf(raw.count_of_issues),
        edition: editionOf(raw.name),
        medium: mediumOf(publisherOf(raw)),
        identity: volumeIdentity(raw),
        franchise: franchiseOf(raw.name),
        links,
        relationshipCounts: new Map([
          ['character', observedRelationshipCounts(raw, 'character', links.get('character'))],
          ['person', observedRelationshipCounts(raw, 'person', links.get('person'))],
        ]),
      };
    });
  return { volumes, entities };
}

function conditionMatches(item, condition) {
  if (!condition || typeof condition !== 'object') return false;
  if (Array.isArray(condition.all)) return condition.all.every((entry) => conditionMatches(item, entry));
  if (Array.isArray(condition.any)) return condition.any.some((entry) => conditionMatches(item, entry));
  if (condition.not) return !conditionMatches(item, condition.not);

  const value = condition.value;
  if (condition.field === 'publisher') {
    const wanted = normalise(value);
    const actual = normalise(item.publisher);
    return condition.op === 'is' ? actual === wanted : actual.startsWith(wanted);
  }
  if (condition.field === 'title') {
    const wanted = normalise(value);
    const actual = normalise(item.title);
    return condition.op === 'is' ? actual === wanted
      : condition.op === 'contains' ? actual.includes(wanted)
        : actual.startsWith(wanted);
  }
  if (condition.field === 'edition' || condition.field === 'medium') {
    return condition.op === 'in'
      ? (condition.value || []).includes(item[condition.field])
      : item[condition.field] === value;
  }
  if (condition.field === 'year' || condition.field === 'issues') {
    const actual = item[condition.field];
    if (condition.op === 'gte') return actual >= numberOf(value);
    if (condition.op === 'lte') return actual <= numberOf(value);
    if (condition.op === 'between') return actual >= numberOf(value?.[0]) && actual <= numberOf(value?.[1]);
    return actual === numberOf(value);
  }
  if (condition.field === 'character' || condition.field === 'creator') {
    const kind = condition.field === 'creator' ? 'person' : 'character';
    return item.links.get(kind)?.has(String(value)) ?? false;
  }
  return false;
}

function score(item, definition, context, seed) {
  const ranking = definition.ranking || 'notability';
  if (ranking === 'newest') return item.year * 10_000 + stableHash(`${seed}:${item.id}`) / 1e10;
  if (ranking === 'oldest') return -item.year * 10_000 + stableHash(`${seed}:${item.id}`) / 1e10;
  if (ranking === 'largest') return item.issues * 10_000 + notability(item);
  if (ranking === 'shortest') return -item.issues * 10_000 + notability(item);
  if (ranking === 'stable-random') return stableHash(`${seed}:${definition.id}:${item.id}`);
  if (ranking === 'relationship-relevance') {
    const relationship = definition.relationship || {};
    const kind = relationship.kind === 'creator' ? 'person' : 'character';
    const appearances = item.relationshipCounts?.get(kind)?.get(String(relationship.id)) || 1;
    const titleMatch = relationship.name && normalise(item.title).includes(normalise(relationship.name));
    // A character's own series belongs ahead of a crossover where they made a
    // couple of appearances. Recorded appearance count then breaks ties, with
    // shelf affinity only refining already-relevant results.
    return (titleMatch ? 1_000_000_000 : 0) + appearances * 1_000_000
      + (context?.affinityByVolume?.get(item.id) || 0) * 1_000 + notability(item);
  }
  if (ranking === 'user-relevance') {
    const affinity = context?.affinityByVolume?.get(item.id) || 0;
    return affinity * 1_000_000 + notability(item);
  }
  return notability(item) * 10_000 + stableHash(`${seed}:${item.id}`) / 1e10;
}

function diversify(items, cap) {
  const selected = [];
  const franchiseCounts = new Map();
  const take = (strict) => {
    let taken = false;
    for (let index = 0; index < items.length && selected.length < cap;) {
      const item = items[index];
      const count = franchiseCounts.get(item.franchise) || 0;
      if (strict && count >= 2) { index += 1; continue; }
      items.splice(index, 1);
      franchiseCounts.set(item.franchise, count + 1);
      selected.push(item);
      taken = true;
    }
    return taken;
  };
  while (selected.length < cap && take(true)) { /* give every franchise room first */ }
  while (selected.length < cap && take(false)) { /* a sparse catalogue still deserves a rail */ }
  return selected;
}

export function resolveRail(definition, catalogue, context = {}, { preview = null, seed = 'inkwell' } = {}) {
  const minimum = definition.display?.minimum ?? MINIMUM_ITEMS;
  const limit = preview ?? definition.display?.preview ?? DEFAULT_PREVIEW;
  const owned = new Set((context.libraryIds || []).map(String));
  const seen = new Set();
  const candidates = catalogue.volumes
    .filter((item) => !definition.personal || !owned.has(item.id))
    .filter((item) => conditionMatches(item, definition.filters))
    .filter((item) => {
      if (seen.has(item.identity)) return false;
      seen.add(item.identity);
      return true;
    })
    .sort((a, b) => score(b, definition, context, seed) - score(a, definition, context, seed));
  if (candidates.length < minimum) return null;
  // diversify intentionally consumes its input while it gives franchises room
  // in the preview. Preserve the matched count for collection pagination.
  const total = candidates.length;
  const items = diversify([...candidates], limit);
  if (items.length < minimum) return null;
  return {
    ...definition, items, total,
    identities: new Set(items.map((item) => item.identity)),
  };
}

function definition(id, title, filters, options = {}) {
  return {
    id, title, filters, source: 'metadata', ranking: 'notability',
    display: { preview: DEFAULT_PREVIEW, minimum: MINIMUM_ITEMS, explore: true },
    topics: [], ...options,
  };
}

export function baseRailDefinitions() {
  return [
    definition('omnibus', 'Omnibuses', { field: 'edition', op: 'is', value: 'Omnibus' }, {
      kicker: 'Format', subtitle: 'Big, shelf-filling reading projects.', topics: ['format:omnibus', 'category:format'], priority: 90,
    }),
    definition('big-collections', 'Big Collections', { field: 'edition', op: 'in', value: ['Compendium', 'Absolute', 'Epic Collection', 'Library edition'] }, {
      kicker: 'Format', subtitle: 'More story in fewer books.', topics: ['format:collection', 'category:format'], priority: 80,
    }),
    definition('superhero-essentials', 'Superhero Essentials', { any: [
      { field: 'title', op: 'starts-with', value: 'Batman' },
      { field: 'title', op: 'starts-with', value: 'X-Men' },
      { field: 'title', op: 'starts-with', value: 'Avengers' },
      { field: 'title', op: 'starts-with', value: 'Superman' },
    ] }, {
      kicker: 'Editor’s starting point', subtitle: 'A curated superhero way in.', source: 'editorial',
      topics: ['editorial:superhero', 'category:editorial'], priority: 75,
    }),
    definition('creator-owned', 'Creator-Owned', { all: [
      { any: [
        { field: 'title', op: 'starts-with', value: 'Saga' },
        { field: 'title', op: 'starts-with', value: 'Hellboy' },
        { field: 'title', op: 'starts-with', value: 'Invincible' },
        { field: 'title', op: 'starts-with', value: 'Monstress' },
        { field: 'title', op: 'starts-with', value: 'Paper Girls' },
      ] },
      { any: [
        { field: 'publisher', op: 'starts-with', value: 'Image' },
        { field: 'publisher', op: 'starts-with', value: 'Dark Horse Comics' },
        { field: 'publisher', op: 'starts-with', value: 'Boom! Studios' },
        { field: 'publisher', op: 'starts-with', value: 'IDW Publishing' },
      ] },
    ] }, {
      kicker: 'Editor’s starting point', subtitle: 'A curated set of creator-led series.', source: 'editorial',
      topics: ['editorial:creator-owned', 'category:editorial'], priority: 65,
    }),
    definition('manga', 'Manga Collections', { field: 'medium', op: 'is', value: 'manga' }, {
      kicker: 'Manga', subtitle: 'Series and editions from manga publishers.', topics: ['medium:manga', 'category:medium'], priority: 70,
    }),
    definition('marvel', 'Marvel', { field: 'publisher', op: 'starts-with', value: 'Marvel' }, {
      kicker: 'Publisher', topics: ['publisher:marvel', 'category:publisher'], priority: 60,
    }),
    definition('dc', 'DC', { field: 'publisher', op: 'starts-with', value: 'DC Comics' }, {
      kicker: 'Publisher', topics: ['publisher:dc', 'category:publisher'], priority: 60,
    }),
    definition('image', 'Image', { field: 'publisher', op: 'starts-with', value: 'Image' }, {
      kicker: 'Publisher', topics: ['publisher:image', 'category:publisher'], priority: 50,
    }),
    definition('dark-horse', 'Dark Horse', { field: 'publisher', op: 'starts-with', value: 'Dark Horse Comics' }, {
      kicker: 'Publisher', topics: ['publisher:dark-horse', 'category:publisher'], priority: 50,
    }),
    definition('comics-from-the-2000s', 'Comics From the 2000s', { field: 'year', op: 'between', value: [2000, 2009] }, {
      kicker: 'Era', subtitle: 'Books first published from 2000 to 2009.', ranking: 'newest', topics: ['era:2000s', 'category:era'], priority: 40,
    }),
    definition('eighties-comics', "Comics From the ’80s", { field: 'year', op: 'between', value: [1980, 1989] }, {
      kicker: 'Era', subtitle: 'Books first published from 1980 to 1989.', topics: ['era:1980s', 'category:era'], priority: 40,
    }),
    definition('massive-sagas', 'Massive Sagas', { field: 'issues', op: 'gte', value: 100 }, {
      kicker: 'Reading commitment', subtitle: 'Long-running series with 100 or more issues.', ranking: 'largest', topics: ['commitment:long', 'category:commitment'], priority: 40,
    }),
    definition('shorter-runs', 'Shorter Runs to Explore', { all: [
      { field: 'issues', op: 'gte', value: 1 }, { field: 'issues', op: 'lte', value: 12 },
    ] }, {
      kicker: 'Reading commitment', subtitle: 'Short series; publication completion is not implied.', ranking: 'shortest', topics: ['commitment:short', 'category:commitment'], priority: 40,
    }),
    definition('modern-collections', 'Modern Collections', { all: [
      { field: 'year', op: 'gte', value: 2000 },
      { field: 'edition', op: 'in', value: ['Omnibus', 'Compendium', 'Absolute', 'Epic Collection', 'Library edition', 'Deluxe edition'] },
    ] }, {
      kicker: 'Era · format', subtitle: 'Collected editions from the modern era.', topics: ['era:modern', 'format:collection', 'category:era', 'category:format'], priority: 35,
    }),
  ];
}

function entityDefinitions(catalogue, kind, names, limit) {
  const label = kind === 'person' ? 'Creator' : 'Character';
  const field = kind === 'person' ? 'creator' : 'character';
  const appearances = new Map();
  for (const volume of catalogue.volumes) {
    for (const id of volume.links.get(kind) || []) {
      appearances.set(id, (appearances.get(id) || 0) + 1);
    }
  }
  const candidates = [...appearances]
    .map(([id, count]) => ({ id, count, name: catalogue.entities[kind].get(id) }))
    .filter((entry) => entry.name && entry.count >= MINIMUM_ITEMS);
  const preferred = names.map((name) => {
    const wanted = normalise(name);
    return candidates.find((entry) => normalise(entry.name) === wanted);
  }).filter(Boolean);
  const selected = [];
  const add = (entry, preferredName = false) => {
    if (selected.some((candidate) => candidate.id === entry.id) || selected.length >= limit) return;
    selected.push({ ...entry, preferred: preferredName });
  };
  preferred.forEach((entry) => add(entry, true));
  candidates.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).forEach((entry) => add(entry));

  return selected.map(({ id, name: resolvedName, preferred: preferredName }) =>
    definition(`${field}:${id}`, `Explore ${resolvedName}`, {
      field, op: 'is', value: id,
    }, {
      kicker: label, subtitle: `Books ComicVine explicitly credits to ${resolvedName}.`,
      relationship: { kind: field, id, name: resolvedName }, ranking: 'relationship-relevance',
      topics: [`${field}:${normalise(resolvedName)}`, `category:${field}`], priority: preferredName ? 20 : 10,
    }));
}

function buckets(catalogue, valueOf) {
  const results = new Map();
  for (const volume of catalogue.volumes) {
    const value = valueOf(volume);
    if (!value) continue;
    const bucket = results.get(value) || { value, count: 0 };
    bucket.count += 1;
    results.set(value, bucket);
  }
  return [...results.values()].filter((bucket) => bucket.count >= MINIMUM_ITEMS)
    .sort((a, b) => b.count - a.count || String(a.value).localeCompare(String(b.value)));
}

function pluralEdition(edition) {
  return {
    Absolute: 'Absolutes', Compendium: 'Compendiums', 'Epic Collection': 'Epic Collections',
    'Deluxe edition': 'Deluxe Editions', 'Library edition': 'Library Editions',
    'Collected edition': 'Collected Editions', Hardcover: 'Hardcovers', 'One-shot': 'One-Shots',
  }[edition] || edition;
}

function generatedPublisherDefinitions(catalogue) {
  const included = new Set(['marvel', 'dc-comics', 'image', 'dark-horse-comics']);
  return buckets(catalogue, (volume) => volume.publisher)
    .filter(({ value }) => !included.has(slug(value))).slice(0, 8)
    .map(({ value }) => definition(`publisher:${slug(value)}`, `Explore ${value}`, {
      field: 'publisher', op: 'starts-with', value,
    }, {
      kicker: 'Publisher', subtitle: `Titles from ${value}.`,
      topics: [`publisher:${slug(value)}`, 'category:publisher'], priority: 15,
    }));
}

function generatedEditionDefinitions(catalogue) {
  return buckets(catalogue, (volume) => volume.edition)
    .filter(({ value }) => value !== 'Series' && value !== 'Omnibus').slice(0, 8)
    .map(({ value }) => definition(`edition:${slug(value)}`, pluralEdition(value), {
      field: 'edition', op: 'is', value,
    }, {
      kicker: 'Format', subtitle: `A local shelf of ${pluralEdition(value).toLowerCase()}.`,
      ranking: 'stable-random', topics: [`format:${slug(value)}`, 'category:format'], priority: 30,
    }));
}

function generatedPublisherEditionDefinitions(catalogue) {
  const counts = new Map();
  for (const volume of catalogue.volumes) {
    if (volume.edition === 'Series') continue;
    const key = `${slug(volume.publisher)}|${volume.edition}`;
    const entry = counts.get(key) || { publisher: volume.publisher, edition: volume.edition, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
  }
  return [...counts.values()].filter((entry) => entry.count >= MINIMUM_ITEMS)
    .sort((a, b) => b.count - a.count || a.publisher.localeCompare(b.publisher) || a.edition.localeCompare(b.edition))
    .slice(0, 12).map(({ publisher, edition }) => definition(
      `publisher:${slug(publisher)}:edition:${slug(edition)}`,
      `${publisher} ${pluralEdition(edition)}`,
      { all: [
        { field: 'publisher', op: 'starts-with', value: publisher },
        { field: 'edition', op: 'is', value: edition },
      ] }, {
        kicker: 'Publisher · format', subtitle: `${pluralEdition(edition)} from ${publisher}.`,
        ranking: 'stable-random', topics: [`publisher:${slug(publisher)}`, `format:${slug(edition)}`], priority: 28,
      },
    ));
}

function generatedPublisherDecadeDefinitions(catalogue) {
  const counts = new Map();
  for (const volume of catalogue.volumes) {
    if (!volume.year || !volume.publisher) continue;
    const decade = Math.floor(volume.year / 10) * 10;
    const key = `${slug(volume.publisher)}|${decade}`;
    const entry = counts.get(key) || { publisher: volume.publisher, decade, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
  }
  return [...counts.values()].filter((entry) => entry.count >= MINIMUM_ITEMS)
    .sort((a, b) => b.count - a.count || b.decade - a.decade || a.publisher.localeCompare(b.publisher))
    .slice(0, 12).map(({ publisher, decade }) => definition(
      `publisher:${slug(publisher)}:decade:${decade}`,
      `${publisher} in the ${decade}s`,
      { all: [
        { field: 'publisher', op: 'starts-with', value: publisher },
        { field: 'year', op: 'between', value: [decade, decade + 9] },
      ] }, {
        kicker: 'Publisher · era', subtitle: `Books first published from ${decade} to ${decade + 9}.`,
        ranking: 'stable-random', topics: [`publisher:${slug(publisher)}`, `era:${decade}s`], priority: 25,
      },
    ));
}

export function generatedRailDefinitions(catalogue) {
  return [
    // This deliberately caps a data-led tail of rails. A fully enriched
    // catalogue might know thousands of names; Discover should surface a few
    // credible, well-represented entries, not render one shelf per entity.
    ...entityDefinitions(catalogue, 'character', CHARACTER_SEEDS, 12),
    ...entityDefinitions(catalogue, 'person', CREATOR_SEEDS, 8),
    ...generatedPublisherDefinitions(catalogue),
    ...generatedEditionDefinitions(catalogue),
    ...generatedPublisherEditionDefinitions(catalogue),
    ...generatedPublisherDecadeDefinitions(catalogue),
  ];
}

export function buildDiscoveryContext(catalogue, library = []) {
  const libraryIds = new Set((library || []).map((item) => String(item.id)));
  const affinity = { character: new Map(), person: new Map(), publisher: new Map() };
  const publisherNames = new Map();
  // Mylar is authoritative that this reader chose a title and gives us its
  // publisher even before ComicVine has enriched its local detail document.
  // That makes a broad personal rail useful immediately without pretending a
  // title word is a character or creator relationship.
  for (const item of library || []) {
    const publisher = String(item.publisher || '').trim();
    if (!publisher) continue;
    const key = normalise(publisher);
    affinity.publisher.set(key, (affinity.publisher.get(key) || 0) + 1);
    if (!publisherNames.has(key)) publisherNames.set(key, publisher);
  }
  for (const item of catalogue.volumes) {
    if (!libraryIds.has(item.id)) continue;
    for (const [kind, ids] of item.links) {
      for (const id of ids) affinity[kind].set(id, (affinity[kind].get(id) || 0) + 1);
    }
  }
  const affinityByVolume = new Map();
  for (const item of catalogue.volumes) {
    let score = affinity.publisher.get(normalise(item.publisher)) || 0;
    for (const [kind, ids] of item.links) for (const id of ids) score += (affinity[kind].get(id) || 0) * 3;
    if (score) affinityByVolume.set(item.id, score);
  }
  return { libraryIds: [...libraryIds], affinity, publisherNames, affinityByVolume };
}

export function personalizedRailDefinitions(catalogue, context) {
  if (!context?.libraryIds?.length) return [];
  const choice = (kind) => [...(context.affinity?.[kind] || [])]
    .sort((a, b) => b[1] - a[1])[0];
  const character = choice('character');
  const creator = choice('person');
  const publisher = choice('publisher');
  const definitions = [];
  if (character && catalogue.entities.character.get(character[0])) {
    const name = catalogue.entities.character.get(character[0]);
    definitions.push(definition(`because:character:${character[0]}`, `More ${name}`, { all: [
      { field: 'character', op: 'is', value: character[0] },
      { field: 'title', op: 'contains', value: name },
    ] }, {
      kicker: 'From your shelf', subtitle: `${name} stories from your local catalogue.`,
      personal: true, relationship: { kind: 'character', id: character[0], name }, ranking: 'relationship-relevance',
      topics: [`character:${normalise(name)}`, 'category:character', 'personal'], priority: 100,
    }));
  }
  if (creator && catalogue.entities.person.get(creator[0])) {
    const name = catalogue.entities.person.get(creator[0]);
    definitions.push(definition(`because:creator:${creator[0]}`, `More From ${name}`, {
      field: 'creator', op: 'is', value: creator[0],
    }, {
      kicker: 'From your shelf', subtitle: `More books ComicVine credits to ${name}.`,
      personal: true, relationship: { kind: 'creator', id: creator[0], name }, ranking: 'relationship-relevance',
      topics: [`creator:${normalise(name)}`, 'category:creator', 'personal'], priority: 95,
    }));
  }
  if (publisher && context.publisherNames?.get(publisher[0])) {
    const name = context.publisherNames.get(publisher[0]);
    definitions.push(definition(`because:publisher:${publisher[0]}`, `Continue Exploring ${name}`, {
      field: 'publisher', op: 'starts-with', value: name,
    }, {
      kicker: 'From your shelf', subtitle: `More from the publisher you collect.`,
      personal: true, ranking: 'user-relevance', topics: [`publisher:${publisher[0]}`, 'category:publisher', 'personal'], priority: 90,
    }));
  }
  return definitions;
}

function overlaps(left, right) {
  if (!left?.size || !right?.size) return 0;
  let shared = 0;
  for (const id of left) if (right.has(id)) shared += 1;
  return shared / Math.min(left.size, right.size);
}

function sharesTopic(left, right) {
  return (left.topics || []).some((topic) => (right.topics || []).includes(topic));
}

/**
 * Pick a useful, stable batch. A rejected rail is deferred by leaving it out
 * of this batch; it remains eligible later once neighbouring shelves differ.
 */
export function selectRails(definitions, catalogue, context, {
  servedIds = [], batchSize = 8, seed = 'inkwell', recent = [],
} = {}) {
  const served = new Set((servedIds || []).map(String));
  const selected = [];
  const history = [...recent];
  const ordered = [...definitions].sort((a, b) => {
    const priority = Number(b.priority || 0) - Number(a.priority || 0);
    return priority || String(a.id).localeCompare(String(b.id));
  });
  for (const definition of ordered) {
    if (selected.length >= batchSize || served.has(String(definition.id))) continue;
    if (history.slice(-2).some((rail) => sharesTopic(rail, definition))) continue;
    const rail = resolveRail(definition, catalogue, context, { seed });
    if (!rail) continue;
    if (history.slice(-3).some((previous) => overlaps(previous.identities, rail.identities) > 0.7)) continue;
    selected.push(rail);
    history.push(rail);
  }
  return selected;
}

export function allRailDefinitions(catalogue, context) {
  return [
    ...personalizedRailDefinitions(catalogue, context),
    ...baseRailDefinitions(),
    ...generatedRailDefinitions(catalogue),
  ];
}
