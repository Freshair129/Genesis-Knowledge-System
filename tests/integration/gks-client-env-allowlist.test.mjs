// @req SEC — the published GKS client must not hand a GKS child the whole
// environment of whatever host started it. GKS reads four GKS_* names and
// nothing else; a host that starts it may hold database URLs, chat-platform
// credentials and model API keys that have no business crossing into the child.
// Before this, GksStdioClient defaulted to `env = process.env` and passed it to
// spawn() unfiltered, and no test covered what the child received.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { buildGksChildEnv, GKS_OS_ENV_NAMES, GksStdioClient } from "@freshair129/gks-client-js";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, "..", "fixtures", "env-report-stdio-server.mjs");

// Everything GKS actually reads: apps/gks-server/src/server.mjs and
// packages/gks-contracts/src/resolution.mjs.
const gksConfig = {
  GKS_DB_PATH: "/allowlist-test/gks.sqlite",
  GKS_DEFAULT_PORTFOLIO_ID: "portfolio-allowlist-test",
  GKS_AUTOMERGE_FLOOR: "0.91",
  GKS_PIPELINE_RELAY_CREDENTIAL: "relay-credential",
};

// What a host holds and GKS has no use for. AWS_SECRET_ACCESS_KEY is the point
// of an allowlist: no denylist ever named it.
const hostSecrets = {
  DATABASE_URL: "postgres://decoy-user:decoy-pass@decoy-host:5432/decoy_production",
  LINE_CHANNEL_SECRET: "decoy-line-channel-secret",
  ANTHROPIC_API_KEY: "sk-decoy-anthropic-key",
  AWS_SECRET_ACCESS_KEY: "decoy-aws-secret",
  MSP_PIPELINE_PRINCIPALS: "[]",
  MSP_GKS_PIPELINE_CREDENTIAL: "decoy-msp-relay-credential",
  NODE_OPTIONS: "--require ./decoy.js",
};

const REPORT_KEYS = [...Object.keys(gksConfig), ...Object.keys(hostSecrets)];

describe("GKS client child-process environment allowlist", () => {
  it("a spawned GKS child receives GKS configuration and none of the host's secrets", async () => {
    const client = new GksStdioClient({
      command: process.execPath,
      args: [serverPath],
      env: { ...gksConfig, ...hostSecrets, PATH: process.env.PATH ?? "/usr/bin" },
    });
    const { received_env: receivedEnv } = await client.call("gks_env_report", { report_keys: REPORT_KEYS });
    for (const [name, value] of Object.entries(gksConfig)) expect(receivedEnv[name], `${name} must reach the GKS child`).toBe(value);
    for (const name of Object.keys(hostSecrets)) expect(receivedEnv[name], `${name} must NOT reach the GKS child`).toBeNull();
  });

  it("the process.env default is filtered too — the case a caller gets by writing nothing", async () => {
    const restore = {};
    for (const [name, value] of Object.entries({ ...gksConfig, ...hostSecrets })) {
      restore[name] = process.env[name];
      process.env[name] = value;
    }
    try {
      const client = new GksStdioClient({ command: process.execPath, args: [serverPath] });
      const { received_env: receivedEnv } = await client.call("gks_env_report", { report_keys: REPORT_KEYS });
      for (const name of Object.keys(hostSecrets)) expect(receivedEnv[name], `${name} must NOT reach the GKS child`).toBeNull();
      expect(receivedEnv.GKS_DB_PATH).toBe(gksConfig.GKS_DB_PATH);
    } finally {
      for (const [name, value] of Object.entries(restore)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("forwards every OS basic it publishes, matched without case and copied as spelled", () => {
    const osBasics = {
      Path: "/usr/bin", PathExt: ".COM;.EXE", SystemRoot: "C:/Windows", SystemDrive: "C:",
      windir: "C:/Windows", ComSpec: "C:/Windows/system32/cmd.exe", Temp: "/temp", Tmp: "/tmp2",
      TMPDIR: "/tmp", HOME: "/home/u", USERPROFILE: "C:/Users/u", HOMEDRIVE: "C:", HOMEPATH: "/Users/u",
      APPDATA: "C:/Users/u/AppData/Roaming", LOCALAPPDATA: "C:/Users/u/AppData/Local",
      LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TZ: "Asia/Bangkok",
    };
    expect(new Set(Object.keys(osBasics).map((key) => key.toUpperCase())), "every published OS basic must be exercised here, exactly once").toEqual(new Set(GKS_OS_ENV_NAMES));
    const lookAlikes = { PATH_SECRET: "decoy", TZ_API_KEY: "decoy", HOME_TOKEN: "decoy", TEMPEST: "decoy" };
    expect(buildGksChildEnv({ ...osBasics, ...lookAlikes, ...hostSecrets })).toEqual(osBasics);
  });

  it("matches the GKS_ prefix without case, and only as a real prefix", () => {
    const childEnv = buildGksChildEnv({ GKS_DB_PATH: "/gks.sqlite", gks_automerge_floor: "0.9", GKSDB: "decoy", MY_GKS_TOKEN: "decoy", XGKS_DB_PATH: "decoy" });
    expect(childEnv).toEqual({ GKS_DB_PATH: "/gks.sqlite", gks_automerge_floor: "0.9" });
  });
});
