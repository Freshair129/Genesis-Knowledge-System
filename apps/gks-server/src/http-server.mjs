import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import {
  createJsonRpcToolErrorResponse,
  createRuntimeFromEnvironment,
  dispatchJsonRpcRequest,
  GKS_TRANSPORT_LIMITS,
  parseBoundedFrame,
} from "./server.mjs";

const MCP_PATH = "/mcp";
const HEALTH_PATH = "/healthz";
const LIVENESS_TOOLS = new Set(["gks_health"]);

class HttpTransportError extends Error {
  constructor(code, message, statusCode = 400, jsonRpcCode = -32600) {
    super(message);
    this.name = "HttpTransportError";
    this.code = code;
    this.statusCode = statusCode;
    this.jsonRpcCode = jsonRpcCode;
  }
}

function httpConfig(env, { host, port } = {}) {
  if (env.GKS_MSP_AUTH_REQUIRED !== "1") {
    throw new Error("HTTP transport requires GKS_MSP_AUTH_REQUIRED=1.");
  }
  if (!env.GKS_MSP_RELAY_CREDENTIAL?.trim()) {
    throw new Error("HTTP transport requires GKS_MSP_RELAY_CREDENTIAL.");
  }
  const bindHost = host ?? env.GKS_HTTP_HOST?.trim();
  if (!bindHost) throw new Error("GKS_HTTP_HOST is required for HTTP transport.");
  const rawPort = port ?? env.GKS_HTTP_PORT?.trim();
  const bindPort = typeof rawPort === "number" ? rawPort : Number(rawPort);
  if (!Number.isInteger(bindPort) || bindPort < 0 || bindPort > 65535) {
    throw new Error("GKS_HTTP_PORT must be an explicit integer in [0,65535].");
  }
  return { bindHost, bindPort };
}

function isPipelineRequest(request) {
  return typeof request.params?.name === "string" && request.params.name.startsWith("gks_pipeline_");
}

function requestLimit(request) {
  return isPipelineRequest(request) ? GKS_TRANSPORT_LIMITS.pipelineFrameBytes : GKS_TRANSPORT_LIMITS.normalFrameBytes;
}

function writeJson(response, statusCode, value) {
  let body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length > GKS_TRANSPORT_LIMITS.responseFrameBytes) {
    body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: value.id ?? null, error: { code: -32002, message: "Response frame exceeds the configured limit." } }), "utf8");
    statusCode = 500;
  }
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8", "content-length": body.length, "cache-control": "no-store" });
  response.end(body);
}

function writeNoContent(response, statusCode = 204) {
  response.writeHead(statusCode, { "cache-control": "no-store" });
  response.end();
}

function writeJsonRpcTransportError(response, id, error, statusCode = error.statusCode ?? 400) {
  writeJson(response, statusCode, { jsonrpc: "2.0", id: id ?? null, error: { code: error.jsonRpcCode ?? -32600, message: error.message } });
}

async function readBody(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > GKS_TRANSPORT_LIMITS.pipelineFrameBytes) {
      throw new HttpTransportError("gks_frame_too_large", "Request frame exceeds the configured limit.", 413);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

function bearerCredential(request) {
  const header = request.headers.authorization;
  if (typeof header !== "string") throw new HttpTransportError("gks_scope_denied", "Authenticated MSP transport is required.", 401);
  const match = /^Bearer ([^\s]+)$/.exec(header);
  if (!match) throw new HttpTransportError("gks_scope_denied", "Authenticated MSP transport is invalid.", 401);
  return match[1];
}

function sameSecret(left, right) {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function withHttpAuthentication(request, httpRequest, runtime) {
  const toolName = request.params?.name;
  if (request.method !== "tools/call" || LIVENESS_TOOLS.has(toolName)) return request;
  const supplied = bearerCredential(httpRequest);
  if (!sameSecret(supplied, runtime.mspRelayCredential)) {
    throw new HttpTransportError("gks_scope_denied", "Authenticated MSP transport is invalid.", 401);
  }
  if (!request.params || typeof request.params !== "object") return request;
  const metadata = request.params._meta && typeof request.params._meta === "object" ? request.params._meta : {};
  const auth = metadata.gksMspAuth && typeof metadata.gksMspAuth === "object" ? metadata.gksMspAuth : {};
  return {
    ...request,
    params: {
      ...request.params,
      _meta: {
        ...metadata,
        gksMspAuth: { ...auth, relayCredential: supplied },
      },
    },
  };
}

async function handleMcpRequest(request, response, runtime, state) {
  const contentType = String(request.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    writeJson(response, 415, { error: "Content-Type must be application/json." });
    return;
  }
  let frame;
  try {
    frame = await readBody(request);
  } catch (error) {
    writeJsonRpcTransportError(response, null, error);
    return;
  }
  let parsed;
  try {
    parsed = parseBoundedFrame(frame);
  } catch (error) {
    writeJsonRpcTransportError(response, null, error);
    return;
  }
  if (frame.length > requestLimit(parsed)) {
    writeJsonRpcTransportError(response, parsed.id, new HttpTransportError("gks_frame_too_large", "Request frame exceeds the configured limit.", 413));
    return;
  }
  if (parsed.method === "notifications/initialized" || parsed.id === undefined) {
    writeNoContent(response);
    return;
  }
  if (state.inFlight >= GKS_TRANSPORT_LIMITS.maxInFlight) {
    writeJsonRpcTransportError(response, parsed.id, new HttpTransportError("gks_overloaded", "Too many in-flight requests.", 429));
    return;
  }
  let authenticated;
  try {
    authenticated = withHttpAuthentication(parsed, request, runtime);
  } catch (error) {
    writeJson(response, error.statusCode ?? 401, createJsonRpcToolErrorResponse(parsed.id, error));
    return;
  }
  state.inFlight += 1;
  try {
    const result = await dispatchJsonRpcRequest(authenticated, { runtime });
    if (result) writeJson(response, 200, result);
    else writeNoContent(response);
  } finally {
    state.inFlight -= 1;
  }
}

export function runHttpServer({ env = process.env, host, port } = {}) {
  const { bindHost, bindPort } = httpConfig(env, { host, port });
  const runtime = createRuntimeFromEnvironment(env);
  const state = { inFlight: 0 };
  let closed = false;
  const server = createServer((request, response) => {
    void (async () => {
      const requestUrl = new URL(request.url ?? "/", "http://gks.local");
      if (requestUrl.pathname === HEALTH_PATH) {
        if (request.method !== "GET") {
          writeJson(response, 405, { error: "Method not allowed." });
          return;
        }
        try {
          await runtime.service.health();
          writeJson(response, 200, { service: "gks", status: "ok" });
        } catch {
          writeJson(response, 503, { service: "gks", status: "unavailable" });
        }
        return;
      }
      if (requestUrl.pathname !== MCP_PATH) {
        writeJson(response, 404, { error: "Not found." });
        return;
      }
      if (request.method !== "POST") {
        writeJson(response, 405, { error: "Method not allowed." });
        return;
      }
      await handleMcpRequest(request, response, runtime, state);
    })().catch((error) => {
      if (!response.headersSent) writeJson(response, 500, { error: "GKS HTTP transport failed." });
      else response.destroy(error);
    });
  });
  const ready = new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve(server.address());
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(bindPort, bindHost);
  });
  const close = () => new Promise((resolve, reject) => {
    if (closed) {
      resolve();
      return;
    }
    closed = true;
    server.close((error) => {
      runtime.close();
      if (error) reject(error);
      else resolve();
    });
  });
  return { server, ready, close, host: bindHost, port: bindPort };
}
