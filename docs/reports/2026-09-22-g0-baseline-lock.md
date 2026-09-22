---
version: "0.1.0b"
created_at: "2026-09-22T00:00:00+07:00,RWANG,working-tree"
last_update: "2026-09-22T00:00:00+07:00,RWANG"
status: "candidate"
superseded_by: null
attributes:
  domain: "genesis-knowledge-system"
  doc_type: "baseline-evidence"
  scope: "G0 baseline lock for the SRS blueprint implementation program"
  baseline_sha: "be97c93adb4308ea9b2d9f9a7a33425758a7176a"
---

# G0 baseline lock — GKS SRS blueprint implementation

## Status

**G0 planning baseline: LOCKED. C0 qualification: OPEN. Production: NOT RUN.**

This report records the baseline used to start the approved implementation
program. It does not promote the extracted blueprint to an approved runtime
contract and does not claim MSP, Tier 4, or production readiness.

## Repository and runtime tuple

| Item | Observed value |
|---|---|
| Repository | `Freshair129/Genesis-Knowledge-System` |
| Branch | `main` |
| HEAD and `origin/main` | `be97c93adb4308ea9b2d9f9a7a33425758a7176a` |
| Node | `v24.19.0` |
| npm | `11.17.0` |
| Package | `gks@0.1.0`, engine `>=22` |
| `package-lock.json` SHA-256 | `92D889F11200A4EC80E2EDACB005A681BE56BED2AAB3080B0C4156295611949C` |
| `.github/workflows/test.yml` SHA-256 | `3371297214BD1CF1AE059341CE78304B7E951A2DED45BBF714A577436D6963AA` |
| Blueprint `SHA256SUMS.txt` SHA-256 | `C22700792D216186A2228BD426369A64F0BB7DABAF7961450C93160CE65C8FD5` |

The worktree also contains user-owned untracked `_inbox/`,
`mission-control-site/`, `mission-control-site.tar.gz`, and this report plus
the approved plan. None are staged.

## Baseline validation

| Check | Result | Evidence boundary |
|---|---|---|
| `npm test` | PASS: 23 files, 199 tests; security 10/10 | Local repository only; 2 Vitest tests skipped |
| `npx vitest run tests/unit` | PASS: 3 files, 9 tests | Local repository only |
| `npm run pack:client` with default npm cache | BLOCKED: `EPERM` creating npm cache temp directory | Environment permission failure before package assertion |
| `npm run pack:client` with process-scoped temp cache | PASS: `@freshair129/gks-client-js@0.2.1` | Diagnostic workaround; default CI/host cache remains unresolved |
| Blueprint `node --test tests/semantics.test.mjs` | PASS: 54 tests | Reference semantics only |
| Blueprint Python validator | NOT RUN | `python` and `py` are unavailable on this host |
| Real MSP provider/service chain | NOT RUN | Requires pinned external checkout/runtime |
| Tier 4 worker/GenesisBlockDB runtime | NOT RUN | No qualified physical runtime fixture |
| Production deployment/cutover | NOT RUN | Explicitly outside G0 |

The blueprint report itself states `0.1.0-proposed`, approval not recorded,
and reports reference-only evidence: 144 requirements, 14 schema checks, 19
negative fixtures, 54 Node reference tests, and 23 SQL reference tests. Those
figures are package evidence, not implemented GKS acceptance evidence.

## Current CI baseline

The existing workflow runs Node 22/24 matrices for contract, integration,
security, unit, and client-pack with `fail-fast: false`, followed by one
aggregate job. External MSP integration is skipped when `MSP_REPO_ROOT` is not
set. Therefore its green result is local CI evidence, not C0 qualification.

## G0 exit decision

G0 is sufficient to start ADR and contract review because the baseline SHA,
runtime, lockfile, workflow, test lanes, and evidence boundaries are pinned.
G0 is **not** sufficient to start K1 migrations or K2 bridge implementation.

Open items carried into G1:

1. Approve the C0 golden registry/hash/scope/receipt corpus.
2. Decide and document the legacy API-010 MSP authentication boundary.
3. Resolve the candidate empty-tenant visibility broadening path.
4. Specify bounded NDJSON framing and malformed-input behavior.
5. Remove the default npm cache permission blocker in the qualification host,
   or declare the approved cache path as part of the runner environment.

## Next gate

Proceed to **G1 ADR/contract review** for C0 transport, scope/auth, persistence,
and receipt compatibility. No source or CI implementation change is included
in this G0 report.

## Change log

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.1.0b | 2026-09-22 | candidate | Locked G0 baseline and recorded evidence boundaries | working-tree | RWANG |
