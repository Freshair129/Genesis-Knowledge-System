import path from "node:path";
import readline from "node:readline";
import { GKS_TOOL_DEFINITIONS } from "@freshair129/gks-contracts";
import { createGksService } from "@freshair129/gks-core";
import { openSqlitePersistence } from "@freshair129/gks-persistence";

export const GKS_TOOLS = GKS_TOOL_DEFINITIONS;

export function createRuntimeFromEnvironment(env = process.env) {
  const dbPath = env.GKS_DB_PATH?.trim();
  if (!dbPath || !path.isAbsolute(dbPath)) throw new Error("GKS_DB_PATH must be an explicit absolute path.");
  const persistence = openSqlitePersistence({ dbPath });
  return {
    persistence,
    service: createGksService({ persistence, defaultPortfolioId: env.GKS_DEFAULT_PORTFOLIO_ID?.trim() || undefined }),
    close() {
      persistence.close();
    },
  };
}

function toolHandler(service, name) {
  const handlers = {
    gks_health: (args) => service.health(args),
    gks_knowledge_promote: (args) => service.promoteCandidate(args),
    gks_search: (args) => service.search(args),
    gks_entity_get: (args) => service.getEntity(args),
    gks_relations_get: (args) => service.getRelations(args),
    gks_artifact_link: (args) => service.linkArtifact(args),
  };
  return handlers[name];
}

export function runStdioServer({ env = process.env, input = process.stdin, output = process.stdout } = {}) {
  const runtime = createRuntimeFromEnvironment(env);
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    runtime.close();
  }
  function send(message) {
    output.write(`${JSON.stringify(message)}\n`);
  }
  lines.on("line", async (line) => {
    if (!line.trim()) return;
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    if (request.method === "notifications/initialized") return;
    if (request.id === undefined) return;
    if (request.method === "initialize") {
      send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "gks-server", version: "0.1.0" } } });
      return;
    }
    if (request.method === "tools/list") {
      send({ jsonrpc: "2.0", id: request.id, result: { tools: GKS_TOOLS } });
      return;
    }
    if (request.method !== "tools/call") {
      send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } });
      return;
    }
    const handler = toolHandler(runtime.service, request.params?.name);
    if (!handler) {
      send({ jsonrpc: "2.0", id: request.id, result: { isError: true, content: [{ type: "text", text: "Unknown GKS tool." }], structuredContent: { code: "gks_invalid_request", message: "Unknown GKS tool." } } });
      return;
    }
    try {
      const structuredContent = await handler(request.params?.arguments ?? {});
      send({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent } });
    } catch (error) {
      const structuredContent = { code: error.code ?? "gks_backend_unavailable", message: error.message };
      send({ jsonrpc: "2.0", id: request.id, result: { isError: true, content: [{ type: "text", text: error.message }], structuredContent } });
    }
  });
  lines.on("close", close);
  return { close: () => { lines.close(); close(); } };
}
