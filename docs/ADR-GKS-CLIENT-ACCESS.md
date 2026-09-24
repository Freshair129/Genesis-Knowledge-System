---
version: "0.2.0b"
created_at: "2026-09-24T07:21:56+07:00,RWANG,working-tree"
last_update: "2026-09-24T10:06:32+07:00,RWANG"
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

The owner approved the read-only access profile on 2026-09-24 and separately
approved per-client bearer credentials. This ADR records the implementation
contract; production activation remains a separate rollout decision.

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
- A client credential is `gksc_` followed by 43 base64url characters encoding
  32 random bytes, sent only as an HTTP Bearer credential. GKS stores no raw
  client key. The grants file stores its lowercase SHA-256 digest, client ID,
  allowed tools and scopes.
- Configure the absolute grants-file path with `GKS_CLIENT_GRANTS_PATH`. The
  JSON document has `schemaVersion: "gks-client-grants/v1"` and a `clients`
  array; each entry contains `clientId`, `credentialSha256`, `allowedTools`
  (a non-empty subset of the three read tools) and one or more complete
  `scopes`. Invalid configuration fails service startup. Credentials are
  rotated or revoked by changing the grants file and restarting the service.
- Network mode continues to require `GKS_MSP_AUTH_REQUIRED=1`. A direct-only
  deployment may omit `GKS_MSP_RELAY_CREDENTIAL` when a valid direct grants
  file is configured; MSP-authenticated operations then fail closed.
- Missing, invalid, revoked or unmapped identity; absent grants;
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

The selected V1 identity mechanism is a per-client opaque bearer credential
with server-side hash-to-grant resolution. OIDC/JWKS, mTLS, runtime grant
administration and hot-reload are out of scope. The existing MSP credential
and `gks-msp-auth/v1` verifier remain a separate profile; a credential digest
cannot be registered for both profiles.

## Current and target topology

The existing governed path remains:

```text
Zuri / GoVibe -> MSP -> GKS -> GKS-owned persistence
```

The separately authorized read-only path is implemented by the private HTTP
adapter when a valid grants file is configured:

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
- Unknown, invalid, revoked and under-scoped client identities are
  denied without leaking inaccessible graph references or source content.
- The existing MSP contract and its compatibility tests continue to pass.
- Direct-client authentication and scope-isolation tests pass before any
  canary; production enablement requires a separate rollout decision.
- No raw client key appears in the grants file, logs, tool responses or test
  diagnostics; invalid grants fail startup before the service accepts calls.
- Grant changes take effect only after restart; operational rotation and
  revocation procedures must account for that boundary.

## Out of scope

This decision does not authorize direct writes, general ingestion, promotion,
review, MSP feature replacement, public/anonymous access, a browser-held service
secret, production deployment or canary traffic. Direct write authority needs
a separate decision covering provenance, approval, revocation, idempotency and
non-MSP receipt semantics.

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.2.0b | 2026-09-24 | beta | Implements per-client 256-bit bearer keys, hash-only server grants, private HTTP read-only authorization and restart-based revoke/rotation; OIDC/mTLS remain out of scope. | working-tree | RWANG |
| 0.1.0b | 2026-09-24 | beta | Owner-approved access profiles: preserve MSP-governed operations and define explicitly granted direct read-only clients; identity verifier and activation remain open. | working-tree | RWANG |
