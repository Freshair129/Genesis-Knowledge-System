import { spawn } from "node:child_process";

export class GksClientError extends Error {
  constructor(message, code = "gks_provider_unavailable") {
    super(message);
    this.name = "GksClientError";
    this.code = code;
  }
}

function encode(payload) {
  return Buffer.from(`${JSON.stringify(payload)}\n`, "utf8");
}

/**
 * What a Node child needs from the OS to start: command lookup, temp and home
 * directories, the Windows system paths libuv and OpenSSL resolve through, and
 * locale/time zone. No credentials, no proxies, and no NODE_OPTIONS — that one
 * can load code into the child.
 */
export const GKS_OS_ENV_NAMES = Object.freeze([
  "PATH", "PATHEXT",
  "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC",
  "TEMP", "TMP", "TMPDIR",
  "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA",
  "LANG", "LC_ALL", "TZ",
]);

const OS_ENV_NAMES = new Set(GKS_OS_ENV_NAMES);

/**
 * The environment a GKS child is spawned with: the OS basics above, plus GKS's
 * own `GKS_*` configuration namespace (GKS_DB_PATH, GKS_DEFAULT_PORTFOLIO_ID,
 * GKS_AUTOMERGE_FLOOR, GKS_PIPELINE_RELAY_CREDENTIAL — the service reads nothing
 * outside that namespace).
 *
 * An allowlist, not a copy of the caller's environment: the host that starts a
 * GKS child holds credentials GKS never reads, and a denylist withholds only
 * what someone remembered to name. Names are matched without case and copied as
 * the caller spelled them, because Windows environment names are
 * case-insensitive and arrive as `Path` or `SystemRoot`.
 *
 * MSP applies the same rule when it spawns GKS
 * (Freshair129/Memory-and-Soul-Passport, apps/msp-server/src/providers/gks-stdio-provider.mjs);
 * this closes the same hole for anyone using the published client directly.
 */
export function buildGksChildEnv(env = process.env) {
  const childEnv = {};
  for (const [name, value] of Object.entries(env ?? {})) {
    if (typeof value !== "string") continue;
    const upper = name.toUpperCase();
    if (OS_ENV_NAMES.has(upper) || upper.startsWith("GKS_")) childEnv[name] = value;
  }
  return childEnv;
}

export class GksStdioClient {
  constructor({ command, args = [], cwd, env = process.env, timeoutMs = 10_000 }) {
    if (!command) throw new TypeError("command is required.");
    this.options = { command, args, cwd, env, timeoutMs };
  }

  health() { return this.call("gks_health", {}); }
  promoteCandidate(input) { return this.call("gks_knowledge_promote", input); }
  search(input) { return this.call("gks_search", input); }
  getEntity(input) { return this.call("gks_entity_get", input); }
  getRelations(input) { return this.call("gks_relations_get", input); }
  linkArtifact(input) { return this.call("gks_artifact_link", input); }
  listUnresolvedMentions(input) { return this.call("gks_review_list", input); }
  applyHumanResolution(input) { return this.call("gks_review_apply", input); }

  async call(toolName, input) {
    const { command, args, cwd, env, timeoutMs } = this.options;
    const child = spawn(command, args, { cwd, env: buildGksChildEnv(env), stdio: ["pipe", "pipe", "pipe"], shell: false });
    let buffer = Buffer.alloc(0);
    let stderr = "";
    let nextId = 1;
    const pending = new Map();
    let exited = false;
    child.on("exit", () => { exited = true; });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-2048); });
    child.stdout.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const body = buffer.subarray(0, newline);
        buffer = buffer.subarray(newline + 1);
        let message;
        try {
          message = JSON.parse(body.toString("utf8"));
        } catch {
          for (const item of pending.values()) item.reject(new GksClientError("GKS returned malformed NDJSON."));
          pending.clear();
          break;
        }
        const item = pending.get(message.id);
        if (!item) continue;
        pending.delete(message.id);
        clearTimeout(item.timeout);
        if (message.error) item.reject(new GksClientError(message.error.message));
        else item.resolve(message.result);
      }
    });

    function request(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new GksClientError(`GKS request timed out after ${timeoutMs}ms.`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timeout });
        child.stdin.write(encode({ jsonrpc: "2.0", id, method, params }));
      });
    }

    try {
      await request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "gks-client-js", version: "0.1.0" } });
      child.stdin.write(encode({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }));
      const result = await request("tools/call", { name: toolName, arguments: input });
      if (result?.isError) throw new GksClientError(result.structuredContent?.message ?? result.content?.[0]?.text ?? "GKS tool failed.", result.structuredContent?.code);
      return result?.structuredContent ?? {};
    } catch (error) {
      if (error instanceof GksClientError) throw error;
      throw new GksClientError(`${error.message}${stderr ? ` ${stderr.trim()}` : ""}`);
    } finally {
      child.stdin.end();
      await new Promise((resolve) => {
        if (exited) return resolve();
        const timer = setTimeout(() => {
          child.kill();
          resolve();
        }, 1_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }
}
