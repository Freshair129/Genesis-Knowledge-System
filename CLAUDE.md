# CLAUDE.md — working guide for this repository

## What this repo is

Standalone Genesis Knowledge System (GKS) — canonical knowledge identity,
relations, deduplication, scoped retrieval, and artifact linking. Extracted
from GoVibe as its own service. See `README.md` and
`docs/ADR-GKS-BOUNDARY.md`.

Remote: `origin` → https://github.com/Freshair129/Genesis-Knowledge-System
(private). Local path in cross-repo references is `D:\gks`.

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

## Pipeline stages GKS owns (read `docs/TIER-BOUNDARY-17-STAGE.md`)

GKS is Tier 3 of a four-tier stack, and owns **seven stages** of zuri-ai's
seventeen-stage knowledge ingestion pipeline: 9 `DPS-KI-ENTITY-RESOLVE`,
10 `DPS-KI-FACT-EXTRACT`, 11 `DPS-KI-ONTOLOGY-MAP`, 12 `DPS-KI-TEMPORAL-MAP`,
13 `DPS-KI-GRAPH-BUILD` (GKS decides, GenesisBlockDB writes), 14 `DPS-KI-ENRICH`,
17 `DPS-KI-QUALITY-GATE`.

Three things that are easy to get wrong:

- **A stage is done when it can report its evidence**, not when its logic runs.
  Each stage has a fixed evidence list; another repository tracks a number
  against exactly those fields.
- **`canonicalEntityRef` hashing is not Stage 9.** It is deduplication by
  identity — two spellings of one entity hash apart and stay apart. Stage 9 is
  the stage that decides they are the same, names the strategy, and reports a
  confidence.
- **Report completion; do not record it.** GKS has no write access to zuri-ai's
  tracker (`PRJ-KNOWLEDGE-17S`, and `docs/roadmap/ROADMAP.md` there) and should
  not gain any. Name the `DPS-KI-*` id and the evidence in the PR.
