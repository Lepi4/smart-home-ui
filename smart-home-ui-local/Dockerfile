# Stage 1: install deps on the native build platform to avoid QEMU SIGILL crashes.
# express and ws are pure JS so node_modules are cross-arch safe.
FROM --platform=$BUILDPLATFORM node:20-alpine AS deps
WORKDIR /app
ENV npm_config_audit=false
ENV npm_config_fund=false
COPY package.json ./
RUN npm install --omit=dev --ignore-optional \
  && npm cache clean --force

# Stage 2: final image for the target arch
FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV DATA_DIR=/data

COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN chmod +x /app/start.sh \
  && mkdir -p /data/backups

EXPOSE 8080
EXPOSE 32457
CMD ["/app/start.sh"]
