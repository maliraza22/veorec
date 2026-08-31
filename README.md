# VeoRec

Loom-style screen recording platform: Chrome extension (MV3) + web app (`client/`, React/Vite) + API server (`server/`, Express).

## ⚠ Read this first

This repository is under a **controlled architectural migration**. The canonical specification lives in [`docs/`](docs/README.md) — it governs all changes. Start with:

- [docs/README.md](docs/README.md) — index, reading order, rules
- [docs/00-EXECUTIVE-SUMMARY.md](docs/00-EXECUTIVE-SUMMARY.md) — what/why
- [docs/26-CLAUDE-CODE-IMPLEMENTATION-RULES.md](docs/26-CLAUDE-CODE-IMPLEMENTATION-RULES.md) — binding rules before writing code
- [docs/24-IMPLEMENTATION-PLAN.md](docs/24-IMPLEMENTATION-PLAN.md) — the task list (T-xxx); work must map to a task
- [docs/BASELINE.md](docs/BASELINE.md) — verified pre-migration state and canonical commands

Features listed as frozen in [docs/23-MIGRATION-PLAN.md](docs/23-MIGRATION-PLAN.md) Phase 0 receive bugfixes only.

## Quick start (current legacy stack)

```bash
# API (local mode: disk uploads, JSON persistence — differs from prod, see docs/01 §2.3)
cd server && npm install && npm run dev        # :3001

# Web app
cd client && npm install && npm run dev        # :5173, proxies /api → :3001

# Extension: chrome://extensions → Load unpacked → ./extension

# Tests (the only suite at baseline)
node tests/fixwebm.test.js
```

Production: Railway (server, Docker), Vercel (client), Cloudinary (media — being migrated per docs/23). Environment variables: [docs/01 §8](docs/01-CURRENT-CODEBASE-AUDIT.md).

## Legacy docs

`BILLING_SETUP.md`, `MONETIZATION.md`, `CHROME_STORE_SUBMISSION.md` predate the docs package; where they conflict with `docs/`, `docs/` wins.
