---
version: "0.3.0b"
created_at: "2026-09-22T10:54:22+07:00,RWANG,working-tree"
last_update: "2026-09-22T11:53:35+07:00,RWANG"
status: "beta"
superseded_by: null
attributes:
  domain: "gks-production-runtime"
  doc_type: "architecture-decision"
  scope: "HTTP transport and GKS-owned SQLite production profile"
approval_owner: "Boss (บอส)"
approval_recorded_at: "2026-09-22T10:54:22+07:00"
---

# ADR: GKS production runtime profile

## Context

The approved GKS service port currently runs as newline-delimited JSON-RPC over
stdio. The port contract requires a future network adapter to preserve the
same service methods, bounded transport behaviour, scope rules, and conformance
fixtures. Production cutover is a separate gate from C0 qualification and from
the private Mission Control Site.

GenesisBlockDB remains a separate product. It is not selected as a GKS
persistence backend by this decision.

## Decision

For the first deployable GKS runtime profile:

1. Keep stdio as the compatibility transport for local operation and MSP
   fixtures.
2. Add an HTTP JSON-RPC 2.0 transport at `POST /mcp` that preserves
   `initialize`, `tools/list`, `tools/call`, the registered GKS tool names, and
   the existing structured error results.
3. Expose `GET /healthz` as a bounded readiness check. It returns no secrets,
   database paths, credentials, or canonical data.
4. Require managed MSP authentication for network calls. The caller supplies
   `Authorization: Bearer <relay credential>` and the request metadata carries
   the existing `gks-msp-auth/v1` principal, role, and scope digest. The
   adapter maps the header into the existing authorization verifier; it does
   not create a second authorization policy. Only `/healthz`, `initialize`,
   `tools/list`, and `gks_health` are unauthenticated liveness/metadata
   operations; every other `tools/call` requires the bearer credential.
5. Preserve the existing limits: 1 MiB normal request frames, 8 MiB pipeline
   request frames, 8 MiB responses, JSON depth 32, no batches, and at most 16
   in-flight requests. HTTP bodies must be rejected before service dispatch
   when they exceed the applicable limit.
6. Select the existing GKS-owned SQLite adapter as the first production
   persistence profile, constrained to one writer process and a durable volume.
   WAL, foreign-key enforcement, explicit absolute `GKS_DB_PATH`, migrations,
   backup, and restore verification remain mandatory. A missing or unavailable
   backend fails closed; no in-memory fallback is allowed.
7. Bind the application to a private interface. TLS termination, network
   policy, process supervision, durable volume, secret injection, and external
   backup retention belong to the deployment target and must be recorded in the
   release evidence.
8. Use the Docker Compose target under `deploy/docker/` as the reference
   operational package for a private Linux host. It provides a non-root Node
   runtime, a durable SQLite volume, read-only application storage, Docker
   secrets for relay credentials, loopback-only host exposure, and a healthcheck.
   The package is deployable infrastructure, not proof that a production host,
   registry, secret manager, or MSP endpoint has been provisioned.

## Configuration contract

Required for a network deployment:

| Variable | Rule |
|---|---|
| `GKS_DB_PATH` | explicit absolute path on the durable volume |
| `GKS_MSP_AUTH_REQUIRED` | exactly `1` |
| `GKS_MSP_RELAY_CREDENTIAL` | injected secret; never logged or stored in SQLite |
| `GKS_PIPELINE_RELAY_CREDENTIAL` | injected secret for authenticated GenesisRAG17 pipeline envelopes |
| `GKS_HTTP_HOST` | explicit private bind address in production |
| `GKS_HTTP_PORT` | explicit listening port in production |
| `GKS_MSP_RELAY_CREDENTIAL_FILE` | Docker-target secret file path consumed by the entrypoint |
| `GKS_PIPELINE_RELAY_CREDENTIAL_FILE` | Docker-target secret file path consumed by the entrypoint |

The existing `GKS_*` policy variables remain available for the service
contract. Pipeline tools continue to validate their own
`GKS_PIPELINE_RELAY_CREDENTIAL` envelope; the HTTP bearer credential is the
MSP transport credential and is not silently substituted into a pipeline
payload. No database URL, caller environment, or unbounded process environment
is introduced.

## Rollout gates

1. Contract parity: HTTP and stdio produce equivalent results for initialize,
   tool listing, health, valid calls, malformed frames, and structured errors.
2. Security: missing/invalid bearer credentials, invalid principal metadata,
   scope-digest mismatch, cross-tenant access, oversized bodies, batches, and
   concurrent overload are denied without service dispatch.
3. Persistence: migration, restart, idempotent retry, conflicting retry,
   backup/restore, and no-partial-write checks pass on the target runtime.
4. MSP canary: the real MSP provider calls the network endpoint with the
   managed credential while the stdio compatibility path remains available.
5. Cutover: only after health, MSP conformance, rollback rehearsal, and owner
   approval are recorded. Rollback changes the MSP endpoint/configuration and
   runtime artifact; it never deletes canonical data.

## Rejected alternatives

- Public unauthenticated HTTP access: rejected because every network caller
  must be authenticated and scope is security-sensitive. This ADR describes the
  current MSP-only HTTP profile; a direct read-only profile is approved only as
  specified by `ADR-GKS-CLIENT-ACCESS.md` and is not yet implemented or enabled.
- A second REST-specific tool contract: rejected because it would drift from
  `GksServicePort` and duplicate conformance coverage.
- GenesisBlockDB as an implicit backend: rejected by the GKS boundary ADR.
- In-memory or GoVibe-local production fallback: rejected because it creates
  duplicate canonical truth and fabricates availability.
- Horizontal SQLite writers: rejected for the first profile until a separately
  approved adapter and concurrency contract exist.

## Change classification

- Complexity: `C-3`
- Risk: `HIGH`
- Capability ceiling: `H4` for production/cross-repository cutover

## Acceptance criteria

- The HTTP adapter reuses the same tool registry, service port, auth verifier,
  error mapping, and transport limits as stdio.
- MSP remains the only governed network caller.
- A restart against the durable SQLite path returns the same canonical mapping.
- The reference Docker target builds from the exact source SHA and starts with
  the required secrets absent only by failing closed.
- Backup/restore and rollback evidence exist before cutover.
- Production status is reported separately from local, CI, cross-repository,
  and fixture evidence.

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.3.0b | 2026-09-24 | beta | Clarifies that the current private HTTP runtime remains MSP-only while the separately approved direct read-only profile awaits its own verifier and tests. | working-tree | RWANG |
| 0.2.0b | 2026-09-22 | beta | Added the Docker Compose reference target with durable SQLite, non-root execution, Docker secret injection, and health/rollback boundaries; production activation remains separate. | working-tree | RWANG |
| 0.1.0 | 2026-09-22 | beta | Selected the first production runtime profile: HTTP JSON-RPC parity over the existing GKS service port with a private, authenticated, single-writer SQLite deployment. | working-tree | RWANG |
