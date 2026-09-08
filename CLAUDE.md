# Inkwell — working notes for agents

An Overseerr-style request front-end for Mylar3. Single user, LAN-only, run as
a container beside Mylar and Komga.

Every address and path is an environment variable with a localhost default —
see `.env.example`. Do not hard-code the address of whatever machine you are
working on; that is what a `.env` is for.

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
7. **Preferences are per-device**, in `localStorage` under `inkwell:*`. They never
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
  A team's books can therefore only be found by its name, which is a weaker
  claim than a saved credit and the page says so. **Do not fill a team shelf
  from its members' credits.** That was tried: because ComicVine files every
  name in a cast list as a credit, and an omnibus cast runs to hundreds,
  Guardians of the Galaxy came out showing Essential X-Men and an Amazing
  Spider-Man omnibus. A member's books belong on the member's page, which the
  roster chips link to.
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

## Mylar has two interfaces, and Inkwell needs both

The API (`:8090/api?cmd=`) covers the watchlist, a series' parts, and queueing
an issue. It has no command for the direct-download queue at all — that lives
only behind the web UI, unauthenticated on the LAN (`authentication = 0`):

- `GET /queueManageIt` is the queue page's own JSON feed. Rows are positional:
  `[series, size, progress, status, updated, queueId, issueId, comicId, link]`.
  `progress` is only ever `100%` or empty — **Mylar does not track bytes for a
  running transfer**, so there is no percentage to show and no bar to draw.
- `GET /ddl_requeue?mode=restart_queue` hands every `Queued` row back to the
  worker; `mode=restart&id=<queueId>` does one row, whatever its status.
  Also `abort`, `remove`, `clear_queue`.

**The failure this exists for:** the DDL queue has one worker. If Mylar restarts
mid-download, that row stays marked `Downloading` forever, nothing picks the
rest up, and every later request sits at `Queued` behind it — indefinitely, with
nothing in the log after the restart. From the request list that is
indistinguishable from a search that never found anything. It had 12 files
wedged behind one dead row for a day before Inkwell could see it.

Its SQLite (`/run/mylar/mylar.db`, mounted read-only) carries the rest: which
providers have searched and when (`provider_searches`), when the standing sweep
next runs (`jobhistory`), what is Wanted and since when (`issues`), and what has
been post-processed (`snatched`, which Inkwell uses as the arrival bell). It is
`journal_mode=delete`, so a reader needs no write access to the file or its
directory — which is what makes the `:ro` mount into a read-only container work.
Every read degrades to null when the file is absent, as it is in local
development.

**Mylar's timestamps are inconsistent and it matters.** `ddl_info.updated_date`
is local wall clock; `jobhistory` is UTC; `next_run_timestamp` is a real epoch
for some jobs and a UTC datetime string for others. The server normalises what
it reads from SQLite to an ISO instant (`instant()`); the DDL queue's local
times are parsed in the browser, which shares Mylar's clock, and never on the
server, which does not.

GetComics mirrors are tried in `ddl_priority_order` (mega, mediafire,
pixeldrain, main). Mega commonly answers `ETOOMANY` for hours at a time; Mylar
falls through to the next mirror on its own, so a Mega failure in the log is
not a fault to fix.

## Events, and why the server has a watcher

Inkwell used to be a page you had to visit; that is how a wedged download queue
went unnoticed for a day. `watchForEvents()` runs every five minutes, reads only
what Mylar has already written, and turns two things into events: a book
post-processed (`snatched`), and a queue that has stopped. Events are recorded
once — `key` is what makes that true — shown on My requests, and pushed to
`PANEL_NOTIFY_URL` if one is set (Discord shape when the URL is a Discord
webhook, otherwise ntfy's body-plus-Title; `PANEL_NOTIFY_FORMAT` overrides).

On an empty events table the first pass records silently. There is no useful
moment to tell a reader about a book that landed last week.

**Stall detection must never use Mylar's clock.** How long a file has been
downloading is measured from Inkwell's own observations, kept in `downloads:running`
in the cache. Reading `ddl_info.updated_date` as if it were this container's
local time reported a perfectly healthy 3GB transfer as stalled, minutes after a
deploy.

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
  (`inkwell:filter:format`, `inkwell:filter:medium`) and `applyContentFilter()` runs
  over every grid of books: publisher catalogues, a thread's credits, hubs,
  search. Render `filterBar()` above any grid it governs, and when a filter
  empties a page say it was the filter, with a Clear button.
- **Page ledes are an introduction, and introductions run once.** Build them
  with `lede(route, {kicker, title, body})`, never by hand. A first visit gets a
  full-screen veil — words arrive blurred, settle, and the panel dissolves after
  ~3s or on any key, click or scroll; reduced motion gets a still panel. Every
  visit after is one kicker line and nothing else. Tracked in `localStorage` as
  `inkwell:seen:<route>`, cleared by Reset preferences. The veil is stashed in
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
  Collection, Earth-616). Never add an entry for a word Inkwell itself chose — fix
  the word instead. "Credits" was one of those: it is now "the books ComicVine
  names them in", everywhere a reader can see it.
- `SOURCES` is the other half of the same ⓘ: where a list on the page came from
  and how it was matched. Every section heading that assembles data from
  somewhere should carry one. It is what lets a reader say "that shelf is wrong
  *because* it is a name match" rather than "this looks random" — which is the
  only useful bug report about a data source, and the reason the workings are
  published rather than implied.
- **A `<select>` needs `appearance: none`.** iOS Safari otherwise draws its own
  rounded pill with its own padding inside our box, and the value is clipped —
  "Comics & manga" did not fit its field on an iPad while looking fine in
  Chromium. Dropping the native appearance means supplying the arrow ourselves
  (an inline SVG background) and leaving `padding-right` clear of it.
- **Never put an ⓘ inside a `<label>` that wraps its control.** A tap on the
  icon activates the control it is explaining: the format and kind dropdowns
  opened at the same time as their own tooltip, and neither could be used.
  `filterField()` keeps the label, the icon and the `<select>` as siblings and
  ties the first two together with `for`/`id`.
- **The ⓘ must open on tap.** iPad is a primary device and has no hover; the
  click handler used to swallow the tap and show nothing, which made every icon
  decoration on the device Inkwell is mostly read on. Tap toggles `.open`, another
  tap, Escape or a scroll closes it, and `placeTip()` flips it away from the
  right edge (the page clips rather than scrolls, so an unflipped tip would be
  gone, not merely awkward).
- Escape everything interpolated into HTML with `esc()`.

## Running it

See `SKILL.md` in `.claude/skills/inkwell-dev/` for the full loop, including how to
verify a change in a real browser without a display.

Quick version: the app needs a Mylar API key and a ComicVine key, which live on
Unraid. Without them the server boots and serves the local catalogue, but every
Mylar-backed route (`/api/library`, `/api/discover`, `/api/search`) returns an
error. Routes that read only SQLite (`/api/threads/browse`, `/api/requests`,
`/api/publishers`, `/api/formats`, `/api/volume/:id/issues`) work offline.

**Never kill a `node server.js` you did not start** — the user's own dev server
usually runs on `PORT=3013`. Use 3099 for testing and check `PORT` in
`/proc/<pid>/environ` before signalling anything.
