---
version: "0.1.0"
created_at: "2026-08-31T15:00:00+07:00,Claude Fable 5,working-tree"
last_update: "2026-08-31T15:00:00+07:00,Claude Fable 5"
status: "draft"
attributes:
  domain: "genesis-knowledge-system"
  doc_type: "decision-brief"
  scope: "who writes GenesisBlockDB — the cross-repo decision blocking zuri-ai pipeline stages 13, 15, and 16"
---

# Decision brief: who writes GenesisBlockDB

**This is not GKS's decision to make alone.** GKS owns the stages that decide
what belongs in GenesisBlockDB; it does not own, and under its own boundary
rule cannot own, the code path that writes it there. This brief exists to
force that question in front of the person who can actually decide it.

## The blocked stages

zuri-ai's seventeen-stage knowledge ingestion pipeline has three stages that
cannot progress: **13** (`DPS-KI-GRAPH-BUILD`, write side), **15**
(`DPS-KI-EMBED`), and **16** (`DPS-KI-INDEX`) — all three assigned to
GenesisBlockDB (Tier 4) per `docs/TIER-BOUNDARY-17-STAGE.md`. The adapter that
is supposed to carry work onto that substrate is documentation, not code:
GoVibe's `ADR-025-Storage-Backend-Independence-and-GenesisBlockDB-Adapter-Boundary.md`
is `status: proposed`, and a grep for `genesisblock` across GoVibe's
`src`/`packages`/`scripts` finds only comments and UI labels that *mention*
GenesisBlockDB — no adapter implementation. Meanwhile zuri-ai already codes
against a real client for it: `genesisblockdb-sink.js` targets the NAPI
binding `@freshair129/gks-genesis-block-native-*`, and ADR-046 records that
GKS itself has no HTTP surface today (NDJSON JSON-RPC over stdio; interim
serving on `:8888`). Three different pieces of this stack each assume a
different thing about who reaches GenesisBlockDB, and none of them has
written the connecting code.

## GKS's hard constraint, stated first

`CLAUDE.md`'s call direction is fixed: `Zuri / GoVibe -> MSP -> GKS`. GKS
never calls outward — not to GenesisBlockDB, not to GoVibe, not to MSP. That
is true under every option below, without exception. Stage 13's own
assignment already names the split: **GKS decides, GenesisBlockDB writes.**
GKS's Stage 13 output is a **graph decision record** — node/edge counts *as
decided*, plus per-business-assertion-edge provenance, confidence, temporal
semantics, and scope, per the FR-109 evidence list `docs/TIER-BOUNDARY-17-STAGE.md`
already fixes. `docs/ADR-GKS-LEDGER-REPORTING.md` D4 is explicit that a
decided count and a written count can legitimately diverge — a downstream
write can partially fail, retry, or be rejected — and that GKS's export must
never be read as a claim the write happened. Whatever this brief's decision
lands on, it changes who *carries* that decision record to the substrate. It
does not change what GKS produces, or make GKS the one who writes it.

## Option 1 — GenesisBlockDB pulls from GKS

GKS exposes a new registry tool, `gks_graph_decision_export({ scope,
since_cursor })`, inheriting the exact properties `docs/ADR-GKS-LEDGER-REPORTING.md`
already decided for `gks_stage_evidence_export` (Task 2's cursor-pull):
registry-registered through `packages/gks-contracts`, scope-enveloped with no
wildcard scope, cursors assigned at commit time so a puller can lag but never
permanently skip a row, and no reliance on `GKS_DEFAULT_PORTFOLIO_ID`. The
GenesisBlockDB side owns its cursor and its idempotent apply — the same
division of labor FR-100 and Task 2's export already use. Cheapest change for
GKS: no new outbound call, no new dependency, one more read-only tool next to
one that already exists in the same shape. **Cost:** requires a GBDB-side
importer to exist, and none does yet — this option does not build it, only
names the shape it should take.

## Option 2 — MSP relays

MSP reads GKS's graph decision records and writes GenesisBlockDB itself,
through the NAPI binding zuri-ai already codes against
(`@freshair129/gks-genesis-block-native-*`). This keeps GenesisBlockDB itself
passive — it never has to pull, poll, or own a cursor — but it makes **MSP a
substrate writer**, a role MSP does not have today. MSP currently relays and
enforces scope between callers and GKS; writing into a Tier-4 graph engine on
GenesisBlockDB's behalf is a materially different responsibility, and one
MSP's own owners have not been asked to take on. Stated honestly, not as a
minor detail: this option's real cost is organizational, not technical — it
assigns MSP a job before anyone with authority over MSP has agreed to it.

## Option 3 — revive GoVibe's ADR-025 adapter as the writer

GoVibe's ADR-025 already describes a GenesisBlockDB adapter boundary; use it
as the write path. **Honest cost:** that ADR has had zero adapter code since
it was proposed on 2026-08-03, and zuri-ai's own ADR-009 records GoVibe as
"never a live Zuri dependency" — one-time bootstrap only. Building a live
write path through GoVibe would re-couple what zuri-ai's ADR-042 decoupled,
for the sake of reviving a contract nobody has built against in the months
since it was proposed.

## Recommendation: Option 1

Two pull contracts already govern this stack: zuri-ai's own FR-100 decision
export, and Task 2's `gks_stage_evidence_export` cursor-pull. Option 1 adds a
third instance of the identical pattern — passive producer, cursor-owning
consumer, replay-safe by commit-time cursor assignment — rather than
introducing a second pattern (Option 2's relay-writer) or reviving a third,
uncoded one (Option 3). That is not a stylistic preference: **one pattern
audited three times** is cheaper and safer to reason about than three
different patterns each audited once, because every reviewer who has already
checked FR-100 or Task 2's export for replay-safety and scope-envelope
correctness already knows what to check here. Option 1 is also the only one
of the three that requires zero new organizational authority — it asks
nothing of MSP or GoVibe that they are not already positioned to do or
already declining to do.

## Named decision owners

**Boss + the GenesisBlockDB owner.** This brief's job ends at putting the
three options and their costs in front of them — GKS commits only to
building the export tool shape Option 1 describes, once someone with
authority over the GenesisBlockDB side agrees an importer will exist to pull
it.

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.1.0 | 2026-08-31 | draft | Initial decision brief. Names the three blocked stages (13 write side, 15, 16), states GKS's hard passive-producer constraint first, argues Options 1 (GBDB pulls from GKS), 2 (MSP relays), 3 (revive GoVibe ADR-025) with honest costs, recommends Option 1 on the "one pattern audited three times" argument, and names Boss + the GenesisBlockDB owner as the decision owners. | working-tree | Claude Fable 5 |
