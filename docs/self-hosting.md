# Self-hosting Inkwell

Inkwell v1 is a single shared installation for a trusted LAN or a reverse proxy, Tailscale, or tunnel that provides HTTPS and access control. It has no user accounts, registration, roles, or per-user libraries.

## Install and first run

One Inkwell container runs the web UI, SQLite database, enrichment work, and Mylar watcher. It listens on container port `3000`; the supplied Compose file publishes `3013` on the host.

Inkwell requires an existing Mylar installation and a ComicVine credential. Mylar remains independent. Komga is optional; without it Inkwell cannot tell whether a requested title has arrived in a reading library.

Get the deployment files, then pull the published image and start it:

```sh
git clone https://github.com/WhoIsCalebBrown/inkwell.git
cd inkwell
cp .env.example .env
docker compose pull
docker compose up -d
```

Nothing is compiled and nothing is built: `docker-compose.yml` deploys
`ghcr.io/whoiscalebbrown/inkwell`, published as one manifest covering
`linux/amd64` and `linux/arm64`, so the same command works on an x86 server and
on ARM hardware. The clone is only for the Compose file, `.env.example`, and the
placeholder configs the optional mounts default to. On Unraid, use the container
template instead — see [Unraid](#unraid).

To build the working tree rather than pull a release, add the developer
override:

```sh
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

Open `http://SERVER-IP:3013`. The first-run page identifies missing required configuration and prevents request-changing actions until setup is finished.

For the normal Mylar integration, set only these values in `.env`:

```dotenv
MYLAR_DIR=/path/on/the/docker-host/to/mylar-appdata
MYLAR_URL=http://mylar:8090/api
```

`MYLAR_DIR` is Mylar **appdata**, containing `config.ini` and `mylar.db`, not a comics directory. It is mounted read-only. Inkwell reads Mylar and ComicVine credentials from `config.ini` and never sends them to the browser. If appdata cannot be mounted, use advanced server-side `MYLAR_API_KEY` and `COMICVINE_API_KEY` values instead.

For Mylar in another Docker project, `mylar` must resolve from Inkwell (for example via a shared external network). For a LAN-hosted Mylar, use its LAN address such as `http://192.168.1.10:8090/api`. Do not use `127.0.0.1` unless Mylar shares Inkwell's network namespace.

After changing deployment configuration, run `docker compose up -d`. Setup can test the Mylar API. A temporarily unreachable Mylar, Komga, Metron, or metadata provider does not stop Inkwell from serving setup or locally saved data.

## Configuration

Normal users set `MYLAR_DIR` and `MYLAR_URL`. The deployment values below have sensible defaults:

| Setting | Default | Purpose |
| --- | --- | --- |
| `INKWELL_PORT` | `3013` | Host WebUI port; the container uses `3000`. |
| `INKWELL_BIND` | `0.0.0.0` | Trusted-LAN bind; use `127.0.0.1` for a same-host proxy. |
| `PUID` / `PGID` / `UMASK` | `1000` / `1000` / `002` | Ownership for `/config`; Unraid commonly uses `99` / `100`. |
| `INKWELL_USER` / `INKWELL_PASSWORD` | empty | Optional shared HTTP Basic protection, recommended for remote access. |
| `INKWELL_UNRAID_ICON` | empty | Optional PNG icon path or URL for the Unraid Docker page; ignored by ordinary Docker. The provided template uses Inkwell's simplified favicon PNG. |
| `INKWELL_VERSION` | empty (`latest`) | Which published image to deploy. Pin an exact version, such as `1.2.3`, to decide for yourself when to upgrade. |

Optional integrations are `KOMGA_URL`, either `KOMF_CONFIG` or `KOMGA_USER` / `KOMGA_PASSWORD`, `KOMGA_PUBLIC_URL`, `METRON_TOKEN`, and notifications. `MYLAR_API_KEY`, `COMICVINE_API_KEY`, `MYLAR_WEB_URL`, and `INKWELL_TRUSTED_PROXIES` are advanced. Never commit a populated `.env` file.

Do not set `CONFIG_DIR`, `CACHE_DB`, `COVER_DIR`, or `PORT` in ordinary container installs; they are internal runtime settings.

## Persistence, backup, and restore

`/config` is Inkwell's full application-data boundary:

- `cache.db` and SQLite `-wal` / `-shm`: setup state, request snapshots, history, catalogue, and queue state.
- `covers/`: cached artwork; regenerable but worth retaining.
- `backups/`: automatic pre-migration SQLite backups.

Mylar, Komf, and comic/library media are not part of Inkwell's backup. Back them up under their own procedures.

For a consistent backup, stop the container and copy the whole config directory, not only `cache.db`:

```sh
docker compose stop inkwell
cp -a /path/to/inkwell-config /path/to/backup/inkwell-config
docker compose start inkwell
```

To restore, stop Inkwell, replace the entire `/config` bind mount or Docker volume with the backup, and start the same or a newer compatible image. The entrypoint repairs ownership for the configured `PUID` / `PGID`. Do not use `docker compose down -v` unless intentionally creating a new installation. If upgrading an older named volume, set `INKWELL_VOLUME` to that exact existing Docker volume name before running Compose.

## Unraid

Inkwell ships a container template, [`unraid/inkwell.xml`](../unraid/inkwell.xml). It is not in Community Applications yet, and current Unraid releases no longer download templates from a "template repository" URL, so install it by putting the file on the flash drive:

```sh
# On the Unraid server, or over the flash share:
curl -fsSL -o /boot/config/plugins/dockerMan/templates-user/my-Inkwell.xml \
  https://raw.githubusercontent.com/WhoIsCalebBrown/inkwell/main/unraid/inkwell.xml
```

Then go to **Docker → Add Container** and pick **Inkwell** from the template dropdown. Fill in the four fields it asks for:

| Field | Value |
| --- | --- |
| WebUI Port | `3013` on the host, mapped to container port `3000`. Change the host side freely; the WebUI link follows it. |
| AppData | `/mnt/user/appdata/inkwell` → `/config`, read/write. Use local appdata on the array, not an SMB/NFS share. |
| Mylar AppData | Your Mylar appdata directory → `/run/mylar`, read-only. This is the folder holding `config.ini` and `mylar.db`, not your comics. |
| Mylar API URL | Mylar's address including `/api`, for example `http://192.168.1.10:8090/api`. |

`PUID` `99`, `PGID` `100` and `UMASK` `002` are Unraid's normal ownership and are already the template's defaults. Everything else — shared username and password, Komga, Komf, notifications, Metron, trusted proxies — is optional and hidden under Advanced view. There is deliberately no comics or media mapping: Inkwell never touches comic files.

**Updates are image digest updates, not Git commits.** Unraid does not watch this repository. It asks GHCR for the digest behind the tag in the template's repository field — `ghcr.io/whoiscalebbrown/inkwell:latest` — and compares it with the digest it already pulled. A new release changes that digest, so the container shows **update ready**. Pinning an exact version in that field instead is supported and simply means no update is ever offered.

**Updating does not touch your configuration.** Unraid pulls the new image, stops the container, removes it, and creates it again from the template you filled in, with the same port, the same variables and the same `/config` mapping. The appdata directory lives on the array, not in the image, so the database, setup state, covers and pre-migration backups are exactly as the old container left them. Only the old image is discarded.

## Upgrades

```sh
docker compose pull
docker compose up -d
```

That replaces the image and recreates the container. `/config` is a mount, not part of the image, so nothing in it is touched: the database, setup state, covers and backups are the same files the new container opens. On Unraid, the **Update** button does exactly the same two steps.

If `INKWELL_VERSION` is pinned in `.env`, `pull` fetches that exact version and nothing else; clear it or set a newer version to move. Rolling back means setting an older version and redeploying — see [the release guide](releasing.md) for the tag policy and the rollback caveat.

Ordered SQLite migrations run before the web server starts. Only one Inkwell replica may use a `/config` directory. Before an existing-database migration, Inkwell creates a timestamped backup in `/config/backups`; a failed, gapped, or newer-than-supported migration stops startup rather than serving an incompatible schema. Rolling back an image requires restoring a compatible database backup.

After an update, run `docker compose ps` and open `/api/ready`. It returns HTTP 200 only after migrations complete and Inkwell can serve setup or the UI. `/api/live` is process liveness. Use `docker compose logs inkwell` for a failed startup.

## Reverse proxies and networking

Inkwell supports a dedicated root hostname such as `https://inkwell.example.com`. It does not terminate HTTPS. Preserve `Host` and proxy to `http://INKWELL-HOST:3013`; no WebSocket configuration is required today.

```nginx
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_http_version 1.1;
proxy_pass http://inkwell:3000;
```

Caddy's `reverse_proxy inkwell:3000`, Nginx Proxy Manager's normal proxy-host setup, and Traefik's normal HTTP router/service configuration use this same root-host model. Set `INKWELL_TRUSTED_PROXIES` only to the direct proxy's IP/CIDR when forwarded values must be trusted; leave it empty by default. Inkwell never trusts arbitrary client-supplied forwarded headers.

Subpath deployments such as `https://example.com/inkwell` are unsupported in v1 because the UI uses root-relative API and asset paths. Use a dedicated hostname. For remote access, terminate HTTPS at the proxy/tunnel and use proxy authentication and/or `INKWELL_USER` / `INKWELL_PASSWORD`. Plain HTTP on `0.0.0.0:3013` is intentionally trusted-LAN only.

## Troubleshooting

- **Container unhealthy:** run `docker compose logs inkwell`. SQLite migration or `/config` errors prevent startup; optional providers do not.
- **Mylar unavailable:** ensure `MYLAR_URL` ends in `/api`, is reachable from the container, and the mounted `config.ini` is readable.
- **ComicVine missing:** check Mylar `config.ini` or set `COMICVINE_API_KEY` server-side.
- **Nothing reads “In library”:** configure optional Komga; Inkwell otherwise reports requests as searching.
- **NAS permission error:** use local appdata for `/config`, set `PUID`, `PGID`, and `UMASK` for that host, and avoid SMB/NFS for SQLite unless it is explicitly tested for SQLite locking.
