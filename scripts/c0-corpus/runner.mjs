// @req GKS-MIG-002, ADR-GKS-C0-QUALIFICATION D4 — the C0.4 golden corpus
// runner (registry c0-qualification/v2).
//
// Each runnable case is a request fixture (tests/fixtures/c0-qualification/
// cases/<id>.json): an ordered list of steps replayed against a real
// `gks-server` stdio process on a fresh SQLite store. The runner records one
// transcript entry per step, normalizes the values that legitimately differ
// between runs, and hashes the result. The registry pins the hash of the
// request fixture and of the expected transcript, so an unreviewed change to
// either the requests or the server's answers fails the corpus.
//
// Step kinds:
//   call              send one JSON-RPC frame and wait for the response with its id
//   raw               send raw bytes (text / base64 / repeated padding) and wait
//                     for the next frame; used for transport denials
//   restart           stop the server (if running) and start a fresh process on
//                     the same store
//   kill-after-commit send one frame, wait until a read-only SQL probe sees the
//                     durable write, SIGKILL the process and never read the reply
//   store-exec        run SQL on the store from a separate connection (fault
//                     injection for backend-failure cases)
//   store-query       read rows from the store and record them
//
// A request value `{"$bind": "<step>.<path>"}` is replaced by the value at that
// path in the named step's raw response before the frame is sent: some
// requests must carry a hash the server derived from its own clock.
import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { canonicalJsonString } from "@freshair129/gks-contracts";

export const CORPUS_DIR = "tests/fixtures/c0-qualification";
const SERVER = "apps/gks-server/bin/gks-server.mjs";
const STEP_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 5_000;
// The server runs with a clean environment so an operator's shell (for
// example an exported GKS_MSP_AUTH_REQUIRED) cannot change a golden result.
const ENV_PASSTHROUGH = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "TMPDIR"];

// Hashes the server derives from its own clock (a decision carries the
// transaction time of its facts), so they differ on every run. Each distinct
// value becomes a numbered label, which keeps equality visible: a replay that
// returns the committed decision shows the same label as the first submit.
const VOLATILE_HASH_KEYS = new Map(Object.entries({
  decisionHash: "decisionHash", decision_hash: "decisionHash",
  graphReceiptHash: "graphReceiptHash", graph_receipt_hash: "graphReceiptHash",
  derivedHash: "derivedHash", derived_hash: "derivedHash",
  receiptHash: "receiptHash", receipt_hash: "receiptHash",
  verdictHash: "verdictHash", verdict_hash: "verdictHash",
  publicationHash: "publicationHash", publication_hash: "publicationHash",
  failureHash: "failureHash", failure_hash: "failureHash",
}));
// Measured wall-clock durations.
const DURATION_KEYS = new Set(["duration_ms", "processing_time_ms"]);
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

export function sha256Canonical(value) {
  return createHash("sha256").update(canonicalJsonString(value), "utf8").digest("hex");
}

export function readJson(root, relativePath) {
  return JSON.parse(readFileSync(path.join(root, relativePath), "utf8"));
}

function serverEnv(dbPath, caseEnv) {
  const env = {};
  for (const name of ENV_PASSTHROUGH) if (process.env[name] !== undefined) env[name] = process.env[name];
  return { ...env, ...caseEnv, GKS_DB_PATH: dbPath };
}

function withTimeout(promise, label, timeoutMs = STEP_TIMEOUT_MS) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function startServer(root, dbPath, caseEnv) {
  const child = spawn(process.execPath, [path.join(root, SERVER)], { cwd: root, env: serverEnv(dbPath, caseEnv), stdio: ["pipe", "pipe", "pipe"], shell: false });
  const server = { child, stdout: "", stderr: "", frames: [], waiters: [], violations: [], killed: false };
  server.exited = new Promise((resolve) => child.once("exit", resolve));
  child.once("error", (error) => server.violations.push(`server process error: ${error.message}`));
  child.stderr.on("data", (chunk) => { server.stderr += chunk.toString("utf8"); });
  readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
    server.stdout += `${line}\n`;
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      // stdout carries protocol frames only (ADR-GKS-C0-QUALIFICATION D3).
      server.violations.push(`non-JSON stdout line: ${line.slice(0, 120)}`);
      return;
    }
    if (!frame || frame.jsonrpc !== "2.0") server.violations.push(`non-JSON-RPC stdout frame: ${line.slice(0, 120)}`);
    server.frames.push(frame);
    for (const waiter of [...server.waiters]) waiter();
  });
  return server;
}

function nextFrame(server, predicate, label) {
  // A server that dies fails the step at once, with its stderr tail.
  const died = server.exited.then((code) => {
    throw new Error(`${label}: server exited (${code ?? server.child.signalCode}) before answering: ${server.stderr.trim().split("\n").slice(-3).join(" | ").slice(0, 300)}`);
  });
  return withTimeout(Promise.race([died, new Promise((resolve) => {
    const check = () => {
      const index = server.frames.findIndex(predicate);
      if (index === -1) return;
      server.waiters.splice(server.waiters.indexOf(check), 1);
      resolve(server.frames.splice(index, 1)[0]);
    };
    server.waiters.push(check);
    check();
  })]), label);
}

async function stopServer(server, { kill = false } = {}) {
  if (kill) {
    server.killed = true;
    server.child.kill("SIGKILL");
  } else {
    server.child.stdin.end();
  }
  try {
    await withTimeout(server.exited, "server stop", STOP_TIMEOUT_MS);
  } catch {
    server.child.kill("SIGKILL");
    await server.exited;
  }
  // A deliberately killed process may still have flushed the lost response;
  // any other frame nobody asked for is a protocol violation.
  if (!server.killed && server.frames.length) server.violations.push(`unsolicited stdout frame(s): ${JSON.stringify(server.frames).slice(0, 200)}`);
}

function lookupBinding(outputs, reference) {
  const [stepName, ...segments] = reference.split(".");
  if (!Object.prototype.hasOwnProperty.call(outputs, stepName)) throw new Error(`$bind refers to unknown step "${stepName}"`);
  let value = outputs[stepName];
  for (const segment of segments) {
    if (value === null || typeof value !== "object" || !(segment in value)) throw new Error(`$bind path "${reference}" does not resolve`);
    value = value[segment];
  }
  return value;
}

export function resolveBindings(value, outputs) {
  if (Array.isArray(value)) return value.map((item) => resolveBindings(item, outputs));
  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === "$bind") return lookupBinding(outputs, value.$bind);
    return Object.fromEntries(keys.map((key) => [key, resolveBindings(value[key], outputs)]));
  }
  return value;
}

function rawBytes(parts) {
  return Buffer.concat(parts.map((part) => {
    if (typeof part.text === "string") return Buffer.from(part.text, "utf8");
    if (typeof part.base64 === "string") return Buffer.from(part.base64, "base64");
    if (typeof part.repeat === "string" && Number.isInteger(part.count)) return Buffer.from(part.repeat.repeat(part.count), "utf8");
    throw new Error(`unsupported raw part ${JSON.stringify(part)}`);
  }));
}

function isSubset(expected, actual) {
  if (expected === null || typeof expected !== "object") return Object.is(expected, actual);
  if (actual === null || typeof actual !== "object") return false;
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.length === actual.length && expected.every((item, index) => isSubset(item, actual[index]));
  return Object.keys(expected).every((key) => isSubset(expected[key], actual[key]));
}

// The intent of a step, checked on every run. The golden hash pins the exact
// answer; these annotations make sure a re-baseline cannot quietly accept an
// answer that contradicts what the case is for.
function checkExpectation(expectation, response) {
  if (!expectation) return [];
  const problems = [];
  const content = response?.result?.structuredContent;
  if (expectation.ok && (!response?.result || response.result.isError === true)) problems.push(`expected success, got ${JSON.stringify(response?.error ?? content).slice(0, 200)}`);
  if (expectation.toolError && (response?.result?.isError !== true || content?.code !== expectation.toolError)) problems.push(`expected tool error ${expectation.toolError}, got ${JSON.stringify(response?.error ?? content).slice(0, 200)}`);
  if (expectation.protocolError && !response?.error) problems.push(`expected a JSON-RPC protocol error, got ${JSON.stringify(response).slice(0, 200)}`);
  if (expectation.errorMessage && response?.error?.message !== expectation.errorMessage) problems.push(`expected protocol error "${expectation.errorMessage}", got "${response?.error?.message}"`);
  if (expectation.match && !isSubset(expectation.match, content)) problems.push(`structuredContent does not match ${JSON.stringify(expectation.match)}`);
  if (expectation.rows && canonicalJsonString(expectation.rows) !== canonicalJsonString(response)) problems.push(`store rows ${JSON.stringify(response)} do not equal ${JSON.stringify(expectation.rows)}`);
  return problems;
}

function withStore(dbPath, options, fn) {
  const db = new Database(dbPath, { fileMustExist: true, ...options });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function probeStore(dbPath, sql, params) {
  try {
    return withStore(dbPath, { readonly: true }, (db) => db.prepare(sql).get(...params));
  } catch {
    return undefined; // the store or table does not exist yet
  }
}

async function waitForCommit(dbPath, until, label) {
  return withTimeout((async () => {
    for (;;) {
      const row = probeStore(dbPath, until.sql, until.params ?? []);
      if (row) return row;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  })(), label);
}

/** Replays one case fixture against a fresh store. */
export async function runCase(root, fixture) {
  const dir = mkdtempSync(path.join(tmpdir(), "gks-c0-corpus-"));
  const dbPath = path.join(dir, "gks.sqlite");
  const transcript = [];
  const problems = [];
  const outputs = {};
  const processes = [];
  let server = null;
  const ensureServer = () => {
    if (!server) {
      server = startServer(root, dbPath, fixture.env ?? {});
      processes.push(server);
    }
    return server;
  };
  try {
    for (const [index, step] of fixture.steps.entries()) {
      const label = `step ${index + 1}${step.name ? ` (${step.name})` : ""}`;
      const entry = { step: index + 1, kind: step.kind, ...(step.name ? { name: step.name } : {}) };
      if (step.kind === "call") {
        const frame = resolveBindings(step.frame, outputs);
        const running = ensureServer();
        running.child.stdin.write(`${JSON.stringify(frame)}\n`);
        const response = await nextFrame(running, (candidate) => candidate.id === frame.id, label);
        entry.response = response;
        if (step.name) outputs[step.name] = response;
        problems.push(...checkExpectation(step.expect, response).map((problem) => `${label}: ${problem}`));
      } else if (step.kind === "raw") {
        const running = ensureServer();
        running.child.stdin.write(rawBytes(step.parts));
        const response = await nextFrame(running, () => true, label);
        entry.response = response;
        if (step.name) outputs[step.name] = response;
        problems.push(...checkExpectation(step.expect, response).map((problem) => `${label}: ${problem}`));
      } else if (step.kind === "restart") {
        if (server) await stopServer(server);
        server = null;
        ensureServer();
      } else if (step.kind === "kill-after-commit") {
        const frame = resolveBindings(step.frame, outputs);
        const running = ensureServer();
        running.child.stdin.write(`${JSON.stringify(frame)}\n`);
        entry.committed = await waitForCommit(dbPath, step.until, label);
        await stopServer(running, { kill: true });
        server = null;
      } else if (step.kind === "store-exec") {
        withStore(dbPath, {}, (db) => db.exec(step.sql));
      } else if (step.kind === "store-query") {
        const rows = withStore(dbPath, { readonly: true }, (db) => db.prepare(step.sql).all(...(step.params ?? [])));
        entry.rows = rows;
        problems.push(...checkExpectation(step.expect, rows).map((problem) => `${label}: ${problem}`));
      } else {
        throw new Error(`${label}: unknown step kind "${step.kind}"`);
      }
      transcript.push(entry);
    }
  } catch (error) {
    problems.push(error.message);
  } finally {
    if (server) await stopServer(server);
    for (const finished of processes) problems.push(...finished.violations);
    // No fixture secret may reach process output or the store files.
    const surfaces = processes.flatMap((finished) => [finished.stdout, finished.stderr]);
    for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) if (existsSync(file)) surfaces.push(readFileSync(file).toString("latin1"));
    for (const secret of fixture.secrets ?? []) {
      if (surfaces.some((surface) => surface.includes(secret))) problems.push(`fixture secret "${secret.slice(0, 6)}..." leaked to process output or the store`);
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
  return { id: fixture.id, transcript: normalizeTranscript(transcript, fixture), problems };
}

function collectStrings(value, into) {
  if (typeof value === "string") into.add(value);
  else if (value && typeof value === "object") for (const item of Object.values(value)) collectStrings(item, into);
  return into;
}

// JSON carried as a string (a tool result's text content, a stored JSON
// column) is parsed so its volatile fields are normalized like any other. A
// text block that repeats structuredContent collapses to a marker.
function expandJson(value) {
  if (typeof value === "string" && /^[[{]/.test(value)) {
    try {
      return { $json: expandJson(JSON.parse(value)) };
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) return value.map(expandJson);
  if (value && typeof value === "object") {
    const expanded = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expandJson(item)]));
    if (Array.isArray(value.content) && value.structuredContent !== undefined) {
      const structured = canonicalJsonString(value.structuredContent);
      expanded.content = value.content.map((block, index) => {
        if (block?.type !== "text" || typeof block.text !== "string") return expanded.content[index];
        try {
          if (canonicalJsonString(JSON.parse(block.text)) === structured) return { type: "text", text: "<same-as-structuredContent>" };
        } catch { /* not JSON: keep the expanded form */ }
        return expanded.content[index];
      });
    }
    return expanded;
  }
  return value;
}

function visitSorted(value, visit, key = null) {
  visit(key, value);
  if (Array.isArray(value)) for (const item of value) visitSorted(item, visit, key);
  else if (value && typeof value === "object") for (const childKey of Object.keys(value).sort()) visitSorted(value[childKey], visit, childKey);
}

/** Replaces run-to-run values with stable labels; see the header comment. */
export function normalizeTranscript(transcript, fixture) {
  const requestStrings = collectStrings(fixture, new Set());
  const expanded = expandJson(transcript);
  const labels = new Map();
  const counters = new Map();
  visitSorted(expanded, (key, value) => {
    if (typeof value !== "string" || !VOLATILE_HASH_KEYS.has(key) || labels.has(value)) return;
    const name = VOLATILE_HASH_KEYS.get(key);
    counters.set(name, (counters.get(name) ?? 0) + 1);
    labels.set(value, `<${name}:${counters.get(name)}>`);
  });
  const rewrite = (value, key) => {
    if (typeof value === "string") {
      if (labels.has(value)) return labels.get(value);
      // A server-clock instant; an instant the caller sent is echoed verbatim.
      if (ISO_INSTANT.test(value) && !requestStrings.has(value)) return "<server-time>";
      let text = value;
      for (const [volatile, label] of labels) if (text.includes(volatile)) text = text.split(volatile).join(label);
      return text;
    }
    if (typeof value === "number" && DURATION_KEYS.has(key)) return "<duration-ms>";
    if (Array.isArray(value)) return value.map((item) => rewrite(item, key));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([childKey, item]) => [childKey, rewrite(item, childKey)]));
    return value;
  };
  return rewrite(expanded, null);
}

/** First path at which two JSON values differ, for a readable failure. */
export function firstDifference(expected, actual, at = "$") {
  // A field present on one side only is `undefined` on the other, which has
  // no canonical JSON form.
  if (expected === undefined || actual === undefined) return expected === actual ? null : `${at}: expected ${JSON.stringify(expected)?.slice(0, 160) ?? "nothing"} got ${JSON.stringify(actual)?.slice(0, 160) ?? "nothing"}`;
  if (canonicalJsonString(expected) === canonicalJsonString(actual)) return null;
  if (expected && actual && typeof expected === "object" && typeof actual === "object" && Array.isArray(expected) === Array.isArray(actual)) {
    for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
      const difference = firstDifference(expected[key], actual[key], `${at}.${key}`);
      if (difference) return difference;
    }
  }
  return `${at}: expected ${JSON.stringify(expected)?.slice(0, 160)} got ${JSON.stringify(actual)?.slice(0, 160)}`;
}
