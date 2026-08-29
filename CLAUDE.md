# CLAUDE.md — working guide for this repository

## What this repo is

Standalone Genesis Knowledge System (GKS) — canonical knowledge identity,
relations, deduplication, scoped retrieval, and artifact linking. Extracted
from GoVibe as its own service. See `README.md` and
`docs/ADR-GKS-BOUNDARY.md`.

**Call direction (do not invert):** `Zuri / GoVibe -> MSP -> GKS`. GKS never
calls outward to GenesisBlockDB, GoVibe, or MSP — MSP (`D:\msp`) is GKS's
sole caller. GenesisBlockDB is a separate graph/vector engine, not GKS's
assumed persistence backend.

## Toolchain

```bash
npm install
npm test                    # test:vitest (contract + integration) + test:security
npm run test:contract       # tests/contract only
npm run test:integration    # requires MSP_REPO_ROOT=D:\msp or the external
                             # MSP suite skips silently and still reports green
npm run test:security       # tests/security/*.security.mjs (Node's own runner)
npm run pack:client         # dry-run pack of the publishable client
```

Start (no implicit database path — ever):
```powershell
$env:GKS_DB_PATH = Join-Path $env:TEMP 'gks.sqlite'
npm start
```

## Working roster

This repo has a role-based subagent roster in `.claude/agents/`, following
the same coordination pattern GoVibe (`D:\GoVibe\.agents\`) already uses —
scoped down to what's real here: no GoVibe task board, no hooks, plain
branch → PR → review.

| Agent | Role | Use for |
|---|---|---|
| `rkoi` | Tech lead / architecture reviewer | Reviewing any change before merge — boundary, layering, scope safety |
| `kin` | Backend implementer | Writing code in `apps/gks-server` or `packages/gks-*` |
| `janus` | DevOps | Workspace, `package.json`, migrations, packaging, runtime config |
| `ghost` | QA | Running/extending the test suite, finding coverage gaps |
| `ather` | Auditor / doc writer | ADR compliance checks, keeping `README.md`/`docs/*.md` current |

Each agent file states exactly what it checks and what it does not — read
the one you're delegating to before assuming its scope.

## Hard rules

- **Never assume GenesisBlockDB is the persistence backend.** It's a
  separate system; GKS owns its own SQLite adapter (`packages/gks-persistence`).
- **Never wire a new tool directly onto the server** — every public tool
  goes through `packages/gks-contracts`' tool registry.
- **Every call carries an explicit scope envelope.** `GKS_DEFAULT_PORTFOLIO_ID`
  exists only for legacy API-010 compatibility calls — a new caller must
  not start relying on it as a default.
- **Package layering is enforced by a test, not a convention:**
  `tests/contract/dependency-boundaries.test.mjs`. Read it before assuming
  what's allowed.
