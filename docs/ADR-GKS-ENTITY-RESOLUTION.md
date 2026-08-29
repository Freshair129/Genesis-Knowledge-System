---
version: "0.2.0b"
created_at: "2026-08-29T15:10:00+07:00,Claude Opus 5,working-tree"
last_update: "2026-08-29T15:40:00+07:00,Claude Opus 5"
status: "beta"
approval_owner: null
approval_recorded_at: null
superseded_by: null
attributes:
  domain: "genesis-knowledge-system"
  doc_type: "architecture-decision"
  scope: "Stage 9 DPS-KI-ENTITY-RESOLVE — canonical entity identity, the resolver seam, the schema split it requires, and what it does to relations"
---

# ADR: Entity Resolution (Stage 9 — `DPS-KI-ENTITY-RESOLVE`)

## Decision status

**Draft for owner review. This document authorizes no implementation,
migration, schema change, port change or release by itself.**

Revision 0.2.0b rewrote four decisions after an independent review found the
diagnosis sound and the prescription weaker than it read. What changed and why
is in the CHANGELOG; the errors are left described rather than quietly deleted,
because two of them are the kind that would have been rediscovered mid-build.

## Context

### What the stage must produce

zuri-ai's FR-109 requires a Stage 9 occurrence to report four things:

> resolution outcome (`MATCHED` / `CREATED` / `AMBIGUOUS` / `REVIEW_REQUIRED` /
> `REJECTED`), strategy used, canonical entity id, confidence against the
> auto-merge policy floor

GKS can produce one of the four today, and that one passes for the wrong
reason: `canonicalMappings[].canonicalRef` (`packages/gks-core/src/index.mjs:67`)
is stable because it is a pure digest, not because anything resolved it.

### What GKS actually does today

`gks_knowledge_promote` computes, at `packages/gks-core/src/index.mjs:31-33`:

```
gks:entity/${slug(candidateRef)}-${sha256(scopeKey \0 candidateRef).slice(0,32)}
```

**The promotion path performs no read of any entity row.** `transactPromotion`
(`packages/gks-persistence/src/index.mjs:103-173`) touches only the idempotency
row (`:104`) and the version counter (`:115`, an `UPDATE … RETURNING`). The two
reads of `entities` (`:214` in `search`, `:217` in `getEntity`) and the one read
of `relations` (`:220` in `getRelations`) are never reached from promotion.
Resolution is read-then-decide by definition, so GKS cannot match a candidate
against prior knowledge **even in principle**.

The consequence follows from the code in both directions, and is silent in both:

- **Over-splits.** `"ACME Corp"`, `"Acme Corp."`, `"acme corporation"` and
  `"ACME_CORP"` in one scope produce four canonical refs for one company.
  Permanently — a digest has no path back.
- **Over-merges, across envelopes.** Two different real companies sharing a
  `candidateRef` collapse into one row: `ON CONFLICT(scope_key, candidate_ref)
  DO UPDATE` (`packages/gks-persistence/src/index.mjs:91`) lets the second write
  overwrite title and summary with no conflict and no audit trail. Within a
  single envelope, conflicting duplicates do throw (`gks-core:51`), so this is a
  cross-envelope failure specifically.

### The ownership inversion

`ADR-GKS-BOUNDARY.md:76` assigns GKS "canonical entities, relations, graph
revision, deduplication, candidate-to-canonical mapping". The implementation
owns the mapping *function* and has delegated the identity *decision* to
whatever string the caller put in `candidateRef`.

`migrations/0001_init.sql:40` makes that concrete: `UNIQUE(scope_key,
candidate_ref)` means **the mention string is the identity**. `entities`
conflates mention and entity. That constraint is the thing Stage 9 has to
change — and, per D1 below, it cannot simply be moved to another table.

### `candidateRef` is neither a stable name nor an unambiguous one

This is the fact both failure directions prove, and it constrains every decision
below. The over-split case shows one entity produces many `candidateRef` values,
so it is not a stable name. The over-merge case shows one `candidateRef` value
can denote different entities, so it is not unambiguous. **Any design that keys
identity on it — in any table — inherits one failure or the other.**

## Decision

### D1 — Mentions are per-occurrence records, not per-string

`entities` keeps canonical identity. A new table holds what a producer asserted
and what was decided about it, **one row per occurrence**:

```
entity_mentions(mention_id PK, scope_key, candidate_ref, provenance_ref,
                promotion_idempotency_key, canonical_ref NULLABLE,
                outcome, strategy, confidence, decided_at)
UNIQUE(scope_key, promotion_idempotency_key, candidate_ref)
```

**`UNIQUE(scope_key, candidate_ref)` does not move to this table.** Revision
0.1.0b proposed exactly that, and it reproduced the defect it was written to fix:
two different companies both asserting `candidateRef "acme"` in one scope would
collide on the constraint and the second would be forced onto the first's
resolution — the same silent merge, one table over. The uniqueness that is true
is *per promotion*: one envelope may assert a given mention string once, which
is what `gks-core:51` already enforces in memory.

`canonical_ref` is nullable because an unresolved mention is a real state
(D3), not a missing value.

**Rejected:** adding `outcome` to `entities`. A row that is both the mention and
the entity has nowhere to record "these two mentions are one entity" — the
statement has no subject.

### D2 — The digest becomes the `CREATED` branch, not the whole function

`canonicalEntityRef` is not deleted. It becomes the fallback taken when nothing
matched:

```
resolveEntity(candidate, scope, lookup) -> { canonicalRef, outcome, strategy, confidence }
```

This keeps every property the digest earned — deterministic, scope-bound,
restart-stable, no coordination — for the one case where it is correct: a
mention nothing matched is a new entity, and its canonical ref may as well be a
function of itself.

`gks-core` stays pure. It **receives** candidate rows through `lookup` and does
not query; the adapter queries. This preserves the layering diamond
(`tests/contract/dependency-boundaries.test.mjs`).

**Accepted consequence — canonical identity becomes ingestion-order-dependent.**
Whichever spelling arrives first becomes the canonical ref, and its slug is baked
in; the same corpus ingested in a different order yields different ids. Today's
digest has no such dependence. This is not a defect of the design but a property
of resolution itself, and it is stated here so it is not discovered later:
per-process restart stability survives, corpus-level reproducibility does not.

**Unresolved consequence — concurrent creation.** Two envelopes carrying
different spellings of one new entity, running concurrently, both find no match
and both take `CREATED`: a timing-dependent over-split. `better-sqlite3`
serializes transactions and hides this; the adapter D8 anticipates will not.
See open question 5.

### D3 — Below the floor, refuse; never merge

A policy floor decides what may merge without a human. Below it the outcome is
`REVIEW_REQUIRED` or `AMBIGUOUS`, `canonical_ref` is null, and the mention is
recorded unresolved.

**A merge is a write and is not recoverable.** An over-split leaves both entities
intact; an over-merge has already overwritten one entity's title with another's.
When the two errors are not symmetric, the floor leans toward the recoverable
one. `GKS-DATA-MODEL.md:171` already lists "autonomous low-confidence promotion"
as a non-goal, and this decision keeps that true.

**This decision is incomplete without D9.** Refusing to merge produces rows
somebody must act on, and nothing in GKS can act on them today.

### D4 — Replay reads the promotion snapshot; mentions are the audit trail

`tests/contract/promotion-contract.test.mjs:39` asserts a replayed promotion
returns exactly what the first returned. That already works and Stage 9 must not
break it: replay returns
`JSON.parse(existing.canonical_mappings_json)` from the promotions row
(`packages/gks-persistence/src/index.mjs:104-113`) — a snapshot frozen at write
time that reads no entity table.

**Evidence therefore rides that snapshot, which gives byte-identity for free.**
Revision 0.1.0b said evidence is "stored on `entity_mentions` and read back on
replay", which would have broken the very test it invoked: a mention's decision
can legitimately change later — a subsequent envelope, or a human resolving a
review — so a replay reading the mention table would return different evidence
than the first call.

`entity_mentions` is the audit trail and the review queue. The promotion
snapshot is what a replay returns. They are allowed to diverge, and the
divergence is the record that something was re-decided.

### D5 — The blocking lookup is scope-filtered inside the adapter

`persistence.search` filters on `portfolio_id` only
(`packages/gks-persistence/src/index.mjs:214`); tenant filtering happens
afterwards in core via `visible()` (`packages/gks-core/src/index.mjs:93`). That
is safe today because the one consumer applies it.

**A resolver must not reuse it.** The Stage 9 lookup is a separate port
operation that filters every scope dimension **in SQL**, because the failure
mode is not a read leak a later filter fix repairs — it is a cross-tenant merge,
and the write has already happened. `GKS-DATA-MODEL.md:156` forbids it
explicitly.

Three hazards it must survive:

- `visible()` (`gks-core:23-29`) checks only the dimensions the *record*
  populates, so a record with an empty `tenantId` is visible to every tenant in
  the portfolio. `tenantId` is `optionalString` in **every** scope
  (`validation.mjs:32`), not only on the legacy `GKS_DEFAULT_PORTFOLIO_ID` path
  (`validation.mjs:46-57`) — so any promotion omitting it creates such a record.
  The pool is larger than a legacy-path-only reading suggests.
- `visible()` ignores `sharing` entirely, so "portfolio-shared" has no runtime
  meaning today. Whatever pool the lookup draws from, it cannot inherit a
  distinction the code does not make.
- `tests/security/cross-tenant-deny.security.mjs` covers reads, not merges. It
  gains a case: *a candidate in tenant B must never resolve to a canonical
  entity from tenant A, including a tenant-less one.*

### D6 — The `DPS-KI-*` id travels as a string, in its own field

`stage` is an integer capped 1–12
(`packages/gks-contracts/src/tool-definitions.mjs:12`,
`packages/gks-contracts/src/validation.mjs:82`) and means *GoVibe Deep Scan
stage* (`GKS-INTEGRATION-FLOW.md:71,144-145,172`).

Overloading it would make Stage 17 inexpressible and would silently alias
DPS-KI stage 9 onto Deep Scan stage 9 — two vocabularies sharing one numeric
range with no error at the boundary. The pipeline stage id is carried as
`"DPS-KI-ENTITY-RESOLVE"` in a new, additive field.

### D7 — Evidence rides the existing promote response; no new *promotion* tool

Per-entity evidence is an additive field on `canonical_mappings`, which already
exists as the per-entity channel (`packages/gks-core/src/index.mjs:67`).

**Rejected:** a `gks_resolve` tool. It would hand a caller resolution authority
*without* promotion — a new governance surface MSP has no story for, on the one
system whose job is being the single canonical authority.

This rejection is about **resolution-without-promotion**, not about the tool
registry being closed forever. D9 adds a tool and is consistent with it.

### D8 — The persistence port breaks, and the break is taken openly

Adding a required operation to `PERSISTENCE_OPERATIONS`
(`packages/gks-contracts/src/validation.mjs:8`) fails
`tests/contract/persistence-port-conformance.test.mjs:9-21`, which asserts a
7-op adapter is accepted. Per `GKS-PORT-CONTRACT.md:149-155` that suite runs
against every future adapter, so this breaks every adapter that will ever exist.

**Rejected:** making the lookup optional so the contract holds. An adapter
without lookup would fall back to digest-only — precisely the defect being
fixed, reintroduced as a supported configuration and named "degraded".

**The documented port is already stale** and gets corrected in the same change:
`GKS-PORT-CONTRACT.md` lists six operations including `linkArtifact`, while the
code has seven including `transactArtifactLink`. The version increments from
what the code actually is, not from what the document claims.

### D9 — An unresolved mention has a consumer, or D3 is a dead end

D3 produces `REVIEW_REQUIRED` and `AMBIGUOUS` rows. Nothing in GKS can read
them, and D2 calls an over-split "fixable later" by a mechanism that does not
exist. Left there, D3 and D7 jointly describe a system that can only refuse.

So Stage 9 ships with a minimum consumption path:

- a read tool listing unresolved mentions within scope, and
- one write operation applying a human decision: bind a mention to an existing
  canonical entity, or merge two canonical entities and record the supersession.

**Merging two canonical entities is the operation that repairs an over-split,
and it is the single most dangerous write in this system** — it is the
unrecoverable direction D3 exists to avoid, performed deliberately. It is
therefore explicitly a human-authorized operation carrying its own provenance,
never a strategy the resolver may invoke, and never available below the floor.

Whether this belongs in Stage 9's scope or is a separate, sequenced piece of
work is **open question 6** — but it cannot be silently absent, because D3's
safety depends on it existing.

### D10 — Relations follow entity identity, and the transaction shape changes

Relations were absent from revision 0.1.0b. They are half the graph and they
break first.

- A relation's canonical ref is a digest of the **entity canonical refs**
  (`gks-core:64`), and `relations` is `UNIQUE(scope_key, from_ref,
  relation_type, to_ref)`. The moment a mention resolves to a matched entity
  instead of its own digest, the same semantic relation acquires a different
  canonical ref than its pre-resolution twin. Existing relations pointing at an
  over-split digest ref do not follow automatically.
- `gks-core:59` throws when a relation endpoint is not in the envelope's ref
  map. Under D3 an endpoint may resolve to **no** canonical ref, and today that
  is an envelope-wide abort — `transactPromotion` is one atomic transaction.

Two consequences, both decided here rather than discovered:

1. **A relation whose endpoint is unresolved is recorded as pending, not
   thrown.** The envelope's entities still promote; the relation is held with
   its mention endpoints and materializes when the endpoint resolves. Aborting
   the whole envelope because one mention was ambiguous would make D3's safe
   refusal more destructive than an unsafe merge.
2. **The entity merge in D9 carries relation re-pointing with it**, in the same
   transaction. A merge that repairs entity identity and leaves relations
   pointing at the superseded ref creates a second, quieter inconsistency.

The migration question for relations already written against digest refs is
part of open question 4.

## Open questions — must be settled before implementation

1. **Which strategies, in what order?** The specification's §14 lists nine;
   FR-109 requires only that the strategy used be *reported*, deliberately
   leaving the ladder to the executing tier. That makes it GKS's decision and it
   is not made here.
2. **What is the floor, numerically, and who sets it?** Per scope or global?
   `confidence` is `Number(input.confidence)` with no validation
   (`validation.mjs:100,113`), so NaN and out-of-range values reach a REAL
   column. A floor compared against an unvalidated number is a floor with a hole
   in it — validation is a prerequisite, not a follow-up.
3. **`validation.mjs:60` rejects every `gks:`-prefixed string at any depth of
   the candidate (`:86`), including inside free text, while
   `GKS-PORT-CONTRACT.md:105-107` permits a caller-supplied canonical ref "being
   resolved".** A `MATCHED` outcome referencing an existing entity is currently
   inexpressible. Settle before Stage 9, not during it.
4. **Do existing rows migrate, or start clean?** Every current canonical ref is
   a digest of a mention, and `gks_artifact_link` rows and `relations` already
   point at them. Re-resolving retroactively changes ids those rows depend on.
5. **What serializes concurrent creation?** Two envelopes creating the same new
   entity concurrently both take `CREATED` (D2). Today's adapter hides it; the
   next one will not.
6. **Is D9 in Stage 9's scope, or sequenced after it?** Either answer is
   workable; leaving it unasked is not, because D3's safety assumes D9 exists.
7. **What does a `MATCHED` mention write to the matched entity?** If nothing,
   titles can never be enriched or corrected. If something, the silent-overwrite
   defect returns through the matched path with cross-mention reach. This is the
   same class of decision the ADR exists to make and it is genuinely open.
8. **Which pool does the lookup draw from?** Exact `scope_key` equality means a
   project-scoped mention can never match tenant-level knowledge — a permanent
   over-split by scope. Hierarchical matching reintroduces the empty-dimension
   hazard D5 warns about. The `entity_mentions` sketch also carries `scope_key`
   but not the discrete scope columns D5's SQL filtering would need.

## Alternatives rejected

1. **Add `outcome` and `strategy` to the promote response and call Stage 9
   done.** Named here because it is the version that will keep being proposed:
   it ships in a day and moves a tracked count from 8/17 to 9/17. The fields
   would be computed by a function that never reads existing state, so `CREATED`
   would be the answer every time except on envelope replay. **Evidence that
   looks real and means nothing is worse than no evidence** — the count would be
   believed, and the four fields would make it look verified.
2. **Resolve inside `gks-persistence`.** Puts a domain decision in the adapter;
   every future adapter reimplements it identically or diverges silently.
3. **Let the caller send a resolved canonical ref.** The current defect
   restated. Identity is the thing GKS exists to own.
4. **Fuzzy matching with no floor and no review outcome.** Converts a visible
   over-split into a silent over-merge — trading a recoverable error for an
   unrecoverable one.
5. **Keep `UNIQUE(scope_key, candidate_ref)` by moving it to the mention
   table** (revision 0.1.0b's D1). Rejected on review: it reproduces the
   over-merge it was written to fix, and makes acceptance criterion 2
   unsatisfiable.

## Change classification

- Complexity: `C-4`
- Risk: `HIGH`
- Primary risks: cross-tenant merge (unrecoverable), retroactive canonical-id
  change stranding existing `relations` and `gks_artifact_link` rows,
  concurrent-creation over-split under a non-serializing adapter, and
  port-contract breakage across every adapter.

## Acceptance criteria

Written to be failable. An implementation that normalizes exactly the four ACME
spellings and does nothing else must **not** pass this list.

- The four over-split spellings resolve to **one** canonical entity, **and** the
  two same-`candidateRef` different companies do **not** merge — the second is
  recorded as its own mention with its own outcome, not forced onto the first.
- **The floor is exercised.** A candidate scoring below it yields
  `REVIEW_REQUIRED` or `AMBIGUOUS`, writes no canonical binding, and does not
  modify the near-match entity. Without this the ADR's central safety decision
  is untested.
- `AMBIGUOUS` and `REJECTED` are each produced by at least one real input. An
  outcome vocabulary with unreachable values is a vocabulary that lies.
- Confidence validation rejects NaN, Infinity and out-of-range before any
  comparison to the floor.
- **Relations survive**: an envelope whose relation endpoint resolves
  `REVIEW_REQUIRED` still promotes its entities, records the relation pending,
  and materializes it when the endpoint resolves — no envelope-wide abort.
- A replayed promotion returns byte-identical evidence
  (`promotion-contract.test.mjs:39`), from the promotion snapshot, **after** a
  later envelope has changed the underlying mention's decision.
- A candidate in tenant B never resolves to an entity in tenant A, including a
  tenant-less one — asserted in `cross-tenant-deny.security.mjs`.
- `stage` keeps meaning Deep Scan stage; the pipeline id travels separately.
- API-010 promotion fixtures pass unchanged.
- `msp-provider-compatibility` and `msp-service-chain` run **with
  `MSP_REPO_ROOT` set** and pass. The promote response is exactly what MSP
  consumes; a green run without that variable proves nothing here.

Criterion 1 pre-commits to an outcome that only some strategies deliver, while
open question 1 defers the strategy choice. That is deliberate: the criterion is
the requirement, and a ladder that cannot meet it is not a candidate ladder.

## Approval gate

Implementation starts only after the owner accepts this ADR **and** the eight
open questions have answers. The schema split, the floor, the port break and
D9's scope are each owner decisions, not implementation details.

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.2.0b | 2026-08-29 | draft | Rewrote four decisions after independent review. D1 no longer moves `UNIQUE(scope_key, candidate_ref)` to the mention table — that reproduced the over-merge it was written to fix; mentions are per-occurrence. D4 corrected: replay reads the promotion snapshot (`canonical_mappings_json`), not the mention table, which would have broken the equality test it cited. Added D9 (unresolved mentions need a consumer, or D3 is a dead end) and D10 (relations follow entity identity; an unresolved endpoint no longer aborts the envelope) — relations were absent entirely. Acceptance criteria rewritten to be failable; open questions 5-8 added. Errata: one read-count named the wrong table, two doc line numbers were wrong, the tenant-less record pool was understated, and the port doc was already stale. | working-tree | Claude Opus 5 |
| 0.1.0b | 2026-08-29 | draft | Proposed Stage 9 as a schema split plus a resolver seam with a policy floor, after a full-runtime review found promotion never reads entity rows and the canonical ref is a digest of the caller's mention string — failing in both the over-split and silent over-merge directions. | working-tree | Claude Opus 5 |
