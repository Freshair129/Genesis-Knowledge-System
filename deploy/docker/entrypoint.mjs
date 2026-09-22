import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";

const secretMappings = [
  ["GKS_MSP_RELAY_CREDENTIAL", "GKS_MSP_RELAY_CREDENTIAL_FILE"],
  ["GKS_PIPELINE_RELAY_CREDENTIAL", "GKS_PIPELINE_RELAY_CREDENTIAL_FILE"],
];

for (const [valueName, fileName] of secretMappings) {
  if (process.env[valueName]?.trim()) continue;
  const secretPath = process.env[fileName]?.trim();
  if (!secretPath) continue;
  if (!existsSync(secretPath)) throw new Error(`${fileName} points to a missing secret file.`);
  const secret = readFileSync(secretPath, "utf8").trim();
  if (!secret) throw new Error(`${fileName} points to an empty secret file.`);
  process.env[valueName] = secret;
}

const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error("A runtime command is required.");

const child = spawn(command, args, { env: process.env, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.once("error", (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  process.exitCode = typeof code === "number" ? code : 1;
  if (signal) process.exitCode = 128;
});
