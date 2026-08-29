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
