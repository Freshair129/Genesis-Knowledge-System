---
version: "1.0.0b"
created_at: "2026-09-11T18:00:00+07:00,Claude Opus 5,working-tree"
last_update: "2026-09-11T18:00:00+07:00,Claude Opus 5,working-tree"
status: "accepted"
superseded_by: null
attributes:
  domain: "genesis-knowledge-system"
  doc_type: "cross-repository-response"
  scope: "GKS's formal acceptance of GenesisRAG17 structured-record profile contract revision 2 (ADR-075 Phase 2 gate), ready to stand as one of the four repository acceptance notes the gate requires"
---

# GKS response to the GenesisRAG17 structured-record profile — contract revision 2 (v1.0.0b)

**Target proposal:** `.brain/proposals/2026-09-11-genesisrag17-structured-record-profile.md`
in `Freshair129/zuri.ai`, on branch `docs/adr-075-phase2-gate` (rev 2). That document
is the ADR-075 Phase 2 gate's zuri-ai-side text; this response answers the decision
list derived from it, contract revision 2, dated 2026-09-11.

**Decision list this response cites:** the four-repo review (zuri-ai Tier 1, MSP
Tier 2, GKS Tier 3, GenesisBlock worker Tier 4) ran the same day against each
repo's `origin/main` and produced one shared decision list, owner decisions O-1
through O-3 and contract items C-1 through C-9. This response is GKS's position on
that list, item by item, with every GKS-side anchor (`packages/gks-core`,
`packages/gks-contracts`, `tests/contract`, and this repository's own docs)
re-verified read-only against this worktree's `origin/main` at commit
`2b205f04a9fcd1dbb35fdef2d56cb16760876b88` while writing this response, not carried
forward from memory.

**GKS's overall position: ACCEPT contract revision 2.** No GKS code changes
accompany this PR — see "What this PR is, and is not" below.

## O-1 / Option A — PRICE_TIER as a distinct entity: ACCEPT

The owner's decision keeps the fact shape unchanged: a tier-qualified price is
its own entity (`PRICE_TIER`), linked by a new `PRICED_AT` predicate, rather than
attaching a `qualifiers` field to an existing fact or edge. GKS's Stage 11
ontology-mapping shape — one predicate, one subject type set, one object type
set, no per-fact side channel — accepts this without any change to the decision
envelope `pipelineClaim` (see C-1) already hands the worker. This is the
shape GKS would have asked for if asked cold: `packages/gks-core/src/pipeline.mjs`'s
existing endpoint-validation step (`validEndpoint`, lines 289-291, see C-2 below)
already assumes one predicate maps to one fixed `{subject types, object types}`
pair with no attached qualifier, and Option A preserves that exactly.

## O-2 / Option B — deferred, not rejected

A `qualifiers` field on facts/edges remains a future option. GKS records the same
reservation the decision list states: adopting it later changes the frozen decision
shape (`pipelineClaim`'s output, and by extension `decisionHash`'s input set) and
therefore needs its own four-repo contract revision and its own four-repo gate —
this PR's acceptance does not pre-clear that future change. Nothing in GKS's
current stage decisions (`packages/gks-core/src/pipeline.mjs`) or contracts
(`packages/gks-contracts/src/pipeline.mjs`) is shaped to carry a qualifier today,
and this response does not ask GKS to prepare for one.

## C-1 — scope correction: ACKNOWLEDGED, matches current code

C-1 states that GKS's `pipelineClaim` hands the worker the whole stored decision —
`entities[]`, `facts[]`, `held[]`, `derived[]`, `graph`, `ontologyVersion` — so the
fact shape crosses the Tier 3 → Tier 4 boundary and the ontology change is a
four-repo contract change. Verified: `packages/gks-core/src/index.mjs:367`
(`async pipelineClaim(rawInput = {}) { ... }`) calls
`persistence.claimPipelineDecisions(request)` and returns
`{ schemaVersion: PIPELINE_SCHEMA_VERSION, scope: request.scope, decisions }`
verbatim — the decision object built by `packages/gks-core/src/pipeline.mjs`
(which carries `ontologyVersion: PIPELINE_ONTOLOGY_VERSION` at
`pipeline.mjs:372`) is exactly what the worker claims. No correction needed on
GKS's side; the scope statement matches the code as it stands today.

## C-2 — vocabulary: ACCEPT the `ontology_v2` table

`ontology_v2` is a superset of `ontology_v1`:

| Predicate | Subject | Object | Status |
|---|---|---|---|
| WORKS_FOR | PERSON | ORGANIZATION | unchanged from v1 |
| PURCHASED | PERSON or ORGANIZATION | PRODUCT | unchanged from v1 |
| HAS_COMPONENT | PACKAGE | PRODUCT | new |
| PRICED_AT | PRODUCT or PACKAGE | PRICE_TIER | new (Option A) |
| IN_CATEGORY | PRODUCT or PACKAGE | CATEGORY | new |

Endpoint types in v2: `PERSON`, `ORGANIZATION`, `PRODUCT`, `PACKAGE`, `CATEGORY`,
`PRICE_TIER`. `PACKAGED_AS` is dropped (redundant reverse of `HAS_COMPONENT`).
`OFFER` is not in v2 — no predicate uses it; SmartGift `BundleOffer` records map
to `PACKAGE`, and `OFFER` can be added in a later revision if a predicate ever
needs it. The type is spelled `PRICE_TIER`, not `PriceTier` — verified against
`packages/gks-core/src/pipeline.mjs:41` (`normalizeType`), which upper-cases and
strips non-alphanumerics, so `"PriceTier"` would normalize to `"PRICETIER"` and
collide with nothing today but must be produced pre-normalized as `PRICE_TIER`
by convention, matching the existing `PERSON`/`ORGANIZATION`/`PRODUCT` constants
in `ENDPOINT_TYPES` (`pipeline.mjs:35`). A `PRICE_TIER` `resolutionKey` is
`{productCode}:{tier}:{price}` (e.g. `PM-BOTTLE-LED:qty100:<satang>`) — GKS's
Stage 9 identity is `[norm_v1(resolutionKey), normalizeSemanticType(semanticType)]`
per `docs/ADR-GKS-GENESISRAG17.md`'s Stage 9 bullet, so two price tiers with the
same product/tier/price collide by design (a dedup, not a bug), and two different
prices for the same product/tier stay distinct identities.

**Endpoint validation becomes a predicate → `{subject types, object types}` table.**
Today `validEndpoint` is a two-branch ternary hard-coded to `WORKS_FOR`/`PURCHASED`
at `packages/gks-core/src/pipeline.mjs:289-291`:

```js
const validEndpoint = predicate === "WORKS_FOR"
  ? subjectType === ENDPOINT_TYPES.PERSON && objectType === ENDPOINT_TYPES.ORGANIZATION
  : (subjectType === ENDPOINT_TYPES.PERSON || subjectType === ENDPOINT_TYPES.ORGANIZATION) && objectType === ENDPOINT_TYPES.PRODUCT;
```

This ternary cannot express three new predicates without becoming unreadable; it
is replaced by a table lookup (predicate → allowed subject-type set → allowed
object-type set) that the worker carries the **same content** of, per C-9. GKS
accepts owning that table's authoring alongside `RELATION_ALIASES`
(`pipeline.mjs:22`) and `ENDPOINT_TYPES` (`pipeline.mjs:35`).

## C-3 — versions and rollout: ACCEPT, GKS is step 2

GKS's Stage 17 gate and the worker's Stage 13 check both accept the fixed set
`{ontology_v1, ontology_v2}`; each decision validates against the table of its
own version. New decisions are produced as `ontology_v2`; in-flight `v1`
decisions complete under `v1` rules — no drain needed. Today
`packages/gks-contracts/src/pipeline.mjs:15` pins a single literal,
`export const PIPELINE_ONTOLOGY_VERSION = "ontology_v1";`, with no supported-set
concept yet — this becomes a fixed two-member set the Stage 17 gate checks
membership against instead of equality, per C-9.

**Rollout order is accept-before-produce, and GKS is step 2 of 3:**

1. worker accepts both versions;
2. **GKS accepts both and starts producing `ontology_v2`** (this repo's step);
3. zuri-ai starts sending parser-2 catalog batches.

GKS accepts this order. It means GKS's implementation (when it lands, after this
gate) ships acceptance of both versions and production of `ontology_v2` in the
same change — GKS is never in a state where it produces a version the worker
cannot yet accept.

zuri-ai's `docs/plans/GENESISRAG17-CONTRACT.md:44` and its flow doc's version
pins update in the implementation change that ships step 2 (GKS's), not before —
GKS's own docs are held to the same rule: this response does not claim `v2` is
live, and the ADR-GKS-GENESISRAG17.md CHANGELOG row this PR adds says explicitly
that `ontology_v2` is planned, not implemented (see below).

**GKS also fixes the literal `"ontology_v1"` in the Stage 17 error message.**
Verified at `packages/gks-core/src/pipeline.mjs:534`:

```js
if (decision.ontologyVersion !== PIPELINE_ONTOLOGY_VERSION) knowledgeReasons.push("ontology version is not ontology_v1.");
```

Once the check becomes set-membership, this message hard-codes a now-wrong
single-version claim and must change to name the supported set, not one version.
Accepted as a required part of the C-9 implementation list.

## C-4 — chunking: ACCEPT, `rule_v1` stays unchanged

C-4 resolves the blocker GKS raised earlier: §B's "one record per chunk" does not
conflict with `rule_v1`'s "one structured claim per chunk," because
`genesisrag17-parser-2` renders each catalog record as one DESCRIPTIVE chunk (a
single mention, so it can never become an `INFERRED` 0.70 candidate held as
`confidence_below_write_floor`) plus one CLAIM chunk per relation, whose entire
text is the canonical JSON triple. GKS confirms this against its own Stage 10/11
code, not just the proposal text:

- The inferred-candidate path that C-4 is designed to avoid is
  `packages/gks-core/src/pipeline.mjs:245`
  (`claims = [{ ... predicate: "INFERRED", confidence: PIPELINE_CONFIDENCE.inferredMax ... }]`),
  which only fires `if (!claims.length && chunkMentions.length >= 2)` — a
  DESCRIPTIVE chunk carrying exactly one mention structurally cannot reach this
  branch, matching C-4's intent exactly.
- The write-floor hold C-4 cites is `pipeline.mjs:265`
  (`if (candidate.confidence < PIPELINE_CONFIDENCE.writeFloor) stage10Held.push(heldRecord(candidate, "confidence_below_write_floor"));`).
- `parseStructuredClaim` (Stage 10's structured-claim path, `basis: "structured"`,
  confidence 0.85) is the parser this profile's CLAIM chunks are written to
  satisfy — GKS does not change its rejection rules for `"?"`, `"never"`, or
  `"does not"` in claim-chunk text; parser-2's tests are the ones asserting
  claim-chunk text avoids them, per C-8.

No change to `PIPELINE_CONFIDENCE` thresholds or `rule_v1`'s scoring is needed or
proposed. The rejected alternative — a multi-triple Stage 10 rule needing a new
extraction-profile version — stays rejected; GKS agrees this is the simpler and
correct choice given C-4's chunk design.

## C-5 — temporal: ACKNOWLEDGED, one open item stays open

A claim chunk carries at most one ISO-8601 date (the catalog version date);
never `updatedAt` or a second date. Descriptive chunks carry no date. GKS's
Stage 12 temporal mapping (`docs/ADR-GKS-GENESISRAG17.md`'s Stage 12 bullet,
ported from MSP's `temporal-engine.mjs` per that ADR) already treats "no
temporal expression found" and "explicit `not_applicable`" as distinct states
without needing a code change for this profile — this response defers to
parser-2's own tests (owned by zuri-ai) to assert the two rendering rules
(single date only, no regex-triggering phrasing).

**C-5's open verification item is explicitly not closed by this response**: "the
bitemporal lane must handle a generation that mixes dated facts and
`not_applicable` facts" — GKS confirms the code path this touches. Verified at
`packages/gks-core/src/pipeline.mjs:410`:

```js
const allFactsNotApplicable = facts.every((fact) => fact.temporal?.validFrom === "not_applicable" && fact.temporal?.validTo === "not_applicable");
```

`.every()` over `facts` already tolerates a mix — a decision with some dated
facts and some `not_applicable` facts correctly evaluates
`allFactsNotApplicable === false`, which routes the bitemporal lane to
`facts.length` expected objects (not `0`), i.e. the existing code already
expects a bitemporal object for every fact in a mixed generation, dated or not.
GKS reads this as the mixed case already being handled by the existing
all-or-nothing/per-fact accounting rather than needing new logic — but this is a
reading, not a new test; C-8's worker-side "mixed-temporal bitemporal case" is
the test that actually proves it end to end, and this response does not claim
that proof exists yet.

## C-6 — Stage 8 recognizer: no action for GKS

`genesisrag17-structured-recognizer-1` and its `resolutionKey` bypass are Stage 8
concerns, owned by zuri-ai (`apps/server/src/modules/knowledge/genesisrag17-source.js`).
Stage 8 is upstream of GKS's Stage 9-14/17 ownership; GKS has no code at that
stage and takes no position beyond noting it received a `resolutionKey` already
in SmartGift-code form when a decision reaches `pipelineClaim`, which is
consistent with how GKS already treats `resolutionKey` as an opaque string in
Stage 9 identity (`norm_v1(resolutionKey)`).

## C-7 — unknown/mis-typed relations: ACCEPT, matches existing hold behavior

Every relation the fixture emits must map to a v2 predicate with valid endpoint
types, or the fact is `HELD` (`unknown_predicate` / `invalid_endpoint`), the
knowledge dimension goes `WARN`, and the run does not publish. This is not new
behavior to build — it is the existing Stage 11 hold path, verified at
`packages/gks-core/src/pipeline.mjs:279-293`: `normalizePredicate` returning
`null` holds `unknown_predicate` (line 281, guarded by the write-floor check),
and a failing `validEndpoint` holds `invalid_endpoint` (line 293). Extending
`RELATION_ALIASES` and the endpoint table to `v2`'s three new predicates changes
what those functions accept; it does not change how a rejection is held or how a
`WARN` propagates to Stage 17's quality verdict. GKS accepts that the fixture set
including one record expected to be held, and a test proving the run ends as a
documented `WARN`/no-publish (never a false `PASS`), is the correct shape for
this to be proven — see C-8.

## C-8 — fixtures and tests: ACCEPT the GKS-owned test list

The shared corpus lives in zuri-ai at
`apps/server/tests/fixtures/genesisrag17/smartgift-catalog/` (current commit
`87184a97`, re-pinned at implementation). GKS keeps its own local cases in
`tests/contract/pipeline-genesisrag17.test.mjs`, which already exists and today
hard-codes `ontology_v1` in two places GKS re-verified for this response:

- `tests/contract/pipeline-genesisrag17.test.mjs:168` —
  `expect(decision).toMatchObject({ ..., ontologyVersion: "ontology_v1", ... });`
- `tests/contract/pipeline-genesisrag17.test.mjs:204` — the test's own title,
  `it("applies rule_v1 confidence floors and ontology_v1 aliases/endpoints", ...)`.

Both are exactly where C-8's planned additions land: a passing and an
`invalid_endpoint` case per new predicate, a `v1` regression case, a `v1`
in-flight-decision-at-the-gate case, the Stage 12 date cases, the inferred-hold
case, and a normKey collision test for `PRICE_TIER` codes (exercising the
`{productCode}:{tier}:{price}` `resolutionKey` collision behavior noted under
C-2). Acceptance metrics are unchanged: Recall@5 ≥ .80, MRR ≥ .65, citation =
1.00, cross-tenant leaks = 0, run through the real four-process chain — GKS
takes no position altering these; they are outside GKS's ownership to set.

## C-9 — required GKS changes (implementation, after the gate)

GKS accepts this as its implementation scope, to be built only once all four
repositories have merged an acceptance note for this revision:

- `packages/gks-contracts/src/pipeline.mjs`: `PIPELINE_ONTOLOGY_VERSION` (today
  a single literal at line 15) becomes a supported-version set including
  `ontology_v1` and `ontology_v2`.
- `packages/gks-core/src/pipeline.mjs`: extend `RELATION_ALIASES` (line 22) and
  `ENDPOINT_TYPES` (line 35) with the three new predicates/types; replace the
  two-branch `validEndpoint` ternary (lines 289-291) with the predicate →
  endpoint table shared verbatim with the worker; fix the Stage 17 message at
  line 534 to name the supported set rather than the single string
  `"ontology_v1"`.
- `tests/contract/pipeline-genesisrag17.test.mjs`: the hard-coded assertions at
  lines 168 and 204 need a `v1`-specific variant once `v2` exists, plus the new
  cases enumerated under C-8.
- Docs: this file's own CHANGELOG (below) records acceptance now; the Stage 11
  bullet in `docs/ADR-GKS-GENESISRAG17.md` is **not** rewritten by this PR — it
  changes only with the implementation, per the instruction that produced this
  response. `docs/ADR-GKS-FACT-EXTRACT.md` (Stage 10, `rule_v1`) needs no
  content change for this revision since C-4 keeps `rule_v1` unchanged, but its
  version/CHANGELOG will need a pointer at implementation time if the fixture
  set changes its scope. `README.md:114` ("extracts `rule_v1` facts, maps
  `ontology_v1`, and records explicit temporal states") and
  `docs/GKS-PORT-CONTRACT.md:138` (the `gks_pipeline_gate` row, whose verdict
  carries `ontologyVersion`) both need the supported-set language once `v2`
  ships — noted here so the implementation change has a checklist, not
  something this docs-only PR edits ahead of code.

**MSP: no change required** (relay-transparent — proven by schema review, no
nested payload constraints, zero references to
`semanticType`/`predicate`/`ontologyVersion`/`qualifiers`). GKS has no basis to
add to or dispute that finding; it is outside GKS's boundary to verify MSP's
internals and GKS does not attempt to here.

**GenesisBlock worker:** GKS notes the version-check and endpoint-ternary
locations the decision list cites (`worker.mjs:275`, `:302-305`, `:1155-1160`,
`entityKind()` at `:758-763`) without independent verification — the worker is
outside GKS's repository and outside what this response can check read-only.
GKS's own predicate→endpoint table (this section, first bullet) is the table
the decision list says the worker must carry the same content of; GKS commits
to keeping the two in sync at implementation time, and flags that a mismatch
between GKS's table and the worker's table is a contract break neither repo
alone would catch — this is worth a shared fixture or golden-table test at
implementation, not decided here.

## What this PR is, and is not

**This PR makes no GKS code change.** It adds this response document and one
CHANGELOG row to `docs/ADR-GKS-GENESISRAG17.md` recording that GKS accepts
contract revision 2 — `ontology_v2` is **planned, not implemented**. No file
under `packages/`, `apps/`, or `tests/` changes. GKS implementation of C-9
starts only after all four repositories (zuri-ai, MSP, GKS, GenesisBlock) have
merged an acceptance note for this revision, per the gate rule the decision
list itself states:

> Phase 2 implementation may start only when the owner approval above is
> recorded in ADR-075 and an acceptance note citing this revision is merged in
> each of zuri-ai, MSP, GKS and GenesisBlock.

This document is GKS's acceptance note for that gate.

## Out of scope (unchanged, restated for completeness)

MSP credential → `relayCredential` mapping; nine `msp_pipeline_*` vs eight
`gks_pipeline_*` tools; the second, receiver-based Tier 1 17-stage
implementation in zuri-ai (`knowledge-ingestion-executor.js`). This response
takes no position on any of these — they are not part of contract revision 2.

## Summary position, for the gate record

| Item | Position |
|---|---|
| O-1 / Option A (`PRICE_TIER` entity) | ACCEPT — matches GKS's existing one-predicate-one-endpoint-pair shape |
| O-2 / Option B (`qualifiers` field) | Deferred, not rejected — needs its own four-repo revision and gate |
| C-1 scope correction | Acknowledged — matches `pipelineClaim` as coded today (`index.mjs:367`) |
| C-2 vocabulary | ACCEPT — table above; endpoint ternary at `pipeline.mjs:289-291` becomes a table |
| C-3 versions/rollout | ACCEPT — GKS is step 2 of 3, accept-before-produce; fixes the `ontology_v1` literal at `pipeline.mjs:15` and the message at `pipeline.mjs:534` |
| C-4 chunking | ACCEPT — `rule_v1` unchanged; verified against `pipeline.mjs:245,265` |
| C-5 temporal | Acknowledged — mixed-temporal accounting already looks correct at `pipeline.mjs:410`, but the proof is C-8's worker-side test, not yet written |
| C-6 Stage 8 recognizer | No action for GKS — upstream, zuri-ai-owned |
| C-7 unknown/mis-typed relations | ACCEPT — existing hold path at `pipeline.mjs:279-293` already does this |
| C-8 fixtures/tests | ACCEPT — GKS's own hard-coded `ontology_v1` sites confirmed at `tests/contract/pipeline-genesisrag17.test.mjs:168,204` |
| C-9 GKS implementation list | ACCEPT as implementation scope, gated on all four acceptance notes merging first |

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 1.0.0b | 2026-09-11 | accepted | Initial GKS acceptance of GenesisRAG17 structured-record profile contract revision 2 (ADR-075 Phase 2 gate): accepts Option A (`PRICE_TIER` entity), records Option B as deferred, accepts the `ontology_v2` vocabulary and the `{ontology_v1, ontology_v2}` supported-version accept-before-produce rollout (GKS step 2 of 3), confirms `rule_v1` chunking stays unchanged, confirms the existing held/`WARN` path already matches C-7, and lists C-9's GKS implementation scope against exact `packages/gks-core`/`packages/gks-contracts`/`tests/contract` anchors re-verified at `origin/main` `2b205f04a9fcd1dbb35fdef2d56cb16760876b88`. No GKS code changes in this PR. | working-tree | Claude Opus 5 |
