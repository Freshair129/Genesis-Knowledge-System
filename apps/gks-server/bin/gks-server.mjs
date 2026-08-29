#!/usr/bin/env node
import { runStdioServer } from "../src/server.mjs";

try {
  runStdioServer();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
