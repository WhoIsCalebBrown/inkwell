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
cp .env.example .env
docker compose pull
docker compose up -d
```

That deploys the published image, `ghcr.io/whoiscalebbrown/inkwell`, built for
`linux/amd64` and `linux/arm64`. On Unraid, add the container from
[its template](unraid/inkwell.xml) instead.

Open `http://SERVER-IP:3013` from your trusted LAN. `/config` is Inkwell's
single persistent application-data mount; the container initializes it on
first boot, then runs as the `PUID`/`PGID` configured in `.env.example`.

For normal use, set `MYLAR_DIR` to Mylar's appdata directory (the one holding
`config.ini` and `mylar.db`) and set `MYLAR_URL` to its API. The mount is
read-only: Inkwell reads its keys and state but never changes Mylar files. A
fresh catalogue also needs a ComicVine key, normally read from that config. If
Mylar is temporarily unavailable, Inkwell still starts and its Settings page
states which part needs configuration; Komga remains optional.

Without Mylar the server still boots and serves everything held locally —
browse, publishers, saved books, covers — and says so wherever a provider is
needed.

For the complete install, configuration, backup/restore, upgrade, proxy, and
troubleshooting contract, read [the self-hosting guide](docs/self-hosting.md).
Upgrading is `docker compose pull && docker compose up -d`, or **Update** on
Unraid; `/config` is a mount, so neither one touches your data.

## Before you expose it

**Inkwell ships for a trusted LAN and listens on port 3013.** It drives a
download client: anything that can reach it can queue books, cancel them and
untrack a series. It is deliberately a single-user/shared-account application,
not a public-registration or multi-user service. Two things guard write
requests, and you should know the limits of both.

- Set `INKWELL_USER` and `INKWELL_PASSWORD` to put it behind HTTP basic auth.
  Off by default, because a LAN-only install behind nothing does not need it
  and a fake login would be worse than an honest none.
- Requests that change something must carry a header Inkwell's own pages send.
  A form on another site cannot set one, and a script that tries triggers a
  preflight Inkwell never answers — so a page you happen to be visiting cannot
  make your Inkwell act. This is not a substitute for a password.

For remote access, terminate HTTPS and authenticate at a reverse proxy,
Tailscale, or tunnel, and turn Basic auth on as well. Inkwell does not
terminate HTTPS. It does not trust `X-Forwarded-*` headers unless the direct
proxy IP/CIDR is explicitly listed in `INKWELL_TRUSTED_PROXIES`.

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
npm test               # unit, migration, setup and release-contract tests
npm run verify:http    # the HTTP contract, no provider calls
npm run verify:cache   # every saved relationship, re-derived from its source
npm run verify:docker  # the production image: clean install, persistence, update

# The container, built from the working tree instead of pulled:
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
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

## Releasing

Push a `v1.2.3` tag; GitHub Actions tests it, builds `linux/amd64` and
`linux/arm64`, and publishes one GHCR manifest tagged `latest`, `1`, `1.2` and
`1.2.3`. Nothing else publishes: a merge to `main` is tested and built, never
released. See [the release guide](docs/releasing.md).

## Licence

MIT. See [LICENSE](LICENSE).
