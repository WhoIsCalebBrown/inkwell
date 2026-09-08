# One process, no build step: the image is Node, the runtime dependency tree,
# and the source. It carries no architecture-specific artifact, which is what
# makes the linux/amd64 + linux/arm64 manifest a plain rebuild.
FROM node:22.18.0-alpine

# A local build is otherwise anonymous. The release workflow overrides version,
# revision and created with the tag's values; source is what links the GHCR
# package to this repository.
LABEL org.opencontainers.image.title="Inkwell" \
      org.opencontainers.image.description="A request front end for Mylar3: browse by publisher, character, creator, team or event, and follow each book to your reading library." \
      org.opencontainers.image.url="https://github.com/WhoIsCalebBrown/inkwell" \
      org.opencontainers.image.source="https://github.com/WhoIsCalebBrown/inkwell" \
      org.opencontainers.image.documentation="https://github.com/WhoIsCalebBrown/inkwell/blob/main/docs/self-hosting.md" \
      org.opencontainers.image.vendor="Caleb Brown" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app

# Before anything that changes per commit: an emulated arm64 build otherwise
# re-runs apk on every source edit. su-exec is in alpine main for x86_64 and
# aarch64 alike, so this layer is identical work on both architectures.
RUN apk add --no-cache su-exec

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY server.js store.js metron.js enrich.js lore.js discovery.js ./
COPY public ./public
COPY docker-entrypoint.sh /usr/local/bin/inkwell-entrypoint
RUN chmod 755 /usr/local/bin/inkwell-entrypoint

ENV NODE_ENV=production PORT=3000 CONFIG_DIR=/config PUID=1000 PGID=1000 UMASK=002
EXPOSE 3000

# Compose declares its own healthcheck; this one is for everything that does
# not read the Compose file, which on Unraid is the Docker page itself.
# /api/ready is true only after SQLite migrations finish.
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT:-3000}/api/ready" || exit 1

ENTRYPOINT ["/usr/local/bin/inkwell-entrypoint"]
CMD ["node", "server.js"]
