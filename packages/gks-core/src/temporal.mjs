// @req FR-109 — map Stage 12 temporal semantics without a runtime MSP dependency.
// @spec ADR-GKS-TEMPORAL-MAP.md
// @tested tests/contract/temporal-engine-parity.test.mjs

// GenesisRAG17 Stage 12 keeps a source-controlled temporal port. The pinned
// provenance and parity baseline live in ADR-GKS-TEMPORAL-MAP.md; this module
// deliberately has no runtime dependency on MSP.

export function createTemporalVersion(input = {}, now = new Date().toISOString()) {
  return {
    version: String(input.version ?? "1"),
    validFrom: input.validFrom || now,
    validTo: input.validTo || undefined,
    recordedAt: input.recordedAt || now,
    supersededAt: input.supersededAt || undefined,
  };
}

export function isTemporalVisible(item = {}, options = {}) {
  const asOfValidAt = Date.parse(options.asOfValidAt ?? new Date().toISOString());
  const asOfRecordedAt = Date.parse(options.asOfRecordedAt ?? new Date().toISOString());
  const validFrom = Date.parse(item.validFrom ?? item.recordedAt ?? new Date(0).toISOString());
  const validTo = item.validTo ? Date.parse(item.validTo) : undefined;
  const recordedAt = Date.parse(item.recordedAt ?? new Date(0).toISOString());
  const supersededAt = item.supersededAt ? Date.parse(item.supersededAt) : undefined;

  if ([asOfValidAt, asOfRecordedAt, validFrom, recordedAt].some((value) => Number.isNaN(value))) return false;
  if (asOfValidAt < validFrom) return false;
  if (validTo !== undefined && !Number.isNaN(validTo) && asOfValidAt > validTo) return false;
  if (asOfRecordedAt < recordedAt) return false;
  if (supersededAt !== undefined && !Number.isNaN(supersededAt) && asOfRecordedAt >= supersededAt) return false;
  return true;
}

export function compareTemporalOrder(item = {}) {
  const errors = [];
  const validFrom = item.validFrom ? Date.parse(item.validFrom) : undefined;
  const validTo = item.validTo ? Date.parse(item.validTo) : undefined;
  const recordedAt = item.recordedAt ? Date.parse(item.recordedAt) : undefined;
  const supersededAt = item.supersededAt ? Date.parse(item.supersededAt) : undefined;

  if (validFrom !== undefined && Number.isNaN(validFrom)) errors.push("validFrom is not a valid ISO timestamp.");
  if (validTo !== undefined && Number.isNaN(validTo)) errors.push("validTo is not a valid ISO timestamp.");
  if (recordedAt !== undefined && Number.isNaN(recordedAt)) errors.push("recordedAt is not a valid ISO timestamp.");
  if (supersededAt !== undefined && Number.isNaN(supersededAt)) errors.push("supersededAt is not a valid ISO timestamp.");
  if (validFrom !== undefined && validTo !== undefined && !Number.isNaN(validFrom) && !Number.isNaN(validTo) && validFrom > validTo) errors.push("validFrom must be before or equal to validTo.");
  if (recordedAt !== undefined && supersededAt !== undefined && !Number.isNaN(recordedAt) && !Number.isNaN(supersededAt) && recordedAt > supersededAt) errors.push("recordedAt must be before or equal to supersededAt.");
  return errors;
}

export function nextVersion(records = []) {
  const numeric = records.map((record) => Number(record.version)).filter((value) => Number.isFinite(value));
  return String((numeric.length ? Math.max(...numeric) : 0) + 1);
}

export function temporalFromFactRow(row = {}) {
  const map = (value) => value === "not_applicable" ? undefined : value;
  return {
    version: row.version,
    validFrom: map(row.valid_from ?? row.validFrom),
    validTo: map(row.valid_to ?? row.validTo),
    recordedAt: row.tx_from ?? row.recordedAt,
    supersededAt: row.tx_to ?? row.supersededAt,
  };
}
