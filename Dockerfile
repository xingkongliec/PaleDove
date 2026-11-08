# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openssl python3 make g++ \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global pnpm@10.28.0

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server ./server
COPY web ./web

RUN --mount=type=cache,id=paledove-pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir=/pnpm/store
RUN pnpm build

# 只导出服务端运行依赖；不在导出目录执行开发用 SQLite 生成脚本。
RUN --mount=type=cache,id=paledove-pnpm,target=/pnpm/store \
    pnpm --filter @paledove/server --prod --ignore-scripts deploy --legacy --store-dir=/pnpm/store /runtime/server
WORKDIR /runtime/server
# migrate deploy 需要本平台的 Prisma 引擎，构建时准备好，运行时无需下载。
RUN node -e "require(require.resolve('@prisma/engines/scripts/postinstall.js', { paths: [require.resolve('prisma/package.json')] }))"

FROM node:22-bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    WEB_DIST=/app/web/dist \
    UPLOAD_DIR=/app/server/data/uploads \
    INCUS_CERT_DIR=/app/server/certs/incus \
    AGENT_RELEASE_CACHE_DIR=/app/server/data/agent-release-cache

WORKDIR /app/server
COPY --from=build /runtime/server/package.json ./package.json
COPY --from=build /runtime/server/node_modules ./node_modules
COPY --from=build /app/server/dist ./dist
COPY --from=build /app/server/templates ./templates
COPY --from=build /app/server/prisma.config.ts ./prisma.config.ts
COPY --from=build /app/server/prisma/schema.prisma ./prisma/schema.prisma
COPY --from=build /app/server/prisma/migrations ./prisma/migrations
COPY --from=build /app/web/dist /app/web/dist
COPY --from=build /app/server/scripts/docker ./scripts/docker
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN mkdir -p data/uploads data/agent-release-cache certs/incus \
    && chown -R node:node data \
    && sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh \
    && chmod 755 /usr/local/bin/docker-entrypoint.sh

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD ["node", "scripts/docker/healthcheck.mjs"]
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["start"]
