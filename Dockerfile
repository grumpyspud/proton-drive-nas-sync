# syntax=docker/dockerfile:1

# =============================================================================
# proton-drive-nas-sync
# Third-party Docker app to sync/back up folders between a NAS and Proton Drive.
# Not affiliated with or endorsed by Proton AG.
#
# Multi-stage build -> a single runtime image.
#   /config: session blob, sync database, encryption keyfile (mount it)
#   /data:   the local folders you pair with Drive folders (mount it)
# =============================================================================

# ---- Stage 1: install dependencies + build the React frontend --------------
FROM node:26-slim AS build
WORKDIR /app

# `npm ci` installs the exact tree from package-lock.json AND runs the postinstall
# (`patch-package`) that fixes @protontech/crypto's `openpgp/lightweight` import
# so it resolves under Node.
COPY package.json package-lock.json ./
COPY patches ./patches
COPY vendor ./vendor
RUN npm ci

# Build the static frontend into web/dist.
COPY tsconfig.json ./
COPY src ./src
COPY web ./web
RUN npm run web:build

# ---- Stage 2: runtime -------------------------------------------------------
FROM node:26-slim
WORKDIR /app

ENV NODE_ENV=production \
    PDN_CONFIG_DIR=/config

# The server runs the TypeScript directly via tsx (the @protontech/crypto package
# ships raw TS), so the runtime image needs node_modules, the source, the vendored
# account module, and the prebuilt frontend.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/vendor ./vendor
COPY --from=build /app/src ./src
COPY --from=build /app/web/dist ./web/dist

RUN mkdir -p /config /data

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "const p=process.env.PDN_HTTP==='true'?'http':'https'; process.env.NODE_TLS_REJECT_UNAUTHORIZED='0'; fetch(p+'://127.0.0.1:'+(process.env.PDN_PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

VOLUME ["/config", "/data"]

CMD ["node", "node_modules/tsx/dist/cli.mjs", "src/server/index.ts"]
