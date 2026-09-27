import crypto from "node:crypto";
import { GksScopeDeniedError } from "./errors.mjs";
import { GKS_MSP_PRINCIPAL_ID, LEGACY_MSP_AUTH_TOOLS, mspScopeDigest, normalizedMspScope } from "./msp-auth.mjs";
import { validateScope } from "./validation.mjs";

export const GKS_CLIENT_GRANTS_VERSION = "gks-client-grants/v1";
// v2 adds the governed profile (ADR-GKS-GOVERNED-CALLERS D2); v1 documents
// keep parsing, every entry being a read grant.
export const GKS_CLIENT_GRANTS_VERSION_V2 = "gks-client-grants/v2";
export const GKS_CALLER_AUTH_VERSION = "gks-caller-auth/v1";
export const GKS_DIRECT_READ_TOOLS = Object.freeze([
  "gks_search",
  "gks_entity_get",
  "gks_relations_get",
]);
// A governed caller may be granted any of the legacy knowledge tools MSP uses;
// pipeline tools are out of scope (ADR-GKS-GOVERNED-CALLERS D8).
export const GKS_GOVERNED_TOOLS = LEGACY_MSP_AUTH_TOOLS;
// The built-in governed caller's provenance namespace; reserved.
export const GKS_MSP_PROVENANCE_NAMESPACE = "msp";
// The built-in governed caller (ADR-GKS-GOVERNED-CALLERS D1): every call that
// did not come from a provisioned governed grant is MSP's.
export const GKS_MSP_CALLER = Object.freeze({ callerId: GKS_MSP_PRINCIPAL_ID, provenanceNamespace: GKS_MSP_PROVENANCE_NAMESPACE });

const DIRECT_READ_TOOL_SET = new Set(GKS_DIRECT_READ_TOOLS);
const GOVERNED_TOOL_SET = new Set(GKS_GOVERNED_TOOLS);
const NAMESPACE_PATTERN = /^[a-z][a-z0-9-]{0,30}$/;
const CLIENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CLIENT_CREDENTIAL_PATTERN = /^gksc_[A-Za-z0-9_-]{43}$/;
const SCOPE_FIELDS = Object.freeze([
  "portfolioId",
  "tenantId",
  "businessId",
  "workspaceId",
  "projectId",
  "sharing",
]);
const SCOPE_INPUT_FIELDS = new Set(SCOPE_FIELDS);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function scopeSignature(scope) {
  return JSON.stringify(SCOPE_FIELDS.map((field) => scope[field]));
}

export function isGksClientCredential(value) {
  if (typeof value !== "string" || !CLIENT_CREDENTIAL_PATTERN.test(value)) return false;
  const encoded = value.slice("gksc_".length);
  const decoded = Buffer.from(encoded, "base64url");
  return decoded.length === 32 && decoded.toString("base64url") === encoded;
}

export function hashGksClientCredential(credential) {
  if (!isGksClientCredential(credential)) throw new TypeError("GKS client credential format is invalid.");
  return crypto.createHash("sha256").update(credential, "utf8").digest("hex");
}

export function parseGksClientGrants(raw) {
  let document = raw;
  if (typeof raw === "string") {
    try {
      document = JSON.parse(raw);
    } catch {
      throw new TypeError("GKS client grants document is invalid.");
    }
  }
  if (!isRecord(document) || !hasOnlyKeys(document, new Set(["schemaVersion", "clients"]))) {
    throw new TypeError("GKS client grants document is invalid.");
  }
  const version = document.schemaVersion;
  if ((version !== GKS_CLIENT_GRANTS_VERSION && version !== GKS_CLIENT_GRANTS_VERSION_V2) || !Array.isArray(document.clients)) {
    throw new TypeError("GKS client grants document is invalid.");
  }

  const seenCredentialHashes = new Set();
  const seenClientIds = new Set();
  const seenNamespaces = new Set();
  const claimedPortfolios = new Set();
  const grants = document.clients.map((entry) => {
    if (!isRecord(entry)) throw new TypeError("GKS client grant entry is invalid.");
    // v1 entries carry no profile and are read grants.
    const profile = version === GKS_CLIENT_GRANTS_VERSION ? "read" : entry.profile;
    if (profile !== "read" && profile !== "governed") throw new TypeError("GKS client grant entry is invalid.");
    const entryFields = profile === "read"
      ? new Set([...(version === GKS_CLIENT_GRANTS_VERSION ? [] : ["profile"]), "clientId", "credentialSha256", "allowedTools", "scopes"])
      : new Set(["profile", "clientId", "credentialSha256", "allowedTools", "provenanceNamespace", "portfolioIds"]);
    if (!hasOnlyKeys(entry, entryFields)) throw new TypeError("GKS client grant entry is invalid.");
    if (typeof entry.clientId !== "string" || !CLIENT_ID_PATTERN.test(entry.clientId) || entry.clientId === GKS_MSP_PRINCIPAL_ID || seenClientIds.has(entry.clientId)) {
      throw new TypeError("GKS client grant entry is invalid.");
    }
    seenClientIds.add(entry.clientId);
    if (typeof entry.credentialSha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.credentialSha256) || seenCredentialHashes.has(entry.credentialSha256)) {
      throw new TypeError("GKS client grant entry is invalid.");
    }
    seenCredentialHashes.add(entry.credentialSha256);
    const toolSet = profile === "read" ? DIRECT_READ_TOOL_SET : GOVERNED_TOOL_SET;
    if (!Array.isArray(entry.allowedTools) || entry.allowedTools.length === 0
      || entry.allowedTools.some((tool) => typeof tool !== "string" || !toolSet.has(tool))
      || new Set(entry.allowedTools).size !== entry.allowedTools.length) {
      throw new TypeError("GKS client grant entry is invalid.");
    }
    const allowedTools = Object.freeze([...entry.allowedTools]);

    if (profile === "governed") {
      // ADR-GKS-GOVERNED-CALLERS D3/D5: a namespace and a portfolio each
      // belong to exactly one caller, and `msp` is reserved for MSP.
      const namespace = entry.provenanceNamespace;
      if (typeof namespace !== "string" || !NAMESPACE_PATTERN.test(namespace) || namespace === GKS_MSP_PROVENANCE_NAMESPACE || seenNamespaces.has(namespace)) {
        throw new TypeError("GKS client grant entry is invalid.");
      }
      seenNamespaces.add(namespace);
      if (!Array.isArray(entry.portfolioIds) || entry.portfolioIds.length === 0) throw new TypeError("GKS client grant entry is invalid.");
      for (const portfolioId of entry.portfolioIds) {
        if (typeof portfolioId !== "string" || !portfolioId || portfolioId !== portfolioId.trim() || portfolioId.length > 256 || claimedPortfolios.has(portfolioId)) {
          throw new TypeError("GKS client grant entry is invalid.");
        }
        claimedPortfolios.add(portfolioId);
      }
      return Object.freeze({
        profile,
        clientId: entry.clientId,
        credentialSha256: entry.credentialSha256,
        allowedTools,
        provenanceNamespace: namespace,
        portfolioIds: Object.freeze([...entry.portfolioIds]),
      });
    }

    if (!Array.isArray(entry.scopes) || entry.scopes.length === 0) throw new TypeError("GKS client grant entry is invalid.");
    const scopes = entry.scopes.map((input) => {
      if (!isRecord(input) || !hasOnlyKeys(input, SCOPE_INPUT_FIELDS)) throw new TypeError("GKS client grant scope is invalid.");
      return Object.freeze(validateScope(input));
    });
    const scopeSignatures = scopes.map(scopeSignature);
    if (new Set(scopeSignatures).size !== scopeSignatures.length) throw new TypeError("GKS client grant entry is invalid.");

    return Object.freeze({
      profile,
      clientId: entry.clientId,
      credentialSha256: entry.credentialSha256,
      allowedTools,
      scopes: Object.freeze(scopes),
      scopeSignatures: Object.freeze(scopeSignatures),
    });
  });
  return Object.freeze(grants);
}

/** Portfolios owned by a governed caller; MSP is denied them (D7). */
export function governedPortfolios(grants = []) {
  return new Set(grants.filter((grant) => grant.profile === "governed").flatMap((grant) => grant.portfolioIds));
}

export function findGksClientGrant(credential, grants = []) {
  if (!isGksClientCredential(credential) || !Array.isArray(grants)) return null;
  const digest = Buffer.from(hashGksClientCredential(credential), "hex");
  let match = null;
  for (const grant of grants) {
    const expected = Buffer.from(grant.credentialSha256, "hex");
    if (crypto.timingSafeEqual(digest, expected)) match = grant;
  }
  return match;
}

// The provenance fields a governed write carries, per tool.
const PROVENANCE_FIELDS = Object.freeze({
  gks_knowledge_promote: "provenance_ref",
  gks_review_apply: "provenanceRef",
  gks_artifact_link: "evidenceRef",
});

/**
 * ADR-GKS-GOVERNED-CALLERS D3-D5: authorizes one call from a governed caller.
 * The grant (resolved server-side from the bearer credential) decides the
 * tools, the portfolio boundary and the provenance namespace; the
 * `gksCallerAuth` envelope must name the same caller and bind the scope.
 * Returns the caller context the service records (D6).
 */
export function authorizeGovernedCallerRequest(grant, meta, { toolName, args, defaultPortfolioId } = {}) {
  if (!grant || grant.profile !== "governed" || !grant.allowedTools.includes(toolName)) {
    throw new GksScopeDeniedError("Governed caller action is not authorized.");
  }
  const auth = meta?.gksCallerAuth;
  if (!isRecord(auth) || auth.version !== GKS_CALLER_AUTH_VERSION || auth.callerId !== grant.clientId) {
    throw new GksScopeDeniedError("Governed caller authentication is invalid.");
  }
  let scope;
  try {
    scope = normalizedMspScope(toolName, args ?? {}, defaultPortfolioId);
  } catch {
    throw new GksScopeDeniedError("Governed caller scope is invalid.");
  }
  if (!grant.portfolioIds.includes(scope.portfolioId)) throw new GksScopeDeniedError("Governed caller scope is not authorized.");
  if (typeof auth.scopeDigest !== "string" || auth.scopeDigest !== mspScopeDigest(scope)) {
    throw new GksScopeDeniedError("Governed caller scope does not match the request.");
  }
  const field = PROVENANCE_FIELDS[toolName];
  if (field && !(typeof args?.[field] === "string" && args[field].startsWith(`${grant.provenanceNamespace}:proof/`))) {
    throw new GksScopeDeniedError(`${field} must be a ${grant.provenanceNamespace}:proof reference for this caller.`);
  }
  return Object.freeze({ callerId: grant.clientId, provenanceNamespace: grant.provenanceNamespace, scope });
}

export function authorizeGksClientRequest(grant, { toolName, args } = {}) {
  if (!grant || grant.profile === "governed" || !grant.allowedTools.includes(toolName)) {
    throw new GksScopeDeniedError("Direct GKS client action is not authorized.");
  }
  let scope;
  try {
    scope = validateScope(args?.scope);
  } catch {
    throw new GksScopeDeniedError("Direct GKS client scope is not authorized.");
  }
  if (!grant.scopeSignatures.includes(scopeSignature(scope))) {
    throw new GksScopeDeniedError("Direct GKS client scope is not authorized.");
  }
  return scope;
}
