---
name: panel-dev
description: Run Panel locally and verify a change in a real browser without a display. TRIGGER when working in the comic-requester repo and you need to start the server, reproduce a UI bug, check a route renders, screenshot a layout, or confirm a front-end change actually works. DO NOT TRIGGER for pure server-side logic that has no rendered output.
---

# Running and verifying Panel

Panel has no test suite. The only honest way to confirm a front-end change is to
render it in a browser and read the DOM back. Chromium is installed; use it.

## Before you start a server

The user usually has their own dev server running on `PORT=3013`. **Never kill a
`node server.js` process without checking whose it is:**

```sh
pgrep -af "node server.js"
tr '\0' '\n' < /proc/<pid>/environ | grep '^PORT='
```

Use **port 3099** for your own testing, and stop only that one when finished.

## Starting a server

Panel reads its ComicVine and Mylar keys from a mounted Mylar `config.ini`, which
does not exist on this workstation. Two options:

**Offline (no keys).** Boots fine; SQLite-only routes work.

```sh
PORT=3099 MYLAR_CONFIG=/dev/null node server.js > /tmp/panel.log 2>&1 &
```

Works: `/api/threads/browse`, `/api/requests`, `/api/publishers`, `/api/formats`,
`/api/volume/:id`, `/api/volume/:id/issues`, `/api/cover/:id`, all static assets.
Fails with a Mylar error: `/api/library`, `/api/discover`, `/api/search`,
`/api/publisher/:name/volumes`, `/api/settings` health.

**With keys**, if the user's server is running, borrow them from its environment
without ever printing them:

```sh
eval "$(tr '\0' '\n' < /proc/<their-pid>/environ \
  | grep -E '^(MYLAR_API_KEY|COMICVINE_API_KEY)=' | sed 's/^/export /')"
PORT=3099 MYLAR_CONFIG=/dev/null node server.js > /tmp/panel.log 2>&1 &
```

Do not write keys to a file, echo them, or put them in a command line.

## Rendering a route

`--dump-dom` runs the page's JS and prints the resulting DOM. Give it a virtual
time budget so async renders finish.

```sh
chromium --headless --no-sandbox --disable-gpu --user-data-dir=/tmp/cd-1 \
  --virtual-time-budget=12000 --dump-dom "http://127.0.0.1:3099/#/threads"
```

Then pull just the rendered view out, rather than reading 200KB of markup:

```python
import re, sys
h = sys.stdin.read()
v = re.search(r'<main id="view".*?</main>', h, re.S).group(0)
print(re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', v)).strip()[:400])
```

**Watch out:** a regex for an element you injected from an inline `<script>` will
also match that script's own source text in the dump. Match all occurrences and
pick the one with real content.

## Screenshotting a layout

For anything where the question is "does this look right", take the picture and
actually look at it. Check the narrow breakpoint too — Panel is used on phones.

```sh
chromium --headless --no-sandbox --disable-gpu --user-data-dir=/tmp/cd-2 \
  --window-size=1400,560 --virtual-time-budget=8000 \
  --screenshot=/tmp/shot.png "http://127.0.0.1:3099/#/browse"
```

## Driving the UI (clicks, scrolls, state)

`--dump-dom` cannot click. Write a temporary harness into `public/`, drive it
with an inline module script, and stash the result somewhere the dump can see it
— `document.title` for a one-liner, an appended `<pre>` for a log.

```html
<script type="module">
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(5000);
  document.querySelector('[data-request="34272"]')?.click();
  await wait(6000);
  document.title = 'SHEET-' + (document.querySelector('#sheet')?.open ? 'OPEN' : 'CLOSED');
</script>
```

To test something the API cannot serve offline, stub `window.fetch` in a plain
`<script>` **before** the `app.js` module tag, returning `new Response(...)` for
the routes you need. This is how the discover rail paging was verified without
Mylar: fake `/api/discover` and `/api/discover/rail/:id`, then script a scroll to
the end and log how many cards arrived.

**Always delete the harness file when done** — `rm public/_smoke.html`. Check
`git status --porcelain` for strays before you finish.

## Checks worth running every time

```sh
node --check server.js && node --check store.js && node --check public/app.js
```

There is no linter and no type checker. `node --check` is the whole safety net,
so run it after every edit to those files.

## After a front-end change

Bump **both** version strings in `public/index.html`:

```html
<link rel="stylesheet" href="/styles.css?v=N" />
<script src="/app.js?v=N" type="module"></script>
```

They are served `immutable` at a given version, so without a bump the browser
will not fetch your change. Tell the user to hard-refresh, and remind them to
restart their own server if you touched `server.js` or `store.js` — those are
loaded once at boot, while `public/` is read from disk per request.

## Inspecting state

The SQLite file is `data/cache.db`. Reading it directly is often faster than
adding a debug endpoint.

```sh
python3 -c "
import sqlite3
c = sqlite3.connect('data/cache.db')
for r in c.execute('''SELECT s.name, p.status, COUNT(*)
  FROM mylar_parts p LEFT JOIN mylar_series s ON s.comic_id = p.comic_id
  GROUP BY s.name, p.status'''): print(r)
"
```

Note that **opening a part picker caches every part Mylar knows about** for that
series, written as `Skipped`. That is how a 192-issue watchlisted run once
flooded the requests page. If you open a picker while testing, expect rows.
