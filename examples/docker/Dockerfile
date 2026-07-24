# connecta — Docker image.
#
# Build context is the PACKAGE ROOT, NOT this directory, so the
# whole package source is available. The package is built to dist/ before the
# runtime image is assembled; the example entrypoint itself runs through tsx.
#
# Build (from the package root):
#   docker build -f examples/docker/Dockerfile -t connecta .
# Or via compose (which sets the context correctly): see docker-compose.yml.

# --- deps: install with a clean, reproducible tree --------------------------
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# --- build: create the same dist/ consumed by package exports ----------------
FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# --- runtime ----------------------------------------------------------------
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# node_modules from the deps stage (includes tsx + runtime deps).
COPY --from=deps /app/node_modules ./node_modules
# Built package and TypeScript example entrypoint.
COPY package.json ./
COPY --from=build /app/dist ./dist
COPY examples/docker/server.ts ./examples/docker/server.ts

# State lives on a mounted volume; make it writable by the non-root user.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

ENV PORT=8787
ENV STATE_FILE=/data/connecta-state.json
EXPOSE 8787

# Health: hit the always-open /health route with Node's global fetch.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node_modules/.bin/tsx", "examples/docker/server.ts"]
