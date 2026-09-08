# Inkwell self-hosted release-readiness audit

**Audit date:** 2026-09-08  
**Scope:** current working tree, including uncommitted application and Docker changes. This is an audit and release plan only; it does not change application code or deployment files.

## Release decision

**Not ready for a public v1.0.0 or public beta yet.** Inkwell has a sound, pleasantly small application shape, but its current Compose file is still a developer-adjacent deployment: it builds locally, publishes only to host loopback by default, assumes a writable named volume owned by the image's `node` user, and has no release image, migration contract, Unraid template, or complete install/backup documentation.

**Phase 3 update (2026-09-08).** The publishing half of that gap is now implemented and locally validated: a CI workflow, a tag-triggered GHCR release workflow producing a `linux/amd64` + `linux/arm64` manifest with semantic tags and OCI metadata, an image-based release Compose file with a developer build override, and a reviewed Unraid template. Everything except the act of publishing has been exercised — including a real emulated arm64 container run and an image-replacement test against a populated `/config`. What remains unproven is exactly what cannot be proven without pushing: the first GHCR publish, the package visibility change it requires, and an Unraid installation actually offering Update. Those are listed under SELFHOST-003 and SELFHOST-013 below.

The right target is still one canonical container image. There is no evidence that Inkwell needs Redis, a separate database service, a queue container, or a scheduler container. It is a single Node process with embedded SQLite and embedded background timers. Mylar3 is a required *external companion service*, and Komga is an optional external companion service; Inkwell should not bundle or operate either of them.

### Audit evidence and limits

- Inspected every tracked source, deployment, configuration, test, documentation, and public asset file, plus the current Git status/history and Compose rendering.
- `npm test` passed: 14/14 discovery tests. A provider-free isolated run passed all 9 `verify:http` checks and returned a healthy HTTP response.
- `npm audit --omit=dev` reported 0 known production dependency vulnerabilities at audit time.
- The initial local audit account was denied access to `/var/run/docker.sock`. Phase 1 subsequently ran the production-image smoke test over SSH on Unraid: fresh named volume, fresh bind mount, non-root runtime UID, restart, and persisted SQLite state all passed. A separate temporary LAN binding was reached from this workstation. The exact normal Compose port 3013 was not reused because an existing testing Inkwell already occupies it.
- No committed secret value was found by scanning the tracked tree and history for common credential markers. The ignored local `.env` and ignored `data/` were not read or included in the audit.

## 1. What Inkwell actually is today

| Concern | Current implementation | Runtime implication |
| --- | --- | --- |
| Application/framework | Node.js ESM, Express 5, no ORM or server-side framework | One `node server.js` process. Node's built-in `node:sqlite` requires a suitably recent Node 22+ runtime; declare and pin this. |
| Front end | Plain static HTML/CSS/ES-module JavaScript in `public/`; no bundler, SSR, or dev server | No frontend build process is needed or desirable. Express serves the assets. |
| Back end | `server.js` (~2,900 lines in the working tree) exposes JSON API plus static assets | HTTP on internal TCP port 3000, listening on `0.0.0.0` inside the container. |
| Database | A single SQLite database opened synchronously through `DatabaseSync`; current Compose location `/data/cache.db` | It is application state, not merely throwaway cache: it contains catalogue mirror data, cover index, cached provider responses, Mylar part snapshots, events, and the durable enrichment queue. |
| Cache | In-memory request memoization plus tables in the same SQLite database | Memory cache is disposable. SQLite cache is rebuildable but expensive and includes user-visible event/request-state history. |
| Queue/scheduled work | No broker. SQLite table `catalogue_enrichment`; `setInterval` every 15s runs one enrichment job. `setInterval` also watches Mylar downloads/events every five minutes. First-run discovery seeds are enqueued after startup. | The web process is also the only worker and scheduler. Run exactly one replica. No second process/container is needed. |
| Web server | Express directly; no nginx/Caddy bundled | A reverse proxy is optional and should terminate TLS outside the app. |
| Files written | SQLite DB and `-wal`/`-shm` files; cached cover images under `COVER_DIR`; short-lived cover `*.tmp` files | All must use one writable persistent application-data mount. |
| Files read | Mylar `config.ini` and `mylar.db` from a read-only mount; optional Komf `application.yml` from a read-only mount | Inkwell does **not** read comic files or scan a comic library directly. It needs no `/comics` mapping today. |
| External APIs | Mylar HTTP API/web UI, ComicVine HTTPS, optional Komga HTTP API, optional Wikidata SPARQL/API, optional Metron HTTPS, optional notification webhook | All outbound calls have timeouts. Mylar and ComicVine are functionally required for a fresh useful installation; Komga/Metron/Wikidata/notification are optional. |
| Authentication | Optional single shared HTTP Basic username/password from environment; no users table, registration, sessions, cookies, reset, RBAC, or admin role | It is a single-user/trusted-LAN application, not safe multi-user software. |
| Migrations/seeding | Schema created via `CREATE TABLE IF NOT EXISTS`, indexes, and one ignored-error `ALTER TABLE`; startup hydrates derived tables and queues fixed discovery search seeds | There is no versioned migration ledger, migration locking, backup checkpoint, downgrade policy, or formal seed lifecycle. |

### Processes and ports

Only one process must run: `node server.js`. It serves the UI, APIs, enrichment lane, and five-minute watcher. There are no WebSockets, cron daemon, worker command, Redis, mailer, or externally exposed database. Inkwell's container port is **3000/TCP**. Current Compose publishes host port **3013** and binds it to **127.0.0.1**.

### What it does not require

Inkwell does not require a separate Postgres/MySQL database, Redis, a message broker, direct comics-library access, upload storage, a browser-side API key, or a frontend compilation stage. Adding any of those would add operational burden without solving a current requirement.

## 2. Persistence and backup boundary

| Category | Current source/path | Survives replacement now? | Release target |
| --- | --- | --- | --- |
| Configuration | Compose environment / host `.env`; mounted Mylar and optional Komf configuration | Only if operator retains the host `.env` and companion-service appdata | Document a minimal host `.env` or use a clearly documented `/config` file. Do not copy Mylar/Komga secrets into browser-visible data. |
| Database | `CACHE_DB=/data/cache.db` before Phase 1 | Yes only when the named `inkwell-cache` volume is retained and writable | `/config/cache.db` plus its `-wal` and `-shm` files. Back up as a unit after checkpoint/while stopped. |
| Application-generated data | `/data/covers` before Phase 1, plus SQLite catalogue, events, enrichment state, Mylar state snapshots | Same condition as database | `/config/covers` and SQLite under `/config`; retain across upgrades. Covers may be regenerated, but keeping them avoids slow API calls. |
| Cache | SQLite `cache` table and in-process maps | SQLite portion persists; memory does not | Persistent but explicitly rebuildable. Provide a UI/CLI-safe clear operation and size policy. |
| Temporary data | Cover `.<id>.<pid>.tmp` files; in-memory maps | No guarantee/acceptable | `/tmp` or `/config/tmp`; remove stale files on startup. Never back up. |
| Media/library | No direct comic/library mount exists | N/A | No mapping should be advertised. Mylar and Komga own their own media/appdata backups. |
| Logs | stdout/stderr only | N/A | Keep stdout/stderr; do not make logs a required persistent volume. |

**Backup contract for the release target:** back up `/config` and the operator's deployment configuration (normally the Compose `.env`, if it remains outside `/config`). Separately back up Mylar and Komga according to their own documentation, including their databases and media; Inkwell cannot restore a Mylar request or a comic file from its own database. Artwork/cache can be omitted from a space-constrained backup and regenerated, but then local catalogue/event history and warm cache are lost. A restore is: stop Inkwell, restore `/config` with its ownership preserved, start the same-or-newer compatible image, verify `/api/ready`, then inspect the Settings/health UI. Do not restore only `inkwell.db` while leaving stale `-wal`/`-shm` files.

## 3. Current first-run path

The literal public-user flow requested in the brief does not work as intended:

1. A user downloads the repository and runs `docker compose up -d`.
2. Compose stops immediately unless `MYLAR_DIR` was set. It also requires a local source checkout because it uses `build: .`, not a published image.
3. With a value set, Compose creates/mounts `/data`, then the image runs as UID/GID `node` (normally 1000:1000). A new Docker named volume root is normally root-owned, so startup is expected to fail creating `/data/cache.db` or `/data/covers`.
4. If it gets past permissions, the WebUI is published only to host loopback. `http://SERVER-IP:3013` does not work from another LAN device, contrary to the expected clean-install flow. The Unraid label also hard-codes `3013` rather than the selected port.
5. There is no setup wizard, config editor, connection test, first admin account, or preflight. Missing/invalid Mylar configuration is discovered lazily when a provider route is used. First-run discovery immediately queues ComicVine work; without a usable ComicVine key it repeatedly postpones the jobs.

The application deliberately degrades individual pages when providers fail, which is good, but that is not a substitute for a guided installation that tells a new user which prerequisite is missing and how to fix it.

## 4. Configuration inventory

`NODE_ENV` is set by the Dockerfile but the application does not branch on it. `INKWELL_VOLUME` and `KOMF_CONFIG` are Compose interpolation variables, not runtime variables read by Node.

| Variable | Current role/default | Classification and release recommendation |
| --- | --- | --- |
| `PORT` | App HTTP port; Docker default `3000` | Advanced/internal. Keep internal 3000; normally expose host port in Compose/Unraid rather than asking users to set this. |
| `CACHE_DB` | SQLite path; default project `data/cache.db` | Advanced/internal. Replace with one `CONFIG_DIR=/config` or default `/config`; do not surface normal users to individual DB paths. |
| `COVER_DIR` | Cached cover directory; default project `data/covers` | Advanced/internal. Derive from `CONFIG_DIR`; do not expose separately. |
| `MYLAR_DIR` | Compose-only required source bind mount | Required for the current preferred integration. User-facing path, read-only, and must contain `config.ini` plus `mylar.db`. Explain it is **Mylar appdata**, not comics. |
| `MYLAR_CONFIG` | `config.ini` path; default `/run/mylar/config.ini` | Advanced override. Keep for nonstandard layouts, document only in advanced configuration. |
| `MYLAR_DB` | Mylar DB path; default sibling `mylar.db` | Advanced override. Same treatment. |
| `MYLAR_URL` | Mylar API; default `http://127.0.0.1:8090/api` | Required for request actions. User-facing, no safe universal default in multi-container or separate-host installs. Recommend a Docker DNS/service-name example and a host/LAN example. |
| `MYLAR_WEB_URL` | Mylar web UI; defaults from API URL | Advanced optional override for Mylar web queue endpoints. Document that authenticated Mylar web UI disables queue diagnostics/actions with current code. |
| `MYLAR_API_KEY` | Direct override for key otherwise read from config | Secret, advanced. Permit it for deployments that cannot mount Mylar config, preferably via Docker secrets/file support rather than a committed `.env`. |
| `COMICVINE_API_KEY` | Direct override otherwise read from config | Secret, advanced but functionally required for fresh metadata/discovery. Clearly document acquisition, storage, and provider terms. |
| `KOMGA_URL` | Komga API URL | Optional user-facing integration setting. No safe general default. |
| `KOMGA_CONFIG` | Optional Komf file path | Advanced override. Current Compose mounts a placeholder so it is not a required path. |
| `KOMGA_USER`, `KOMGA_PASSWORD` | Direct Komga credentials | Optional secrets. Prefer a Komga API credential/token if Komga supports one; otherwise document secret handling and least privilege. |
| `KOMGA_PUBLIC_URL` | Browser-facing Komga base URL for Read links | Optional user-facing setting, needed when Inkwell's internal route differs from externally reachable Komga route. |
| `METRON_TOKEN` | Optional bearer token | Optional secret. Missing token correctly disables Metron. |
| `INKWELL_USER`, `INKWELL_PASSWORD` | Optional HTTP Basic auth | Security-critical secrets. Current names are user-facing; production Compose must require them when LAN/non-loopback publishing is enabled or put setup/auth behind a deliberate safe flow. |
| `INKWELL_NOTIFY_URL` | Optional outbound webhook | Optional secret/sensitive URL. Treat as a secret; validate format and redact in health/logs. |
| `INKWELL_NOTIFY_FORMAT` | `auto`, `ntfy`, `discord`, or `json` | Optional user-facing advanced setting; validate accepted values at startup. |
| `INKWELL_BIND` | Compose host-bind address, default `127.0.0.1` | Deployment setting, not app setting. It currently makes LAN install fail; choose a documented secure default. |
| `INKWELL_PORT` | Compose published host port, default `3013` | Deployment setting. Use the actual default consistently in README, label, template, and examples. |
| `INKWELL_VOLUME` | Compose named-volume name | Advanced migration compatibility knob. Do not expose in normal install UI; use `/config` bind mount for Unraid. |
| `PUID`, `PGID`, `UMASK` | Not implemented | Recommended addition because Inkwell writes host-mounted appdata on Unraid/NAS systems. Do not use them for Mylar/Komga/comic mounts, which remain read-only. |

### Minimal release configuration

For a normal installation, keep the required surface to: application data path, Mylar appdata path, Mylar API URL, and a first shared authentication credential (or a completed secure setup flow). Komga URL/credentials, public Komga URL, notifications, Metron, alternate Mylar paths, and direct API-key overrides are optional/advanced. Do not ask users to configure cache/cover/database paths, Node environment, or provider internals at initial install.

## 5. Target shipping architecture

```
                 HTTPS (optional; TLS terminates here)
Browser ───────────────────▶ Reverse proxy / LAN client
                                      │
                                      ▼
                          :3000/TCP (internal)
                 ┌─────────────────────────────┐
                 │      Inkwell container      │
                 │ Express + SQLite + worker + │
                 │ scheduler in one process    │
                 └───────┬───────────────┬─────┘
                         │               │
            /config (rw) │               │ /run/mylar (ro)
      SQLite, covers, app │               │ Mylar config.ini + DB
                         ▼               ▼
                 persistent bind      Mylar3 (external)
                 mount/volume              │
                                      ComicVine API

                         └──── optional HTTP ───▶ Komga
                         └──── optional HTTPS ──▶ Wikidata / Metron / ntfy
```

Use one OCI image, for example `ghcr.io/whoiscalebbrown/inkwell`. Publish a Compose file that references that image; the Unraid Community Applications template references exactly the same tag. Do not run Mylar, Komga, Redis, or a database in the Inkwell Compose file unless the project later explicitly chooses to provide a tested full stack. They have independent existing installations, storage, upgrade cadence, and security boundaries.

Recommended target interface:

| Item | Recommendation |
| --- | --- |
| Container | One `inkwell` container; one replica only. |
| Port | Internal 3000/TCP. Choose one documented host default (3000 is conventional; retaining 3013 is fine only if all assets agree). |
| Persistent storage | `/config` writable. It owns SQLite, WAL/SHM, covers, and any future application-owned configuration. |
| Source mounts | `/run/mylar:ro`; optional `/run/komf/application.yml:ro`. No `/comics` mount until code actually consumes it. |
| Required variables | `MYLAR_URL` and either read-only Mylar config mount or direct Mylar/ComicVine secrets; deployment authentication must be enabled for a LAN/remote published port. |
| Optional variables | Komga, public Komga URL, Metron, notifications, advanced paths. |
| Networking | Default direct published port for simple installs; optional shared external proxy network documented separately. Use service DNS rather than `127.0.0.1` for another Docker container. |
| Upgrade | Pull immutable/version tag, start replacement, run an explicit serialized SQLite migration/checkpoint step, then start the sole application process. |

## 6. Prioritized findings

### P0 — Release blockers

#### Phase 1 implementation status (2026-09-08)

This section records implementation progress after the audit. Container tests
were run on the Unraid Docker host over SSH; local Docker access remains
unavailable to this audit account.

| Finding | Status | Implementation notes | Validation performed | Remaining risk / Docker validation |
| --- | --- | --- | --- | --- |
| SELFHOST-001 | Implemented and Docker-validated | Added `/config` as the canonical application-owned mount, `PUID`/`PGID`/`UMASK`, and an entrypoint that creates/chowns only `/config`, `/config/covers`, and `/config/backups`, then uses `su-exec` to run Node non-root. Existing named volume contents remain at the mount root, preserving `cache.db` and `covers` when moving the mount from `/data` to `/config`. | Shell syntax checked; fresh SQLite storage regression test passes. Unraid production-image smoke passed for a fresh named volume and fresh bind mount, with PID 1 running as test UID 12345. | Validate the ownership path on an actual Unraid appdata share/user mapping before CA release; no blocker remains for ordinary local-volume/bind-mount use. |
| SELFHOST-002 | Implemented and LAN-validated | Compose now publishes `0.0.0.0:3013` by default for a trusted LAN and uses the matching Unraid WebUI port. HTTPS remains proxy/Tailscale/tunnel responsibility. Forwarded headers are not trusted unless `INKWELL_TRUSTED_PROXIES` is explicitly set. This small P1 proxy-safety change was necessary to make the P0 networking decision safe. | Compose rendering confirms host `0.0.0.0`, published 3013, and no default trusted proxies. A temporary Unraid container bound to its LAN IP on unused port 31313 answered `/api/ready` and `/api/setup` from this workstation. | Exact 3013 was not exercised because an existing test Inkwell owns it. Host-based reverse-proxy behavior remains P1 work. Plain HTTP remains intentionally unauthenticated only on a trusted LAN. |
| SELFHOST-003 | **Open — intentionally deferred** | Publishing/CI/GHCR work was not started because this phase explicitly excludes publishing. Compose still builds a local image. | N/A. | A public release image, version tags, multi-arch build, and release smoke workflow remain a release blocker before public beta. |
| SELFHOST-004 | Implemented for the current single-user product scope | Compose can now boot provider-free using a read-only placeholder. `/api/setup` and Settings expose credential/configuration readiness without leaking paths or secrets. First-run discovery no longer queues/retries until a ComicVine credential exists. No account/registration system was added: v1 remains an explicitly shared Basic-auth or trusted-LAN app, so an "initial admin" is not a meaningful separate entity. | Provider-free HTTP contract passes, including `/api/setup`; manual isolated run and Unraid LAN container displayed the setup state and deferred seed warning. | Validate against real Mylar appdata/API and improve broader setup/configuration UX under P1. |
| SELFHOST-005 | Implemented and Docker-validated for clean install/restart | Replaced inline best-effort schema changes with ordered migration versions, a migration ledger, exclusive SQLite transaction, inter-container migration lock file, automatic online pre-migration SQLite backup for existing DBs, startup refusal on a failed/gapped/newer schema, and graceful checkpoint/close on SIGTERM. | Added automated fresh-DB/restart, legacy-DB/in-place migration/backup, and newer-schema refusal tests; all pass. Unraid smoke passed initial creation, restart, and persisted SQLite marker against both named volume and bind mount. | Must test a future image-to-image schema upgrade, interrupted migration, and stale lock recovery procedure when a new migration is introduced. One replica remains required. |

#### Phase 2 P1 implementation status (2026-09-08)

This phase intentionally addresses the self-hosted install, configuration, and
runtime P1s. Publishing, multi-architecture release automation, Community
Applications submission, broad repository-policy work, and provider-terms
review remain outside this implementation pass.

| Finding | Status | Implementation notes | Validation performed | Remaining risk / Docker validation |
| --- | --- | --- | --- | --- |
| SELFHOST-006 | Implemented for the documented single-user model | A fresh installation is write-gated until server-persisted setup completes. Trusted-LAN installations must explicitly acknowledge that model; shared Basic authentication remains supported, has bounded failed-attempt rate limiting, and baseline response headers are set. There is no public registration or admin bootstrap because v1 has no account model. | Automated setup regression covers write blocking, acknowledgement, restart persistence, and allowed writes after completion. Nginx proxy smoke completed setup and a write through a dedicated host; the Compose smoke completed the trusted-LAN acknowledgement on port 31314. | This intentionally does not make Inkwell multi-user. Operators must still use authentication/TLS before remote exposure. |
| SELFHOST-007 | Implemented; live-Mylar validation remains | Removed the misleading container-localhost default. Setup distinguishes a readable Mylar mount, credential availability, and a valid API URL; it provides a bounded connection test. Compose supports direct secret overrides only as an advanced alternative and always mounts Mylar appdata read-only. | Provider-free clean-install/container tests prove a missing mount is nonfatal; setup regression tests direct credential configuration. | A real Mylar appdata/API test on each supported Mylar version and restrictive Unraid share remains before claiming broad companion compatibility. |
| SELFHOST-008 | Implemented and Docker-validated | `/config` is now documented as the application-data boundary, including SQLite, setup state, covers, and migration backups. A separately named Compose service volume preserves the legacy physical default for upgrade compatibility. | Unraid Docker smoke now creates state, stops, copies/restores the bind-mounted `/config`, recreates the container, and verifies the marker survives. An isolated real Compose deployment also retained completed setup across restart. | Covers/cache remain intentionally regenerable; Mylar/Komga/media backups stay external. |
| SELFHOST-009 | Partially implemented | The production image now pins Node `22.18.0-alpine`, installs only production dependencies, selectively copies runtime files, excludes `.env` from build context, runs non-root after entrypoint initialization, and has a production smoke test. The Compose file no longer forces a global container name, so it can coexist with another project/test. | Production images built and ran in isolated Unraid Docker tests, including a real Compose build/start/restart on alternate port 31314. | OCI release labels, immutable digest recording, amd64/arm64 manifest build, and CI belong with the still-open publishing/release work. |
| SELFHOST-010 | Implemented and Docker-validated | Root-host proxying is documented; no HTTPS/WebSocket/base-URL feature was added because the app has none. Forwarded headers remain untrusted unless explicitly configured. v1 explicitly does not support subpaths. | A fresh production image was reached through an isolated Nginx container; preserved host/origin allowed setup completion and a protected write. | Nginx was exercised. NPM/Caddy/Traefik use the same standard HTTP root-host contract but were not individually container-tested. |
| SELFHOST-011 | Template prepared, not submitted | Added a maintained Unraid template draft using the future canonical GHCR image, host port 3013, local `/config` appdata, read-only Mylar appdata, clear optional advanced fields, and the tracked Inkwell SVG icon. It deliberately has no comics mapping. | XML syntax checked locally. The underlying bind-mount/PUID/PGID runtime contract was Docker-tested on Unraid. | Publishing an image, live template-install testing, and CA submission are intentionally deferred. |
| SELFHOST-012 | Deployment documentation implemented; repository-doc scope remains open | Added a self-hosting guide covering install, first run, config, topology, backup/restore, migrations, upgrades, proxying, and troubleshooting. README now states the product boundary. | Commands and endpoint behavior are backed by automated and remote Docker smoke tests described above. | Screenshots, FAQ, contribution/security policy, issue templates, and broader public-project documentation were deferred by scope. |
| SELFHOST-013 | Open — deferred with publishing/CI work | Reusable Docker and proxy smoke harnesses now exist for a later CI workflow. | Both harnesses ran successfully against Unraid Docker. | No GitHub workflow, release build, architecture matrix, SBOM, or scanning was added. |
| SELFHOST-014 | Implemented as a documented product boundary | Setup, README, configuration guide, and template state that v1 is shared/trusted-LAN or shared-Basic only. No registration/account claim is made. | Setup regression verifies the intentional access acknowledgement. | A true multi-user authorization model remains future architecture work. |
| SELFHOST-015 | Implemented for the supported contract | `/config` ownership uses PUID/PGID/UMASK; only application-owned files are changed. Mylar remains read-only, no comic media path is mounted, and docs require local appdata rather than untested SMB/NFS SQLite storage. | Fresh named-volume and bind-mount tests passed on Unraid Docker with a non-default UID/GID. | Test an actual restrictive Unraid appdata ACL/share before release. Network filesystem support is intentionally not claimed. |
| SELFHOST-016 | Implemented and Docker-validated | Graceful shutdown/checkpoint, liveness/readiness separation, migration failure startup refusal, backup/restore instructions, and a bind-mount restore regression are in place. Setup incomplete is ready because the server is correctly serving the setup UI; failed SQLite migration never reaches readiness. | Automated migration/setup tests, Unraid bind-volume/restore smoke, and real Compose stop/restart setup persistence pass. | Future-version upgrade and interrupted-migration fixtures remain needed when a new migration is introduced. |
| SELFHOST-017 | Partially implemented | Required vs optional integrations are explicit, setup can test Mylar, invalid/missing optional integrations do not block boot, and the self-hosting guide records basic offline behavior. | Provider-free and direct-credential setup paths tested. | Provider terms/attribution, real-provider end-to-end checks, persistent cooldown policy, and webhook URL redaction remain open. |

#### Phase 3 publishing implementation status (2026-09-08)

This phase covers only the release/distribution path: CI, the GHCR release
workflow, the release Compose shape, image hardening for multi-architecture
builds, the Unraid template review, and the documentation for all of it. No
application behavior, port, path, environment variable, or storage behavior was
changed.

| Finding | Status | Implementation notes | Validation performed | Remaining risk / external validation |
| --- | --- | --- | --- | --- |
| SELFHOST-003 | Implemented and exercised end to end | `.github/workflows/release.yml` triggers only on `v[0-9]+.[0-9]+.[0-9]+` (plus a `-suffix` prerelease), reuses `ci.yml`, authenticates to GHCR with `GITHUB_TOKEN` alone, and publishes one `linux/amd64` + `linux/arm64` manifest tagged `latest`, `1`, `1.2`, `1.2.3` — with the three moving aliases explicitly gated off for prereleases. It refuses a tag that disagrees with `package.json`, asserts both architectures are in the published manifest, attaches SBOM/provenance and a signed build attestation, and writes the digest into the GitHub Release. `docker-compose.yml` now deploys `ghcr.io/whoiscalebbrown/inkwell:${INKWELL_VERSION:-latest}`; `docker-compose.dev.yml` restores the local build. | Both workflows parse; the tag/alias/prerelease rules, image-name agreement across Compose, template and workflow, and the "no secret but `GITHUB_TOKEN`" rule are asserted by `test/release-contract.test.mjs`. Both Compose files validate with `docker compose config`. Both architectures were built from this Dockerfile on a real Docker host, and the arm64 image was loaded and run under emulation: ready, healthy, `aarch64`, non-root PID 1, `/config` correctly owned. | Proven by two real releases (see the note below). What remains is visibility, not machinery: the package and repository are private, so Unraid's anonymous digest check cannot see the image and GitHub will not store an attestation. |
| SELFHOST-009 | Implemented | The image now carries OCI labels (title, description, url, source, documentation, vendor, licences) with version/revision/created supplied per release by `docker/metadata-action`, a `HEALTHCHECK` for hosts that do not read the Compose file, `apk add` moved ahead of the source layers so an emulated arm64 rebuild does not repeat it, and a `.dockerignore` that keeps docs, tests, tools, design bundles and every `.env` out of the build context. The base image stays pinned to `node:22.18.0-alpine`. | Full production-image smoke passed on a real Docker host in 19s. `node:22.18.0-alpine` was confirmed to publish `linux/arm64/v8`, and `su-exec` to exist for `aarch64` on Alpine 3.21/3.22, before either build. Labels were read back off the built arm64 image. | Release-time labels (version, revision, created) are asserted only by the workflow configuration until a tag runs. |
| SELFHOST-011 | Reviewed and corrected; not yet installed from | `WebUI` now uses `[PORT:3000]`, the container port, so the link follows a changed host port; `TemplateURL` is a raw XML URL rather than a `blob` HTML page; `Registry` points at the GHCR package; `ReadMe`, `Requires` and a `no-new-privileges` `ExtraParams` were added; the optional Komf mount now comes with the `KOMGA_CONFIG` variable that makes it do anything. `/config` remains a required read/write host path and Mylar appdata remains read-only. | The template was rendered through Unraid's own `xmlToCommand()` on an Unraid 7 host: correct image, `-p '3013:3000/tcp'`, `-v '/mnt/user/appdata/inkwell':'/config':'rw'`, read-only Mylar mount, empty optional path correctly omitted. `DockerTemplates::getControlURL()` was called directly to prove `[PORT:3000]` follows a changed host port where `[PORT:3013]` does not. `test/release-contract.test.mjs` guards every one of these properties. | Installing the template on Unraid, seeing "update ready" after a second release, and Community Applications submission all require a published image first. |
| SELFHOST-013 | Implemented | `.github/workflows/ci.yml` runs on pull requests and pushes to `main` and is `workflow_call`-able, so the release runs the identical checks: lockfile install on the Node version read out of the Dockerfile, a parse of every shipped module, entrypoint shell check, the full test suite, production dependency audit, both Compose files, the Unraid XML, the production-image clean-install/persistence/replacement smoke, and a `linux/amd64,linux/arm64` build. | Every check was run locally or on the Unraid Docker host; the suite is 26 tests, all passing. | Both workflows have now run green on GitHub Actions. Vulnerability scanning of the published image is still not part of the pipeline. |

**Publication, as actually exercised (2026-09-08).** Two release candidates were
tagged and published from this repository:

- `v1.0.0-rc.1` built and pushed `ghcr.io/whoiscalebbrown/inkwell:1.0.0-rc.1`,
  digest `sha256:cf8bc2b2…`, and the workflow's own assertion confirmed
  `linux/amd64 present` and `linux/arm64 present`. The prerelease gating worked:
  that was the only tag pushed — no `latest`, `1` or `1.0`. The run then failed
  at `actions/attest-build-provenance`, which GitHub does not offer for a
  user-owned private repository. The attestation step is now conditional on the
  repository being public.
- `v1.0.0-rc.2` completed: manifest pushed (digest `sha256:76cf60f1…`), both
  architectures asserted, attestation skipped, and the GitHub Release created
  and marked prerelease with the digest and upgrade instructions in its notes.

The first CI run also found a real defect: `tools/verify-docker-smoke.mjs` could
only run as root, because it read a bind mount the container had chowned to
`PUID`. On GitHub's non-root runner that aborted the process inside Node's C++
copy implementation — uncatchable, and it would have masked every later failure.
The harness now performs the backup, restore, ownership check and cleanup in a
throwaway root container.

**The remaining gate is visibility, and it is one setting, not a code change.**
Reproducing Unraid's check against the published tag today returns
`HTTP/2 401` with no anonymous token, which is exactly the path where
`getRemoteVersionV2()` returns null and Unraid records status `undef` — no
Update is ever offered. Making the GHCR package public fixes that; making the
repository public additionally fixes the template's `Icon` and `TemplateURL`
raw links and re-enables the attestation.

#### SELFHOST-001

- **Severity:** P0
- **Area:** Docker first boot / persistence
- **Current behavior:** `Dockerfile` switches to the unprivileged `node` user, while Compose mounts a new named volume at `/data`. No image build step creates/chowns `/data`, and no entrypoint initializes ownership. `store.js` and `server.js` synchronously create `/data/cache.db` and `/data/covers` at startup.
- **Why it matters:** A new Docker volume is normally root-owned. The normal fresh install can fail before the server listens. A host bind mount on Unraid/NAS can fail for the inverse reason because the image's fixed UID 1000 does not match its owner.
- **Recommended solution:** Introduce `/config`, a small root-only initialization entrypoint that creates only app-owned directories, applies configured `PUID`/`PGID`/`UMASK`, then execs Node as that unprivileged identity. Never recursively chown the read-only Mylar/Komf mounts. Test named volume, fresh bind mount, Unraid `nobody` mapping, and a non-1000 NAS UID.
- **Files/components involved:** `Dockerfile`, new entrypoint, `docker-compose.yml`, `server.js`, `store.js`, Unraid template.
- **Estimated scope:** Medium
- **Dependencies:** None; complete before the clean-install test.

#### SELFHOST-002

- **Severity:** P0
- **Area:** First-run networking / Docker Compose
- **Current behavior:** Compose publishes `${INKWELL_BIND:-127.0.0.1}:${INKWELL_PORT:-3013}:3000`; the Unraid WebUI label is fixed to port 3013. Thus a new user cannot open `http://SERVER-IP:PORT` from another machine without discovering and changing a hidden deployment variable.
- **Why it matters:** This directly fails the promised normal LAN/Unraid install. It also makes a proxy in a separate container non-obvious to connect.
- **Recommended solution:** Choose and document a secure default topology. The preferred public-install flow is a LAN-published port paired with required initial authentication (or a secure setup flow); alternatively make loopback-only an explicitly documented reverse-proxy-only profile, not the default Compose experience. Generate the Unraid WebUI URL from its selected port. Add a proxy-network example rather than hard-coding host loopback.
- **Files/components involved:** `docker-compose.yml`, `.env.example`, `README.md`, future Unraid XML/template.
- **Estimated scope:** Small
- **Dependencies:** SELFHOST-006 security decision.

#### SELFHOST-003

- **Severity:** P0
- **Area:** Distribution / Docker publishing
- **Current behavior:** The only Compose service uses `build: .`; `package.json` is `private`, the repository has no release tags, and there is no `.github` CI/CD workflow. There is no published OCI image, tag policy, multi-architecture manifest, smoke test, or provenance.
- **Why it matters:** A stranger cannot use the intended GitHub release → image → Compose/Unraid path. Updates require source checkout/build and are neither reproducible nor roll-backable.
- **Recommended solution:** Publish a single image to GHCR on signed semantic-version tags, make release Compose reference `ghcr.io/<owner>/inkwell:${INKWELL_VERSION:-latest}`, and retain a separate developer `compose.dev`/local-build option if needed. Publish Linux `amd64` and `arm64` manifests. Add immutable full-version tags and release notes before a public beta.
- **Files/components involved:** `Dockerfile`, `docker-compose.yml`, `package.json`, new `.github/workflows/*`, GitHub repository settings/releases.
- **Estimated scope:** Large
- **Dependencies:** SELFHOST-001, SELFHOST-009, SELFHOST-013.

#### SELFHOST-004

- **Severity:** P0
- **Area:** Installation prerequisites / first-run UX
- **Current behavior:** The README says Mylar is the only required value, but a fresh useful catalogue also needs ComicVine credentials (usually extracted from Mylar config), a reachable Mylar API, readable Mylar config/DB, and correct Docker networking. There is no startup validation, connection-test UI, installer, setup state, or actionable error page. A missing key makes the initial seed job fail/retry indefinitely in the background.
- **Why it matters:** A new user sees a partial empty application and cannot distinguish optional-degraded functionality from a broken installation. They must understand internal container paths, Mylar internals, and logs to continue.
- **Recommended solution:** Define the supported prerequisite matrix (Mylar required; ComicVine credential required for discovery; Komga optional), validate it without logging secrets, and add a first-run/setup page or concise preflight screen with connection tests and exact remediation. Delay initial seed jobs until required metadata configuration is valid. Move only normal user settings into this UI; retain infrastructure paths/secrets as documented deployment configuration.
- **Files/components involved:** `server.js`, `public/app.js`, `.env.example`, `README.md`, `docker-compose.yml`.
- **Estimated scope:** Large
- **Dependencies:** SELFHOST-002, SELFHOST-006, SELFHOST-007.

#### SELFHOST-005

- **Severity:** P0
- **Area:** SQLite migration and upgrade safety
- **Current behavior:** Schema evolution happens inline at module import with unordered `CREATE TABLE IF NOT EXISTS` statements and an `ALTER TABLE ...` whose error is ignored. There is no schema-version table, transactional migration runner, lock, compatibility check, backup/checkpoint, downgrade policy, or SIGTERM handler that closes/checkpoints SQLite. The same DB also owns a durable job queue and event state.
- **Why it matters:** A future change can partially apply, be mistaken for "already migrated," or race with an old/replaced container. Interrupted upgrades and SQLite WAL state have no documented recovery path. This is unsafe for the requested pull-and-restart upgrade contract.
- **Recommended solution:** Add numbered, idempotent, transactionally applied migrations recorded in the database; acquire an exclusive migration lock; fail fast with a clear nonzero error on migration failure; perform a checkpoint/backup policy before destructive migrations; and close HTTP intake plus SQLite cleanly on SIGTERM. State that rollbacks across migrations require restore unless explicitly supported. Test each migration from a fixture DB and an interrupted/failed case.
- **Files/components involved:** `store.js`, `server.js`, new `migrations/` and migration runner, CI fixtures, upgrade/backup documentation.
- **Estimated scope:** Large
- **Dependencies:** SELFHOST-001 and backup design in SELFHOST-016.

### P1 — Required for a good public release

#### SELFHOST-006

- **Severity:** P1
- **Area:** Authentication / exposure safety
- **Current behavior:** Inkwell has optional shared HTTP Basic auth and otherwise intentionally has no authentication. Any reachable user can queue, cancel, retry, abort, and untrack Mylar content. No configuration guard prevents an operator from publishing to LAN/WAN with empty credentials. There is no rate limit or security-header policy.
- **Why it matters:** The current defaults are defensible only for a deliberately trusted loopback/LAN deployment, but the release target includes HTTPS/proxies/remote access. A single missed environment value exposes write actions.
- **Recommended solution:** Make the exposure model explicit: officially support single-user trusted-LAN and authenticated reverse-proxy/shared-Basic deployments, require credentials or an opt-in `ALLOW_UNAUTHENTICATED_LAN=true` acknowledgement when publishing beyond loopback, and document proxy authentication. Add baseline headers (`X-Content-Type-Options`, framing/referrer policy, CSP after testing) and rate-limit failed Basic auth/write endpoints. Keep `/api/ready` minimal/unauthed only if required for container health checks.
- **Files/components involved:** `server.js`, Compose/template defaults, README security/reverse-proxy docs, tests.
- **Estimated scope:** Medium
- **Dependencies:** SELFHOST-002, SELFHOST-004.

#### SELFHOST-007

- **Severity:** P1
- **Area:** Companion-service topology and permissions
- **Current behavior:** `MYLAR_URL` defaults to `http://127.0.0.1:8090/api`, which is only correct when Mylar shares the network namespace/host. The app separately reads Mylar's config and SQLite directly. A `:ro` Mylar appdata mount may be unreadable to UID 1000 if host files are restrictive. Mylar web-UI authentication makes one queue feature unavailable.
- **Why it matters:** Docker Compose, Unraid, separate-host, NFS/SMB, and proxy users have materially different correct addresses and permissions. The default will not connect to a normal separate Mylar container.
- **Recommended solution:** Document supported topologies with concrete service-DNS, host-LAN, and Unraid examples. Validate mount readability and API reachability separately in health/setup. Explain Mylar DB schema/version coupling and queue limitation. Do not weaken Mylar permissions or mount its appdata writable just to make this work.
- **Files/components involved:** `docker-compose.yml`, `.env.example`, `server.js`, README/install/troubleshooting docs.
- **Estimated scope:** Medium
- **Dependencies:** SELFHOST-001, SELFHOST-004.

#### SELFHOST-008

- **Severity:** P1
- **Area:** Persistent-state semantics
- **Current behavior:** The deployment calls the only persistent volume `inkwell-cache`, and comments call data rebuildable, yet its SQLite tables retain user-visible event history, Mylar request/part snapshots, cover index, and durable enrichment work. Cache clear deliberately preserves some of these, but backup/restore semantics are undocumented.
- **Why it matters:** Operators may delete a volume named "cache" during maintenance and silently lose Inkwell's local history and expensive catalogue. It obscures what must survive image recreation.
- **Recommended solution:** Rename and document the canonical persistent mount as `/config`/`inkwell-config`. Maintain a data classification in docs. Implement/verify a safe cache clear and a separate optional "clear derived catalogue and covers" operation; never conflate either with Mylar's authoritative watchlist/library.
- **Files/components involved:** `docker-compose.yml`, `server.js`, `store.js`, `public/app.js`, README/backup docs.
- **Estimated scope:** Medium
- **Dependencies:** SELFHOST-001, SELFHOST-005.

#### SELFHOST-009

- **Severity:** P1
- **Area:** Production image reproducibility and lifecycle
- **Current behavior:** The Dockerfile is single-stage and uses mutable `node:22-alpine`; it copies production source and installs with `npm ci --omit=dev`, which is good, but copies developer tools, has no OCI metadata, no explicit Node engine contract, no image digest/version pin, no init/shutdown behavior, and no image-size/architecture verification.
- **Why it matters:** An unpinned base can change between builds; a public release needs a reproducible artifact and declared runtime support. Node's built-in SQLite is a particularly important runtime compatibility point.
- **Recommended solution:** Keep the simple no-build image, but pin a supported Node 22 minor (and release build digest), declare `engines`, add OCI labels/version/revision, exclude non-runtime developer artifacts, and CI-test the final image. Verify both `linux/amd64` and `linux/arm64`; there are no current native dependencies, so both should be feasible.
- **Files/components involved:** `Dockerfile`, `.dockerignore`, `package.json`, release workflow.
- **Estimated scope:** Medium
- **Dependencies:** SELFHOST-003.

#### SELFHOST-010

- **Severity:** P1
- **Area:** Reverse proxy and base-path support
- **Current behavior:** The app has no cookies, redirects, WebSockets, or generated Inkwell absolute URLs, so it does not presently need Express `trust proxy` or an Inkwell base URL for host-based HTTPS proxying. Write CSRF checks compare `Origin` host to `Host`. Frontend API paths and static assets are root-absolute (`/api/...`, `/app.js`, `/styles.css`), so a subpath deployment is not supported without proxy rewriting and is likely to break.
- **Why it matters:** Users need a reliable answer for Nginx Proxy Manager, nginx, Caddy, Traefik, Tailscale, and Cloudflare Tunnel. Guessing support creates confusing failures or insecure proxy configuration.
- **Recommended solution:** Officially support root-host deployment only, e.g. `https://inkwell.example.com`, in v1. State that `/inkwell` subpaths are unsupported. Provide tested proxy snippets that preserve `Host`, forward standard headers, and proxy HTTP/1.1; no websocket special case is necessary. Add a future `PUBLIC_URL`/path-prefix only if subpaths become a requirement, with end-to-end tests. Test the CSRF origin logic through a proxy before release.
- **Files/components involved:** `server.js`, `public/index.html`, `public/app.js`, proxy documentation/tests.
- **Estimated scope:** Small
- **Dependencies:** SELFHOST-006.

#### SELFHOST-011

- **Severity:** P1
- **Area:** Unraid Community Applications readiness
- **Current behavior:** Compose contains an optional Unraid WebUI label but there is no CA template XML/repository, icon, screenshots, support route, template validation, appdata mapping, user/group handling, or Unraid-specific instructions.
- **Why it matters:** A compose label alone is not a Community Applications submission and currently points at a hard-coded port that may be wrong.
- **Recommended solution:** After the image and `/config` contract are stable, create a maintained CA template for the same GHCR image: WebUI `http://[IP]:[PORT:3000]` (or chosen default), `config` host path `/mnt/user/appdata/inkwell` → `/config`, `mylar` host path → `/run/mylar:ro`, optional Komf config file → `/run/komf/application.yml:ro`, PUID/PGID/UMASK, timezone only if code adopts it, icon, overview, project/support links, and security/prerequisite notes. Do not add a comics mapping because current code never uses one.
- **Files/components involved:** New Unraid template repository/metadata, README, image release process.
- **Estimated scope:** Medium
- **Dependencies:** SELFHOST-001 through SELFHOST-004 and SELFHOST-013.

#### SELFHOST-012

- **Severity:** P1
- **Area:** Documentation and supportability
- **Current behavior:** README is a concise developer-oriented introduction and explains some security/provider caveats, but it lacks public release installation paths, first-run expectations, configuration reference, exact mounts, companion topology, reverse proxy recipes, upgrades, backups/restores, troubleshooting, FAQ, screenshots, contribution/security documents, and release policy.
- **Why it matters:** Documentation is the install interface for self-hosting. Without it, users will substitute development assumptions and require maintainer support for ordinary cases.
- **Recommended solution:** Publish separate production-install and development docs. Include the supported topology matrix, configuration table above, secure LAN/remote deployment, ports/volumes, backup/restore, migration/rollback, known Mylar constraints, logs/health troubleshooting, and a concise support boundary. Add screenshots and a feature overview. Add `CONTRIBUTING.md`, `SECURITY.md`, issue/PR templates, release notes/changelog policy, and repository description/topics.
- **Files/components involved:** `README.md`, `docs/`, `.github/`, repository settings/assets.
- **Estimated scope:** Large
- **Dependencies:** Architecture/configuration decisions in SELFHOST-001 through SELFHOST-011.

#### SELFHOST-013

- **Severity:** P1
- **Area:** CI/CD and quality gates
- **Current behavior:** There are no GitHub Actions/workflows. Existing tests cover 14 pure discovery rules and a 9-route provider-free HTTP contract, but no linting, type checking, dependency review, Docker build, image smoke test, persistence test, migration test, or architecture matrix.
- **Why it matters:** A public multi-arch image needs reproducible verification on every release. The most serious regression paths are deployment and persistence, currently untested.
- **Recommended solution:** On pull requests: `npm ci`, tests, a syntax/lint/type baseline, dependency audit, Docker build, and provider-free container smoke test. On main: same plus optional image build cache. On version tags: build/push `amd64`+`arm64` manifest to GHCR, run clean-install/persist/upgrade smoke tests, generate SBOM and provenance, scan the image, sign if the chosen GHCR workflow supports keyless signing, and create GitHub release notes. Keep the initial workflow small and reliable; do not require an external database.
- **Files/components involved:** New `.github/workflows/*`, Docker/Compose test fixtures, `package.json` scripts.
- **Estimated scope:** Large
- **Dependencies:** SELFHOST-003, SELFHOST-005.

#### SELFHOST-014

- **Severity:** P1
- **Area:** Authentication and multi-user product boundary
- **Current behavior:** All browser state is per-device localStorage; server state has no user identity. The one optional Basic credential grants full access to every action and data view. There is no signup, admin bootstrap, registration switch, password hashing/reset, user-scoped library/request data, or authorization model.
- **Why it matters:** Users may reasonably infer an Overseerr-like multi-user experience. It would be unsafe to advertise this as multi-user or expose it to untrusted household/public accounts.
- **Recommended solution:** Declare v1 explicitly **single-user/shared-account**. Support a trusted LAN or an upstream identity-aware proxy only under that limitation. Do not add superficial registration. Treat real multi-user support as a later architecture project requiring user records, authorization at every route, migrations, and threat-model review.
- **Files/components involved:** README/product copy, UI settings copy, release documentation.
- **Estimated scope:** Small for correct scope/documentation; Large for actual multi-user support.
- **Dependencies:** SELFHOST-006.

#### SELFHOST-015

- **Severity:** P1
- **Area:** Filesystem/NAS behavior
- **Current behavior:** Application-owned paths are configurable but separately named; startup creates them synchronously. Cover writes use atomic rename, which is good on a normal local filesystem. There is no configured umask, ownership initialization, disk-space check, stale-temp cleanup, path diagnostic, or documented NFS/SMB behavior. The app does not touch comic files.
- **Why it matters:** NAS bind mounts commonly fail due to identity/permissions; SMB/NFS can have rename/locking semantics different from local filesystems. SQLite on network shares can be unsafe or unsupported.
- **Recommended solution:** Require `/config` to be a local Docker/Unraid appdata filesystem, not an SMB/NFS share unless explicitly tested. Support PUID/PGID/UMASK for that mount, report clear writable/readable diagnostics, retain atomic-write error handling, clean stale temp files safely, and document Mylar source mounts as read-only. Do not recursively change host library permissions.
- **Files/components involved:** Docker entrypoint, `server.js`, `store.js`, docs/template.
- **Estimated scope:** Medium
- **Dependencies:** SELFHOST-001.

#### SELFHOST-016

- **Severity:** P1
- **Area:** Reliability, shutdown, backup and restore
- **Current behavior:** Node has no explicit SIGTERM/SIGINT handler. In-flight HTTP requests, cover writes, SQLite checkpoint/close, and timer cancellation rely on process termination behavior. Health is liveness-only (`/api/ready` returns OK without validating writable storage), and no backup command/procedure is implemented.
- **Why it matters:** Container updates/reboots can interrupt an HTTP mutation or a SQLite/cover write. SQLite WAL recovery is robust, but a public appliance-like app needs a defined graceful path and recoverable backup guidance.
- **Recommended solution:** Implement bounded graceful shutdown: mark not-ready, stop accepting HTTP, stop timers, wait briefly for in-flight work, checkpoint/close SQLite, then exit. Separate liveness from startup/readiness checks without making optional provider outages restart a healthy app. Provide a documented stop-and-copy backup procedure first; add an optional consistent SQLite backup command/API only if it can be properly authorized and tested.
- **Files/components involved:** `server.js`, `store.js`, Docker healthcheck, docs, CI lifecycle test.
- **Estimated scope:** Medium
- **Dependencies:** SELFHOST-005, SELFHOST-008.

#### SELFHOST-017

- **Severity:** P1
- **Area:** External services and provider resilience
- **Current behavior:** ComicVine requests are globally paced and back off on 420/429; Wikidata and Metron are serialized/timed out; optional Metron is disabled without a token; notification calls have a 10s timeout. These are strong foundations. However no documented provider API-key acquisition/terms/attribution review, retry policy matrix, persisted cooldown across restart, webhook allowlist/redaction, or user-facing connection test exists.
- **Why it matters:** Provider outages/limits are normal in a self-hosted app. Undocumented commercial/community provider conditions can block or complicate public distribution, and user-supplied notification endpoints are sensitive outbound destinations.
- **Recommended solution:** Document each integration as required/optional, keys, scopes, timeouts, rate-limit behavior, offline behavior, and support boundary. Review current ComicVine, Metron, Wikidata, Mylar, Komga, ntfy, and Discord terms/branding/attribution before release; link required attribution in-app/docs. Persist only safe cooldown state if needed. Keep optional failures nonfatal and redact token/webhook URLs from logs/health.
- **Files/components involved:** `server.js`, `metron.js`, `lore.js`, README/docs, UI status page.
- **Estimated scope:** Medium
- **Dependencies:** SELFHOST-004, SELFHOST-012.

### P2 — Strong improvements

#### SELFHOST-018

- **Severity:** P2
- **Area:** Security hardening
- **Current behavior:** Parameterized route identifiers are generally validated (for example numeric cover IDs), JSON is capped at 32 KB, no CORS is enabled, write routes require an application header, Basic comparisons use timing-safe equality, cover content is type/size checked, and no shell commands are executed. Cover source URLs still originate from remote ComicVine data and may redirect; general error responses surface provider error text.
- **Why it matters:** The current shape has no obvious direct SQL injection, command injection, upload, or arbitrary local path traversal route, but defense in depth matters for an internet-adjacent install.
- **Recommended solution:** Add security regression tests for IDs, origins, Basic auth, and redirects; restrict cover fetch redirects/hosts to an explicit trusted policy or revalidate every final URL; cap redirects; sanitize externally sourced error text returned to clients; set security headers; and run automated dependency/container scans. Do not claim a security certification based on this audit.
- **Files/components involved:** `server.js`, tests, CI.
- **Estimated scope:** Medium
- **Dependencies:** SELFHOST-006, SELFHOST-013.

#### SELFHOST-019

- **Severity:** P2
- **Area:** Observability and operational UX
- **Current behavior:** Logs are mostly plain console messages/errors; `/api/health` reports selected provider/cache state and the UI presents status. There is no structured startup configuration summary (with secrets redacted), version/build endpoint, disk usage, last successful watcher run, migration status, or actionable startup diagnostics.
- **Why it matters:** Remote operators need to identify wrong mount, wrong URL, rate limit, permission error, and version mismatch without source knowledge.
- **Recommended solution:** Log a concise redacted startup report; expose version/schema/storage readiness and last-job status to authenticated diagnostics; use stable error codes/messages for setup UI; document `docker logs`; and retain stdout logging. Avoid adding an external observability stack.
- **Files/components involved:** `server.js`, `store.js`, `public/app.js`, docs.
- **Estimated scope:** Medium
- **Dependencies:** SELFHOST-004, SELFHOST-005.

#### SELFHOST-020

- **Severity:** P2
- **Area:** Cache growth and maintenance
- **Current behavior:** SQLite catalogue/cache/covers grow from browsing and are intentionally long-lived. There is a response-cache clear endpoint but no documented quota, age pruning, cover cleanup, vacuum/checkpoint routine, disk-low behavior, or migration-growth monitoring.
- **Why it matters:** A long-running server can consume unexpected appdata space; SQLite files can retain free pages after deletes.
- **Recommended solution:** Measure representative growth, set a documented retention/size policy, add safe age/size pruning for derived payloads/covers, run checkpoint/vacuum only in controlled maintenance, and expose storage use. Preserve durable event/queue data unless the user chooses an explicit reset.
- **Files/components involved:** `store.js`, `server.js`, settings UI, docs/tests.
- **Estimated scope:** Medium
- **Dependencies:** SELFHOST-008, SELFHOST-016.

#### SELFHOST-021

- **Severity:** P2
- **Area:** Job reliability and idempotency
- **Current behavior:** The enrichment queue persists attempts/state and processes one task at a time; events use deterministic keys to avoid duplicate notices; these are good. There is no lease/heartbeat for a job claimed when the process dies, no concurrency guard across accidental multiple containers, no documented max retry/dead-letter state, and first-run seed behavior is coupled to provider availability.
- **Why it matters:** Restarted/overlapping containers or prolonged provider failures can leave work appearing stuck or replayed unpredictably.
- **Recommended solution:** Make claim transitions lease-based with recovery of expired `running` jobs, add a one-instance deployment guard/documentation, show retry/last-error state in UI, and test interrupted work. Continue to keep the worker in the app process unless workload proves otherwise.
- **Files/components involved:** `store.js`, `server.js`, UI/tests.
- **Estimated scope:** Medium
- **Dependencies:** SELFHOST-005, SELFHOST-016.

#### SELFHOST-022

- **Severity:** P2
- **Area:** Configuration validation and secret delivery
- **Current behavior:** Values are parsed ad hoc; invalid URLs/notify formats/partial Basic credentials are not centrally validated. Secrets commonly enter Compose environment or mounted companion configs. `.env.example` is broad and does not distinguish normal from advanced settings.
- **Why it matters:** A typo becomes a late provider error; environment variables are visible to users with Docker inspect access and can be copied into support logs.
- **Recommended solution:** Validate configuration once at startup and present a redacted error list. Support `*_FILE` for Inkwell-owned secrets or a documented secrets mechanism where practical; never log values. Split basic and advanced examples. Preserve config mounts as a valid way to avoid duplicating companion secrets.
- **Files/components involved:** `server.js`, Compose, `.env.example`, documentation.
- **Estimated scope:** Medium
- **Dependencies:** SELFHOST-004.

#### SELFHOST-023

- **Severity:** P2
- **Area:** Legal/repository hygiene review
- **Current behavior:** The tracked repository has an MIT `LICENSE`, source/design files, and six publisher-logo SVGs. No comic archives/media files are tracked; ignored local data is not in Git. There is no `SECURITY.md`, contribution policy, code of conduct, issue/PR templates, changelog convention, or documented review of logo/source licenses, provider terms, or trademarks.
- **Why it matters:** A comic-related public project must clearly distribute code rather than copyrighted comic material, and logo/API use may require attribution or permission. Missing repository policies make responsible disclosure/support harder.
- **Recommended solution:** Before public release, inventory each `public/logos/*` source and license/permission, review ComicVine/Metron/Wikidata/provider API terms and attribution requirements, and ensure screenshots/demo fixtures contain no unlicensed cover/comic content. Add repository policy files and a release checklist. This is a concrete review task, not legal advice or a conclusion about rights.
- **Files/components involved:** `public/logos/`, README/docs, GitHub metadata/templates.
- **Estimated scope:** Medium
- **Dependencies:** SELFHOST-012, SELFHOST-017.

#### SELFHOST-024

- **Severity:** P2
- **Area:** Test strategy / clean-install smoke test
- **Current behavior:** Current unit and provider-free HTTP tests are useful but run against a manually started process. No test creates a clean persistent volume, restarts, performs an image upgrade, or checks a reverse proxy/ARM image.
- **Why it matters:** The release's central promise is persistence through replacement/upgrade, which is not currently executable evidence.
- **Recommended solution:** Add an isolated test fixture using a fake Mylar HTTP service and temporary appdata. Test: build/pull image; first boot; readiness; setup/preflight; create representative state; stop/restart; verify state; migrate a fixture old DB; replace image/tag; verify state; and check invalid/missing mount behavior. Run it in CI on amd64 and build arm64 at minimum.
- **Files/components involved:** New test fixtures/scripts, Compose/CI, migrations.
- **Estimated scope:** Large
- **Dependencies:** SELFHOST-001 through SELFHOST-005, SELFHOST-013.

### P3 — Future improvements

#### SELFHOST-025

- **Severity:** P3
- **Area:** Real multi-user support
- **Current behavior:** Single shared account/trusted-LAN model only.
- **Why it matters:** It limits household sharing and external access, but does not block an honestly scoped v1.
- **Recommended solution:** Plan a separate authorization model before adding accounts: user migration, ownership rules, per-user preferences/requests, admin bootstrap, password reset/OIDC, auditing, and route-level tests.
- **Files/components involved:** Most API/UI/database/auth components.
- **Estimated scope:** Large
- **Dependencies:** A stable single-user release and security model.

#### SELFHOST-026

- **Severity:** P3
- **Area:** In-app configuration management
- **Current behavior:** Infrastructure settings live in environment/mounted files; there is no setup UI.
- **Why it matters:** A concise setup/preflight is required for v1, but a full UI secrets/config editor is not necessary and could weaken configuration-as-deployment practice.
- **Recommended solution:** After v1, consider an encrypted/config-file-backed settings UI only for low-risk provider and notification settings, with clear restart/apply semantics. Keep mount paths, UID/GID, and port/network configuration external.
- **Files/components involved:** New config subsystem/UI.
- **Estimated scope:** Large
- **Dependencies:** SELFHOST-004, SELFHOST-022.

#### SELFHOST-027

- **Severity:** P3
- **Area:** Full-stack installer/topology automation
- **Current behavior:** Inkwell assumes a separately managed Mylar and optional Komga.
- **Why it matters:** A one-click full media stack could be convenient, but would expand support and data-ownership scope substantially.
- **Recommended solution:** Keep the canonical single-container distribution. Consider optional, separately maintained examples for common stacks only after the standalone integration path is stable.
- **Files/components involved:** Documentation/example compose files only.
- **Estimated scope:** Large
- **Dependencies:** Stable image, docs, and support capacity.

#### SELFHOST-028

- **Severity:** P3
- **Area:** Subpath hosting
- **Current behavior:** Only root-host deployment is viable.
- **Why it matters:** Some homelab proxies prefer a shared-domain subpath, but host-based routing is widespread and simpler.
- **Recommended solution:** Add a tested public base-path abstraction only if user demand justifies it; otherwise document host-based routing as intentional.
- **Files/components involved:** Frontend asset/API URL construction, Express routing, docs/tests.
- **Estimated scope:** Large
- **Dependencies:** SELFHOST-010.

## 7. Production deployment details

### Recommended Compose shape (target, not current code)

The final release Compose should be concise and image-based. Conceptually:

```yaml
services:
  inkwell:
    image: ghcr.io/whoiscalebbrown/inkwell:${INKWELL_VERSION:-latest}
    container_name: inkwell
    restart: unless-stopped
    ports:
      - "${INKWELL_PORT:-3000}:3000"
    environment:
      PUID: ${PUID:-1000}
      PGID: ${PGID:-1000}
      UMASK: ${UMASK:-002}
      MYLAR_URL: ${MYLAR_URL}
      INKWELL_USER: ${INKWELL_USER}
      INKWELL_PASSWORD: ${INKWELL_PASSWORD}
      # optional integrations only
    volumes:
      - ${INKWELL_CONFIG_DIR:-./inkwell-config}:/config
      - ${MYLAR_DIR}:/run/mylar:ro
    healthcheck:
      # readiness endpoint after storage initialization
    security_opt:
      - no-new-privileges:true
```

Exact environment names and whether first-run auth is a wizard or required preconfigured Basic auth must be decided during Phase 1. This sample deliberately omits Mylar/Komga database containers, source mounts, and any comic library mount. A default `./inkwell-config` bind is readable to newcomers; a named volume is also valid for Compose but is less obvious to back up. Unraid should map its appdata folder to `/config`.

### Reverse proxy guidance

Support host-based deployments only in v1:

- `https://inkwell.example.com` is supported after the proxy preserves `Host` and forwards HTTP to `inkwell:3000` or the host port.
- HTTPS termination happens at NPM/nginx/Caddy/Traefik/Cloudflare Tunnel. Inkwell has no cookies or redirects needing scheme reconstruction today, so `trust proxy` is not presently required. Reassess if sessions/cookies/absolute app URLs are added.
- Tailscale can use direct HTTP behind tailnet ACLs or the same proxy/auth model.
- `https://example.com/inkwell` is **not supported** in v1 because frontend and API paths are root-absolute.
- Basic/auth proxy configuration must not strip the application's `X-Inkwell` write header or alter same-origin `Host` handling.

### Database and upgrade policy

Target normal upgrade:

1. Back up `/config` (and Compose `.env` if used).
2. `docker compose pull`.
3. `docker compose up -d` (or Unraid Update).
4. New container takes exclusive migration lock, validates/backups/checkpoints SQLite as designed, runs ordered idempotent migrations, starts the sole process, and becomes ready.
5. Verify the release version/health page. If migration failed, application must remain stopped with a clear log/error; restore backup rather than starting an older image against an unknown newer schema.

No automatic destructive reset, reseed that clears user-visible state, or arbitrary schema recovery should occur on startup. Initial schema creation is a migration from version zero. First-run discovery seed jobs must be idempotent and only run after metadata configuration validates.

### Image/release policy

Use semantic versioning and publish:

- `latest` for the newest stable release only;
- `1` for latest compatible 1.x;
- `1.2` for latest compatible 1.2.x;
- `1.2.3` immutable release tag;
- optionally `edge`/`beta` only if clearly unsupported for production.

GitHub Releases should carry exact image digest, upgrade notes, migration/breaking-change notes, known issues, and rollback/restore instruction. GHCR alone is sufficient initially; mirror to Docker Hub only if a clear audience need arises.

### CI/CD proportionate baseline

| Trigger | Required checks |
| --- | --- |
| Pull request | lockfile install, unit tests, provider-free HTTP smoke, syntax/lint/type baseline, dependency audit, Docker build, container startup/health smoke. |
| `main` | PR checks plus cached build validation. |
| Signed version tag | Build/test `linux/amd64` and `linux/arm64`, publish GHCR manifest/tags, clean-install/persistence/migration smoke, SBOM, provenance, vulnerability scan, GitHub Release. |

**As implemented (2026-09-08):** pull requests and pushes to `main` run `ci.yml` — install, module parse, entrypoint check, tests, production audit, Compose and Unraid template validation, the production-image smoke, and a both-architecture build. A `v*` tag runs the same workflow and then publishes. `main` deliberately publishes nothing at all, not even an `edge` tag, so `latest` can only move by tagging. Image vulnerability scanning remains unimplemented.

## 8. Unraid release target

Submit to Community Applications only after a stable tagged image, public documentation/support channel, and tested template exist. The installer screen should be limited to settings actual code uses:

| Template field | Target value/behavior |
| --- | --- |
| Name | Inkwell |
| Repository | `ghcr.io/whoiscalebbrown/inkwell:<version policy>` |
| Network | Bridge by default; document custom proxy network separately. |
| WebUI | `http://[IP]:[PORT:3000]` using selected host port, not a hard-coded unrelated port. |
| WebUI port | Chosen default, likely 3000. |
| AppData | `/mnt/user/appdata/inkwell` → `/config` read/write. |
| Mylar appdata | User-selected Mylar directory → `/run/mylar:ro`; label it as required Mylar config/database, not comics. |
| Optional Komf config | User-selected file → `/run/komf/application.yml:ro`, or use direct Komga credentials. |
| Comics/library | Omit: Inkwell does not access it. |
| PUID/PGID/UMASK | Expose once supported by the image. |
| Timezone | Omit unless application code adopts it; browser/Mylar time semantics currently should not be changed merely for convention. |
| Variables | Mylar API URL; required authentication/setup values; optional Komga/Metron/notifications in an advanced group. |
| Metadata | Square icon with verified usage rights, description, project URL, issue/support URL, categories, and disclaimer that Inkwell does not include comic content. |

## 9. v1 first-run and clean-install acceptance test

The release must have an automated test and a manual release checklist equivalent to:

1. Start with empty temporary `/config`, fake/isolated Mylar fixture, and a new image by version tag.
2. Start through published Compose, not source `build:`.
3. Wait for storage-ready health; visit `http://SERVER-IP:PORT` from a non-host client.
4. Complete secure setup/preflight; prove missing Mylar/key/path messages are actionable.
5. Configure or validate Mylar, then optional Komga; add/request representative content against the fake fixture.
6. Confirm SQLite and a cover are under `/config`; restart container and verify state/event/queue persistence.
7. Start an old-schema fixture, upgrade to current tag, verify migration and data; simulate a failing migration and ensure it does not start/reset data.
8. Exercise an authenticated host-based reverse proxy.
9. Repeat startup/image smoke for `amd64` and `arm64`; manually validate Unraid appdata permissions before CA submission.

Current blockers for this test are SELFHOST-001 through SELFHOST-005. The provider-free HTTP contract is a useful seed but not this deployment test.

**Status after Phase 3 (2026-09-08).** Steps 1, 6 and 7 are automated and pass: `tools/verify-docker-smoke.mjs` covers an empty `/config` on both a fresh volume and a fresh bind mount, a placeholder Mylar fixture, restart persistence, a stop-and-copy restore, and an image replacement against a populated `/config`; the migration tests cover a legacy database and a refusal to downgrade. Step 9's arm64 half was exercised for real — the emulated `linux/arm64` image reached `/api/ready`, reported healthy, and ran as the configured non-root UID. Step 2 still builds from the Dockerfile rather than pulling a published tag, because no tag has been published; steps 3, 4, 5 and the Unraid appdata permission check in step 9 remain manual.

## 10. Implementation roadmap

### Phase 1 — Make the deployment contract safe (P0)

1. Decide the supported security/topology default: LAN host port plus required auth/setup, and host-based proxy support; document single-user scope.
2. Implement `/config` ownership initialization and unprivileged runtime; convert state paths to it.
3. Replace local-build public Compose with image-based distribution design and choose port/tag policy.
4. Specify migration/version/backup/rollback behavior, then implement the migration runner and graceful shutdown.
5. Build setup/preflight/connection validation sufficient for Mylar + ComicVine and clear degraded states.

These are sequential at their interfaces, but Docker ownership, migration design, and setup UI can be developed in parallel after the security/topology decision.

### Phase 2 — Prove production behavior (P1)

1. Add CI, GHCR multi-arch release workflow, SBOM/provenance/scan, and clean-install/persistence/upgrade fixtures.
2. Write production README, configuration, security, proxy, backup, upgrade, troubleshooting, and provider documentation.
3. Add startup diagnostics, readiness/shutdown behavior, configuration validation, and NAS filesystem guidance.
4. Create/test Unraid template using the released image.

CI fixture work and documentation can run in parallel; Unraid work should wait until `/config`, image tags, and configuration names are stable.

### Phase 3 — Public-beta hardening (P2)

1. Cache quotas/pruning, job lease recovery, observability, error/SSRF hardening, secret-file support.
2. Complete provider/logo/license/trademark review and repository health assets.
3. Run a beta with documented support boundaries, collect actual Unraid/NAS/proxy results, and fix evidence-based gaps.

### Phase 4 — Post-v1 improvements (P3)

Evaluate true multi-user support, subpath hosting, richer in-app configuration, and optional full-stack examples only in response to demonstrated demand.

## Appendix: current strengths to retain

- The dependency footprint is very small (Express only) and current production npm audit is clean.
- The container is already read-only, uses `no-new-privileges`, has a restart policy, runs unprivileged, exposes only one port, and logs to stdout. Preserve these choices while solving writable-volume initialization.
- The app's one-process worker/scheduler is the simplest appropriate architecture.
- Provider calls have explicit timeouts and thoughtful rate-limit behavior; optional metadata sources degrade without crashing the whole app.
- Direct Mylar and Komf mounts are read-only, and keys do not reach browser JavaScript.
- Route input validation, JSON size limit, no CORS, write-header CSRF defense, timing-safe Basic comparison, cover size/type checks, and atomic cover write are good foundations.
- The repository contains no tracked comic files. Continue to keep code distribution separate from user media and review the source/license of bundled logo assets before release.
