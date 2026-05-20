FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates wget \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production
ENV ALLHA_MODE=home-assistant-addon
ENV BUILD_VERSION=5.1.0-beta.6
ENV PATH=/app/node_modules/.bin:$PATH
ENV npm_config_audit=false
ENV npm_config_fund=false
ENV npm_config_registry=https://registry.npmjs.org

COPY package.json package-lock.json ./
RUN for i in 1 2 3; do \
      npm ci --omit=dev --omit=optional --no-audit --no-fund --registry=https://registry.npmjs.org && break; \
      echo "npm ci failed, retry $i/3" >&2; \
      npm cache clean --force || true; \
      sleep $((i * 10)); \
    done \
  && node -e "require.resolve('express'); require.resolve('ws'); require.resolve('better-sqlite3'); console.log('Dependencies OK')" \
  && npm cache clean --force

COPY . .
RUN chmod +x /app/start.sh /app/start-local.sh 2>/dev/null || true \
  && mkdir -p /data/backups /app/config

EXPOSE 8080
EXPOSE 8099
EXPOSE 32457
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://localhost:${PORT:-8080}/api/readyz || exit 1
CMD ["node", "server.js"]
