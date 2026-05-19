FROM node:20-alpine

RUN apk add --no-cache python3 make g++

WORKDIR /app
ENV NODE_ENV=production
ENV ALLHA_MODE=home-assistant-addon
ENV BUILD_VERSION=5.1.0-beta.1
ENV PATH=/app/node_modules/.bin:$PATH

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --registry=https://registry.npmjs.org \
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
