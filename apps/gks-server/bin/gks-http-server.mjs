#!/usr/bin/env node
import { runHttpServer } from "../src/http-server.mjs";

let app;
try {
  app = runHttpServer();
  await app.ready;
  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : app.port;
  process.stderr.write(`GKS HTTP server listening on ${app.host}:${port}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}

if (app) {
  const stop = () => { void app.close().finally(() => process.exit(0)); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
