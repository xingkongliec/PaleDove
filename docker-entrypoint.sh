#!/bin/sh
set -eu

cd /app/server

migrate() {
    node node_modules/prisma/build/index.js migrate deploy --config prisma.config.ts
}

case "${1:-start}" in
    start)
        node scripts/docker/check-env.mjs start
        if [ "${DB_MIGRATE:-true}" = "true" ]; then
            migrate
        fi
        node dist/init-admin.js
        exec node dist/index.js
        ;;
    migrate)
        node scripts/docker/check-env.mjs migrate
        migrate
        ;;
    seed)
        node scripts/docker/check-env.mjs seed
        exec node dist/seed.js
        ;;
    init)
        node scripts/docker/check-env.mjs init
        migrate
        exec node dist/seed.js
        ;;
    *)
        exec "$@"
        ;;
esac
