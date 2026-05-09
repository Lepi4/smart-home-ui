FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV DATA_DIR=/data
ENV npm_config_audit=false
ENV npm_config_fund=false

# Install production dependencies first so Docker cache works correctly.
# Do not run node-based dependency checks during cross-arch buildx/QEMU builds:
# on some arm64 emulated builders a simple `node -e ...` exits with code 132
# even when npm install completed successfully.
COPY package.json ./
RUN npm install --omit=dev \
  && npm cache clean --force

COPY . .
RUN chmod +x /app/start.sh \
  && mkdir -p /data/backups

EXPOSE 8080
CMD ["/app/start.sh"]
