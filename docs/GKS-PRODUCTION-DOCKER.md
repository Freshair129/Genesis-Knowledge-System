---
version: "0.1.0b"
created_at: "2026-09-22T11:53:35+07:00,RWANG,working-tree"
last_update: "2026-09-22T11:53:35+07:00,RWANG"
status: "beta"
superseded_by: null
attributes:
  domain: "gks-production-runtime"
  doc_type: "deployment-target"
  scope: "private Docker Compose target for GKS HTTP runtime"
---

# GKS production Docker target

This is the reference packaging target for the approved private HTTP runtime.
It assumes a private Linux host with Docker Compose, a durable volume, and a
secret manager or protected filesystem that supplies the two relay credential
files. It does not make the host, registry, reverse proxy, MSP route, or secret
manager part of this repository.

## Build and inspect

Build from the exact source SHA that is being released:

```text
docker build --file deploy/docker/Dockerfile --tag <registry>/<image>:<source-sha> .
docker compose --file deploy/docker/compose.production.yml config
```

The image runs as the `node` user, stores SQLite under `/var/lib/gks`, keeps the
application filesystem read-only, and reads credentials from Docker secrets.
The service is bound to loopback on the host; a private reverse proxy or MSP
network route must be the only governed caller path.

## Required host inputs

Set `GKS_MSP_RELAY_CREDENTIAL_FILE` and
`GKS_PIPELINE_RELAY_CREDENTIAL_FILE` to protected host file paths. Do not put
credential values in the repository, compose file, command line, image, or
logs. Set `GKS_IMAGE` to the immutable image tag when deploying a registry
artifact; the local default is for a canary only.

## Canary and rollback

```text
docker compose --file deploy/docker/compose.production.yml up --detach
curl --fail http://127.0.0.1:${GKS_HTTP_PUBLISHED_PORT:-8787}/healthz
docker compose --file deploy/docker/compose.production.yml ps
```

The canary must also run MSP authentication, scope-deny, restart, idempotency,
backup/restore, and bounded-overload checks before traffic is changed. Rollback
pins `GKS_IMAGE` to the retained previous immutable image, restores the prior
MSP route/configuration, and leaves the canonical SQLite volume intact.

## Evidence boundary

Successful image build and local health are deployment-package evidence. They
do not prove a production host, durable backup, MSP network conformance,
rollback rehearsal, or production cutover. Those fields remain `NOT_RUN` until
the target owner records them in [GKS-PRODUCTION-RUNBOOK.md](GKS-PRODUCTION-RUNBOOK.md).

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.1.0b | 2026-09-22 | beta | Added the reference private Docker Compose target for the GKS HTTP runtime. | working-tree | RWANG |
