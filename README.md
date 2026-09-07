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
cp .env.example .env      # optional: notifications, Metron
docker compose up -d --build
```

The compose file expects an Unraid-style layout: Mylar's appdata directory
mounted read-only at `/run/mylar` (its `config.ini` for the keys, its
`mylar.db` for search and queue state) and Komf's config for the Komga login.
Adjust the paths and the published address at the top of `docker-compose.yml`
to match your machine.

Without Mylar the server still boots and serves everything held locally —
browse, publishers, saved books, covers — and says so where a provider is
needed.

## Working on it

```sh
npm run dev            # node --watch, port 3013
npm run verify:http    # the HTTP contract, no provider calls
npm run verify:cache   # every saved relationship, re-derived from its source
```

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
