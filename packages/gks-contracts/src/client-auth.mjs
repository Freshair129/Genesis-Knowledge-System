import crypto from "node:crypto";
import { GksScopeDeniedError } from "./errors.mjs";
import { validateScope } from "./validation.mjs";

export const GKS_CLIENT_GRANTS_VERSION = "gks-client-grants/v1";
export const GKS_DIRECT_READ_TOOLS = Object.freeze([
  "gks_search",
  "gks_entity_get",
  "gks_relations_get",
]);

const DIRECT_READ_TOOL_SET = new Set(GKS_DIRECT_READ_TOOLS);
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
  if (document.schemaVersion !== GKS_CLIENT_GRANTS_VERSION || !Array.isArray(document.clients)) {
    throw new TypeError("GKS client grants document is invalid.");
  }

  const seenCredentialHashes = new Set();
  const grants = document.clients.map((entry) => {
    const entryFields = new Set(["clientId", "credentialSha256", "allowedTools", "scopes"]);
    if (!isRecord(entry) || !hasOnlyKeys(entry, entryFields)) throw new TypeError("GKS client grant entry is invalid.");
    if (typeof entry.clientId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(entry.clientId) || entry.clientId === "msp-runtime") {
      throw new TypeError("GKS client grant entry is invalid.");
    }
    if (typeof entry.credentialSha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.credentialSha256) || seenCredentialHashes.has(entry.credentialSha256)) {
      throw new TypeError("GKS client grant entry is invalid.");
    }
    seenCredentialHashes.add(entry.credentialSha256);
    if (!Array.isArray(entry.allowedTools) || entry.allowedTools.length === 0
      || entry.allowedTools.some((tool) => typeof tool !== "string" || !DIRECT_READ_TOOL_SET.has(tool))
      || new Set(entry.allowedTools).size !== entry.allowedTools.length) {
      throw new TypeError("GKS client grant entry is invalid.");
    }
    if (!Array.isArray(entry.scopes) || entry.scopes.length === 0) throw new TypeError("GKS client grant entry is invalid.");

    const scopes = entry.scopes.map((input) => {
      if (!isRecord(input) || !hasOnlyKeys(input, SCOPE_INPUT_FIELDS)) throw new TypeError("GKS client grant scope is invalid.");
      return Object.freeze(validateScope(input));
    });
    const scopeSignatures = scopes.map(scopeSignature);
    if (new Set(scopeSignatures).size !== scopeSignatures.length) throw new TypeError("GKS client grant entry is invalid.");

    return Object.freeze({
      clientId: entry.clientId,
      credentialSha256: entry.credentialSha256,
      allowedTools: Object.freeze([...entry.allowedTools]),
      scopes: Object.freeze(scopes),
      scopeSignatures: Object.freeze(scopeSignatures),
    });
  });
  return Object.freeze(grants);
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

export function authorizeGksClientRequest(grant, { toolName, args } = {}) {
  if (!grant || !grant.allowedTools.includes(toolName)) {
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
