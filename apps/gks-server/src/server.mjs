// @req FR-109, FR-110 — relay the authenticated GenesisRAG17 tool surface through stdio.
// @spec ADR-GKS-GENESISRAG17.md, docs/plans/GENESISRAG17-CONTRACT.md
// @tested tests/contract/server-dispatch.test.mjs, tests/integration/stdio-restart.test.mjs

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import { GKS_MSP_CALLER, GKS_TOOL_DEFINITIONS, GksScopeDeniedError, authorizeGksClientRequest, authorizeGovernedCallerRequest, authorizeLegacyMspRequest, automergeFloor, governedPortfolios, parseGksClientGrants, requiresLegacyMspAuth } from "@freshair129/gks-contracts";
import { createGksService } from "@freshair129/gks-core";
import { openSqlitePersistence } from "@freshair129/gks-persistence";

export const GKS_TOOLS = GKS_TOOL_DEFINITIONS;
export const GKS_TRANSPORT_LIMITS = Object.freeze({
  normalFrameBytes: 1 * 1024 * 1024,
  pipelineFrameBytes: 8 * 1024 * 1024,
  responseFrameBytes: 8 * 1024 * 1024,
  maxJsonDepth: 32,
  maxInFlight: 16,
});

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const JSON_WHITESPACE = new Set([" ", "\t", "\r", "\n"]);
const JSON_ESCAPES = new Set(["\"", "\\", "/", "b", "f", "n", "r", "t"]);
const HEX = /^[0-9a-fA-F]{4}$/;

class TransportError extends Error {
  // `requestId` is set only when the frame parsed and carried a usable id, so
  // the caller can correlate the refusal; every other transport error answers
  // with id null.
  constructor(code, message, jsonRpcCode = -32600, requestId = null) {
    super(message);
    this.name = "TransportError";
    this.code = code;
    this.jsonRpcCode = jsonRpcCode;
    this.requestId = requestId;
  }
}

// A JSON-RPC 2.0 id is a string, a number or null.
function usableRequestId(id) {
  return typeof id === "string" || (typeof id === "number" && Number.isFinite(id)) ? id : null;
}

function skipWhitespace(text, index) {
  while (index < text.length && JSON_WHITESPACE.has(text[index])) index += 1;
  return index;
}

function readJsonString(text, start) {
  if (text[start] !== '"') throw new TransportError("gks_parse_error", "Parse error.", -32700);
  let index = start + 1;
  while (index < text.length) {
    const character = text[index];
    if (character === '"') {
      const raw = text.slice(start, index + 1);
      return { value: JSON.parse(raw), next: index + 1 };
    }
    if (character.charCodeAt(0) < 0x20) throw new TransportError("gks_parse_error", "Parse error.", -32700);
    if (character === "\\") {
      index += 1;
      const escaped = text[index];
      if (escaped === "u") {
        const digits = text.slice(index + 1, index + 5);
        if (!HEX.test(digits)) throw new TransportError("gks_parse_error", "Parse error.", -32700);
        index += 5;
        continue;
      }
      if (!JSON_ESCAPES.has(escaped)) throw new TransportError("gks_parse_error", "Parse error.", -32700);
    }
    index += 1;
  }
  throw new TransportError("gks_parse_error", "Parse error.", -32700);
}

function readNumber(text, start) {
  const match = text.slice(start).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
  if (!match) throw new TransportError("gks_parse_error", "Parse error.", -32700);
  const raw = match[0];
  const number = Number(raw);
  if (!Number.isFinite(number) || (Number.isInteger(number) && !Number.isSafeInteger(number))) {
    throw new TransportError("gks_unsafe_number", "Unsafe or non-finite JSON number.");
  }
  return start + raw.length;
}

function scanJsonValue(text, start, depth) {
  if (depth > GKS_TRANSPORT_LIMITS.maxJsonDepth) throw new TransportError("gks_json_depth_exceeded", "JSON depth exceeds the configured limit.");
  const index = skipWhitespace(text, start);
  const character = text[index];
  if (character === '"') return readJsonString(text, index).next;
  if (character === "{") {
    let cursor = skipWhitespace(text, index + 1);
    const keys = new Set();
    if (text[cursor] === "}") return cursor + 1;
    while (cursor < text.length) {
      const key = readJsonString(text, cursor);
      if (keys.has(key.value)) throw new TransportError("gks_duplicate_key", `Duplicate JSON object key: ${key.value}.`);
      keys.add(key.value);
      cursor = skipWhitespace(text, key.next);
      if (text[cursor] !== ":") throw new TransportError("gks_parse_error", "Parse error.", -32700);
      cursor = scanJsonValue(text, cursor + 1, depth + 1);
      cursor = skipWhitespace(text, cursor);
      if (text[cursor] === "}") return cursor + 1;
      if (text[cursor] !== ",") throw new TransportError("gks_parse_error", "Parse error.", -32700);
      cursor = skipWhitespace(text, cursor + 1);
    }
    throw new TransportError("gks_parse_error", "Parse error.", -32700);
  }
  if (character === "[") {
    let cursor = skipWhitespace(text, index + 1);
    if (text[cursor] === "]") return cursor + 1;
    while (cursor < text.length) {
      cursor = scanJsonValue(text, cursor, depth + 1);
      cursor = skipWhitespace(text, cursor);
      if (text[cursor] === "]") return cursor + 1;
      if (text[cursor] !== ",") throw new TransportError("gks_parse_error", "Parse error.", -32700);
      cursor = skipWhitespace(text, cursor + 1);
    }
    throw new TransportError("gks_parse_error", "Parse error.", -32700);
  }
  if (text.startsWith("true", index)) return index + 4;
  if (text.startsWith("false", index)) return index + 5;
  if (text.startsWith("null", index)) return index + 4;
  if (character === "-" || (character >= "0" && character <= "9")) return readNumber(text, index);
  throw new TransportError("gks_parse_error", "Parse error.", -32700);
}

export function parseBoundedFrame(frame) {
  if (frame.length > GKS_TRANSPORT_LIMITS.pipelineFrameBytes) {
    throw new TransportError("gks_frame_too_large", "Request frame exceeds the configured limit.");
  }
  let text;
  try {
    text = UTF8_DECODER.decode(frame);
  } catch {
    throw new TransportError("gks_invalid_utf8", "Request frame is not valid UTF-8.", -32700);
  }
  const end = skipWhitespace(text, scanJsonValue(text, 0, 0));
  if (end !== text.length) throw new TransportError("gks_parse_error", "Parse error.", -32700);
  const request = JSON.parse(text);
  if (Array.isArray(request)) throw new TransportError("gks_batch_unsupported", "JSON-RPC batch requests are unsupported.");
  if (!request || typeof request !== "object") throw new TransportError("gks_invalid_request", "JSON-RPC request must be an object.");
  // GKS-API-002: JSON-RPC 2.0 only. A missing or different version is an
  // Invalid Request, refused before any dispatch.
  if (request.jsonrpc !== "2.0") throw new TransportError("gks_invalid_request", 'JSON-RPC version must be "2.0".', -32600, usableRequestId(request.id));
  return request;
}

export function createRuntimeFromEnvironment(env = process.env) {
  const dbPath = env.GKS_DB_PATH?.trim();
  if (!dbPath || !path.isAbsolute(dbPath)) throw new Error("GKS_DB_PATH must be an explicit absolute path.");
  const requireMspAuth = env.GKS_MSP_AUTH_REQUIRED === "1";
  const mspRelayCredential = env.GKS_MSP_RELAY_CREDENTIAL?.trim() || undefined;
  const clientGrantsPath = env.GKS_CLIENT_GRANTS_PATH?.trim();
  if (clientGrantsPath && !path.isAbsolute(clientGrantsPath)) throw new Error("GKS_CLIENT_GRANTS_PATH must be an absolute path.");
  // Read grants and governed-caller grants (ADR-GKS-CLIENT-ACCESS,
  // ADR-GKS-GOVERNED-CALLERS) share one file and one credential format.
  let clientGrants = [];
  if (clientGrantsPath) {
    let contents;
    try {
      contents = readFileSync(clientGrantsPath, "utf8");
    } catch {
      throw new Error("GKS_CLIENT_GRANTS_PATH could not be read.");
    }
    try {
      clientGrants = parseGksClientGrants(contents);
    } catch {
      throw new Error("GKS_CLIENT_GRANTS_PATH contains invalid grants.");
    }
  }
  if (clientGrants.length > 0 && !requireMspAuth) {
    throw new Error("GKS_MSP_AUTH_REQUIRED=1 is required when client grants are configured.");
  }
  if (requireMspAuth && !mspRelayCredential && clientGrants.length === 0) {
    throw new Error("GKS_MSP_RELAY_CREDENTIAL or a non-empty GKS_CLIENT_GRANTS_PATH is required when GKS_MSP_AUTH_REQUIRED=1.");
  }
  if (mspRelayCredential) {
    const mspCredentialHash = createHash("sha256").update(mspRelayCredential, "utf8").digest("hex");
    if (clientGrants.some((grant) => grant.credentialSha256 === mspCredentialHash)) {
      throw new Error("A credential cannot be registered for both MSP and a client grant.");
    }
  }
  const persistence = openSqlitePersistence({ dbPath });
  return {
    persistence,
    defaultPortfolioId: env.GKS_DEFAULT_PORTFOLIO_ID?.trim() || undefined,
    requireMspAuth,
    mspRelayCredential,
    clientGrants,
    // D7: portfolios a governed caller owns are denied to MSP.
    governedPortfolios: governedPortfolios(clientGrants),
    // Decision 2: the auto-merge floor is deployment-set (GKS_AUTOMERGE_FLOOR)
    // and resolved HERE, at startup, from the same env the rest of the
    // runtime reads — an invalid value fails closed before the first promote.
    service: createGksService({ persistence, defaultPortfolioId: env.GKS_DEFAULT_PORTFOLIO_ID?.trim() || undefined, automergeFloor: automergeFloor(env), pipelineRelayCredential: env.GKS_PIPELINE_RELAY_CREDENTIAL, pipelineWorkerCredential: env.GKS_PIPELINE_WORKER_CREDENTIAL?.trim() || undefined }),
    close() {
      persistence.close();
    },
  };
}

// `caller` is the authenticated governed caller; the three governed writes use
// it for their provenance namespace and attribution.
export function toolHandler(service, name) {
  const handlers = {
    gks_health: (args) => service.health(args),
    gks_knowledge_promote: (args, caller) => service.promoteCandidate(args, caller),
    gks_search: (args) => service.search(args),
    gks_entity_get: (args) => service.getEntity(args),
    gks_relations_get: (args) => service.getRelations(args),
    gks_artifact_link: (args, caller) => service.linkArtifact(args, caller),
    gks_review_list: (args) => service.listUnresolvedMentions(args),
    gks_review_apply: (args, caller) => service.applyHumanResolution(args, caller),
    gks_stage_evidence_export: (args) => service.exportStageEvidence(args),
    gks_pipeline_submit: (args) => service.pipelineSubmit(args),
    gks_pipeline_claim: (args) => service.pipelineClaim(args),
    gks_pipeline_graph_receipt: (args) => service.pipelineGraphReceipt(args),
    gks_pipeline_stage_failure: (args) => service.pipelineStageFailure(args),
    gks_pipeline_write_receipt: (args) => service.pipelineWriteReceipt(args),
    gks_pipeline_gate: (args) => service.pipelineGate(args),
    gks_pipeline_publication_receipt: (args) => service.pipelinePublicationReceipt(args),
    gks_pipeline_evidence: (args) => service.pipelineEvidence(args),
  };
  return handlers[name];
}

export function createJsonRpcToolErrorResponse(id, error) {
  // GKS-API-005: only the gks_* vocabulary crosses the wire. A driver or
  // runtime code (SQLITE_BUSY, ENOENT, ...) is an unavailable backend to the
  // caller, not a new public error code.
  const code = typeof error.code === "string" && error.code.startsWith("gks_") ? error.code : "gks_backend_unavailable";
  const structuredContent = { code, message: error.message };
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    result: {
      isError: true,
      content: [{ type: "text", text: error.message }],
      structuredContent,
    },
  };
}

export async function dispatchJsonRpcRequest(request, { runtime, clientGrant } = {}) {
  if (!runtime) throw new TypeError("runtime is required.");
  if (request.method === "notifications/initialized" || request.id === undefined) return null;
  if (request.method === "initialize") {
    return { jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "gks-knowledge-graph-service", version: "0.1.0" } } };
  }
  if (request.method === "tools/list") {
    return { jsonrpc: "2.0", id: request.id, result: { tools: GKS_TOOLS } };
  }
  if (request.method !== "tools/call") {
    return { jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } };
  }
  const toolName = request.params?.name;
  const handler = toolHandler(runtime.service, toolName);
  if (!handler) {
    return createJsonRpcToolErrorResponse(request.id, { code: "gks_invalid_request", message: "Unknown GKS tool." });
  }
  try {
    const args = request.params?.arguments ?? {};
    let caller = GKS_MSP_CALLER;
    if (clientGrant?.profile === "governed") {
      // ADR-GKS-GOVERNED-CALLERS: tools, portfolio boundary and provenance
      // namespace all come from the server-side grant.
      caller = authorizeGovernedCallerRequest(clientGrant, request.params?._meta, { toolName, args, defaultPortfolioId: runtime.defaultPortfolioId });
    } else if (clientGrant) {
      authorizeGksClientRequest(clientGrant, { toolName, args });
    } else if (runtime.requireMspAuth && requiresLegacyMspAuth(toolName)) {
      const scope = authorizeLegacyMspRequest(request.params?._meta, {
        toolName,
        args,
        defaultPortfolioId: runtime.defaultPortfolioId,
        relayCredential: runtime.mspRelayCredential,
      });
      // D7: a portfolio owned by a governed caller is not MSP's.
      if (runtime.governedPortfolios?.has(scope.portfolioId)) throw new GksScopeDeniedError("This portfolio is governed by another caller.");
    }
    const structuredContent = await handler(args, caller);
    return { jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent } };
  } catch (error) {
    return createJsonRpcToolErrorResponse(request.id, error);
  }
}

export function runStdioServer({ env = process.env, input = process.stdin, output = process.stdout } = {}) {
  const runtime = createRuntimeFromEnvironment(env);
  let closed = false;
  let pendingFrame = Buffer.alloc(0);
  let droppingOversizedFrame = false;
  let inFlight = 0;
  function close() {
    if (closed) return;
    closed = true;
    runtime.close();
  }
  function send(message) {
    if (closed) return;
    let encoded = Buffer.from(`${JSON.stringify(message)}\n`, "utf8");
    if (encoded.length > GKS_TRANSPORT_LIMITS.responseFrameBytes) {
      encoded = Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: message.id ?? null, error: { code: -32002, message: "Response frame exceeds the configured limit." } })}\n`, "utf8");
    }
    output.write(encoded);
  }
  function sendError(id, error) {
    send({ jsonrpc: "2.0", id: id ?? null, error: { code: error.jsonRpcCode ?? -32600, message: error.message } });
  }
  async function handleFrame(frame) {
    if (closed || frame.length === 0 || (frame.length === 1 && frame[0] === 0x0d)) return;
    let request;
    try {
      request = parseBoundedFrame(frame);
    } catch (error) {
      sendError(error.requestId ?? null, error);
      return;
    }
    const isPipelineRequest = typeof request.params?.name === "string" && request.params.name.startsWith("gks_pipeline_");
    const requestLimit = isPipelineRequest ? GKS_TRANSPORT_LIMITS.pipelineFrameBytes : GKS_TRANSPORT_LIMITS.normalFrameBytes;
    if (frame.length > requestLimit) {
      sendError(request.id, new TransportError("gks_frame_too_large", "Request frame exceeds the configured limit."));
      return;
    }
    if (request.method === "notifications/initialized") return;
    if (request.id === undefined) return;
    if (inFlight >= GKS_TRANSPORT_LIMITS.maxInFlight) {
      sendError(request.id, new TransportError("gks_overloaded", "Too many in-flight requests."));
      return;
    }
    inFlight += 1;
    try {
      const response = await dispatchJsonRpcRequest(request, { runtime });
      if (response) send(response);
    } finally {
      inFlight -= 1;
    }
  }
  function consumeChunk(chunk) {
    if (closed) return;
    let data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (droppingOversizedFrame) {
      const newline = data.indexOf(0x0a);
      if (newline < 0) return;
      data = data.subarray(newline + 1);
      droppingOversizedFrame = false;
    }
    if (pendingFrame.length) data = Buffer.concat([pendingFrame, data]);
    let cursor = 0;
    while (cursor < data.length) {
      const newline = data.indexOf(0x0a, cursor);
      if (newline < 0) {
        pendingFrame = data.subarray(cursor);
        if (pendingFrame.length > GKS_TRANSPORT_LIMITS.pipelineFrameBytes) {
          sendError(null, new TransportError("gks_frame_too_large", "Request frame exceeds the configured limit."));
          pendingFrame = Buffer.alloc(0);
          droppingOversizedFrame = true;
        }
        return;
      }
      const frame = data.subarray(cursor, newline);
      cursor = newline + 1;
      void handleFrame(frame);
    }
    pendingFrame = Buffer.alloc(0);
  }
  input.on("data", consumeChunk);
  input.on("end", () => {
    if (!droppingOversizedFrame && pendingFrame.length) void handleFrame(pendingFrame);
    pendingFrame = Buffer.alloc(0);
    close();
  });
  input.on("close", close);
  input.on("error", close);
  return { close };
}
