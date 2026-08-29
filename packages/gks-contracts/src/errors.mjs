export class GksError extends Error {
  constructor(message, code) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
  }
}

export class GksInvalidRequestError extends GksError {
  constructor(message = "GKS request is invalid.") {
    super(message, "gks_invalid_request");
  }
}

export class GksScopeDeniedError extends GksError {
  constructor(message = "GKS scope denied.") {
    super(message, "gks_scope_denied");
  }
}

export class GksConflictError extends GksError {
  constructor(message = "GKS canonical conflict.") {
    super(message, "gks_conflict");
  }
}

// ADR-GKS-ENTITY-RESOLUTION decision 5: an entity INSERT that loses the
// UNIQUE(scope_key, norm_key) race surfaces to the caller as this typed
// conflict, carrying the winning row, so gks-core can retry the envelope
// and return MATCHED against the winner instead of over-splitting. It is
// still a gks_conflict on the wire; the subclass exists so the retry path
// can distinguish it from an idempotency conflict, which is never retried.
export class GksNormKeyConflictError extends GksConflictError {
  constructor(message = "An entity with this normalization key already exists in scope.", { candidateRef = null, normKey = null, winner = null } = {}) {
    super(message);
    this.candidateRef = candidateRef;
    this.normKey = normKey;
    this.winner = winner;
  }
}

export class GksBackendUnconfiguredError extends GksError {
  constructor(message = "GKS persistence is not configured.") {
    super(message, "gks_backend_unconfigured");
  }
}

export class GksBackendUnavailableError extends GksError {
  constructor(message = "GKS persistence is unavailable.") {
    super(message, "gks_backend_unavailable");
  }
}

export class GksInvalidBackendResponseError extends GksError {
  constructor(message = "GKS persistence returned an invalid response.") {
    super(message, "gks_invalid_backend_response");
  }
}
