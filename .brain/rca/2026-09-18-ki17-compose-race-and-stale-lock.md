---
version: "1.0.0"
created_at: "2026-09-18T02:00:00+07:00"
last_update: "2026-09-18T02:00:00+07:00"
status: "active"
superseded_by: null
attributes:
  domain: "genesisrag17"
  doc_type: "rca"
  scope: "production-runtime"
---

# RCA: concurrent Compose replacement and stale worker lock

## Symptom

The approved GenesisRAG17 worker entered a restart loop during activation. A
second Compose invocation had also replaced the web container with an older
release image.

## Evidence

- The web container was observed on `release-f9d315d8` instead of the approved
  `release-ki17-0c7fd884` image.
- The worker first reported a missing shared web namespace, then reported
  `WORKER_STORE_ALREADY_OWNED:1` after the approved stack was restored.
- The only active container mounting `zuri-ai_ki17-genesis-store` was the
  Genesis worker.
- The lock contained PID `1`, which was the PID reused by the newly created
  container. The lock was removed only after the worker was stopped and the
  stale owner was proven.
- After targeted lock removal, the approved worker became healthy with restart
  count `0`; the relay smoke passed.

## Root cause

Two Compose operations raced on the same live project. Container PID reuse made
the worker's old lock appear live even though its original owner no longer
existed.

## Why detection escaped

The deployment procedure did not hold an exclusive Compose-project lock and did
not require an image/namespace acknowledgment after every recreate. The worker
lock correctly fails closed, but it cannot distinguish a reused PID without an
operator recovery check.

## Prevention

Use one primary checkout and one fixed Compose project/overlay for the complete
activation. Add a preflight acknowledgment that records web and worker image
digests, then recreate dependent services together. If a worker lock failure
occurs, stop the sole store owner, verify the mounted-container inventory, and
remove only the proven stale worker lock. Preserve all data volumes.

## Changelog

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 1.0.0 | 2026-09-18 | active | Documented concurrent Compose race and stale lock recovery | pending | RWANG |
