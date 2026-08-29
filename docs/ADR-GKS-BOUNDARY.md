---
version: "0.2.0b"
created_at: "2026-08-12T10:05:34+07:00,ATHER,working-tree"
last_update: "2026-08-12T10:31:21+07:00,ATHER"
status: "beta"
approval_owner: "Boss (บอส)"
approval_recorded_at: "2026-08-12T10:16:19+07:00"
superseded_by: null
attributes:
  domain: "gks-service-extraction"
  doc_type: "architecture-decision"
  scope: "D:/gks; D:/msp; G:/govibe; Zuri consumers"
---

# ADR: Standalone GKS Service Boundary

## Decision status

Draft for owner review. This document authorizes no implementation, migration,
cutover, deletion, release, or promotion by itself.

## Context

GoVibe already defines the authority chain in which GoVibe produces governed
candidate semantics, MSP owns memory/context and promotion mediation, and GKS
owns canonical knowledge identity and relations. MSP has now been extracted to
`D:\msp` as a standalone runtime candidate while the compatible MSP surfaces
remain in `G:\govibe`.

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

Create `D:\gks` as the standalone GKS service authority.

```text
Zuri ---------------------> MSP service (D:\msp)
GoVibe -------------------> MSP service (D:\msp)
                                  |
                                  v
                           GKS service (D:\gks)
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

- `D:\gks` owns GKS service runtime, public contracts, canonicalization logic,
  backend ports, and service-level tests.
- `D:\msp` keeps its GKS provider/client boundary and remains the sole governed
  runtime caller of GKS.
- `G:\govibe` keeps MSP/GKS names, contracts, disabled direct-GKS shim,
  fixtures, docs, and project-local `.govibe-knowledge-block` as required for
  compatibility and rollback.
- `.govibe-knowledge-block` is not automatically moved into `D:\gks`. It is a
  source/candidate corpus and may enter GKS only through a governed import and
  MSP authorization flow.
- GKS persistence is selected and governed inside the `D:\gks` boundary.
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

Implementation starts only after the owner accepts this boundary and the three
peer contracts in this document set.

## Implementation evidence

Implemented in `D:\gks` as separate server, contracts, core, client, persistence,
migrations, and test packages. The actual `D:\msp` provider and full MSP service
chain pass against this standalone process. No GoVibe, MSP, or GenesisBlock
runtime source was copied into the GKS implementation.

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.2.0b | 2026-08-12 | beta | Recorded implementation of the approved standalone boundary and external MSP compatibility evidence. | working-tree | ATHER |
| 0.1.2b | 2026-08-12 | beta | Owner approved the standalone GKS boundary for implementation. | working-tree | Boss (บอส) / ATHER |
| 0.1.1b | 2026-08-12 | draft | Clarified that GenesisBlockDB is a separate repository/product and is not the GKS source or an assumed backend. | working-tree | ATHER |
| 0.1.0b | 2026-08-12 | draft | Proposed standalone GKS extraction while retaining GoVibe compatibility surfaces. | working-tree | ATHER |
