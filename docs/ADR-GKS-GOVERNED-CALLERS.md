---
version: "0.3.0"
created_at: "2026-09-27T21:00:00+07:00,Claude,working-tree"
last_update: "2026-09-27T22:00:00+07:00,Claude"
status: "accepted"
approval_owner: "Boss (บอส)"
approval_recorded_at: "2026-09-27T21:30:00+07:00"
superseded_by: null
attributes:
  domain: "gks-service-access"
  doc_type: "architecture-decision"
  scope: "Governed callers: MSP becomes one implementation of a caller role that any system with its own auth and memory can fill"
---

# ADR: Governed callers

## Decision status

**Accepted by the owner on 2026-09-27, as proposed.** The owner approved all
four open questions as proposed; see "Owner decisions" below. This ADR amends
three documents:

- ADR-GKS-BOUNDARY: "MSP is the only governed caller";
- ADR-GKS-CLIENT-ACCESS: its "Out of scope: direct writes" section;
- the matching hard rule in `CLAUDE.md`.

Those documents are updated together with the implementation.

## Context

Today a system can write to GKS only through MSP:

- promotion, artifact linking and human review require the
  `gks-msp-auth/v1` envelope with `principalId: "msp-runtime"`;
- every provenance reference must start with `msp:proof/`;
- direct clients (ADR-GKS-CLIENT-ACCESS) may only read.

What GKS actually needs from its writer is a **role**, not the MSP product. The
role has three parts:

1. **Authenticate** the end user or agent. GKS trusts the caller that did so.
2. **Decide the scope** (portfolio, tenant, business, workspace, project,
   sharing) of each call.
3. **Supply provenance**: a reference to the approval that authorized the
   write.

A customer that already runs its own auth and memory can already fill that
role. Requiring it to deploy MSP only to reach GKS adds a hop that contributes
nothing. ADR-GKS-CLIENT-ACCESS left direct writes open, pending a decision on
provenance, approval, revocation, idempotency and non-MSP receipts. This ADR is
that decision.

## Decision

### D1 — "Governed caller" is a role; MSP is its first implementation

A governed caller is a system that GKS trusts to authenticate its own users,
choose scopes within its boundary, and attest provenance. MSP keeps working
exactly as today, as the built-in governed caller `msp-runtime`. Other
governed callers are provisioned explicitly by the GKS operator. The call
direction is unchanged: a caller calls GKS, and GKS never calls out.

### D2 — Provisioned by the existing grants file

`GKS_CLIENT_GRANTS_PATH` gains `schemaVersion: "gks-client-grants/v2"`, and
v1 documents keep parsing unchanged. Each entry declares a `profile`:

```json
{
  "schemaVersion": "gks-client-grants/v2",
  "clients": [
    { "profile": "read", "clientId": "reporting", "credentialSha256": "…",
      "allowedTools": ["gks_search"], "scopes": [{ "portfolioId": "p1", "tenantId": "t1", "…": "…" }] },
    { "profile": "governed", "clientId": "acme-backend", "credentialSha256": "…",
      "provenanceNamespace": "acme",
      "portfolioIds": ["acme-portfolio"],
      "allowedTools": ["gks_knowledge_promote", "gks_search", "gks_entity_get", "gks_relations_get",
                       "gks_artifact_link", "gks_review_list", "gks_review_apply", "gks_stage_evidence_export"] }
  ]
}
```

- `read` is the existing direct-client profile, unchanged.
- `governed` may list any of the eight legacy knowledge tools. Pipeline tools
  are out of scope (see D8).
- Credentials use the existing format (`gksc_` + 32 random bytes) and are
  stored hash-only, with the same restart-based rotation and revocation.
- Startup fails on any invalid entry. That includes a namespace or portfolio
  claimed twice (D3, D5), a governed entry whose `clientId` is
  `msp-runtime`, and the namespace `msp`.

### D3 — Exclusive portfolio boundary

- A governed caller owns the portfolios in `portfolioIds`. **Each portfolio
  has at most one governed caller.** Within its portfolios the caller is
  trusted to choose tenant, business, workspace, project and sharing, just as
  MSP is today.
- GKS still enforces the exact tenant wall on every request
  (ADR-GKS-C0-QUALIFICATION D1). A caller's trust never crosses a tenant
  inside its own portfolio.
- A request for a portfolio outside the caller's boundary is
  `gks_scope_denied` before any persistence read.
- Exclusivity is also what keeps callers apart in storage:
  - idempotency keys, canonical refs and evidence cursors are all keyed by
    `scope_key`;
  - two callers can therefore never collide on an idempotency key, and cannot
    observe each other's rows.

### D4 — Authentication envelope

Governed callers use the private HTTP transport:

- the credential goes in `Authorization: Bearer`;
- each tool call carries this envelope:

```json
"_meta": { "gksCallerAuth": { "version": "gks-caller-auth/v1", "callerId": "acme-backend", "scopeDigest": "<sha256 of the normalized scope>" } }
```

- `callerId` must equal the grant's `clientId`.
- `scopeDigest` is computed exactly like MSP's (`mspScopeDigest`). It binds
  the metadata to the arguments, so a proxy that rewrites the scope is refused.

Stdio stays MSP-only. Whoever spawns a stdio child already holds the store and
its environment, which is operator trust, not caller trust.

### D5 — Provenance namespaces

- **The public tool schemas widen their pattern.** Today they require
  `^msp:proof/`. The new pattern is `^[a-z][a-z0-9-]{0,30}:proof/`. It
  applies to `provenance_ref` (promote), `provenanceRef` (review apply) and
  `evidenceRef` (artifact link). Widening a pattern accepts everything
  accepted before, so API-010 payloads are unaffected.
- **The authorization layer then requires the caller's own namespace**:
  `acme:proof/…` for `acme-backend`, and `msp:proof/…` for MSP only. A caller
  cannot attest under another caller's namespace. Namespaces are unique across
  grants, and `msp` is reserved.
- **GKS stores the reference as given.** It never mints proofs or receipts
  for any caller. That is the "non-MSP receipt semantics" question from
  ADR-GKS-CLIENT-ACCESS: there are none, exactly as for MSP today.
- Verifying proofs (GKS-IDN-006) becomes a per-caller question, for example
  proofs signed with a key in the grant. That stays a separate decision.

### D6 — Attribution

Each write records the authenticated `caller_id` next to the caller-supplied
provenance. That covers promotions, human resolutions, artifact links and
stage evidence, via additive migration 0008. Existing rows are backfilled as
`msp-runtime`. "Who wrote this" must not rest on a string the writer chose.

### D7 — MSP compatibility

- `GKS_MSP_RELAY_CREDENTIAL` and the `gks-msp-auth/v1` envelope work unchanged
  over stdio and HTTP. API-010 payloads, response shapes and stored
  `msp:proof/` references are untouched.
- MSP's boundary is every portfolio **not** claimed by a governed grant. A
  portfolio moved to another governed caller becomes `gks_scope_denied` to
  MSP. With no governed grants configured, behaviour is identical to today.

### D8 — Out of scope

- Pipeline (GenesisRAG17) tools. They keep their relay/worker credentials, and
  per-caller pipeline sources would be a follow-up.
- OIDC/JWT/mTLS verification.
- Runtime grant administration or hot reload.
- Portfolios shared between callers.
- Public or anonymous access.
- GKS minting receipts.
- Verifying proofs against the caller (GKS-IDN-006).

## Consequences

- A customer with its own auth and memory reaches GKS directly. Its backend
  becomes a governed caller, so there is no MSP deployment.
- There is still one authorization model: grants plus the built-in MSP
  profile. No second, competing model appears.
- The blast radius of a leaked governed credential is that caller's
  portfolios, not the whole store. It is revoked by editing the grants file
  and restarting.
- Two things are now true of every write rather than assumed:
  - "MSP owns policy" becomes "the portfolio's governed caller owns policy";
  - the stored `caller_id` records who wrote each row.

## Changes on acceptance (implemented 2026-09-27)

| Area | Change |
|---|---|
| `gks-contracts/client-auth.mjs` | parse grants v2 (the `governed` profile); enforce namespace and portfolio uniqueness |
| `gks-contracts/tool-definitions.mjs` | widen the three provenance patterns. The tool registry hash changes, so the baseline is re-locked. |
| `gks-contracts/validation.mjs`, `gks-core` | move the `msp:proof/` checks into caller-aware authorization |
| `apps/gks-server/http-server.mjs`, `server.mjs` | resolve a bearer credential to a governed grant; verify `gksCallerAuth`; enforce the boundary and namespace; deny MSP on claimed portfolios |
| `migrations/0008_caller_attribution.sql` | additive `caller_id` columns, with backfill |
| docs | amend ADR-GKS-BOUNDARY, ADR-GKS-CLIENT-ACCESS, GKS-PORT-CONTRACT, `CLAUDE.md`; runbook section on provisioning a governed caller |

## Acceptance criteria

- A governed caller can promote, link, review and export within its
  portfolios, and every one of those calls is denied outside them.
- Denials that fail closed, with no persistence read:
  - a wrong credential;
  - a `callerId`/grant mismatch;
  - a scope-digest mismatch;
  - another caller's namespace, including `msp`;
  - a portfolio owned by another caller;
  - a tool not in `allowedTools`;
  - any pipeline tool.
- Invalid grant documents fail startup, including overlapping portfolios,
  duplicate namespaces, and a governed `msp-runtime` or `msp`.
- MSP behaviour, the API-010 fixtures and the C0.4 golden corpus replay
  unchanged when no governed grant is configured. New golden cases cover a
  governed caller and the denials above.
- Every write stores its authenticated `caller_id`, and existing rows read
  back as `msp-runtime`.
- No raw credential appears in the grants file, logs, responses or the store.

## Owner decisions (2026-09-27)

The owner accepted each of the following as proposed.


1. **MSP's boundary** is every portfolio not claimed by a governed grant.
2. **Portfolios are exclusive:** one governed caller per portfolio.
3. **The attribution migration (D6)** ships in the same rollout.
4. **Per-caller pipeline sources** are left for a later, separate decision.

## Change log

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.1.0b | 2026-09-27 | proposed | Draft: governed-caller role with MSP as its first implementation. Grants v2 `governed` profile with exclusive portfolios, the `gks-caller-auth/v1` envelope, per-caller provenance namespaces, caller attribution, MSP compatibility; pipeline out of scope. | working-tree | Claude |
| 0.2.0 | 2026-09-27 | accepted | The owner accepted the ADR and all four open questions as proposed. | working-tree | Claude |
| 0.3.0 | 2026-09-27 | accepted | Implemented: grants v2 governed profile, `authorizeGovernedCallerRequest`, per-caller provenance namespaces (MSP messages unchanged), MSP denied on governed portfolios, migration 0008 `caller_id`, and the amended BOUNDARY, CLIENT-ACCESS, PORT-CONTRACT, README, runbook and CLAUDE.md. A golden corpus case over HTTP follows in the next PR. | working-tree | Claude |
