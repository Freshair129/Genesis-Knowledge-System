---
version: "0.1.1"
created_at: "2026-08-31T15:00:00+07:00,Claude Fable 5,working-tree"
last_update: "2026-08-31T16:00:00+07:00,Claude Fable 5"
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

This is not merely undecided, either: two already-approved zuri-ai artifacts
answer the same question in ways that contradict each other and contradict
the framing below. `ADR-043-FOUR-TIER-COGNITIVE-ARCHITECTURE.md` (Approved,
2026-08-22) draws `GKS --query-ir.v1--> GenesisBlockDB`, and its D2.3 has GKS
itself generating `query-ir.v1` requests — an outbound GKS call. `ADR-046`'s
own consequence line has GKS "becom[ing] another consumer of the same
[FR-100] export" — GKS initiating a pull toward zuri-ai, the opposite
direction from `Zuri / GoVibe -> MSP -> GKS`. No option below can be approved
while these stand unreconciled; each option's section states what it
requires of them.

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
`ADR-GKS-BOUNDARY.md` itself is explicit that this brief cannot settle the
question by naming a favorite: "GenesisBlockDB is not selected implicitly.
Any future integration between these separate systems requires its own ADR,
adapter contract, and approval." Whatever the owners pick below, their
decision's deliverable is that ADR, that adapter contract, and that
approval — not merely a preference recorded in this brief.

## Option 1 — GenesisBlockDB pulls from GKS

Stated longhand, the way the ledger ADR states its own pull: the recommended
path is `GenesisBlockDB -> MSP -> gks_graph_decision_export`. MSP stays the
only governed caller of GKS — `ADR-GKS-BOUNDARY.md`'s own acceptance
criterion — with **no boundary change required**. A direct `GenesisBlockDB ->
GKS` call instead, skipping MSP, would require amending `ADR-GKS-BOUNDARY.md`
itself; that is a different, larger decision with a different cost, and the
owners must know which one they are approving. Adopting this option also
obligates amending `ADR-043`'s approved `GKS --query-ir.v1--> GenesisBlockDB`
arrow (D2.3: GKS generating outbound query-IR requests) — that arrow is a
live, approved contradiction of this option's passive-producer stance and
cannot be left standing alongside it.

GKS exposes a new registry tool, `gks_graph_decision_export({ scope,
since_cursor })`, inheriting the properties `docs/ADR-GKS-LEDGER-REPORTING.md`
decided for `gks_stage_evidence_export` (Task 2's cursor-pull) — itself
`status: proposed`, decided but not yet built or approved, so this inherits a
design, not a working precedent: registry-registered through
`packages/gks-contracts`, scope-enveloped with no wildcard scope, cursors
assigned at commit time so a puller can lag but never permanently skip a row,
and no reliance on `GKS_DEFAULT_PORTFOLIO_ID`. The GenesisBlockDB side owns
its cursor and its idempotent apply — the same division of labor FR-100 and
Task 2's export use. Cheapest change for GKS: no new outbound call, no new
dependency, one more read-only tool next to one already designed in the same
shape. **Overlap to resolve, not this brief's call:** Stage 13's per-edge
decision record already has a decided home — the `records` child array
`docs/ADR-GKS-LEDGER-REPORTING.md` D2 assigns to Stage 13 rows on
`gks_stage_evidence_export`. Option 1 must either extend that export instead
of adding a second tool, or justify why a second tool is warranted; that
choice belongs to whoever accepts the ledger ADR. **Cost:** requires a
GBDB-side importer to exist, and none does yet — this option does not build
it, only names the shape it should take.

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
as the write path. **Honest cost:** that ADR has had zero adapter code in the
28 days since it was proposed (2026-08-03), and the absence is enforced, not
incidental. GoVibe's own conformance suite carries a live test forbidding
this exact path: `entitlement-runtime-conformance.test.mjs` #64
("conformance: no adapter path to GKS or GenesisBlockDB",
`packages/govibe-core/src/entitlement-runtime-conformance.test.mjs:296`)
asserts `not.toMatch(/genesisblockdb/i)` across every entitlement-runtime
module (line 308), and `provider-adapter-host.test.mjs:329` enforces the same
assertion on the adapter host itself. zuri-ai's own ADR-009 records GoVibe as
"never a live Zuri dependency" — one-time bootstrap only — with ADR-024
("zuri-ai Is a Standalone Product") the decision that drew that line. Building
a live write path through GoVibe would re-couple what ADR-009 and ADR-024
decoupled, and would require deliberately loosening another repo's own
enforced invariant, not merely writing new code against an open contract.

## Recommendation: Option 1

One pull contract already governs this stack in production — zuri-ai's own
FR-100 decision export. A second, `gks_stage_evidence_export`, is decided but
not yet built or approved (`docs/ADR-GKS-LEDGER-REPORTING.md`, status
`proposed`). Option 1 adds a third instance of the identical pattern —
passive producer, cursor-owning consumer, replay-safe by commit-time cursor
assignment — rather than introducing a second pattern (Option 2's
relay-writer) or reviving a third, uncoded one (Option 3). That is not a
stylistic preference: **one pattern audited three times** is cheaper and
safer to reason about than three different patterns each audited once,
because every reviewer who has already checked FR-100's design, and will
check Task 2's export, for replay-safety and scope-envelope correctness
already knows what to check here — a claim conditional on
`ADR-GKS-LEDGER-REPORTING.md`'s Option B actually being accepted; if it is
not, this argument has only FR-100 as a working precedent, not two. Option 1
is also the only one of the three that requires zero new organizational
authority — it asks
nothing of MSP or GoVibe that they are not already positioned to do or
already declining to do.

## Named decision owners

**Boss + the GenesisBlockDB owner.** ADR-025's own frontmatter lists its
owner as "Boss / ARCHON / ATHER" — three names, not one — so identifying the
single person with actual decision authority over the GenesisBlockDB side is
step one of convening this decision, not a given already satisfied by this
brief. Past that, this brief's job ends at putting the three options and
their costs in front of them — GKS commits only to building the export tool
shape Option 1 describes, once someone with authority over the GenesisBlockDB
side agrees an importer will exist to pull it.

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.1.1 | 2026-08-31 | draft | RKOI's review folded in — 2 Critical, 4 Important, 3 Minor. Option 1 now states its inbound path longhand (`GenesisBlockDB -> MSP -> gks_graph_decision_export`, no boundary change) and names the boundary-amendment cost of a direct GBDB→GKS call as a separate, larger decision. Added the two approved zuri-ai artifacts that already answer this question the other way — ADR-043's approved `GKS --query-ir.v1--> GenesisBlockDB` arrow and ADR-046's "GKS becomes another consumer" pull — and stated that no option can be approved while they stand unreconciled. Qualified `gks_stage_evidence_export` and its "two pull contracts already govern this stack" claim as one built precedent (FR-100) plus one proposed-not-built design, making the "one pattern audited three times" argument conditional on the ledger ADR's acceptance. Cited `ADR-GKS-BOUNDARY.md`'s own "not selected implicitly... requires its own ADR, adapter contract, and approval" clause. Named the overlap between Option 1's export and the ledger ADR's Stage 13 `records` array as a choice for whoever accepts that ADR. Strengthened Option 3's cost with GoVibe's enforced conformance tests (`entitlement-runtime-conformance.test.mjs` #64, `provider-adapter-host.test.mjs`) forbidding a GKS/GenesisBlockDB adapter path. Fixed the decoupling attribution to ADR-009/ADR-024 (not ADR-042) and the ADR-025 age to 28 days (not "months"). Named identifying the single GenesisBlockDB decision owner — ADR-025's owner field lists three names — as step one of convening this decision. | working-tree | Claude Fable 5 |
| 0.1.0 | 2026-08-31 | draft | Initial decision brief. Names the three blocked stages (13 write side, 15, 16), states GKS's hard passive-producer constraint first, argues Options 1 (GBDB pulls from GKS), 2 (MSP relays), 3 (revive GoVibe ADR-025) with honest costs, recommends Option 1 on the "one pattern audited three times" argument, and names Boss + the GenesisBlockDB owner as the decision owners. | working-tree | Claude Fable 5 |
