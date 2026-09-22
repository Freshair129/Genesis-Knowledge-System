---
version: "0.1.0b"
created_at: "2026-09-22T11:53:35+07:00,RWANG,working-tree"
last_update: "2026-09-22T11:53:35+07:00,RWANG"
status: "beta"
superseded_by: null
attributes:
  domain: "gks-release"
  doc_type: "rca"
  scope: "production runtime contract, package metadata, and deployment surface"
---

# RCA: GKS release-surface drift

## Symptom

After the private HTTP runtime was merged, the repository still had no
reference deployment package, the package lock omitted the new HTTP binary, and
the port contract retained a sentence saying that the production adapter was
unresolved.

## Evidence

- `docs/GKS-PORT-CONTRACT.md` selected GKS-owned SQLite at the production
  profile section while a later legacy paragraph still said no adapter was
  selected.
- `apps/gks-server/package.json` declared `gks-http-server`, while the
  `apps/gks-server` entry in `package-lock.json` listed only `gks-server`.
- The repository had no Dockerfile, Compose target, or other host deployment
  surface for the Node HTTP service.
- PR #13 was merged and all required CI lanes passed, but no production host,
  durable volume, secret manager, or MSP network endpoint existed in this
  checkout.

## Root Cause

The runtime implementation, documentation, and release packaging were changed
in separate slices without a release-surface consistency gate. Existing tests
covered service behavior but not package metadata parity, stale contract prose,
or deployment-target presence.

## Why the issue escaped detection

The CI matrix validated contract, integration, security, unit, and client-pack
behaviour. None of those lanes built a production image or asserted that the
package lock matched executable bins. Documentation review also focused on the
new profile section and did not search for the older unresolved statement.

## Proposed prevention

- Build the reference production image in CI on every release-affecting change.
- Keep package metadata and lockfile changes in the same staged diff.
- Treat the runbook's target-owned evidence fields as explicit gates; missing
  host or MSP evidence remains `NOT_RUN`, never an inferred pass.
- Reconcile contract documents with a targeted stale-phrase search before
  release.

## Fix applied

This change removes the stale contract statement, synchronizes the lockfile,
adds the Docker Compose reference target, and adds a CI container-build lane.
