# @veorec/db — PostgreSQL foundation

PostgreSQL is the **source of truth for all application state** (docs/02 §11). This package owns the connection pool, the Drizzle client, and the SQL migrations. Canonical specification: [docs/07-DATABASE-DESIGN.md](../docs/07-DATABASE-DESIGN.md) — §14 covers operations.

> **T-101 scope:** foundation only. There are **no application tables yet** — `src/schema/` is intentionally empty and migration `0000_foundation` creates only shared primitives (`citext`, `set_updated_at()`). Tables arrive in **T-102**.

## Quick start

```bash
docker compose up -d          # from the repo root: postgres, redis, minio, mailhog
cp .env.example .env          # once
cd db && npm install
npm run db:migrate            # apply migrations
npm run db:status             # connectivity + migration state
npm test                      # foundation tests (uses veorec_test)
```

## Commands

| Command | Purpose | Exit codes |
|---|---|---|
| `npm run db:migrate` | Apply pending migrations. Forward-only, tracked, idempotent — safe to run on every deploy. | 0 ok · 1 failed |
| `npm run db:status` | Connectivity + applied/pending migrations. Read-only; usable as a deploy gate. | 0 up to date · 1 cannot connect · 2 pending |
| `npm run db:reset` | **Destructive.** Drop everything and re-migrate. Local/test only — refused when `APP_ENV` is staging/production. | 0 ok · 1 refused/failed |
| `npm run db:generate` | Author a new migration by diffing `src/schema` (T-102 onward). Never applies anything. | — |
| `npm test` | Env guards + live-DB foundation tests. Skips loudly when no DB is reachable; `DB_TESTS_REQUIRED=1` makes that a failure (CI). | 0/1 |

## Layout

```
db/
├── drizzle.config.js      drizzle-kit config (authoring only)
├── migrations/            version-controlled SQL, applied in journal order
│   ├── 0000_foundation.sql
│   └── meta/_journal.json ordered manifest — the runner's source of truth
├── docker/init/           runs once on an empty Postgres volume (creates veorec_test)
└── src/
    ├── env.js             APP_ENV resolution, defaults, destructive guards, redaction
    ├── pool.js            pg Pool construction (timeouts, SSL, shared pool)
    ├── client.js          Drizzle client
    ├── migration-state.js applied vs pending (read-only)
    ├── schema/            table definitions — EMPTY until T-102
    └── cli/               migrate.js · status.js · reset.js
```

## Environments

`APP_ENV` ∈ `local` | `test` | `staging` | `production`.

- `local` → `DATABASE_URL`, defaults to the compose Postgres on port **5433**.
- `test` → `DATABASE_URL_TEST` (a **separate** database; its schema is dropped on every test run).
- `staging` / `production` → `DATABASE_URL` is **required**; there is no default and no fallback to a local database. `DATABASE_SSL` defaults to `require`.

Destructive commands are permitted only in `local`/`test` and **always refused for production**. Connection strings are redacted (`postgres://user:***@host/db`) everywhere they are printed.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `ECONNREFUSED 127.0.0.1:5433` | `docker compose up -d postgres`, then `docker compose ps` to confirm health |
| Port 5433/6380 already in use | Set `POSTGRES_PORT`/`REDIS_PORT` in `.env` and update `DATABASE_URL` to match |
| `database "veorec_test" does not exist` | The init script only runs on a fresh volume: `docker compose down -v && docker compose up -d postgres` |
| `password authentication failed` | `.env` disagrees with the compose credentials — recreate the volume or align both |
| Migration applied but schema looks wrong | `npm run db:status`; locally, `npm run db:reset` re-applies from scratch |
| Tests report SKIPPED | Infrastructure is not running — that is expected without Docker; start Postgres or set `DB_TESTS_REQUIRED=1` to enforce |
