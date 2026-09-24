---
version: "0.1.0b"
created_at: "2026-09-24T07:21:56+07:00,RWANG,working-tree"
last_update: "2026-09-24T07:21:56+07:00,RWANG"
status: "beta"
approval_owner: "Boss (บอส)"
approval_recorded_at: "2026-09-24T07:21:56+07:00"
superseded_by: null
attributes:
  domain: "gks-service-access"
  doc_type: "architecture-decision"
  scope: "MSP governed operations and authorized direct read-only clients"
---

# ADR: GKS client access profiles

## Decision status

The owner approved this architecture direction on 2026-09-24. The contract is
approved for implementation planning; no direct-client authentication or
runtime access is implemented or enabled by this ADR alone.

## Context

GKS owns canonical knowledge identity, relations, graph revisions and scoped
queries as a Knowledge Graph Service. Its current caller contract is narrower:
the `gks-msp-auth/v1` profile authenticates `msp-runtime`, and the current HTTP
adapter accepts the configured MSP relay credential. A client cannot become a
trusted caller by putting a principal, role or scope in request metadata.

That MSP-only contract is appropriate for promotion, review, pipeline and
receipt flows, where MSP owns policy, context, authorization and its own
`msp:promotion/` receipts. It prevents a system that only needs semantic graph
queries from using GKS without MSP governance features, but it also means the
service is not yet directly connectable to other systems.

## Decision

GKS has two distinct access profiles. Both use the same canonical service and
scope-enforced query implementation; neither profile grants authority to the
other.

### MSP governed profile

- Preserve the existing MSP authentication, scope digest, tool contracts and
  compatibility behavior.
- MSP remains the only caller authorized for promotion, artifact linking,
  human review, pipeline operations and their governed receipts.
- MSP continues to own memory, conversation context, policy and promotion
  authorization. GKS does not mint `msp:` receipts.

### Direct client read-only profile

- A separately authenticated system client may call only `gks_search`,
  `gks_entity_get` and `gks_relations_get`.
- Each client identity is resolved by a trusted server-side authentication
  adapter to an explicitly provisioned grant containing its allowed read
  actions and exact `KnowledgeScope` values. Client-supplied identity, role,
  action grants or scope claims are not authorization evidence.
- Missing, invalid, expired, revoked or unmapped identity; absent grants;
  wildcard scope; and cross-tenant access all fail closed. A
  `portfolio-shared` read requires an explicit grant provisioned by the GKS
  operator for that complete scope. The GKS grant authorizes only the read; it
  is not MSP promotion evidence.
- Direct clients cannot call promotion, artifact-link, human review, pipeline
  or evidence-receipt tools. Requests that attempt these operations are denied.
- Direct reads create no MSP context, approval or receipt. GKS returns only
  its scoped canonical query result under the existing result contract.
- No anonymous/public client access is introduced. Network access remains
  private and authenticated; the existing MSP bearer credential is never
  shared with direct clients or browser code.

The exact identity technology and credential lifecycle are intentionally not
selected here. Before implementation, inspect the deployment's available
workload identity options and approve a concrete verifier, provisioning,
rotation, expiration and revocation contract. The existing private HTTP
profile remains MSP-only until that work and its security tests are complete.

## Current and target topology

The existing governed path remains:

```text
Zuri / GoVibe -> MSP -> GKS -> GKS-owned persistence
```

The separately authorized read-only path is approved as a target, not yet
implemented:

```text
System client -> trusted GKS authentication/grant adapter -> GKS read tools
                                                       -> scoped query
```

## Consequences

- GKS can serve a system that already owns its memory or conversation policy
  without requiring that system to adopt MSP for graph reads.
- MSP remains necessary for MSP-specific memory/context, governance, approval,
  promotion mediation, pipeline orchestration and `msp:` receipts.
- GKS owns the direct-client read grant boundary; a grant must not be inferred
  from a client-provided scope or from possession of the MSP credential.
- The direct path does not change canonical storage, the persistence port,
  GenesisBlockDB ownership or existing API-010 promotion behavior.

## Acceptance criteria before enabling direct clients

- The selected identity verifier authenticates a client independently of
  caller-supplied JSON metadata and supports a documented revoke/rotate path.
- Only the three read tools are permitted to a direct-client principal;
  mutation, review, pipeline and receipt operations fail closed.
- Every query uses an explicitly granted complete scope, with cross-tenant
  denial enforced in the persistence query.
- Unknown, invalid, expired, revoked and under-scoped client identities are
  denied without leaking inaccessible graph references or source content.
- The existing MSP contract and its compatibility tests continue to pass.
- Direct-client authentication and scope-isolation tests pass before any
  canary; production enablement requires a separate rollout decision.

## Out of scope

This decision does not authorize direct writes, general ingestion, promotion,
review, MSP feature replacement, public/anonymous access, a browser-held service
secret, production deployment or canary traffic. Direct write authority needs
a separate decision covering provenance, approval, revocation, idempotency and
non-MSP receipt semantics.

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.1.0b | 2026-09-24 | beta | Owner-approved access profiles: preserve MSP-governed operations and define explicitly granted direct read-only clients; identity verifier and activation remain open. | working-tree | RWANG |
