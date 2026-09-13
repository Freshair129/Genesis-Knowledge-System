# @freshair129/gks-client-js

Node.js client for the GKS (Genesis Knowledge System) stdio service. It starts a
GKS server as a child process, speaks NDJSON JSON-RPC to it, and exposes the
knowledge tool surface.

```js
import { GksStdioClient } from "@freshair129/gks-client-js";

const client = new GksStdioClient({
  command: process.execPath,
  args: ["apps/gks-server/bin/gks-server.mjs"],
  env: { ...process.env, GKS_DB_PATH: "/absolute/path/gks.sqlite" },
});

const result = await client.promoteCandidate(candidate);
```

Methods: `health`, `promoteCandidate`, `search`, `getEntity`, `getRelations`,
`linkArtifact`, `listUnresolvedMentions`, `applyHumanResolution`, and `call`
for any other tool by name.

**One child process per call.** Each `call()` spawns the server, runs
`initialize` → `tools/call`, and shuts it down in a `finally`. That keeps the
client stateless and is fine for occasional use; it is not a connection pool.

## What GKS reads from the environment

Four variables, all `GKS_*`:

| name | required | purpose |
|---|---|---|
| `GKS_DB_PATH` | yes | absolute path to the SQLite store; the server exits if it is missing or relative |
| `GKS_DEFAULT_PORTFOLIO_ID` | no | service default portfolio |
| `GKS_AUTOMERGE_FLOOR` | no | auto-merge policy floor |
| `GKS_PIPELINE_RELAY_CREDENTIAL` | no | expected value for the `relayCredential` carried in pipeline request payloads |

## The child environment is an allowlist

**This is the behaviour most likely to surprise you.** The GKS child is not
given your process environment. It is given exactly:

- every variable whose name begins with `GKS_`
- the OS basics a Node child needs to start, published as `GKS_OS_ENV_NAMES`

Names are matched without case (Windows spells them `Path` and `SystemRoot`)
and copied under the spelling you used. `NODE_OPTIONS` is deliberately
excluded: it can load arbitrary code into the child. The filter applies to an
`env` you pass explicitly as well as to the default `process.env`.

The host that starts GKS typically holds database URLs, chat-platform
credentials and model API keys that GKS has no use for. A denylist would only
withhold what someone remembered to name; this withholds everything not named.

```js
import { buildGksChildEnv, GKS_OS_ENV_NAMES } from "@freshair129/gks-client-js";

console.log(Object.keys(buildGksChildEnv(process.env)));
```

If your deployment needs a variable outside those two groups, add it to the
list in this package rather than working around the filter.

## Errors

Failures raise `GksClientError` with a `code` — `gks_provider_unavailable` by
default, or the code the service returned. A failed store open names its OS
error code (`ENOENT`, `EACCES`, `SQLITE_*`) but never the value of
`GKS_DB_PATH`, so the message is safe to log and to relay.

## Requirements

Node 22 or newer.
