#!/bin/sh
set -eu

# `/config` is the only application-owned mount. The image starts as root only
# long enough to make a fresh Docker volume or NAS bind mount usable, then
# drops to the configured numeric identity before Node starts. Do not extend
# this to companion mounts: Mylar and Komf are deliberately read-only inputs.
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
UMASK="${UMASK:-002}"
CONFIG_DIR="${CONFIG_DIR:-/config}"

case "$PUID" in
  ''|*[!0-9]*|0) echo "PUID must be a non-root numeric UID" >&2; exit 64 ;;
esac
case "$PGID" in
  ''|*[!0-9]*|0) echo "PGID must be a non-root numeric GID" >&2; exit 64 ;;
esac
case "$UMASK" in
  [0-7][0-7][0-7]) ;;
  *) echo "UMASK must be a three-digit octal mask, for example 002" >&2; exit 64 ;;
esac
case "$CONFIG_DIR" in
  /config|/config/*) ;;
  *) echo "CONFIG_DIR must be /config or a path below it in the container" >&2; exit 64 ;;
esac

if [ "$(id -u)" -ne 0 ]; then
  echo "Inkwell entrypoint must start as root so it can initialize /config" >&2
  exit 77
fi

umask "$UMASK"
mkdir -p "$CONFIG_DIR" "$CONFIG_DIR/covers" "$CONFIG_DIR/backups"
# This is intentionally limited to the application-owned persistent mount. It
# also migrates files from the old /data mount when the same named volume is
# subsequently mounted at /config.
chown -R "$PUID:$PGID" "$CONFIG_DIR"

exec su-exec "$PUID:$PGID" "$@"
