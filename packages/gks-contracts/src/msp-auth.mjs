import crypto from "node:crypto";
import { GksBackendUnconfiguredError, GksScopeDeniedError } from "./errors.mjs";
import { resolvePromotionScope, validateScope } from "./validation.mjs";

export const GKS_MSP_AUTH_VERSION = "gks-msp-auth/v1";
export const GKS_MSP_PRINCIPAL_ID = "msp-runtime";

export const LEGACY_MSP_AUTH_TOOLS = Object.freeze([
  "gks_knowledge_promote",
  "gks_search",
  "gks_entity_get",
  "gks_relations_get",
  "gks_artifact_link",
  "gks_review_list",
  "gks_review_apply",
  "gks_stage_evidence_export",
]);

const LEGACY_MSP_AUTH_TOOL_SET = new Set(LEGACY_MSP_AUTH_TOOLS);

export function requiresLegacyMspAuth(toolName) {
  return LEGACY_MSP_AUTH_TOOL_SET.has(toolName);
}

export function normalizedMspScope(toolName, args = {}, defaultPortfolioId) {
  if (toolName === "gks_knowledge_promote") return resolvePromotionScope(args, defaultPortfolioId);
  return validateScope(args.scope);
}

export function mspScopeDigest(scope) {
  const normalized = validateScope(scope);
  const canonical = [
    normalized.portfolioId,
    normalized.tenantId,
    normalized.businessId,
    normalized.workspaceId,
    normalized.projectId,
    normalized.sharing,
  ].join("\u0000");
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}

function equalSecret(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && crypto.timingSafeEqual(leftBytes, rightBytes);
}

export function authorizeLegacyMspRequest(meta, { toolName, args, defaultPortfolioId, relayCredential } = {}) {
  if (typeof relayCredential !== "string" || !relayCredential) {
    throw new GksBackendUnconfiguredError("GKS_MSP_RELAY_CREDENTIAL is not configured.");
  }
  const auth = meta?.gksMspAuth;
  if (!auth || auth.version !== GKS_MSP_AUTH_VERSION || auth.principalId !== GKS_MSP_PRINCIPAL_ID || auth.role !== "msp") {
    throw new GksScopeDeniedError("Authenticated MSP transport is required.");
  }
  if (!equalSecret(auth.relayCredential, relayCredential)) throw new GksScopeDeniedError("Authenticated MSP transport is invalid.");
  let scope;
  try {
    scope = normalizedMspScope(toolName, args, defaultPortfolioId);
  } catch {
    throw new GksScopeDeniedError("Authenticated MSP transport scope is invalid.");
  }
  if (typeof auth.scopeDigest !== "string" || auth.scopeDigest !== mspScopeDigest(scope)) {
    throw new GksScopeDeniedError("Authenticated MSP transport scope does not match the request.");
  }
  return scope;
}
