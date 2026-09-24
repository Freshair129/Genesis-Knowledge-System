---
version: "0.2.1"
created_at: "2026-09-22T00:00:00+07:00,RWANG,working-tree"
last_update: "2026-09-25T02:08:55+07:00,RWANG"
status: "beta"
approval_owner: "Boss (บอส)"
approval_recorded_at: "2026-09-22T00:00:00+07:00"
superseded_by: null
attributes:
  domain: "gks-service-extraction"
  doc_type: "architecture-decision"
  scope: "C0 tenant isolation, MSP authentication boundary, bounded stdio transport, and qualification corpus"
  baseline_sha: "be97c93adb4308ea9b2d9f9a7a33425758a7176a"
---

# ADR: C0 qualification boundary

## Decision status

**Approved for C0 implementation.** This ADR narrows and qualifies the
already-approved standalone GKS boundary. It does not authorize
K1 migrations, K2 retrieval, deployment, cutover, or production release.

## Context

G0 reproduced the current local C0 suites, but identified four qualification
gaps:

1. service-level visibility treats an empty stored scope dimension as broad,
   while SQL resolution/evidence predicates treat an empty tenant as its own
   pool;
2. legacy API-010 calls prove provenance but the frozen payload has no room for
   a new credential field, so the relay boundary needs an explicit transport
   mode that does not silently break existing clients;
3. the stdio server uses line parsing without an enforced raw-frame budget,
   duplicate-key rejection, or depth/in-flight limits;
4. the official 17-tool C0 golden registry/hash/scope/receipt corpus is not
   yet a tracked qualification artifact.

The parent boundary ADR requires MSP to be the only governed caller and
`GKS-PORT-CONTRACT` requires bounded JSON-RPC, exact scope rules, and unchanged
API-010 inner payload compatibility.

## Decisions

### D1 — Tenant wall is exact, never a wildcard

Normalize a missing `tenantId` to the empty tenant key `""` for C0 access
checks. A stored row and a request are visible to one another only when their
normalized tenant keys are equal. This rule applies consistently to search,
entity, relation, artifact, review, legacy stage evidence, and pipeline
evidence reads, as well as promotion and human-resolution writes.

Consequences:

- a tenantless legacy row is visible only to a tenantless request;
- a non-empty tenant cannot read tenantless rows;
- a tenantless request cannot read a non-empty tenant;
- `portfolio-shared` does not override the tenant wall;
- legacy records are not widened by an automatic migration or compatibility
  fallback;
- the existing exact SQL resolution predicates remain the source of truth and
  service-level filtering must not weaken them.

The other optional scope dimensions retain their existing sharing semantics
until a separate scope ADR changes them. This decision is specifically the
tenant boundary and does not invent a new hierarchy.

### D2 — Legacy API-010 keeps its inner payload; secure mode adds transport auth

The literal `govibe-knowledge-candidate/v1` request remains unchanged. C0 has
two explicit runtime modes so compatibility is not confused with a secured
managed deployment:

- **Compatibility mode** (the default when `GKS_MSP_AUTH_REQUIRED` is absent):
  preserves the frozen API-010 and existing local callers. The governed
  process boundary remains MSP-only; this mode is not a secure-mode
  qualification claim.
- **Secure qualification mode** (`GKS_MSP_AUTH_REQUIRED=1`): MSP adds an
  outer JSON-RPC metadata envelope to every legacy knowledge read or mutation:

```json
{
  "jsonrpc": "2.0",
  "id": "request-id",
  "method": "tools/call",
  "params": {
    "name": "gks_knowledge_promote",
    "arguments": { "schema_version": "govibe-knowledge-candidate/v1" },
    "_meta": {
      "gksMspAuth": {
        "version": "gks-msp-auth/v1",
        "principalId": "msp-runtime",
        "role": "msp",
        "relayCredential": "<secret injected by MSP>",
        "scopeDigest": "<sha256 of normalized request scope>"
      }
    }
  }
}
```

In secure mode, the server compares the configured relay credential in constant
time, checks `role`, recomputes and compares `scopeDigest`, then strips the auth
envelope before domain persistence. Credentials, metadata secrets, and raw auth
values are never persisted or logged. Missing, forged, stale, or mismatched
auth is a typed denial with no persistence attempt. The MSP provider forwards
`GKS_MSP_RELAY_CREDENTIAL` only through the child allowlist and never places it
in the API-010 inner payload.

`initialize`, `tools/list`, and `gks_health` remain unauthenticated protocol
operations. In secure mode, every legacy operation that returns scoped
knowledge or changes canonical state requires the envelope. Existing pipeline
requests retain their own authenticated principal/relay fields and must satisfy
both exact-scope and role checks; the server must not create two competing
authorization models. A future change may make secure mode the only supported
mode, but that is a separate versioned rollout and is not hidden inside C0.

### D3 — Bounded raw NDJSON/JSON-RPC

The server must enforce limits before expensive parsing, validation, or a
database transaction:

| Budget | C0 value |
|---|---:|
| Normal request frame | 1 MiB |
| Submit/pipeline request frame | 8 MiB |
| Response frame | 8 MiB |
| Maximum JSON depth | 32 |
| Maximum in-flight requests | 16 |
| JSON-RPC batch | unsupported and explicitly rejected |

Raw framing must reject an oversized frame, malformed UTF-8, duplicate object
keys, excessive depth, unsafe/non-finite numbers, and malformed JSON before it
reaches the service. The response is a structured protocol error; it must not
write partial rows. Notifications receive no result, and cancellation must
never claim that an already durable write was rolled back. stdout contains
protocol frames only; diagnostics are redacted and go to stderr.

These are the blueprint's proposed C0 budgets. A deployment may set smaller
limits, but may not silently increase them or truncate input.

### D4 — Tracked C0 golden corpus

Create the qualification corpus under
`tests/fixtures/c0-qualification/` after this ADR is approved. Its registry
must contain, for each case:

- fixture ID and contract/profile version;
- request and expected-result SHA-256 hashes;
- tool name and normalized scope;
- expected opaque refs, receipt hashes, ledger name, and cursor outcome;
- expected error code for denied cases;
- runtime/fixture provenance without secrets.

The minimum corpus is:

1. all 17 registered tools and their accepted response envelopes;
2. API-010 accepted promotion/replay/idempotency cases;
3. tenantless/tenant exact-wall cases, portfolio sharing with and without MSP
   authorization, and forged scope cases;
4. forged/missing/stale MSP auth, malformed/oversized/deep/duplicate-key
   frames, unsupported batch, and stderr/stdout separation;
5. GenesisRAG17 receipt order, wrong hash/scope/stage, duplicate receipt,
   failed terminal state, and publication gating;
6. backend unavailable, disk/transaction failure, and lost-response replay.

The `C0.4-LOST-RESPONSE-REPLAY` case uses `gks_pipeline_submit` against an
isolated temporary SQLite database. A test-only subprocess output adapter
captures the successful structured result out-of-band, then exits before
forwarding that JSON-RPC response to the caller. The test restarts GKS against
the same database and replays the identical request. It must prove that the
replay returns the same durable decision and scope with only `idempotent`
changing from `false` to `true`, that one batch and one unchanged decision hash
remain, and that the original four Stage 9-12 `pipeline_evidence` rows and
cursors are not duplicated. The adapter is test-only; no production crash
switch, external endpoint, or real credential is permitted.

No production secrets, user data, or external live endpoint is allowed in the
corpus. A qualification run must report `PASS`, `FAIL`, `NOT_RUN`, or
`BLOCKED`; a missing external MSP fixture cannot become a green C0 claim.

## Contract and test matrix

| Surface | Required assertion | Test class |
|---|---|---|
| Tenant scope | normalized exact equality, including empty tenant | security + persistence contract |
| Legacy auth | MSP envelope required; inner API-010 payload unchanged | contract + real MSP integration |
| Transport | raw bounds, duplicate keys, depth, correlation, stderr-only | protocol contract + restart |
| Tool registry | 17 names, schemas, roles, and error envelope unchanged | registry contract |
| Receipts | immutable ordering, idempotent retry, wrong hash/scope denied | pipeline contract + failure matrix |
| Corpus | registry hashes and expected opaque refs reproduce | golden qualification |

## Implementation slices after approval

1. **C0.1 contracts/tests:** add schemas and negative fixtures for D1–D3;
   preserve API-010 inner payload fixtures.
2. **C0.2 transport boundary:** implement bounded raw framing and auth
   extraction before dispatch; keep stdout/stderr behavior explicit.
3. **C0.3 scope enforcement:** make service visibility and persistence checks
   share the exact tenant wall; add cross-tenant regression cases.
4. **C0.4 corpus/runner:** add the tracked registry, deterministic runner,
   result manifest, and no-skip qualification classification.
5. **C0.5 real MSP qualification:** run the pinned provider/service chain and
   record cross-repository evidence separately from local CI.

Each slice requires tests first, a review of this ADR's acceptance matrix, and
serial merge through the G1 gate. No K1/K2 work may use a failed or unresolved
C0 gate as a dependency.

## Acceptance and approval gate

G1 is accepted only when the owner approves D1–D4 and the implementation
review confirms:

- no wildcard tenant access remains;
- legacy API-010 compatibility is preserved in compatibility mode and inside
  the authenticated MSP transport boundary in secure mode;
- secure mode is exercised by the actual MSP provider/service chain;
- all stated raw-frame limits are enforced before persistence;
- the golden corpus has deterministic hashes and explicit skip semantics.

## Change log

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.1.0b | 2026-09-22 | candidate | Proposed C0 qualification decisions for G1 review | working-tree | RWANG |
| 0.1.0 | 2026-09-22 | beta | User approved D1-D4 for C0 implementation | working-tree | RWANG |
| 0.2.0 | 2026-09-22 | beta | Clarified compatibility versus secure MSP auth mode and recorded real-chain qualification boundary | working-tree | RWANG |
| 0.2.1 | 2026-09-25 | beta | Specified the process-loss replay evidence boundary for GenesisRAG17 pipeline submission | working-tree | RWANG |
