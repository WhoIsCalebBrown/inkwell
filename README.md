# Inkwell

A request front end for [Mylar3](https://github.com/mylar3/mylar3) — the shape
of Overseerr, but for comics, where the hard part is not "which season" but
which of six books called *The Amazing Spider-Man* is the one you meant.

You browse by publisher, character, creator, team or event; open a book; choose
the volumes you actually want; and watch each one through the search, the
download and the import until it is readable in Komga. Nothing is queued until
you say so.

Single user, LAN only, no build step, no framework, no bundler.

## What it talks to

| Service | For | Required |
| --- | --- | --- |
| **Mylar3** | The watchlist, the search, the download queue | Yes |
| **ComicVine** | Books: titles, issue counts, covers, who is in them | Yes (key read from Mylar's config) |
| **Komga** | Proof a book actually arrived, and the link to read it | Optional |
| **Wikidata** | Who a character is: creators, universe, teams, family | Optional, no key |
| **Metron** | Supplementary story-arc data | Optional |

Mylar's own `config.ini` is mounted read-only, so both API keys stay on the
server and key rotation needs no redeploy. Nothing key-shaped ever reaches the
browser.

## Running it

```sh
cp .env.example .env      # set MYLAR_DIR; everything else is optional
docker compose up -d --build
```

`MYLAR_DIR` is the only value you must set: the directory holding Mylar's
`config.ini` and `mylar.db`, mounted read-only. Inkwell reads both API keys
from the first, so they never enter this project or the browser, and reads
search and download state from the second, because Mylar's API does not expose
it. Every other address and path has a single-host default — see
`.env.example`.

Without Mylar the server still boots and serves everything held locally —
browse, publishers, saved books, covers — and says so wherever a provider is
needed.

## Before you expose it

**Inkwell ships with no password and binds to `127.0.0.1`.** It drives a
download client: anything that can reach it can queue books, cancel them and
untrack a series. Two things guard that, and you should know the limits of
both.

- Set `INKWELL_USER` and `INKWELL_PASSWORD` to put it behind HTTP basic auth.
  Off by default, because a LAN-only install behind nothing does not need it
  and a fake login would be worse than an honest none.
- Requests that change something must carry a header Inkwell's own pages send.
  A form on another site cannot set one, and a script that tries triggers a
  preflight Inkwell never answers — so a page you happen to be visiting cannot
  make your Inkwell act. This is not a substitute for a password.

If you put it on the open internet, put it behind a reverse proxy that
authenticates, and turn the password on as well.

## What it cannot see

- **The download queue is Mylar's direct-download queue.** Books fetched
  through an NZB or torrent client do not appear in that section; Mylar tracks
  those in its own history. Requests, searching and arrivals work the same
  either way.
- **That queue is read from Mylar's web interface**, which has no API. A Mylar
  with `authentication = 1` answers with a login page instead, and Inkwell says
  so rather than showing an empty list.
- **Search state is read from `mylar.db` directly**, read-only. It is the only
  place Mylar records which indexers have been tried and when the next sweep
  is. A future Mylar could change that schema; if it does, those panels go
  quiet and nothing else is affected.

## Working on it

```sh
npm run dev            # node --watch, port 3013
npm run verify:http    # the HTTP contract, no provider calls
npm run verify:cache   # every saved relationship, re-derived from its source
```

`npm run dev` reads the same `.env` as the container, so a workstation can talk
to a Mylar and a Komga running elsewhere on the network. Set `MYLAR_CONFIG` to
a config.ini it can read, or hand it `MYLAR_API_KEY` and `COMICVINE_API_KEY`
directly for a session.

The browser gets ES modules straight off disk; `public/index.html` versions the
two assets with `?v=`, so bump both when you change them. `CLAUDE.md` is the
working notes: the model everything is built on, the invariants that have been
got wrong before, and the ComicVine and Mylar quirks each one cost.

## The rules it keeps

- **A relationship is never invented from a keyword.** A book appears under a
  character because ComicVine's record for that book names them, not because
  the title matched.
- **The local catalogue grows only from what you did.** Searched, opened,
  followed or requested. There is no crawler.
- **A provider being down degrades one shelf, not the page.** ComicVine
  throttles for an hour at a time; everything already learned keeps working.
- **The workings are published.** Every list says where it came from and how it
  was matched, because "that shelf is wrong *because* it is a name match" is a
  useful thing for a reader to be able to say.

## Licence

MIT. See [LICENSE](LICENSE).
