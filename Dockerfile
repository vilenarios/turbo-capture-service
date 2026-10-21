# Turbo Capture Service
#
# Stages:
#   deps        npm dependencies + Chrome for Testing (download only)
#   runtime     slim image: Chrome's shared-library deps, tini, app
#   test        runtime + test suite (docker build --target test)
#   production  default target
#
# Node 22 LTS: puppeteer 25 requires Node >= 22.12 and Node 20 is end-of-life.

ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS deps
RUN apt-get update && apt-get install -y --no-install-recommends unzip \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV PUPPETEER_CACHE_DIR=/opt/puppeteer
COPY package.json package-lock.json ./
# Skip puppeteer's postinstall (it would fetch both chrome and
# chrome-headless-shell); install only the browser we use.
RUN PUPPETEER_SKIP_DOWNLOAD=true npm ci --omit=dev --no-audit --no-fund \
    && npx puppeteer browsers install chrome \
    && npm cache clean --force \
    && cp /opt/puppeteer/chrome/linux-*/chrome-linux64/deb.deps /opt/puppeteer/deb.deps

FROM ${NODE_IMAGE} AS runtime
ENV PUPPETEER_CACHE_DIR=/opt/puppeteer \
    NODE_ENV=production
COPY --from=deps /opt/puppeteer/deb.deps /tmp/deb.deps
# Chrome's own dependency list (deb.deps ships with Chrome for Testing),
# plus fonts and tini as PID 1 so orphaned Chrome processes are reaped.
RUN apt-get update \
    && sed -e 's/ (.*)//' -e 's/|.*//' /tmp/deb.deps | grep -vE '^(wget|xdg-utils)$' | xargs apt-get install -y --no-install-recommends \
       fonts-liberation fonts-noto-color-emoji tini \
    && rm -rf /var/lib/apt/lists/* /tmp/deb.deps

RUN groupadd -r pptruser && useradd -r -m -g pptruser -G audio,video pptruser

WORKDIR /app
COPY --from=deps /opt/puppeteer /opt/puppeteer
COPY --from=deps /app/node_modules ./node_modules
COPY package.json openapi.yaml server.js ./
COPY src ./src

USER pptruser
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]

FROM runtime AS test
COPY --chown=pptruser:pptruser test ./test
CMD ["node", "--test", "--test-concurrency=1", "test/*.test.js"]

FROM runtime AS production
