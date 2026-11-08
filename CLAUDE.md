# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

PaleDove is an IDC panel for selling and managing Incus instances: LXC NAT, KVM NAT and KVM with a dedicated IPv4. It is a pnpm monorepo (Node ≥ 22.12, pnpm 10):

- `server` – Fastify 5 API plus the BullMQ worker, using Prisma 7 (PostgreSQL) and Redis.
- `web` – React 19, Rsbuild, Base UI, Tailwind v4 and TanStack Query.
- `server/src/shared` – DTO types, enums, enum labels and browser-compatible pure helpers used by both apps. The frontend imports them through `web/src/shared/index.ts`. Keep a single source of truth, with no Node.js-only imports or separate workspace package.
- `agent` – the host agent (Go, standard library only). It reports live host status to `/api/agent/nodes/report` and applies VM CPU limits, auto-upgrades, runs node tests, reports instance stats and applies smart-routing egresses. Entry point `cmd/paledove-agent`; one package per feature under `internal/`. Production uses `AGENT_RELEASE_REPOSITORY` to proxy this project's GitHub `agent-v*` releases through the panel with verified caches; heartbeats only read cached metadata. Without a release repository, `pnpm build:agent` provides local files in `agent/dist/` (`AGENT_DIST`). See `docs/AGENT_RELEASE.md`. Test it with `pnpm test:agent`.

The README (in Chinese) is the feature and deployment reference.

## Commands

```bash
pnpm dev                 # server (tsx watch) + web (rsbuild, :5180, proxies /api to API_URL or 127.0.0.1:3000)
pnpm typecheck           # tsc --noEmit in every package; the main correctness gate
pnpm test                # vitest in server (web has no tests)
cd server && npx vitest run test/payments.test.ts     # single file
cd server && npx vitest run -t "fee"                  # by test name
pnpm db:migrate          # dev: PG → prisma migrate dev; SQLite → regenerate sqlite schema + db push
pnpm db:deploy           # prod: prisma migrate deploy (SQLite: db push)
pnpm db:seed             # admin user + default images (SEED_DEMO=true adds mock nodes/plans)
pnpm i18n:tw             # regenerate zh-TW dictionaries (web + server) from zh-CN via OpenCC
pnpm build               # web then server (esbuild → server/dist/index.js); no Go needed
pnpm start               # builds missing web/server artifacts, then serves the frontend and API on the backend port
pnpm test:startup        # Node.js startup build checks (including legacy SQLite bundles)
pnpm build:agent:release # build standalone GitHub Agent release assets (requires Go)
```

### Local development without PostgreSQL or Redis

Copy `server/.env.example` to `server/.env`. It defaults to development mode, SQLite, memory Redis, HTTP cookies and mock demo data:

- `DATABASE_URL=file:./data/dev.db` switches the server to SQLite (`lib/prisma.ts` → `lib/prisma-sqlite.ts`).
- `REDIS_URL=memory://` switches to an in-process Redis replacement and job queue (`lib/memory-redis.ts`, `jobs/memory-queue.ts`), persisted to `data/memory-redis.json`.

Docker reads the root `.env` (copy `.env.example`) and uses external PostgreSQL/Redis. Node.js commands run in `server/` and read `server/.env`; the root Docker configuration does not override it. Keep existing secrets and local databases when adjusting configuration. `pnpm start` supports SQLite through the separately built `dist/prisma-sqlite.js`; the PostgreSQL container does not install the SQLite adapter.

Docker startup runs `dist/init-admin.js` after migrations. `services/admin-init.ts` creates the first administrator from environment variables only when the database has no administrators. If any administrator exists, it skips all credential validation and comparison and leaves the account unchanged, even when the environment credentials differ. The seed command uses the same helper. There is no administrator password reset command.

How the SQLite schema works:

- `scripts/sqlite-schema.mjs` derives `prisma/sqlite/schema.prisma` from the PostgreSQL schema.
- Never edit the derived schema directly.
- Code has to stay compatible with both databases. Use `containsInsensitive()` and `skipDuplicates` from `lib/prisma.ts` instead of the `mode: 'insensitive'` / `skipDuplicates` options.

Mock nodes:

- A node whose endpoint is `mock://<name>` uses `incus/mock.ts`.
- Instance state is kept in Redis and metrics are random, so you can exercise every flow without a real Incus host.

## Schema changes

1. Edit `server/prisma/schema.prisma`, which is the PostgreSQL source of truth.
2. Hand-write a PostgreSQL migration at `prisma/migrations/<yyyymmddhhmmss>_<name>/migration.sql`. When you develop on SQLite, `db:migrate` only runs `db push`, so it never generates this file for you.
3. Run `pnpm db:migrate`. It runs `prisma generate` for both clients; generated code lives in `src/generated/prisma` and `src/generated/prisma-sqlite`.

Additive changes are safe to push. Get the user's explicit consent before any push that drops or alters data.

## Server architecture (`server/src`)

**Wiring**

- `app.ts` registers the plugins:
  - the locale hook;
  - `plugins/session.ts`: Redis sessions storing a SHA-256 of the cookie token, plus API tokens;
  - `plugins/maintenance.ts`: maintenance-mode gating.
- `app.ts` also registers every route module, and in production it serves `WEB_DIST` as an SPA.
- `index.ts` starts the API and/or the worker according to `RUN_API` and `RUN_WORKER`.

**Routes** (`routes/`, admin routes under `routes/admin/`)

- Each module is a Fastify plugin that declares full `/api/...` paths.
- A module guards itself with `app.addHook('preHandler', adminGuard | authGuard | consoleGuard)` from `lib/http.ts`.
- Request input is validated with `parse(zodSchema, req.body)`.
- `consoleGuard` blocks admins from user-only console features. Admins act on users through `/api/admin/...` or impersonation.
- `instanceDetailRoutes` is registered twice: once for users and once under `/api/admin/instances` with `{ admin: true }`.

**Errors**

- Throw `AppError` or its helpers (`badRequest`, `notFound`, `conflict`, `forbidden`, `paymentRequired`) from `lib/errors.ts`.
- The central error handler in `app.ts` maps the following to `{ error, message, details }`:
  - `AppError`;
  - `ZodError`;
  - Prisma P2025, P2002 and P2003;
  - `IncusError` (returned as 502).
- Zod messages may be server i18n keys; they are translated per request.

**i18n (server)**

- Every user-facing message goes through `t('key', vars)` (`i18n/index.ts`). Keys live in `i18n/zh-CN.ts` and `i18n/en.ts`.
- `zh-TW.ts` is generated by `pnpm i18n:tw`, so never hand-edit it.
- Locale resolution order: the `x-locale` header, then the account preference, then `Accept-Language`.
- Background jobs run in the locale of the instance owner.

**Business logic**

- Business logic lives in `services/`; routes should stay thin. Key services:
  - `billing.ts` handles purchase, placement and renewals.
  - `operations.ts` runs instance operations as tasks.
  - `payments/` holds payment channels, callbacks and crediting (`payments.ts`) plus the gateway clients (`epay`, `stripe`, `heleket`) and exchange rates (`fx`).
  - `lifecycle.ts` handles expiry, suspension, deletion and traffic cycles.
  - `metrics.ts` polls `GET /1.0/instances?recursion=2` once a minute.
  - `caddy.ts` pushes the full config to the host's Caddy over mTLS.
  - `agent/` holds the host bootstrap and install template parameter mapping (`install-script.ts`), agent tokens and host reports (`agent.ts`), and the agent binaries (`agent-binary.ts`). Shell templates live in `server/templates/` and are read fresh on every download by `src/install-template.ts`, both from source and the production bundle. Deploy `templates/` alongside `dist/`. Agent install token refresh invalidates the previous unconsumed token for that node; running credentials rotate only when a token is redeemed.
  - `mail/` holds SMTP sending, mail templates and business notices; `realname/` holds real-name verification.
  - `node-ops.ts` lists a host's live Incus instances (registered / leftover / other / missing) and diffs them against the panel baseline. It also implements the `SYNC_BASELINE` and `REPAIR_NETWORK` tasks.
- DTO conversion is centralised in `services/serializers.ts` (`toPlan`, `toNode`, `toAdminUser`, …), which returns the types defined in `server/src/shared/types.ts`.

**Incus**

- `getIncus(node)` in `incus/index.ts` returns a cached client per node.
- `HttpIncusClient` authenticates with the panel's TLS client certificate and pins the server's SHA-256 fingerprint. `MockIncusClient` handles `mock://` endpoints.
- Developers create and deploy `client.crt` and `client.key` in `server/certs/incus/` (or `INCUS_CERT_DIR`, resolved relative to `server`). Certificates are read from files only, never generated or stored in the database. File replacements invalidate Incus / Caddy connection caches by fingerprint. The admin certificate API is read-only and never returns the private key.

**Tasks**

- Instance operations create a `Task` row and enqueue it on BullMQ (`jobs/queue.ts`, `jobs/worker.ts`).
- Operations on the same instance are serialised with a Redis lock.
- Interrupted tasks are recovered on restart.

**Settings**

- `lib/settings.ts` stores `SiteSettings` as JSON in the `Setting` table under key `site`. Reads go through a 10-second cache.
- When a site setting is added or removed, update `DEFAULT_SETTINGS`, the shared type, `routes/admin/system.ts` and `routes/auth.ts` (public config) together.
- Other features (payment channels, maintenance, …) keep their own setting keys.

**Secrets**

- `lib/crypto.ts` encrypts root passwords and gateway secrets with AES-256-GCM. The Incus client private key is managed by developers in the local certificate directory.
- The key is derived by HKDF from `APP_SECRET` with `KEY_SALT = 'inculark'`. **Never change the salt or `APP_SECRET`**: existing ciphertext would become unreadable.
- Masked secrets returned to the UI mean "unchanged" when they are sent back on save.

**Tests**

- Tests live in `server/test/*.test.ts`.
- Integration-style tests build the app with `buildApp()` against a temporary SQLite database and `memory://` Redis, then use `app.inject`.
- Requests must send `x-requested-with: XMLHttpRequest`; it is the CSRF guard on all writes.

## Web architecture (`web/src`)

**API calls**

- `lib/api.ts` provides `api.get/post/patch/put/delete`, which prefix `/api`, add `x-requested-with` and throw `ApiError`.
- Data fetching uses TanStack Query; shared queries are in `lib/queries.ts`.

**Routing**

- Routes are declared in `App.tsx` with React Router 7.
- Pages are lazy-loaded through `lib/routes.ts` `loaders`, which the sidebar also uses to preload chunks. Add a page in both places.
- Page folders:
  - `pages/Home.tsx` and `pages/Legal.tsx` – public home and legal/document reading pages;
  - `pages/auth/` – sign-in, password reset and email verification;
  - `pages/console/` – user console, with account and security settings in `account/`, and the balance center, invoice list and invoice detail in `billing/`;
  - `pages/admin/` – admin console, grouped by area: `nodes/`, `instances/`, `catalog/` (products, plans, images), `billing/`, `settings/`;
  - `pages/instance/` – instance detail, shared by user and admin;
  - `pages/tickets/` and `pages/market/` – tickets and the marketplace, shared by user and admin;
  - `layouts/AppShell.tsx` – header, sidebar and maintenance banner.

**UI kit**

- `components/ui/*` contains the UI kit (Base UI wrappers). Notable pieces:
  - `select.tsx` – Select with per-option `description`;
  - `dialog.tsx` – Modal (becomes a bottom sheet on mobile);
  - `misc.tsx` – Switch, SwitchRow, Checkbox, …;
  - `confirm.tsx`;
  - `toaster.tsx`.
- Option pickers should be dropdown `Select`s with a description for each option, not radio cards. This is the user's stated preference.

**Styling**

- Colors come only from the semantic tokens in `styles.css` (for example `text-fg`, `text-fg-3`, `bg-surface-2`, `border-line`). Light and dark themes are both defined there.
- Status colors are used only to express status.

**i18n (web)**

- Dictionaries are in `i18n/zh/{common,user,admin,operations,tickets,instance}.ts` and the matching `i18n/en/*`.
- Simplified Chinese is the source. TypeScript requires the English dictionaries to have the same keys.
- `i18n/zh-TW.ts` is generated. Run `pnpm i18n:tw` after changing any zh text, on both web and server.

**Shared code**

- Put UI shared by multiple pages in `components/` (for example `components/billing/AmountText.tsx`), rather than importing it from another route page.
- Put enums, DTOs and logic used by both sides in `server/src/shared`, and export them from `index.ts`. The frontend accesses these through `web/src/shared/index.ts`. Keep these modules browser-compatible: no database, configuration, secret or Node.js-only imports. Examples: image presets and ordering, and `nodeImageIds` / `nodeAllowsImage`.

**Directory reference**

- `docs/PROJECT_STRUCTURE.md` documents directory ownership, build scripts, generated outputs and local runtime data. Keep it in sync when reorganizing the project.
- Keep `server/`, `web/` and `agent/` at the root, following the reference project's flat application layout. The workspace includes only `server` and `web`; shared code lives inside these applications, and the Go Agent is built separately.
- Docker uses the root `docker-entrypoint.sh`, validation and health checks in `server/scripts/docker/`, and the Node.js test at `server/test/docker.test.mjs` (`pnpm test:docker`).
- Maintenance scripts belong to their owning modules: `agent/scripts/build.mjs` builds the Go Agent, and `server/scripts/gen-zh-tw.mts` generates both applications' Traditional Chinese dictionaries. Root package commands and the Agent workflow invoke these files; there is no root `scripts/` or `shared/` directory.
- Keep historical local database snapshots in `server/data/backups/`, separate from the active database and uploads.

## Project conventions

**Reference project**

- New account, settings, admin and payment features should mirror the reference project **PaleLark** at `D:\项目\Kubernetes`: same code structure, API shapes, wording and UI. Check how it does something before designing it fresh.

**Code style**

- Comments and UI copy are written in Chinese. Match the existing comment density and naming.

**Editing**

- Some files use CRLF line endings. If an exact-match edit fails, check the line endings.
- In scripted edits, avoid `String.prototype.replace` with replacement strings that contain `$`: `$'` and `$&` corrupt the output.

**Real infrastructure**

- The dev database may contain a real host (node 「11」).
- Don't run write operations, token-issuing actions or test saves against real nodes. Use `mock://` nodes for experiments and clean up the test data you create.
