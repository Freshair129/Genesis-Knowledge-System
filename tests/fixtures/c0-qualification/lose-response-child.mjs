import { runStdioServer } from "../../../apps/gks-server/src/server.mjs";

// Test-only output adapter: stop after a successful pipeline submit has returned
// from dispatch (and committed) but before its response bytes reach the caller.
runStdioServer({
  output: {
    write(chunk) {
      const response = JSON.parse(chunk.toString("utf8"));
      if (response.id === 2) {
        const result = response.result?.structuredContent;
        const exitCode = result?.decisionId && result?.batchId ? 73 : 74;
        process.stderr.write(`C0_LOST_RESPONSE_RESULT=${JSON.stringify(result ?? response)}\n`, () => process.exit(exitCode));
        return false;
      }
      return process.stdout.write(chunk);
    },
  },
});
