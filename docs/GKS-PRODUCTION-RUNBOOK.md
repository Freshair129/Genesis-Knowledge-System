---
version: "0.1.0b"
created_at: "2026-09-22T10:54:22+07:00,RWANG,working-tree"
last_update: "2026-09-22T10:54:22+07:00,RWANG"
status: "beta"
superseded_by: null
attributes:
  domain: "gks-production-runtime"
  doc_type: "runbook"
  scope: "private HTTP runtime, canary, rollback, and cutover"
---

# GKS production runbook

This runbook applies to the production runtime profile in
[ADR-GKS-PRODUCTION-RUNTIME.md](ADR-GKS-PRODUCTION-RUNTIME.md). It does not
publish the private Mission Control Site and it does not authorize a
GenesisBlockDB deployment.

## Required evidence before deployment

- exact source SHA and passed required CI checks;
- immutable runtime artifact and a retained previous artifact for rollback;
- explicit private host, port, TLS/reverse-proxy boundary, and process owner;
- durable volume for `GKS_DB_PATH` with tested backup and restore;
- `GKS_MSP_AUTH_REQUIRED=1` and an injected relay credential;
- MSP network configuration and a reversible previous configuration;
- health, scope-deny, restart, idempotency, and overload evidence.

Missing evidence is `NOT_RUN`, not a pass.

## Runtime configuration

Set these values through the target secret/configuration manager. Never put a
relay credential in a command line, repository file, archive, or log.

```text
GKS_DB_PATH=<absolute path on durable volume>
GKS_MSP_AUTH_REQUIRED=1
GKS_MSP_RELAY_CREDENTIAL=<secret reference/value from secret manager>
GKS_PIPELINE_RELAY_CREDENTIAL=<secret reference/value for pipeline envelopes>
GKS_HTTP_HOST=<private bind address>
GKS_HTTP_PORT=<explicit port>
```

The server must fail closed when the database path, required credential, or
network bind configuration is missing.

## Canary sequence

1. Verify the artifact SHA and configuration names without printing values.
2. Start one isolated canary process against the intended durable volume.
3. Check `GET /healthz` and record status, build SHA, migration result, and
   backend readiness without recording the database path.
4. Run HTTP contract, authentication-deny, cross-tenant-deny, idempotency,
   restart, and bounded-overload checks.
5. Run the real MSP network provider/service-chain qualification.
6. Confirm the prior artifact and prior MSP configuration are immediately
   restorable.

The canary is not production cutover evidence until the target owner accepts
the result and the rollback rehearsal is recorded.

## Cutover

1. Freeze the exact artifact and configuration revision.
2. Confirm the canary evidence and backup receipt.
3. Point MSP to the network endpoint while retaining the compatibility bridge.
4. Observe health, authentication failures, scope denials, latency, error
   codes, and persistence writes.
5. Record the cutover time, source SHA, artifact SHA, endpoint revision, and
   operator decision.

Do not remove the stdio compatibility path or delete old canonical data in the
same change.

## Rollback

Rollback is configuration/artifact reversal, not data deletion:

1. Stop new MSP traffic or restore the previous MSP endpoint configuration.
2. Restore the previously verified runtime artifact.
3. Keep the SQLite file and additive data intact.
4. Run health and read-only scope checks.
5. Record the reason, source/artifact SHA, restored config revision, and
   resulting health status.

If the database cannot be opened or the scope wall is uncertain, keep the
service fail-closed and escalate; do not switch to an in-memory store.

## Evidence record

Every deployment attempt records:

| Field | Value |
|---|---|
| source SHA | exact full commit |
| artifact SHA | immutable build digest |
| config revision | secret/config manager revision, not secret values |
| backup receipt | target and timestamp |
| canary result | `PASS`, `FAIL`, `NOT_RUN`, or `BLOCKED` |
| cutover result | `PASS`, `FAIL`, `NOT_RUN`, or `BLOCKED` |
| rollback result | `PASS`, `FAIL`, `NOT_RUN`, or `BLOCKED` |
| operator decision | owner and timestamp |

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.1.0b | 2026-09-22 | beta | Added private runtime prerequisites, canary, cutover, rollback, and evidence requirements. | working-tree | RWANG |
