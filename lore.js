// Lore provider (Wikidata).
//
// The division of labour: ComicVine knows about the physical comics — which
// volumes exist, what an omnibus collects, covers, issue numbers, publishers.
// It is unreliable about the *stories*: its X-Men team record lists Spider-Man
// as a member, because its team/character links are crowd-entered and nobody
// polices them.
//
// Wikidata is the opposite. It has almost nothing useful about editions, but
// its fictional-character graph is properly curated: "member of" (P463) on the
// X-Men returns Cyclops, Storm, Nightcrawler and Jean Grey, and does not
// return Spider-Man. So lore questions — who is in this team, what teams is
// this character in — go here, and everything about the books stays with
// ComicVine.
//
// Free, keyless and generous, but a shared public endpoint: be a good citizen.
// One query at a time, a courteous gap between them, a real User-Agent, and
// answers cached on disk for a month. Nothing here is ever on the critical
// path — every call degrades to null and the ComicVine data stands.

import { cached } from './store.js';

const SPARQL = 'https://query.wikidata.org/sparql';
const SEARCH = 'https://www.wikidata.org/w/api.php';
// Wikidata asks that clients identify themselves; an anonymous scraper-looking
// agent is what gets an IP blocked.
const AGENT = 'Inkwell/1.0 (personal comic library; https://github.com/WhoIsCalebBrown/inkwell)';

const MIN_GAP_MS = 1200;
let lastCall = 0;
let chain = Promise.resolve();

// Serialised, like the Metron client, and for the same reason: concurrency is
// what gets a shared endpoint annoyed with you.
function schedule(work) {
  const run = chain.then(async () => {
    const wait = Math.max(0, MIN_GAP_MS - (Date.now() - lastCall));
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    try { return await work(); } finally { lastCall = Date.now(); }
  });
  chain = run.then(() => {}, () => {});
  return run;
}

async function ask(query) {
  return schedule(async () => {
    const url = `${SPARQL}?query=${encodeURIComponent(query)}`;
    const response = await fetch(url, {
      headers: { Accept: 'application/sparql-results+json', 'User-Agent': AGENT },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`Wikidata returned HTTP ${response.status}`);
    const body = await response.json();
    return body?.results?.bindings ?? [];
  });
}

// The public endpoint 502s and 429s under load. One patient retry turns most of
// those into an answer; anything past that is the caller's problem to shrug off.
async function askTwice(query) {
  try { return await ask(query); } catch (error) {
    if (!/HTTP (429|50\d)/.test(error.message)) throw error;
    await new Promise((resolve) => setTimeout(resolve, 2500));
    return ask(query);
  }
}

// Wikidata types per thing we look up. Without a type constraint a plain label
// search for "X-Men" resolves to the 2000 Bryan Singer film, which then has no
// members and quietly answers nothing.
const LORE_TYPES = {
  team: ['wd:Q14623646', 'wd:Q15720567'],          // fictional organization, superhero team
  character: ['wd:Q95074', 'wd:Q188784'],          // fictional character, superhero
  event: ['wd:Q13593966', 'wd:Q1667921'],          // comics storyline, novel series
};

// Resolve a name to a Wikidata entity of the right KIND. Matches the label or a
// recognised alias, and prefers the entity the rest of Wikidata links to most —
// which is reliably the famous one rather than a same-named obscurity.
export async function resolve(name, kind = 'team') {
  const wanted = String(name || '').trim();
  const types = LORE_TYPES[kind];
  if (wanted.length < 2 || !types) return null;
  return cached(`lore:id:${kind}:${wanted.toLowerCase()}`, 30 * 24 * 60 * 60_000, async () => {
    const literal = JSON.stringify(wanted);
    const rows = await askTwice(`SELECT ?e ?eLabel (COUNT(?sl) AS ?links) WHERE {
        VALUES ?type { ${types.join(' ')} }
        ?e wdt:P31/wdt:P279* ?type .
        { ?e rdfs:label ${literal}@en } UNION { ?e skos:altLabel ${literal}@en }
        OPTIONAL { ?sl schema:about ?e }
        SERVICE wikibase:label { bd:serviceParam wikibase:language "en" }
      } GROUP BY ?e ?eLabel ORDER BY DESC(?links) LIMIT 3`);
    const best = rows[0];
    if (!best) return null;
    return { id: best.e.value.split('/').pop(), label: best.eLabel?.value ?? wanted };
  });
}

// Members of a team, most-linked first. P463 is "member of"; P527 "has part"
// catches the teams modelled the other way round.
export async function teamMembers(entityId, limit = 24) {
  if (!/^Q\d+$/.test(String(entityId || ''))) return [];
  return cached(`lore:members:${entityId}`, 30 * 24 * 60 * 60_000, async () => {
    // Ranked by sitelinks — how many Wikipedias carry an article on them — which
    // is a good cheap proxy for how famous a member is. Counting *all* inbound
    // triples instead was accurate and hopelessly expensive: it timed the
    // endpoint out with a 502.
    const rows = await askTwice(`SELECT ?m ?mLabel (COUNT(?sl) AS ?links) WHERE {
        { ?m wdt:P463 wd:${entityId} } UNION { wd:${entityId} wdt:P527 ?m }
        OPTIONAL { ?sl schema:about ?m }
        SERVICE wikibase:label { bd:serviceParam wikibase:language "en" }
      } GROUP BY ?m ?mLabel ORDER BY DESC(?links) LIMIT ${Math.min(60, Math.max(1, limit))}`);
    return rows
      .map((row) => ({
        id: row.m?.value?.split('/').pop() ?? null,
        name: row.mLabel?.value ?? null,
        links: Number(row.links?.value) || 0,
      }))
      // An unresolved label comes back as the bare Q-number, which is not a name.
      .filter((row) => row.id && row.name && !/^Q\d+$/.test(row.name));
  });
}

// The teams a character belongs to — the same edge read from the other end.
export async function characterTeams(entityId, limit = 12) {
  if (!/^Q\d+$/.test(String(entityId || ''))) return [];
  return cached(`lore:teams:${entityId}`, 30 * 24 * 60 * 60_000, async () => {
    const rows = await askTwice(`SELECT ?t ?tLabel WHERE {
        wd:${entityId} wdt:P463 ?t .
        SERVICE wikibase:label { bd:serviceParam wikibase:language "en" }
      } LIMIT ${Math.min(40, Math.max(1, limit))}`);
    return rows
      .map((row) => ({ id: row.t?.value?.split('/').pop() ?? null, name: row.tLabel?.value ?? null }))
      .filter((row) => row.id && row.name && !/^Q\d+$/.test(row.name));
  });
}

// A character profile is deliberately a graph of named, direct Wikidata
// statements rather than prose assembled from search snippets. That keeps the
// distinction useful: ComicVine owns the books below the profile, while this
// answers the story questions around the character — who made them, which
// universe they inhabit, their affiliations and explicit family links.
//
// `P1441` (present in work) is not included. It mixes comics, games, films and
// episodes into a long, unranked pile, while ComicVine already gives Inkwell the
// much more useful physical-comics list. This endpoint is for relationships,
// not a noisier duplicate bibliography.
const CHARACTER_RELATIONSHIPS = [
  ['creators', 'Created by', 'wdt:P170'],
  ['universes', 'Universe', 'wdt:P1080'],
  ['affiliations', 'Member of', 'wdt:P463'],
  ['affiliations', 'Affiliated with', 'wdt:P1416'],
  ['affiliations', 'Part of', 'wdt:P361'],
  ['family', 'Father', 'wdt:P22'],
  ['family', 'Mother', 'wdt:P25'],
  ['family', 'Sibling', 'wdt:P3373'],
  ['family', 'Spouse or partner', 'wdt:P26'],
  ['family', 'Child', 'wdt:P40'],
  ['family', 'Relative', 'wdt:P1038'],
  ['family', 'Family', 'wdt:P53'],
];

const MAX_PROFILE_ITEMS = 18;

// Teams have a different useful graph from people. Their creator/founder,
// fictional universe, parent organisations and headquarters are lore; the
// physical series they appear in remain ComicVine's job.
const TEAM_RELATIONSHIPS = [
  ['creators', 'Created by', 'wdt:P170'],
  ['creators', 'Founded by', 'wdt:P112'],
  ['universes', 'Universe', 'wdt:P1080'],
  ['affiliations', 'Member of', 'wdt:P463'],
  ['affiliations', 'Affiliated with', 'wdt:P1416'],
  ['affiliations', 'Part of', 'wdt:P361'],
  ['affiliations', 'Parent organization', 'wdt:P749'],
  ['locations', 'Headquarters', 'wdt:P159'],
];

async function relationshipProfile(entityId, cacheKey, relationships) {
  if (!/^Q\d+$/.test(String(entityId || ''))) return null;
  return cached(cacheKey, 30 * 24 * 60 * 60_000, async () => {
    const values = relationships
      .map(([group, relation, property]) => `(${property} "${group}" "${relation}")`)
      .join(' ');
    const rows = await askTwice(`SELECT DISTINCT ?group ?relation ?value ?valueLabel ?description WHERE {
        VALUES (?property ?group ?relation) { ${values} }
        wd:${entityId} ?property ?value .
        FILTER(isIRI(?value))
        OPTIONAL { wd:${entityId} schema:description ?description FILTER(LANG(?description) = "en") }
        SERVICE wikibase:label { bd:serviceParam wikibase:language "en" }
      } LIMIT 100`);

    const profile = {
      description: rows.find((row) => row.description?.value)?.description?.value ?? null,
    };
    for (const [group] of relationships) profile[group] ??= [];
    const seen = new Set();
    for (const row of rows) {
      const group = row.group?.value;
      const id = row.value?.value?.split('/').pop();
      const name = row.valueLabel?.value;
      if (!profile[group] || !id || !name || /^Q\d+$/.test(name)) continue;
      const key = `${group}:${id}`;
      if (seen.has(key) || profile[group].length >= MAX_PROFILE_ITEMS) continue;
      seen.add(key);
      profile[group].push({ id, name, relation: row.relation?.value || null });
    }
    return profile;
  });
}

// Returns only direct, labelled item statements. That is intentionally
// conservative: inferencing a cousin from a parent or a teammate from a title
// is precisely the kind of relationship that made the ComicVine X-Men data
// misleading in the first place.
export async function characterProfile(entityId) {
  return relationshipProfile(entityId, `lore:character-profile:${entityId}`, CHARACTER_RELATIONSHIPS);
}

export async function teamProfile(entityId) {
  return relationshipProfile(entityId, `lore:team-profile:${entityId}`, TEAM_RELATIONSHIPS);
}
