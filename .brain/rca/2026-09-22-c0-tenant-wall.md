# RCA — C0 tenant-wall visibility mismatch

## Symptom

The service-level visibility predicate could treat a stored empty `tenantId`
as broader than a request with a non-empty tenant. That was inconsistent with
the persistence resolver/evidence predicates, which treat the empty tenant as
its own scope pool.

## Evidence

- Before the change, `packages/gks-core/src/index.mjs` checked optional scope
  dimensions only when the stored value was truthy, so an empty stored tenant
  did not reject a non-empty request tenant.
- The existing SQL resolution and evidence paths already applied exact tenant
  predicates, creating two different scope decisions in one read path.
- New regression test `tests/security/c0-tenant-wall.security.mjs` passes for
  tenantless isolation while preserving business/workspace/project sharing.
- The complete security suite passes `11/11`; the full contract/integration
  suite passes `203` tests with `2` pre-existing skipped tests.

## Root Cause

The scope rule was implemented twice with different semantics: persistence
treated an empty tenant as a concrete namespace, while `visible()` treated an
empty stored dimension as an implicit wildcard. No shared normalized tenant
predicate or service-level regression case forced the two layers to agree.

## Why the issue escaped detection

Existing cross-tenant tests exercised foreign non-empty tenants and the SQL
resolution/evidence wall, but did not exercise a tenantless row returned to a
non-empty tenant at the service visibility boundary. The repository therefore
proved the database predicate and missed the later in-memory broadening.

## Proposed prevention

1. Normalize missing `tenantId` to `""` and require exact equality in every
   service visibility check.
2. Keep the SQL scope predicate and service predicate covered by the same
   tenantless/tenant/cross-tenant security matrix.
3. Retain the C0 golden registry cases for tenant wall and denial outcomes.
4. Treat a future scope-policy change as a versioned ADR, not as a truthy-value
   convenience in one layer.
