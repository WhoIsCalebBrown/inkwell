# Comic Requester

An Overseerr-inspired request interface for Mylar3. It uses Mylar's ComicVine
integration for series metadata, while keeping the Mylar key server-side.

## Deploy on Unraid

Copy this folder to `/mnt/cache/appdata/comic-requester`, then run:

```sh
docker compose up -d --build
```

The app listens only on `192.168.40.44:3013`. Point the existing LAN-only
`requests.calebs.online` nginx server block at it. The container mounts Mylar's
`config.ini` read-only so API-key rotation does not require a redeploy.

## Local UI development

The application can run on a LAN workstation and still use Unraid's Mylar API.
It needs temporary Mylar and ComicVine API keys; do not add them to source files.
On Caleb's workstation, start it with:

```sh
export MYLAR_API_KEY="$(ssh unraid 'awk -F= "'"'tolower($1) ~ /^api_key/ {gsub(/^[ \t]+|[ \t]+$/, "", $2); print $2; exit}'"'"' /mnt/cache/appdata/mylar3/mylar/config.ini')"
export COMICVINE_API_KEY="$(ssh unraid 'awk -F= "'"'tolower($1) ~ /^comicvine_api/ {gsub(/^[ \t]+|[ \t]+$/, "", $2); print $2; exit}'"'"' /mnt/cache/appdata/mylar3/mylar/config.ini')"
docker compose -f docker-compose.yml -f docker-compose.local.yml up --build
```

Open `http://localhost:3013`. The keys exist only in the shell and container
environment for that session; they never reach the browser.
