import { describe, expect, it } from "vitest";
import {
  GKS_CLIENT_GRANTS_VERSION,
  authorizeGksClientRequest,
  findGksClientGrant,
  hashGksClientCredential,
  isGksClientCredential,
  parseGksClientGrants,
} from "@freshair129/gks-contracts";

const credential = `gksc_${Buffer.alloc(32, 42).toString("base64url")}`;
const scope = {
  portfolioId: "portfolio-test",
  tenantId: "tenant-a",
  businessId: "business-a",
  workspaceId: "workspace-a",
  projectId: "project-a",
  sharing: "workspace",
};

function document(overrides = {}) {
  return {
    schemaVersion: GKS_CLIENT_GRANTS_VERSION,
    clients: [{
      clientId: "system-a",
      credentialSha256: hashGksClientCredential(credential),
      allowedTools: ["gks_search"],
      scopes: [scope],
      ...overrides,
    }],
  };
}

describe("GKS direct-client grants", () => {
  it("accepts a canonical 256-bit bearer credential and resolves its server-side grant", () => {
    expect(isGksClientCredential(credential)).toBe(true);
    const grants = parseGksClientGrants(JSON.stringify(document()));
    expect(findGksClientGrant(credential, grants)).toMatchObject({ clientId: "system-a", allowedTools: ["gks_search"] });
    expect(findGksClientGrant(`${credential}x`, grants)).toBeNull();
    expect(findGksClientGrant(`gksc_${"A".repeat(43)}`, grants)).toBeNull();
  });

  it("fails closed for malformed, duplicated, or over-privileged grants", () => {
    expect(() => parseGksClientGrants("not-json")).toThrow(/document is invalid/);
    expect(() => parseGksClientGrants({ ...document(), extra: true })).toThrow(/document is invalid/);
    expect(() => parseGksClientGrants(document({ allowedTools: ["gks_knowledge_promote"] }))).toThrow(/grant entry is invalid/);
    expect(() => parseGksClientGrants(document({ credentialSha256: "not-a-digest" }))).toThrow(/grant entry is invalid/);
    expect(() => parseGksClientGrants({ ...document(), clients: [document().clients[0], document().clients[0]] })).toThrow(/grant entry is invalid/);
  });

  it("authorizes only a granted read tool and the exact normalized scope", () => {
    const grant = findGksClientGrant(credential, parseGksClientGrants(document()));
    expect(authorizeGksClientRequest(grant, { toolName: "gks_search", args: { scope, query: "term" } })).toEqual(scope);
    expect(() => authorizeGksClientRequest(grant, { toolName: "gks_knowledge_promote", args: { scope } })).toThrow(/action is not authorized/);
    expect(() => authorizeGksClientRequest(grant, { toolName: "gks_search", args: { scope: { ...scope, tenantId: "tenant-b" } } })).toThrow(/scope is not authorized/);
    expect(() => authorizeGksClientRequest(grant, { toolName: "gks_search", args: {} })).toThrow(/scope is not authorized/);
  });
});
