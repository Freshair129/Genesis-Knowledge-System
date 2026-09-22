FROM node:22-bookworm-slim AS build

WORKDIR /app

RUN apt-get update \
  && apt-get install --no-install-recommends --yes g++ make python3 \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY apps/gks-server/package.json apps/gks-server/package.json
COPY apps/wiki-desktop/package.json apps/wiki-desktop/package.json
COPY packages/gks-client-js/package.json packages/gks-client-js/package.json
COPY packages/gks-contracts/package.json packages/gks-contracts/package.json
COPY packages/gks-core/package.json packages/gks-core/package.json
COPY packages/gks-persistence/package.json packages/gks-persistence/package.json

RUN npm ci --omit=dev

COPY apps/gks-server apps/gks-server
COPY packages/gks-contracts packages/gks-contracts
COPY packages/gks-core packages/gks-core
COPY packages/gks-persistence packages/gks-persistence
COPY migrations migrations
COPY deploy/docker/entrypoint.mjs deploy/docker/entrypoint.mjs

RUN npm rebuild better-sqlite3

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    GKS_DB_PATH=/var/lib/gks/gks.sqlite \
    GKS_HTTP_HOST=0.0.0.0 \
    GKS_HTTP_PORT=8787 \
    GKS_MSP_AUTH_REQUIRED=1 \
    GKS_MSP_RELAY_CREDENTIAL_FILE=/run/secrets/gks_msp_relay_credential \
    GKS_PIPELINE_RELAY_CREDENTIAL_FILE=/run/secrets/gks_pipeline_relay_credential

WORKDIR /app

COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/package-lock.json ./package-lock.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/gks-server ./apps/gks-server
COPY --from=build --chown=node:node /app/packages/gks-contracts ./packages/gks-contracts
COPY --from=build --chown=node:node /app/packages/gks-core ./packages/gks-core
COPY --from=build --chown=node:node /app/packages/gks-persistence ./packages/gks-persistence
COPY --from=build --chown=node:node /app/migrations ./migrations
COPY --from=build --chown=node:node /app/deploy/docker/entrypoint.mjs ./deploy/docker/entrypoint.mjs

RUN mkdir -p /var/lib/gks \
  && chown node:node /var/lib/gks

VOLUME ["/var/lib/gks"]
EXPOSE 8787
USER node

ENTRYPOINT ["node", "deploy/docker/entrypoint.mjs"]
CMD ["node", "apps/gks-server/bin/gks-http-server.mjs"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/healthz').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"]
