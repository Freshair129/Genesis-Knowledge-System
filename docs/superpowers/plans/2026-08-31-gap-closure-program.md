# Gap-Closure Program Implementation Plan (zuri-ai 17-stage pipeline)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the nine remaining zuri-ai pipeline stages' gap in the order recommended by the 2026-08-31 gap analysis: (1) Stage 9 tracker hand-off, (2) ledger-reporting design, (3) Stage 10 design pass, (4) Stage 12 design pass reusing the msp-runtime bitemporal engine, (5) GenesisBlockDB adapter decision brief, (6) CR-002 response.

**Architecture:** This is a *program* plan: every deliverable here is a decision or hand-off document authored inside `D:\gks`, because the repository's own rule is "owning a stage is not authorization to build it — each one needs its own design pass" (`docs/TIER-BOUNDARY-17-STAGE.md`). Code for Stages 10 and 12 ships via follow-on implementation plans written only after their ADRs are accepted, mirroring the Stage 9 pattern (ADR accepted → contracts → persistence → core → consumer → acceptance-criteria suite as the gate, commits `e52d997`…`233d079`).

**Tech Stack:** Markdown docs with GKS versioned frontmatter + CHANGELOG table (every `docs/*.md` here carries one — copy the shape from `docs/TIER-BOUNDARY-17-STAGE.md` lines 1–10). Review agents from `.claude/agents/`: `rkoi` (architecture), `ather` (ADR compliance / doc currency).

## Global Constraints

- Call direction is `Zuri / GoVibe -> MSP -> GKS` and is never inverted; GKS never calls outward to GenesisBlockDB, GoVibe, or MSP (`CLAUDE.md`).
- Every public tool goes through `packages/gks-contracts`' tool registry — never wired directly onto the server (`CLAUDE.md`).
- Every call carries an explicit scope envelope; no new caller may rely on `GKS_DEFAULT_PORTFOLIO_ID` (`CLAUDE.md`).
- Package layering is enforced by `tests/contract/dependency-boundaries.test.mjs` — read it before assuming what's allowed.
- A stage is done when it can **report its evidence**, not when its logic runs (`docs/TIER-BOUNDARY-17-STAGE.md`).
- **Report completion; do not record it.** GKS has no write access to `PRJ-KNOWLEDGE-17S` or zuri-ai's `ROADMAP.md` and must not gain any.
- Stage ids are the key (`DPS-KI-*`), never numbers; an id never changes meaning.
- Documents that describe other artifacts must name the artifact's version they describe (the TIER-BOUNDARY file went stale twice in two days for skipping this — see its CHANGELOG).
- All new docs are English, matching the existing `docs/` corpus.

**Cross-repo facts this plan relies on (from the 2026-08-31 gap analysis):**
- zuri-ai tracker reads 8/17 (`D:\zuri-ai\docs\roadmap\ROADMAP.md:160`); Stage 9 shipped from GKS on 2026-08-30 and was reported per protocol.
- AC-109.12 (Tier-3/4 stages must report evidence onto zuri-ai's FR-071 ledger) is zuri-ai's largest open dependency on GKS; ADR-050 explicitly authorizes **no** GKS client in zuri-ai, so a new decision is required on *both* sides.
- The reusable bitemporal engine is `G:\govibe\packages\msp-runtime\src\domain\temporal-engine.mjs` (with parity test `test/temporal-engine.parity.test.mjs`).
- CR-002 (`D:\zuri-ai\docs\change-requests\CR-002-GKS-MSP-CATALOG-VAULT-RESOLUTION.md`, v1.2.0, status `proposed`) asks GKS to (a) register `smartgift://b2b/portfolio/v1` with vector spaces `unboxing_sensory` (1024-dim `bge-m3`) and `product_features`, (b) dispatch compiled `query-ir.v1` requests directly to the Edge Substrate, (c) never mint `gks:` refs outside GKS.
- GoVibe's `ADR-025` (storage-backend independence / GenesisBlockDB adapter) is `proposed` with zero adapter code.

---

### Task 1: Stage 9 tracker hand-off packet (recommended step 1)

**Files:**
- Create: `docs/reports/2026-08-31-stage-9-tracker-handoff.md`

**Interfaces:**
- Consumes: `docs/TIER-BOUNDARY-17-STAGE.md` (evidence list, reporting protocol), commit `e412ec0`.
- Produces: a self-contained evidence packet the Boss hands to whoever holds write authority on `PRJ-KNOWLEDGE-17S`, so the task move 8/17 → 9/17 happens against evidence, not a claim.

- [ ] **Step 1: Verify what the shipping PR already reported**

Run: `git -C D:\gks log e412ec0 --format=%B` and `git -C D:\gks show 233d079 --stat`
Expected: the Stage 9 ship commit body names `DPS-KI-ENTITY-RESOLVE` and the acceptance-suite commit lists `tests/` files. Copy the exact evidence sentences found into Step 2's packet; if the commit body does *not* name the four evidence fields, say so in the packet's "what was reported where" section rather than papering over it.

- [ ] **Step 2: Write the packet**

Create `docs/reports/2026-08-31-stage-9-tracker-handoff.md` with GKS frontmatter (`domain: genesis-knowledge-system`, `doc_type: completion-report`, `status: final`) and exactly these sections, filled from Step 1's findings:

```markdown
# Stage 9 tracker hand-off — DPS-KI-ENTITY-RESOLVE

## What to move
Project `PRJ-KNOWLEDGE-17S` (Wannapa Workspace → TNT-EtohGroup → SmartGift →
Development domain), workstream `WST-KI-PIPELINE`, task `DPS-KI-ENTITY-RESOLVE`
→ `DONE`. Expected project reading after the move: 9/17 = 52.9%.

## Evidence (the four required fields)
| Field | Where it now rides |
|---|---|
| resolution outcome (`MATCHED`/`CREATED`/`AMBIGUOUS`/`REVIEW_REQUIRED`/`REJECTED`) | `canonical_mappings` rows, promote response |
| strategy used | same row, `strategy` — one of the six ladder rungs |
| canonical entity id | same row |
| confidence vs the 0.85 auto-merge floor | same row; FUZZY rung structurally capped below the floor |

## Verification trail
- Ship commit: e412ec0 (2026-08-30), acceptance-criteria suite: 233d079.
- Verified against the real MSP provider chain; RKOI review: two documentation
  errata, zero code findings (commit 4a79bf7).
- ADR: docs/ADR-GKS-ENTITY-RESOLUTION.md revision 0.3.0b, gate open.

## What GKS is NOT asking
No write access to the tracker or ROADMAP.md. The move is the holder's to
make against this evidence, per docs/TIER-BOUNDARY-17-STAGE.md.
```

- [ ] **Step 3: Route to `ather` for a compliance read**

Dispatch the `ather` agent: "Audit `docs/reports/2026-08-31-stage-9-tracker-handoff.md` against `docs/TIER-BOUNDARY-17-STAGE.md`'s reporting protocol — does it claim only what commits e412ec0/233d079/4a79bf7 support, and does it ask for zero write access?" Fix anything it flags.

- [ ] **Step 4: Commit**

```bash
git -C D:\gks add docs/reports/2026-08-31-stage-9-tracker-handoff.md
git commit -m "docs: Stage 9 tracker hand-off packet for the PRJ-KNOWLEDGE-17S holder"
```

---

### Task 2: Ledger-reporting ADR draft — AC-109.12 (recommended step 2)

**Files:**
- Create: `docs/ADR-GKS-LEDGER-REPORTING.md` (status `proposed`)
- Create: `docs/reports/2026-08-31-cr-draft-ledger-pull.md` (companion CR draft to hand to zuri-ai)

**Interfaces:**
- Consumes: FR-071 ledger model names (`PipelineRun`/`PipelineStep`/`PipelineRecordEvent`), `DPL-KNOWLEDGE-INGEST-V1` / `EXC-KNOWLEDGE-INGEST-V1`, NFR-020's six per-stage metrics (`records_in`, `records_out`, `records_failed`, `records_quarantined`, `processing_time`, `retry_count`).
- Produces: the decided transport shape every later stage (10–14, 17) must emit evidence through. **This gates Task 3's implementation follow-on** — Stage 10 must not ship un-reportable.

- [ ] **Step 1: Write the ADR with three options and one recommendation**

Create `docs/ADR-GKS-LEDGER-REPORTING.md` (frontmatter `doc_type: architecture-decision`, `status: proposed`). Required content — write it as decision prose, not bullets-to-fill-later:

- **Context:** AC-109.12 requires Tier-3/4 stage evidence on zuri-ai's FR-071 ledger; ADR-050 authorizes no GKS client in zuri-ai; GKS never calls outward; therefore neither side may open a connection toward the other today. The only lawful direction is `zuri-ai → MSP → GKS`.
- **Option A — push via MSP relay:** GKS returns stage evidence inside existing tool responses (the Stage 9 precedent: evidence rides the promote response, ADR-GKS-ENTITY-RESOLUTION D7); the *caller* (MSP, then zuri-ai) is responsible for landing it on the ledger. Cost: every intermediate hop must forward faithfully; zuri-ai still needs a writer.
- **Option B — cursor pull (recommended):** GKS persists one evidence row per stage execution in a new `stage_evidence` table and exposes one read-only registry tool, `gks_stage_evidence_export({ scope, since_cursor, limit })`, returning `{ rows: [{ cursor, pipeline_stage_id, pipeline_definition_id: "DPL-KNOWLEDGE-INGEST-V1", execution_contract_id: "EXC-KNOWLEDGE-INGEST-V1", evidence: {…per-stage catalog fields…}, metrics: { records_in, records_out, records_failed, records_quarantined, processing_time_ms, retry_count }, produced_at }], next_cursor }`. zuri-ai pulls through MSP on its own schedule and owns its cursor and idempotent apply — the exact mirror of its own FR-100 decision-export pattern, so a replayed page is harmless by design.
- **Option C — do nothing until zuri-ai decides:** rejected in the ADR body: it re-creates the Stage-9 lesson ("work could not be reported against stages nobody knew existed") for stages 10–17.
- **Decision consequences:** the tool is registry-registered (`packages/gks-contracts`), scope-enveloped, read-only; a metric a stage did not produce is reported as `0`, never omitted (NFR-020: "zero, not absent"); the ADR names which repo must still change (zuri-ai needs a pull importer — that is the companion CR's ask, not GKS's to build).

- [ ] **Step 2: Write the companion CR draft for zuri-ai**

Create `docs/reports/2026-08-31-cr-draft-ledger-pull.md`: a ready-to-submit change-request body proposing zuri-ai add a scheduled pull (`zuri-ai → MSP → gks_stage_evidence_export`) that writes `PipelineRecordEvent` rows under `DPL-KNOWLEDGE-INGEST-V1`, closing AC-109.12 without violating ADR-050's "no GKS client" (the MSP client already exists on their side per FR-057). State explicitly: cursor ownership is zuri-ai's; GKS guarantees replay-safety of any exported page.

- [ ] **Step 3: RKOI review**

Dispatch `rkoi`: "Review `docs/ADR-GKS-LEDGER-REPORTING.md` for boundary safety: does Option B keep GKS strictly passive (no outward calls), keep the tool in the contracts registry, and keep scope envelopes mandatory? Is the evidence-row schema compatible with port version 2 (`docs/GKS-PORT-CONTRACT.md`) or does it need a port version note?" Fold findings into the ADR before commit.

- [ ] **Step 4: Commit**

```bash
git -C D:\gks add docs/ADR-GKS-LEDGER-REPORTING.md docs/reports/2026-08-31-cr-draft-ledger-pull.md
git commit -m "docs: ADR draft — Tier-3 stage evidence reaches the FR-071 ledger by cursor pull (AC-109.12)"
```

---

### Task 3: Stage 10 design pass — `DPS-KI-FACT-EXTRACT` ADR draft (recommended step 3)

**Files:**
- Create: `docs/ADR-GKS-FACT-EXTRACT.md` (status `proposed`)
- Modify: `docs/TIER-BOUNDARY-17-STAGE.md` (add one line under Stage 10 pointing at the ADR, and a CHANGELOG row — this file's own CHANGELOG documents that it goes stale when it doesn't track sibling artifacts)

**Interfaces:**
- Consumes: FR-109 Stage 10 evidence list (`subject`/`predicate`/`object`-or-value, `confidence`, `evidence`, `valid_time`, `provenance`); Task 2's evidence-export shape.
- Produces: the accepted decision set that the follow-on plan `docs/superpowers/plans/2026-09-XX-stage-10-fact-extract.md` implements. Later tasks refer to the fact record as `fact_rows` with columns exactly as decided in this ADR.

- [ ] **Step 1: Write the ADR context + the open-questions register**

Create `docs/ADR-GKS-FACT-EXTRACT.md` mirroring `docs/ADR-GKS-ENTITY-RESOLUTION.md`'s structure (Decision status → Context → Decisions → Alternatives rejected → Change classification). The context section states what exists today (Stage 9's `canonical_mappings` + mentions; no fact store) and enumerates the questions that must each get a decided answer **before any code task is written** — modeled on Stage 9's eight decided questions:

1. **Input contract** — what does MSP hand Stage 10: chunks with resolved entity refs from Stage 9, or raw candidates? (Proposed: chunk + the Stage 9 resolution set for that chunk; Stage 10 never re-resolves.)
2. **Extraction method** — deterministic pattern rules vs local model inference; FR-111's `cloud_processing_allowed=false` means the method must be runnable fully locally. (Proposed: rule-first with a named, versioned extractor id; model-assist is a separate later decision, not smuggled in.)
3. **Fact schema** — `fact_rows(subject_ref, predicate_raw, object_ref | object_value, confidence, evidence_span, source_chunk_id, valid_from, valid_to, tx_from, tx_to, provenance, extractor_version, scope columns)`. Predicate stays **raw** at Stage 10; canonicalization is Stage 11's job and must not be pre-empted.
4. **Storage / port impact** — new migration in `packages/gks-persistence`; does this require port version 3 of `docs/GKS-PORT-CONTRACT.md`? (The ADR must answer explicitly, the way Stage 9's D8 took the port break openly.)
5. **Confidence model** — where the number comes from per extraction path, and what the floor semantics are (extraction has no auto-merge floor; the ADR must say what confidence *gates* instead — e.g. below X ⇒ `REVIEW_REQUIRED`-style holding state, reusing Stage 9's D9 consumer pattern for unreviewed facts).
6. **Idempotency** — key shape per BR-021's philosophy: source identity + source version + content hash + extractor version together.
7. **Evidence & reporting** — the Stage 10 evidence row emitted through Task 2's `stage_evidence` mechanism, with all six NFR-020 metrics.
8. **Tenant wall** — the same hard wall as Stage 9's D5/8: extraction pools and any dedup of facts never cross `tenant_id`.

Each question gets a **Proposed** answer written in full (as above) so acceptance is an approval of concrete text, not a request for homework.

- [ ] **Step 2: Pre-write the acceptance-criteria list**

Inside the ADR, a section "Acceptance criteria for the implementation branch" — the future step-6 gate suite must show: a fact row carries all seven FR-109 evidence fields; a fact whose source chunk cannot be reached is refused (spec §3.2's provenance rule); cross-tenant extraction is unwritable, not merely forbidden; the stage's evidence row exports with metrics reporting zero-not-absent; replaying the same chunk+extractor version produces no duplicate facts.

- [ ] **Step 3: RKOI review, then TIER-BOUNDARY update**

Dispatch `rkoi` on the ADR draft (boundary, layering, scope). Then edit `docs/TIER-BOUNDARY-17-STAGE.md`: under the Stage 10 row's evidence table entry add "Design pass in progress: `ADR-GKS-FACT-EXTRACT.md` (proposed)", bump the frontmatter version, add a CHANGELOG row.

- [ ] **Step 4: Commit**

```bash
git -C D:\gks add docs/ADR-GKS-FACT-EXTRACT.md docs/TIER-BOUNDARY-17-STAGE.md
git commit -m "docs: ADR draft — Stage 10 fact extraction (DPS-KI-FACT-EXTRACT) design pass"
```

- [ ] **Step 5: On ADR acceptance — write the follow-on implementation plan**

Only after the Boss accepts the ADR (gate open), write `docs/superpowers/plans/2026-09-XX-stage-10-fact-extract.md` with the full TDD task breakdown in the Stage 9 commit shape: (1) contracts vocabulary + validation in `packages/gks-contracts`, (2) migration + fact writes in `packages/gks-persistence`, (3) extractor in `packages/gks-core`, (4) the held-fact consumer, (5) evidence wiring per Task 2's ADR, (6) acceptance-criteria suite as the gate. That plan carries the real test code; this program plan deliberately does not, because the code shape is exactly what the ADR decides.

---

### Task 4: Stage 12 design pass — `DPS-KI-TEMPORAL-MAP` ADR draft, porting the msp-runtime bitemporal engine (recommended step 4)

**Files:**
- Create: `docs/ADR-GKS-TEMPORAL-MAP.md` (status `proposed`)
- Modify: `docs/TIER-BOUNDARY-17-STAGE.md` (same one-line + CHANGELOG treatment as Task 3)

**Interfaces:**
- Consumes: `G:\govibe\packages\msp-runtime\src\domain\temporal-engine.mjs` (read-only reference — same owner, ported by re-implementation, never by import: `msp-runtime` is not a published dependency and layering forbids it).
- Produces: the decided bitemporal column set Task 3's `fact_rows` already names (`valid_from`, `valid_to`, `tx_from`, `tx_to`) plus the explicit not-applicable marker.

- [ ] **Step 1: Write the ADR**

Create `docs/ADR-GKS-TEMPORAL-MAP.md`. Required decisions, each with proposed text:

1. **Port, don't import.** The temporal semantics (`isTemporalVisible`, `compareTemporalOrder`, `valid_from/valid_to/recorded_at/superseded_at`) are re-implemented in `packages/gks-core` with a parity test against recorded fixtures — the same discipline msp-runtime itself uses (`temporal-engine.parity.test.mjs` pins its port against `scripts/mcp/temporal-versioning.mjs`). Name the source file and the commit of `G:\govibe` being ported (`79f339e`) in the ADR so drift is detectable.
2. **Column mapping.** msp-runtime's `recorded_at`/`superseded_at` become the spec's `tx_from`/`tx_to`; `valid_from`/`valid_to` map 1:1. The ADR carries this table explicitly because the names differ between the two systems and FR-109's evidence list uses the spec's names.
3. **Not-applicable is a value.** A fact with no temporal claim records `temporal: "not_applicable"` explicitly — FR-109 requires "or an explicit not-applicable"; absence is not compliant (the same zero-not-absent philosophy as NFR-020).
4. **Where mapping runs.** Stage 12 is a *mapping* stage: it reads Stage 10's facts, extracts/normalizes temporal claims from evidence spans, and writes the four columns — it never invents time. Facts whose source has no time data take the not-applicable path.
5. **Evidence row** through Task 2's export, like every stage.

- [ ] **Step 2: RKOI review + TIER-BOUNDARY update + commit**

Dispatch `rkoi` (focus: does the port keep `packages/gks-core` free of any runtime dependency on GoVibe paths?). Update `docs/TIER-BOUNDARY-17-STAGE.md` Stage 12 row + CHANGELOG. Then:

```bash
git -C D:\gks add docs/ADR-GKS-TEMPORAL-MAP.md docs/TIER-BOUNDARY-17-STAGE.md
git commit -m "docs: ADR draft — Stage 12 temporal mapping ports the msp-runtime bitemporal semantics"
```

- [ ] **Step 3: On acceptance — follow-on plan**

Same gate as Task 3 Step 5: `docs/superpowers/plans/2026-09-XX-stage-12-temporal-map.md`, written only after the ADR is accepted. Its parity-test fixtures are generated from the named `G:\govibe` commit.

---

### Task 5: GenesisBlockDB adapter decision brief (recommended step 5)

**Files:**
- Create: `docs/reports/2026-08-31-gbdb-adapter-decision-brief.md`

**Interfaces:**
- Consumes: gap-analysis findings (GoVibe ADR-025 `proposed`, zero adapter code; zuri-ai ADR-046 notes GKS has no HTTP surface; Stage 13 = "GKS decides, GenesisBlockDB writes"; Stages 15–16 are Tier 4's).
- Produces: a one-page brief the Boss uses to convene the cross-repo decision. **This is not GKS's decision to make alone** — the brief's job is to force the question, name the options, and state GKS's constraint.

- [ ] **Step 1: Write the brief**

Create `docs/reports/2026-08-31-gbdb-adapter-decision-brief.md` with exactly this argument structure:

- **The blocked stages:** 13 (write side), 15, 16 cannot progress while the Tier-4 adapter is documentation (`G:\govibe\docs\adr\ADR-025…` proposed, no code; grep for `genesisblock` in GoVibe code hits nothing).
- **GKS's hard constraint, stated first:** GKS never calls outward — so *whatever* is decided, GKS's Stage 13 output is a **graph decision record** (nodes/edges with provenance, confidence, temporal semantics, scope — the FR-109 evidence list), not a write into GBDB. Someone else carries it to the substrate.
- **Option 1 — GBDB pulls from GKS** (mirrors Task 2's cursor-pull and zuri-ai's FR-100): GKS exposes `gks_graph_decision_export({ scope, since_cursor })` through the registry; the GBDB side owns cursor + idempotent apply. Cheapest for GKS; requires a GBDB-side importer to exist.
- **Option 2 — MSP relays:** MSP reads GKS's decision records and writes GBDB via the NAPI binding zuri-ai already codes against (`@freshair129/gks-genesis-block-native-*`). Keeps GBDB passive; makes MSP a substrate writer — a role MSP does not have today and may not want.
- **Option 3 — revive GoVibe ADR-025's adapter** as the writer. Honest cost note: that contract has had zero code since proposal, and zuri-ai's view of GoVibe is "never a live dependency" — building the write path there re-couples what ADR-042 decoupled.
- **Recommendation:** Option 1, for symmetry with the two pull contracts that already govern this stack (FR-100 decisions export, Task 2's evidence export) — every boundary crossing becomes "passive producer + cursor-owning consumer," one pattern audited three times instead of three patterns audited once.
- **Named decision owners:** Boss + GenesisBlockDB owner; GKS commits only to the export tool shape.

- [ ] **Step 2: RKOI sanity read + commit**

Dispatch `rkoi`: "Does the brief keep GKS passive in all three options, and does Option 1's export tool respect the registry + scope-envelope rules?" Then:

```bash
git -C D:\gks add docs/reports/2026-08-31-gbdb-adapter-decision-brief.md
git commit -m "docs: decision brief — who writes GenesisBlockDB (stages 13/15/16 are blocked on it)"
```

---

### Task 6: CR-002 response from GKS (recommended step 6 — may run in parallel with Tasks 2–5)

**Files:**
- Create: `docs/reports/2026-08-31-cr-002-response.md`

**Interfaces:**
- Consumes: `D:\zuri-ai\docs\change-requests\CR-002-GKS-MSP-CATALOG-VAULT-RESOLUTION.md` v1.2.0 (re-read it before writing — it is `proposed` and moved as recently as 2026-08-30).
- Produces: GKS's formal position on each of the three asks, ready to paste into the CR's review thread.

- [ ] **Step 1: Re-read CR-002 and write the three-part response**

Read the current CR text, then create `docs/reports/2026-08-31-cr-002-response.md`:

- **Ask (a) — register `smartgift://b2b/portfolio/v1` (v1.3.0) with vector spaces `unboxing_sensory` (1024-dim `bge-m3`) and `product_features`: ACCEPT with sequencing.** Schema-contract registration is registry work GKS can take; note that the *embedding* of those spaces is Stage 15 / Tier 4 territory, so registration lands as contract metadata, and point at the reusable bge-m3 1024-dim path in `G:\govibe\packages\msp-runtime\src\retrieval\vector.mjs` as the reference implementation whoever builds Stage 15 should port.
- **Ask (b) — "dispatch compiled `query-ir.v1` requests directly to the Edge Substrate": FLAG AS A BOUNDARY CONFLICT, propose amendment.** As written this has GKS calling outward to the substrate, which the standing rule (`CLAUDE.md`: GKS never calls outward; `docs/ADR-GKS-BOUNDARY.md`) forbids. The response proposes the amendment rather than silently accepting or refusing: GKS *compiles and returns* `query-ir.v1` (the plan/IR is GKS's product per ADR-042 D1), and the dispatch hop is carried by the caller chain or by whatever transport the Task 5 decision lands on. If zuri-ai's architecture genuinely requires GKS→substrate calls, that is a change to GKS's boundary ADR and must be decided there first — name that explicitly.
- **Ask (c) — never mint `gks:` refs outside GKS: ACCEPT, and return one finding.** GKS accepts the invariant (it already holds internally). The finding to hand back: GoVibe's `packages/govibe-core/src/poc/msp-stub.mjs` mints `gks:atom/<sha>` refs today; the response asks that the stub be fenced (test-only) or renamed off the `gks:` namespace so the invariant is checkable by grep across repos.

- [ ] **Step 2: RKOI review + commit**

Dispatch `rkoi`: "Check `docs/reports/2026-08-31-cr-002-response.md` — does the ask-(b) position correctly preserve the call-direction rule while leaving zuri-ai a workable path?" Then:

```bash
git -C D:\gks add docs/reports/2026-08-31-cr-002-response.md
git commit -m "docs: GKS response to CR-002 — accept (a)(c), propose amendment to (b) on call direction"
```

---

## Sequencing & parallelism

- Task 1 is independent and immediate.
- Task 2 gates Task 3 Step 5 and Task 4 Step 3 (no stage implementation plan is written until the reporting shape is decided — "done means reportable").
- Tasks 5 and 6 are hand-off documents and may run in parallel with everything; Task 6's ask-(b) answer and Task 5's recommendation should be kept consistent (both say: GKS produces, others carry).
- Follow-on implementation plans (`2026-09-XX-stage-10-…`, `2026-09-XX-stage-12-…`) are separate plans per the scope rule — each produces working, testable software on its own, in the Stage 9 six-step commit shape, implemented by `kin` with `ghost` extending the suites and `rkoi` reviewing before merge.

## Out of scope for this program plan

- Stages 11 (`DPS-KI-ONTOLOGY-MAP`), 14 (`DPS-KI-ENRICH`), 17 (`DPS-KI-QUALITY-GATE`): sequenced after Stage 10 exists (11 consumes raw predicates from 10; 14/17 consume the graph). Each gets its own design pass then.
- Stages 15–16: GenesisBlockDB's, contingent on Task 5's decision.
- Any write into zuri-ai, GoVibe, or the `PRJ-KNOWLEDGE-17S` tracker.
