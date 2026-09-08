# Discovery rails

## Purpose

Discover is a metadata-driven comic discovery surface. It should provide a long,
varied sequence of horizontal rails without becoming a hand-written list of
shelves or silently crawling providers.

The architecture separates four concerns:

1. A **rail definition** says what a collection represents: reader-facing copy,
   a safe filter expression, a ranking strategy, display settings, provenance,
   and diversity topics.
2. A **resolver** turns one definition into valid discoverable volumes from the
   local ComicVine mirror.
3. A **selector** chooses a diverse batch of resolvable rails for a particular
   discovery context, excluding rails already served in the browser session.
4. The frontend renders every result through the existing `rail` and
   `volumeCard` components, and uses the same definition for its full
   `Explore` collection page.

This is deliberately deterministic and local-first. Discover must not issue
background ComicVine requests while a reader scrolls.

## Data contract

The discoverable item is a ComicVine **volume**. It may represent a continuing
series or a collected edition; it is not a canonical work model. Do not claim
that two editions are content-equivalent without an explicit source.

The initial resolver may use only evidence already held in the local mirror:

- volume title, publisher, start year, issue count and cover; format is a
  conservative title classification and manga is a publisher classification,
  both published as such rather than provider-supplied facts;
- observed volume-to-character and volume-to-creator links;
- real, request-scoped Mylar/Komga library state for personal context;
- explicitly provenance-labelled editorial memberships.

Do not infer relationships from keywords. In particular, ComicVine does not
currently supply reliable genre, tone, story scale, creator-owned status,
publication completion, page counts, popularity, ratings, awards, volume-level
universe/imprint membership, or story-arc membership. Definitions needing one
of those facts remain unavailable unless an editorial or provider-backed source
is introduced and shown to the reader.

An editorial rail may deliberately use a bounded title membership rule when it
is preserving a human-curated starting collection (for example, the existing
Superhero Essentials and Creator-Owned paths). Its UI source must say editorial;
that rule is never evidence that every matching volume has a genre, ownership,
or character relationship.

Team credits are especially weak: never construct a team rail from the books
of team members. Existing team title matching remains a separately labelled,
weaker browse behaviour, not discovery metadata.

## Definition shape

Definitions are server-owned objects. Clients submit only registered IDs, never
raw SQL or arbitrary filter fields.

```js
{
  id: 'modern-spider-man-omnibuses',
  title: 'Modern Spider-Man Omnibuses',
  kicker: 'Character · format',
  subtitle: 'Big reads from the last two decades.',
  source: 'metadata', // metadata | editorial | hybrid
  filters: {
    all: [
      { field: 'character', op: 'is', value: '<ComicVine id>' },
      { field: 'edition', op: 'is', value: 'Omnibus' },
      { field: 'year', op: 'gte', value: 2000 },
    ],
  },
  ranking: 'notability',
  display: { preview: 14, minimum: 6, explore: true },
  topics: ['character:spider-man', 'format:omnibus', 'era:modern'],
}
```

The filter language supports `all`, `any`, and `not`; initial scalar fields are
publisher, medium, edition, year, and issue count. Character and creator
conditions are relationship predicates. It must be straightforward to add a
provider-backed tag condition later without changing the selector or frontend.
Creator pairings require no second query mechanism: an `all` expression with
two creator predicates represents a pairing. The current provider links do not
reliably distinguish writer from artist roles, so pairing rails are not yet
generated automatically.

Character and creator definitions are bounded: familiar names are preferred
when explicit local relationships exist, then a capped set of names represented
by at least the rail minimum of locally saved volumes is eligible. This grows
the deep-discovery tail without making a shelf for every entity Inkwell learns.

Publisher, decade, and collected-edition buckets are also generated from the
local catalogue, as are bounded publisher-plus-edition and publisher-plus-era
composites. A composite has the same filter AST as every other rail, not a
bespoke query path; for example, “Marvel Epic Collections” is publisher AND
edition. A candidate still has to clear the rail minimum before the selector
can serve it.

## Selection and personalization

The selector creates a `DiscoveryContext` for each request. It contains only
the current reader's library/request state and derived affinities from observed
creator/character relationships. A tracked Mylar publisher is a real immediate
signal even before detail enrichment, so it may produce a broad “Continue
Exploring [publisher]” rail; character and creator rails wait for observed
ComicVine credits. With too little reliable activity, it emits no personal rail
and falls back to general discovery.

Selection rules:

- reject definitions that cannot produce the minimum number of meaningful
  titles;
- never repeat a served definition within the browser discovery session;
- avoid adjacent definitions with the same dominant topic;
- defer a candidate whose preview overlaps recent rails too heavily;
- allow a title to recur later in a different, useful context;
- keep ranking stable for a given session seed.

Served IDs live in the active Discover view, with a small session record kept
for diagnostics and a stable seed. This avoids global, cross-reader session
state. Personal result caches, if introduced, must include a context fingerprint
and never be shared across users.

## Performance and integrity

Discover reads only local SQLite data. It uses prepared, bounded queries,
existing relationship indexes, and indexed/materialized discovery attributes
where justified. There must be no per-card query and no per-rail provider call.

Only real ComicVine volume records may enter `catalogue_volumes`. Historical
non-volume mirror rows are defensively ignored by both the snapshot query and
resolver; new ingestion rejects them while retaining their appropriate records
in `catalogue_objects`. Discovery never needs a destructive cache migration.

## Delivery sequence

1. Enforce the volume-ingestion invariant and add minimal indexed discovery
   attributes.
2. Implement the definition, resolver, selector, and metadata-backed starter
   registry.
3. Replace the fixed Discover rail list with rendered selected rails and add a
   generic full collection route.
4. Add vertical rail batching with session-level exclusion.
5. Add provenance-aware editorial tags only when their memberships have a real
   source; then broaden tone, newcomer, universe, and event rails.

Use native Node tests for filter composition, entity validity, selection,
batching, personalization fallback, and user-context isolation.
