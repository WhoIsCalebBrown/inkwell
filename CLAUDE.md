# Panel — working notes for agents

An Overseerr-style request front-end for Mylar3. Single user, LAN-only, deployed
to Unraid at `192.168.40.44:3013` behind `requests.calebs.online`.

This codebase is deliberately AI-written and will stay that way. It is optimised
for an agent to read the whole of a file, understand why it is shaped that way,
and change it correctly on the first pass. Keep it that way.

## Shape

Four files carry everything. There is no build step, no framework, no bundler.

| File | Lines | Role |
| --- | --- | --- |
| `server.js` | ~1700 | Express API, ComicVine/Mylar/Komga clients, all request shaping |
| `store.js` | ~575 | SQLite: response cache, local catalogue mirror, Mylar part state |
| `public/app.js` | ~1470 | Whole front end: hash router, routes, render functions |
| `public/styles.css` | ~520 | Whole stylesheet |

`metron.js` and `enrich.js` are optional supplements. `tools/` is scratch.

The browser gets ES modules straight from disk. `public/index.html` links the two
assets with a `?v=` query — **bump both when you change them** or the browser
serves a year-old cached copy (they are `immutable` at a version).

## The model everything is built on

`Publisher → Line → Thread → Volume`. A *thread* is whatever a reader follows:
a character, creator, team or event. All four are real ComicVine resources
(`character`, `person`, `team`, `story_arc`).

"Thread" is our word for the tier. It lives in code and comments; **it must not
appear in the interface** — the UI says Character, Creator, Team or Event.
`THREAD_LABELS` in `server.js` is the single source of the reader-facing names.

The design canvas lives in `design/*.dc.html` (artboards) plus `design/canvas.json`.
Read those before changing layout — they are the intent. `design/panel-comic-app.html`
is a 2.5MB published bundle; ignore it, the artboards are the source.

## Non-negotiable invariants

These are all things that have been got wrong before.

1. **Never invent a relationship from a keyword.** Thread→volume links come from
   saved ComicVine credits in `catalogue_links` only. A title search that happens
   to contain a creator's name is not a credit.
2. **The local catalogue grows only from data we legitimately fetched.** No bulk
   crawling, no speculative prefetching. `catalogue_enrichment` is a queue fed by
   things the reader actually searched, opened, followed or requested.
3. **Respect the ComicVine cooldown.** A 420/429 sets `cvLimitedUntil`; nothing
   may issue calls behind it. Never cache a rate-limit failure as an empty result.
4. **API keys stay server-side.** They come from the mounted Mylar `config.ini`
   or env vars. Nothing key-shaped ever reaches the browser.
5. **`resource !== 'issues'`** guards the mirror in `comicVineFetch`. Issues are
   not volumes; without the guard they pollute `catalogue_volumes`.
6. **One primary action per volume, called Request**, with its scope stated in
   prose underneath. The open-ended series watch is a separate secondary button.
   Do not reintroduce a primary button whose meaning depends on invisible fields.
7. **Preferences are per-device**, in `localStorage` under `panel:*`. They never
   touch Mylar's or Komga's own configuration.

## ComicVine quirks worth knowing before you call it

Verified against the live API; all of these have cost time already.

- **`sort` is ignored on list endpoints.** `/characters?sort=count_of_issue_appearances:desc`
  returns an arbitrary page. There is no "most popular" query — curated seed
  lists plus one search each is the working pattern.
- **`/search` does not index story arcs at all.** `resources=story_arc` returns
  zero results for everything. Use `/story_arcs/?filter=name:<term>` instead.
- **Story arc names carry a quoted parent title**: `"Green Lantern" Blackest
  Night`. Strip it with `ARC_PREFIX` for display, on both the seeded and the
  local path.
- **Teams have no `count_of_issue_appearances`** (it is always null), so fame
  cannot rank them. Shortest matching name is the usable tiebreak.
- **The publisher filter is ignored**, which is why publisher pages seed by name
  and then confirm the house from each record. ComicVine's own spelling also
  differs from ours — it files Image Comics as "Image", so `publisherArt()` falls
  back to the leading word when the full name misses.
- **Volumes carry no team credits.** The Uncanny X-Men Omnibus reports 357
  characters and zero teams, so `catalogue_links` can never hold volume→team.
  A team's books are derived from its line-up instead (`volumesForCharacters`),
  and the UI says so.
- **Never cache an empty result from a seeded fetch.** A rate-limited pass
  resolves to `[]`, and `cached()` will happily store that for a month — which
  is how four publisher tiles lost their art. Throw instead, so the next open
  retries.
- Search returns near-misses generously. Keep only the best match per seed and
  use a small `limit` — every result returned is written into the local mirror
  by `comicVineFetch`, so a wide search permanently pollutes the browse lists.

Seeded browse lists live under `threads:seeded:<kind>:vN` with a 7-day TTL.
**Bump the `vN` whenever the seeds or the shaping change**, or you will serve
the old list for a week.

## Performance rules

The app is used on desktop, iPad and phone. Assume the iPad is the slow one.

- **Never use `requestAnimationFrame` as a throttle for anything load-bearing.**
  It is starved in background tabs and not reliably delivered during iOS
  momentum scrolling. A dropped frame there strands the guard flag and the
  feature stops permanently. Rail paging was broken on iPad for exactly this
  reason; it now uses a `RAIL_CHECK_MS` timer throttle. rAF is fine for painting
  a hover, which is what `paintHover` uses it for.
- **No layout reads in a pointer handler.** `getBoundingClientRect()` per
  `pointermove` forces synchronous layout on every event. Measure on enter,
  cache, coalesce the writes.
- **Cover bands fill by `flex: 1 0 92px`, never a fixed width.** A fixed width
  can only fill a card of exactly the right size — too few covers left a strip
  of ground on the right, too many just cost downloads. Six per band is plenty
  because they grow; fourteen once meant ~300 cover fetches on one Browse load.
  A cover that 404s removes its own slot (`onerror`) so the survivors re-flex.
- **Grids get `content-visibility: auto`**; rails must not (a horizontal
  scroller needs its children measured to know its scroll extent).
- **Covers are proxied, never hotlinked.** `/api/cover/:id` caches to
  `data/covers/` and serves `immutable`. Thread portraits still hotlink
  ComicVine — that is the next proxy worth adding.
- JSON and text assets are compressed by the middleware at the top of
  `server.js` (brotli q5 / gzip 6, ≥1KB, built-in `zlib`, no dependency).
  Typical saving is 72–85%.
- SQLite is tuned in `store.js` (WAL + `synchronous=NORMAL`, 256MB mmap, 32MB
  page cache). Every table is a rebuildable cache, so durability is not the goal.

## Two traps in the front end

- **A percentage `max-height` inside a content-sized box is circular** and is
  ignored: the publisher mark rendered at its natural 106px square and spilled
  onto the title. Size such images with explicit `width: 100%; height: 100%`
  plus `object-fit: contain`.
- **Anchor an overlay to the thing it belongs to.** `bottom` on a `.house-mark`
  inside `.art-tile` measured from the tile's base, parking the logo on the
  publisher's name; it wants `top` measured against the art band's height.

- **`[hidden]` loses to any class that sets `display`.** The UA rule is
  `[hidden] { display: none }`, which a `.thing { display: grid }` outranks on
  specificity. This silently broke the collapsed lede and the request-parts
  unfurl at once. `styles.css` now settles it globally with
  `[hidden] { display: none !important; }` — keep that rule.
- **Format is a standing filter, not a destination.** The Formats browse
  section is gone — a shape of book was never somewhere to go, and every way of
  drawing thickness was rejected. `contentFilter()` is stored per device
  (`panel:filter:format`, `panel:filter:medium`) and `applyContentFilter()` runs
  over every grid of books: publisher catalogues, a thread's credits, hubs,
  search. Render `filterBar()` above any grid it governs, and when a filter
  empties a page say it was the filter, with a Clear button.
- **Page ledes are an introduction, and introductions run once.** Build them
  with `lede(route, {kicker, title, body})`, never by hand. A first visit gets a
  full-screen veil — words arrive blurred, settle, and the panel dissolves after
  ~3s or on any key, click or scroll; reduced motion gets a still panel. Every
  visit after is one kicker line and nothing else. Tracked in `localStorage` as
  `panel:seen:<route>`, cleared by Reset preferences. The veil is stashed in
  `pendingVeil` and appended to `document.body` by `armVeil()` after the route
  renders — never returned inline, because routes that rebuild the view's
  innerHTML would wipe it, and a fixed overlay does not belong in the scroller.

## Style

- Comments explain **why**, never what. If a line looks odd, the comment says
  what broke without it. Match the existing density — it is high on purpose.
- Copy is plain English written from the reader's side. Name things by what a
  person recognises, not how the system is built. The reader manages *requests*,
  not "Mylar watchlist entries".
- Prefer showing over defining. The Formats browse card draws spine thickness to
  scale; that is worth more than the glossary entry beside it.
- `GLOSSARY` is for vocabulary the comics industry owns (omnibus, Epic
  Collection, Earth-616). Never add an entry for a word Panel itself chose — fix
  the word instead.
- Escape everything interpolated into HTML with `esc()`.

## Running it

See `SKILL.md` in `.claude/skills/panel-dev/` for the full loop, including how to
verify a change in a real browser without a display.

Quick version: the app needs a Mylar API key and a ComicVine key, which live on
Unraid. Without them the server boots and serves the local catalogue, but every
Mylar-backed route (`/api/library`, `/api/discover`, `/api/search`) returns an
error. Routes that read only SQLite (`/api/threads/browse`, `/api/requests`,
`/api/publishers`, `/api/formats`, `/api/volume/:id/issues`) work offline.

**Never kill a `node server.js` you did not start** — the user's own dev server
usually runs on `PORT=3013`. Use 3099 for testing and check `PORT` in
`/proc/<pid>/environ` before signalling anything.
