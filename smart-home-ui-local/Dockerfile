FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV DATA_DIR=/data

# Install production dependencies first so Docker cache works correctly.
# The node -e check makes the build fail immediately if express/ws were not installed.
COPY package.json ./
RUN npm install --omit=dev \
  && npm cache clean --force \
  && node -e "require('express'); require('ws'); console.log('Dependencies OK')"

COPY . .
RUN chmod +x /app/start.sh \
  && mkdir -p /data/backups

EXPOSE 8080
CMD ["/app/start.sh"]
