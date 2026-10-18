# The hosted FlightByte MCP server (Streamable HTTP on POST /mcp), as deployed to mcp.flightbyte.dev.

# ---- build -----------------------------------------------------------------
FROM node:24-alpine AS build
WORKDIR /app

# Dependencies first: a source-only change then reuses the install layer.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

# ---- runtime ---------------------------------------------------------------
FROM node:24-alpine AS runtime
WORKDIR /app

# tini forwards SIGTERM so the server closes cleanly on redeploys.
RUN apk add --no-cache tini

# TRUST_PROXY=1: one reverse proxy (Dokploy's Traefik) sits in front and appends
# the client address to X-Forwarded-For; the per-IP rate limit reads it from there.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    TRUST_PROXY=1 \
    RATE_LIMIT_PER_MINUTE=120

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/http.js"]
