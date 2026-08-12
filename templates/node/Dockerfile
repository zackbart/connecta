# This deployment, containerized. The build context is this directory: the
# image installs @zackbart/connecta from the registry exactly like any other
# consumer, so nothing here depends on the Connecta repository.
#
#   docker compose up -d --build
FROM node:22-slim

WORKDIR /app

# `connecta init` deliberately leaves no lockfile — it rewrites the Connecta
# version pin, and a lockfile shipped in the template would already disagree
# with it. Without one the build resolves the pin itself, which is fine but not
# reproducible. Run `npm install` on the host and commit the `package-lock.json`
# it writes: the build context then carries it and every later build takes the
# `npm ci` path. A lockfile written inside this layer stays inside the image.
# Dev dependencies stay in: tsx runs src/index.ts directly, so the deployment
# you review is the deployment that runs.
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then \
      npm ci --include=dev; \
    else \
      npm install --include=dev --no-audit --no-fund; \
    fi

COPY tsconfig.json ./
COPY src ./src

# State lives on a mounted volume. The image owns the mount point so a fresh
# named volume inherits an owner the non-root user can actually write to.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

ENV NODE_ENV=production
ENV PORT=8787
ENV CONNECTA_STATE_FILE=/data/connecta-state.json
EXPOSE 8787

# /health is always open, so the probe never carries the bearer token and
# never leaves the container.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# `node --import tsx` keeps Node itself in the foreground: no wrapper process
# swallows SIGTERM, so `docker compose down` stops the server promptly and the
# QuickJS children go with it.
CMD ["node", "--import", "tsx", "src/index.ts"]
