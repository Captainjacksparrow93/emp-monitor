# EmpMonitor PG edition API server.
# Build from the pg-edition folder:  docker build -f server/Dockerfile -t empmonitor-server .
FROM node:22-alpine
WORKDIR /app/server
ENV NODE_ENV=production DATA_DIR=/data
COPY server/package*.json ./
RUN npm ci --omit=dev --include=optional
COPY server/src ./src
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
# Graceful shutdown flushes buffered data to Postgres.
STOPSIGNAL SIGTERM
CMD ["node", "src/index.js"]
