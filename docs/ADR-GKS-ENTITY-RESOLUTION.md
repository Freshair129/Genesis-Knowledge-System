---
version: "0.3.0b"
created_at: "2026-08-29T15:10:00+07:00,Claude Opus 5,working-tree"
last_update: "2026-08-29T16:10:00+07:00,Claude Opus 5"
status: "beta"
approval_owner: "Boss (บอส) — delegated the eight open questions to Claude Fable 5"
approval_recorded_at: "2026-08-29T16:10:00+07:00"
superseded_by: null
attributes:
  domain: "genesis-knowledge-system"
  doc_type: "architecture-decision"
  scope: "Stage 9 DPS-KI-ENTITY-RESOLVE — canonical entity identity, the resolver seam, the schema split it requires, and what it does to relations"
---

# ADR: Entity Resolution (Stage 9 — `DPS-KI-ENTITY-RESOLVE`)

## Decision status

**All eight open questions are decided (§ The eight decisions). The approval
gate is open; the three recording steps in that section come before any code.**

The path here matters, because it is what the decisions rest on. Revision
0.1.0b was drafted from a full-runtime review. An independent review at 0.2.0b
found the diagnosis sound and the prescription weaker than it read, and four
decisions were rewritten — including one that reproduced the exact defect it was
written to fix. At 0.3.0b the owner delegated the eight remaining questions to
that same independent reviewer, which decided all eight and amended D1, D2 and
D5 in doing so.

Errors from earlier revisions are described rather than quietly deleted. Two of
them were the kind that would otherwise have been rediscovered mid-build.

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
entity_mentions(mention_id PK, scope_key,
                portfolio_id, tenant_id, business_id, workspace_id,
                project_id, sharing,
                candidate_ref, norm_key, provenance_ref,
                promotion_idempotency_key, canonical_ref NULLABLE,
                outcome, strategy, confidence, decided_at)
UNIQUE(scope_key, promotion_idempotency_key, candidate_ref)
```

**The six discrete scope columns are not redundant with `scope_key`** (amended
by decision 8). `scopeKey` is an opaque `\u0000`-join of those six values
(`packages/gks-contracts/src/validation.mjs:42-44`), so it can express equality
and nothing else. The ancestor-scope predicate the lookup needs
(`dim = '' OR dim = ?`) and D9's scoped review listing are both SQL over
individual dimensions, and neither can be written against the join.

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

**Concurrent creation is closed by a uniqueness constraint, not by convention**
(amended by decision 5). `entities` gains `norm_key` and `norm_version` with
`UNIQUE(scope_key, norm_key)`. The `CREATED` branch inserts under that
constraint; on conflict it re-reads and returns **`MATCHED`** against the
winner, so the race becomes a deterministic merge rather than a timing-dependent
over-split.

Serialization by adapter convention was rejected for the same reason D8 rejects
an optional lookup: it is an unenforced guarantee. A uniqueness constraint is
enforced natively by every adapter that will ever exist, and it doubles as the
index the `DETERMINISTIC` rung needs.

Two guards on it: a human ruling that two same-named entities are genuinely
distinct discriminates the second's `norm_key` (`norm_key + '#' + mention_id`),
so it stays insertable but reachable only by the canonical-ref, external-ref and
alias rungs; and `norm_version` pins the normalizer, so changing normalization
rules is a versioned event rather than a silent re-key of everything.

The residual race — two *fuzzy-level* different spellings creating concurrently
— stays an over-split. That is the recoverable direction, repairable through D9.

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

**The pool rule** (amended by decision 8). For a mention in scope
`(P, T, B, W, Proj)` the lookup returns entities where:

- `portfolio_id = P`, and
- **`tenant_id = T` by exact equality — an empty `tenant_id` matches only an
  empty-tenant mention, never "any tenant"**, and
- for each of business, workspace and project: `entity.dim = '' OR
  entity.dim = mention.dim` — an entity at the same or a broader scope, never a
  narrower one.

`sharing` is not a pooling dimension, because it grants nothing today —
`visible()` ignores it entirely, and the pool cannot inherit a distinction the
code does not make.

The tenant rule is the direct answer to the `visible()` hazard above: treating
`tenant_id = ''` as **a tenant of its own** rather than a wildcard means a
tenant-less entity can never be matched by a tenanted mention or the reverse,
and it holds by SQL equality rather than by a filter applied afterwards. Below
tenant, empty-dimension breadth *is* the wanted ancestor semantics, so it is
permitted there and only there.

Downward matching is excluded deliberately: a tenant-level mention merging into
some project's private entity would pull narrow knowledge up past its scope.

**Cost, stated rather than discovered:** tenant-less and tenanted knowledge
never converge automatically, even when they name the same real entity. Only a
D9 merge joins them. The alternative is a cross-tenant merge — the one
unrecoverable failure this ADR ranks first.

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

Whether this belongs in Stage 9's scope was open question 6. **Decided: it is
inside Stage 9, sequenced last within it** — two acceptance criteria are
untestable without it, so a resolver-without-D9 build cannot pass its own gate.

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

Relations already written against digest refs were open question 4. **Decided:
nothing happens to them at migration time, because no canonical ref is ever
rewritten** — pre-existing over-splits converge only through a D9 merge, which
re-points relations in the same transaction.

## The eight decisions

The owner delegated these to an independent reviewer, which had already found
four defects in revision 0.1.0b and therefore knew the code. Each decision below
is binding; three of them amended D1, D2 and D5 above, marked there.

### 1 — The ladder

`CANONICAL_REF → EXTERNAL_REF → EXACT → ALIAS → DETERMINISTIC → FUZZY
(detect-only) → CREATED`. First decisive rung wins.

| Rung | Behavior | Confidence |
|---|---|---|
| `CANONICAL_REF` | `resolveTo` names an existing entity in the pool → MATCHED; nonexistent or out-of-pool → **REJECTED** | 1.0 |
| `EXTERNAL_REF` | candidate external refs intersect an entity's, same type | 0.98 |
| `EXACT` | normalized `candidateRef` equals a prior resolved mention's, compatible type | 0.95 |
| `ALIAS` | matches an alias recorded by a prior D9 human bind | 0.92 |
| `DETERMINISTIC` | normalization plus a versioned rule table (corporate suffixes including Thai บริษัท / จำกัด, articles, underscore→space) yields an existing `norm_key` | 0.88 |
| `FUZZY` | **detect-only, ceiling 0.84 — structurally below the floor.** One near match → REVIEW_REQUIRED, several → AMBIGUOUS. Can never produce MATCHED | ≤ 0.84 |
| `CREATED` | D2's digest fallback | 1.0 |

**A contradiction check overlays every rung except `CANONICAL_REF`**: a
string-level match whose stored title materially conflicts with the incoming
title drops to 0.60 and becomes REVIEW_REQUIRED. This is what makes acceptance
criterion 1 satisfiable at all — no string ladder can separate two companies
both literally named `"acme"`, so the discriminating evidence has to be the
conflicting titles. Today that evidence is destroyed by
`ON CONFLICT ... DO UPDATE` (`packages/gks-persistence/src/index.mjs:91`); the
contradiction check is where it gets used instead. Two mentions byte-identical
in every attribute merge, correctly, on the only evidence available.

**Omitted, each a decision:**

- **`EMBEDDING`** — GKS has no vector infrastructure and `GKS-DATA-MODEL.md`
  excludes an embedding schema from the public model. Including it would smuggle
  a second ADR-sized decision (vector store selection) inside this one. FUZZY's
  detect-only role covers the recall gap by routing near misses to review rather
  than losing them.
- **`LLM_ASSISTED`** — a model call inside `transactPromotion`'s atomic
  transaction makes the canonical authority nondeterministic and
  latency-unbounded, and `ADR-GKS-BOUNDARY.md` puts model governance with MSP,
  not GKS. If wanted later it lives *outside* promotion, proposing D9 binds
  asynchronously — which needs no new decision, only D9.
- **`HUMAN`** — not a resolver rung. A D9 bind records `strategy = "HUMAN"` on
  the mention, so the ninth strategy is reported without being executed here.

**Cost:** recall is deliberately lower than a fuzzy-merging resolver, and there
will be more REVIEW_REQUIRED rows early. That is D3's asymmetry, priced in.

### 2 — The floor is 0.85, global, deployment-set; confidence is validated

`confidence >= floor` merges. Default in `gks-core`, overridable only by
deployment config (`GKS_AUTOMERGE_FLOOR`), set by the owner. No per-scope floor
in v1.

0.85 is **structural, not tuned**: it sits so `DETERMINISTIC` (0.88) may
auto-merge — required, or the four ACME spellings never converge — and `FUZZY`
(capped 0.84) never can. With fixed per-rung confidences the floor's only real
freedom is *which rungs may merge*, and that framing survives re-tuning.

Per-scope floors would need a policy store GKS does not have, and
`ADR-GKS-BOUNDARY.md` puts policy surfaces with MSP. A per-tenant floor, if ever
wanted, arrives as MSP-supplied evidence under a different ADR.

**Confidence validation is part of this decision, not a follow-up.** It becomes
a finite number in `[0, 1]` or `gks_invalid_request`, replacing bare
`Number(input.confidence)` (`packages/gks-contracts/src/validation.mjs:100,113`).
Today `NaN >= 0.85` is `false`, so a NaN lands silently on the no-merge path
*and* in a REAL column — wrong twice. Callers sending junk now fail closed, and
they should.

### 3 — The code changes, not the contract: one named escape hatch

`rejectCanonicalAssignments` (`validation.mjs:59-70`, applied at `:86`) gains
exactly one exemption: the key `resolveTo` on a candidate **entity**, whose value
must match `^gks:entity/[a-z0-9-]+-[a-f0-9]{32}$`. Every other `gks:`-prefixed
string at any depth stays rejected, and `GKS-PORT-CONTRACT.md:105-107` stands
unchanged.

The contract's rule was right and the code merely made it inexpressible.
Widening the blanket rejection instead would reopen the forged-identity surface
the guard exists for — pinned by
`tests/contract/promotion-contract.test.mjs:51-56`
(`promotion_callerAssignedCanonicalIdentity_failsClosed`), which stays green
because `CANONICAL_KEYS` (`validation.mjs:7,67`) is untouched.

A dedicated field keeps intent unambiguous: **`resolveTo` is a claim to be
verified, never trusted.** The `CANONICAL_REF` rung checks existence and pool
membership including the tenant wall; failure yields `REJECTED`, null
`canonical_ref`, no entity created, and its relations pending per D10. This is
what makes `REJECTED` reachable by a real input.

**Cost:** legitimate free text beginning with `gks:` is still rejected.
Accepted — that string is this system's reserved namespace.

### 4 — Migrate in place, backfill mentions, never rewrite a ref

The migration adds the new tables and backfills **one `CREATED` mention per
existing entity** (`strategy = "BACKFILL"`, `confidence` NULL,
`decided_at = entities.created_at`). No canonical ref changes retroactively, so
nothing happens to `relations` or `artifact_links` at migration time.

Both alternatives fail. Re-resolving retroactively changes ids that `relations`
(`from_ref` / `to_ref`), `artifact_links.knowledge_ref` — which holds **entity**
refs, since `linkArtifact` resolves it through `getEntity`
(`packages/gks-core/src/index.mjs:120-121`) — and MSP-side receipts already
depend on, and there is no reverse index from a digest ref to its replacement.
Start-clean is *feasible* today (every known deployment is a dev SQLite,
`docs/MIGRATION.md:23`), but writing "wipe on upgrade" into the migration story
sets a precedent the first real deployment regrets.

**The rule going forward is absolute: a canonical ref, once minted, changes only
via a D9 merge with supersession recorded.** So "what happens to refs that
change" has a one-word answer — none.

**Cost:** dev databases carry their historical over-splits until someone
D9-merges them. They are dev databases, and the repair tool is in scope.

### 5 — `norm_key` uniqueness plus conflict-retry-to-MATCHED

Recorded in D2 above. The port contract additionally requires
`transactPromotion` to run where unique-constraint checks are atomic — every
serious database provides this, and no adapter-level global lock is needed.

**Cost:** the normalizer becomes frozen infrastructure. Changing the rule table
requires a version bump and affects only new resolutions; "just tweak the suffix
list" stops being a casual edit.

### 6 — D9 is inside Stage 9's scope, sequenced last within it

Both D9 pieces ship before Stage 9 counts as delivered.

Two of this ADR's own acceptance criteria are untestable without it. Criterion 5
requires a pending relation to materialize when its endpoint resolves, and the
only mechanism by which an unresolved endpoint later resolves **is** a D9 bind —
so a resolver-without-D9 build cannot pass its own gate. Decision 4 then leaves
backfilled over-splits whose sole repair path is a D9 merge. Sequencing D9 after
Stage 9 would ship the refusal half of a safety valve with no repair half: the
"system that can only refuse" this ADR warned D3 and D7 would jointly describe.

D7 is not violated. D9's write is human-authorized repair carrying its own
provenance, not caller resolution-without-promotion.

**Cost:** Stage 9 is a larger unit of delivery and the tracked count moves
later. That is the count being honest.

### 7 — `MATCHED` writes are additive only

A matched mention writes: its own mention row; its normalized form as an alias if
new; the union of external refs; and a fill of an **empty** entity field (empty
`summary`, null `source_ref`) with a graph-version bump.

For a **conflicting non-empty** field it writes nothing to the entity. The
field-level diff is recorded on the mention, where D9's review tool surfaces it
as a proposed edit for a human to apply.

`ON CONFLICT ... DO UPDATE SET title = excluded.title, summary = excluded.summary`
(`packages/gks-persistence/src/index.mjs:88-92`) is deleted, replaced by
insert-plus-explicit-fill.

The asymmetry governing D3 governs here too: an un-applied enrichment sits in a
queue and is recoverable; an applied overwrite is not. Automatic overwrite
through the matched path would recreate the proven defect with *worse* reach —
one careless envelope re-titling an entity that fifty prior mentions converge
on. The aliases and external refs accumulated here are also what let the ALIAS
and EXTERNAL_REF rungs improve over time with no fuzzy risk.

**Cost:** a typo in the first-arriving title persists until a human accepts the
correction. Deliberate — title correctness is curated, not last-writer-wins.

### 8 — The pool: tenant hard wall, ancestors below it

Recorded in D5 above, together with the discrete scope columns it forces onto
`entity_mentions` (D1).

## What must be recorded before code

1. **This revision is that record.** The owner's delegated acceptance of these
   eight answers is the gate opening.
2. ~~Bump `GKS-PORT-CONTRACT.md`~~ — **done 2026-08-29** (that document, revision
   0.3.0b). It now records port version 2 with `lookupResolutionCandidates` and
   the atomic unique-check requirement from decision 5, and corrects the
   already-stale port version 1: the document had listed six operations with
   `linkArtifact`, while `PERSISTENCE_OPERATIONS` (`validation.mjs:8`) has
   enforced seven with `transactArtifactLink` and `close` since implementation.
3. ~~Author the `norm_v1` rule table~~ — **done 2026-08-29**
   ([NORM-V1-RULE-TABLE.md](NORM-V1-RULE-TABLE.md), version 1.0.0). It is
   load-bearing for both the `DETERMINISTIC` rung and decision 5's constraint,
   which is why it could not be an implementation-time ad-hoc list: decision 5
   **stores** its output under `UNIQUE(scope_key, norm_key)`, so the rules can
   never be edited in place, only superseded by a `norm_v2`.

   Two choices in it are worth reading before the resolver is written. Only
   legal-form scaffolding and leading articles are removed — `"group"`,
   `"holdings"` and their Thai equivalents stay, because folding them would be
   an over-merge performed by the normalizer, beneath the floor and beneath
   review. And an empty result falls back to the un-stripped form, because
   `"The Company"` otherwise normalizes to nothing and every such entity merges
   into one under the unique constraint.

**Build order:** schema migration + backfill → confidence validation +
`resolveTo` → lookup port op + pool SQL → resolver ladder → pending relations
(D10) → D9 read tool → D9 bind/merge with relation re-pointing → the
acceptance-criteria suite, including the tenant-less cross-tenant-merge denial.


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

Criterion 1 was written before the ladder was chosen, and pre-committed to an
outcome only some strategies deliver — deliberately, because the criterion is
the requirement and a ladder that cannot meet it is not a candidate ladder. The
ladder decision 1 chose does meet it: `DETERMINISTIC` (0.88) clears the 0.85
floor and converges the four spellings, while the contradiction check keeps the
two same-named companies apart. The criterion did its job as a constraint on the
choice rather than a description of it.

## Approval gate

**Open.** The owner delegated the eight questions to an independent reviewer on
2026-08-29 and accepted its answers; they are recorded above and are binding.
The schema split, the floor, the port break and D9's scope were the owner
decisions this gate existed to collect, and all four are made.

What still precedes the first line of resolver code is not approval but the
three recording steps in *What must be recorded before code* — most importantly
the `norm_v1` rule table, which two separate decisions now depend on and which
must not be improvised during implementation.

A decision here is revisable, but only the way it was made: by amending this
document with a reason, never by an implementation quietly doing something else.

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.3.0b | 2026-08-29 | accepted | Owner delegated the eight open questions to an independent reviewer, which decided all eight; the gate is open. The ladder is six rungs with FUZZY capped structurally below a 0.85 floor so it can never auto-merge, plus a contradiction check that is what makes the two-companies-named-acme criterion satisfiable at all. `resolveTo` becomes a single named, shape-validated exemption to the `gks:` rejection — the code moves to the contract, not the reverse. Rows migrate in place with backfilled mentions and **no canonical ref is ever rewritten**; concurrent creation is closed by `UNIQUE(scope_key, norm_key)` with conflict-retry-to-MATCHED rather than by adapter convention. `MATCHED` writes are additive only, conflicting fields proposed for human review instead of overwritten. The lookup pool treats an empty `tenant_id` as a tenant of its own rather than a wildcard, which is what makes the tenant wall hold in SQL rather than in a later filter. D9 is inside Stage 9's scope, because two acceptance criteria are untestable without it. Amends D1 (discrete scope columns, `norm_key`), D2 (uniqueness constraint) and D5 (the pool rule). | working-tree | Claude Fable 5 (decisions) · Claude Opus 5 (record) |
| 0.2.0b | 2026-08-29 | draft | Rewrote four decisions after independent review. D1 no longer moves `UNIQUE(scope_key, candidate_ref)` to the mention table — that reproduced the over-merge it was written to fix; mentions are per-occurrence. D4 corrected: replay reads the promotion snapshot (`canonical_mappings_json`), not the mention table, which would have broken the equality test it cited. Added D9 (unresolved mentions need a consumer, or D3 is a dead end) and D10 (relations follow entity identity; an unresolved endpoint no longer aborts the envelope) — relations were absent entirely. Acceptance criteria rewritten to be failable; open questions 5-8 added. Errata: one read-count named the wrong table, two doc line numbers were wrong, the tenant-less record pool was understated, and the port doc was already stale. | working-tree | Claude Opus 5 |
| 0.1.0b | 2026-08-29 | draft | Proposed Stage 9 as a schema split plus a resolver seam with a policy floor, after a full-runtime review found promotion never reads entity rows and the canonical ref is a digest of the caller's mention string — failing in both the over-split and silent over-merge directions. | working-tree | Claude Opus 5 |
