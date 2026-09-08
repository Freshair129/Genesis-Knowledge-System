---
version: "0.3.0b"
created_at: "2026-08-12T10:05:34+07:00,ATHER,working-tree"
last_update: "2026-09-08T00:30:00+07:00,RWANG"
status: "beta"
approval_owner: "Boss (บอส)"
approval_recorded_at: "2026-08-12T10:16:19+07:00"
superseded_by: null
attributes:
  domain: "gks-service-extraction"
  doc_type: "architecture-decision"
  scope: "configured GKS/MSP boundary, GoVibe compatibility, and Zuri consumers"
---

# ADR: Standalone GKS Service Boundary

## Decision status

The standalone boundary was approved for implementation by the owner in
revision 0.1.2b. This ADR records that boundary and authorizes no later
migration, cutover, deletion, release, or promotion by itself.

## Context

GoVibe already defines the authority chain in which GoVibe produces governed
candidate semantics, MSP owns memory/context and promotion mediation, and GKS
owns canonical knowledge identity and relations. MSP has now been extracted to
the configured MSP root as a standalone runtime while compatible MSP surfaces
remain in the configured GoVibe root.

The next extraction must follow the same meaning: **form a standalone GKS
service without erasing GKS or MSP integration surfaces from GoVibe**.

Current evidence also distinguishes GKS from GenesisBlockDB:

- GKS is the logical knowledge/relation authority.
- GenesisBlockDB is a separate graph/vector database engine and repository.
- GenesisBlockDB is not the source repository, implementation owner, or assumed
  persistence backend of the extracted GKS service.
- The current MSP bridge calls a typed GKS promotion tool over NDJSON stdio.
- GoVibe must not call GKS directly.

## Decision

Create the configured GKS root as the standalone GKS service authority.

```text
Zuri ---------------------> MSP service (configured MSP root)
GoVibe -------------------> MSP service (configured MSP root)
                                  |
                                  v
                           GKS service (configured GKS root)
                                  |
                                  v
                       GKS PersistencePort
                                  |
                                  v
                   selected GKS-owned persistence
```

The runtime authority and call direction are:

```text
GoVibe < MSP < GKS
Zuri   < MSP < GKS
```

`<` means the caller has less knowledge/promotion authority than the service to
its right. It does not mean source code must be deleted from the caller's repo.

### Ownership

| Boundary | Owns | Must not own |
|---|---|---|
| GoVibe | candidate production, validation, orchestration, compatibility clients, project-local knowledge material | canonical GKS identity, GKS credentials, direct GKS access |
| MSP | memory/context, scope, policy, candidate review state, promotion authorization, context assembly, receipts | canonical semantic identity or backend storage implementation |
| GKS | canonical entities, relations, deduplication, graph revision, candidate-to-canonical mapping, knowledge query policy enforcement | Zuri transactions, conversational memory, agent-turn context assembly |
| Zuri | business/project/transaction truth and references to MSP/GKS outputs | memory truth or canonical semantic graph truth |

### Repository rule

- The configured GKS root owns GKS service runtime, public contracts, canonicalization logic,
  backend ports, and service-level tests.
- The configured MSP root keeps its GKS provider/client boundary and remains the sole governed
  runtime caller of GKS.
- The configured GoVibe root keeps MSP/GKS names, contracts, disabled direct-GKS shim,
  fixtures, docs, and project-local `.govibe-knowledge-block` as required for
  compatibility and rollback.
- `.govibe-knowledge-block` is not automatically moved into the GKS root. It is a
  source/candidate corpus and may enter GKS only through a governed import and
  MSP authorization flow.
- GKS persistence is selected and governed inside the GKS boundary.
  GenesisBlockDB is not selected implicitly. Any future integration between
  these separate systems requires its own ADR, adapter contract, and approval.

## Compatibility decision

Extraction and consumer cutover are separate gates. The first implementation
may create a behavior-compatible standalone GKS server while GoVibe
compatibility surfaces remain present. Deletion or consolidation
requires independent usage evidence and owner authorization.

The existing `gks_knowledge_promote` request/response defined by GoVibe
API-010 must remain wire compatible during extraction.

## Alternatives rejected

1. **Remove all GKS/MSP material from GoVibe.** Rejected because it breaks
   compatibility, rollback, documentation traceability, and the user's stated
   extraction model.
2. **Rename, copy, or treat GenesisBlockDB as GKS.** Rejected because it is a
   separate repository and product, not the GKS extraction source.
3. **Let Zuri or GoVibe call GKS directly.** Rejected because it bypasses MSP
   scope, context, and promotion authority.
4. **Add multiple canonical stores inside GKS.** Rejected because it creates
   dual truth. Test fakes are permitted; production fallback storage is not.

## Change classification

- Complexity: `C-3`
- Required capability ceiling: `H4` for cross-repository cutover; bounded local
  implementation may use `H3` after explicit approval.
- Risk: `HIGH`
- Primary risks: authority bypass, duplicate canonical state, protocol drift,
  cross-scope leakage, dirty-worktree overwrite, and false cutover claims.

## Acceptance criteria

- MSP is the only governed caller of GKS in the Zuri/GoVibe path.
- GKS owns canonical identity and relations without owning MSP memory/context.
- GKS owns one explicit persistence boundary without an implied dependency on
  GenesisBlockDB.
- Existing API-010 promotion fixtures pass unchanged against the standalone
  server.
- GoVibe compatibility surfaces remain available until a separate cutover and
  retirement decision.
- No production fallback fabricates `gks:` references when GKS or its backend
  is unavailable.

## Approval gate

The initial implementation gate was satisfied by the owner acceptance recorded
in revision 0.1.2b. GenesisRAG17 uses its own frozen contract and stage ADRs;
deployment cutover, deletion and production release remain separate gates.

## Implementation evidence

Implemented in the configured GKS root as separate server, contracts, core, client, persistence,
migrations, and test packages. The configured MSP provider and full MSP service
provider and full MSP service chain pass against this standalone process. No
GoVibe, MSP, or GenesisBlock
runtime source was copied into the GKS implementation.

## GenesisRAG17 boundary

The additive `genesisrag17.v1` pipeline keeps MSP as the sole GKS caller. GKS
owns stages 9–14 and 17; Tier 4 supplies the physical graph, embedding and
index receipts for stages 13, 15 and 16. The immutable decision, graph receipt
then Stage 14 ordering, separate pipeline evidence stream, and post-publication
query boundary are recorded in [`ADR-GKS-GENESISRAG17.md`](ADR-GKS-GENESISRAG17.md)
and [`TIER-BOUNDARY-17-STAGE.md`](TIER-BOUNDARY-17-STAGE.md).

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.3.0b | 2026-09-08 | beta | Reconciled the accepted standalone boundary with configured deployment roots, the implemented GKS/MSP boundary, and the additive GenesisRAG17 stage ownership and receipt boundary. | 9279cfe | RWANG |
| 0.2.0b | 2026-08-12 | beta | Recorded implementation of the approved standalone boundary and external MSP compatibility evidence. | working-tree | ATHER |
| 0.1.2b | 2026-08-12 | beta | Owner approved the standalone GKS boundary for implementation. | working-tree | Boss (บอส) / ATHER |
| 0.1.1b | 2026-08-12 | draft | Clarified that GenesisBlockDB is a separate repository/product and is not the GKS source or an assumed backend. | working-tree | ATHER |
| 0.1.0b | 2026-08-12 | draft | Proposed standalone GKS extraction while retaining GoVibe compatibility surfaces. | working-tree | ATHER |
