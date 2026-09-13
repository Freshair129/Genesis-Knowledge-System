# Changelog

## 0.2.1

- Ships a README and this changelog inside the package. 0.2.0 changed how the
  child environment is built and a consumer had no way to learn that from the
  tarball.
- Node floor raised to 22, matching the service this client starts
  (better-sqlite3 13 declares the same floor). The client has no native
  dependency itself, but it exists to spawn a runtime that does.

## 0.2.0

**Breaking.** The GKS child is spawned with an allowlisted environment instead
of a copy of the caller's `process.env`.

Before this, `GksStdioClient` passed its `env` straight to `spawn()` and
defaulted to `process.env`, so the child inherited everything the host held —
production database URLs, chat-platform credentials, model API keys, and
`NODE_OPTIONS`, which a host could use to load arbitrary code into the GKS
child. GKS reads four variables, all named `GKS_*`.

The child now receives only `GKS_*` names and the OS basics a Node process
needs to start. Filtering applies to an explicitly-passed `env` as well as to
the default.

**If you relied on another variable reaching the GKS child, it no longer
arrives.** Add its name to `GKS_OS_ENV_NAMES` in this package, or give it a
`GKS_` name. `buildGksChildEnv` and `GKS_OS_ENV_NAMES` are exported so you can
see exactly what crosses.

Also in this release, in the service rather than the client: a failed store open
no longer puts the value of `GKS_DB_PATH` in its error message, which the client
surfaces through `GksClientError`.

## 0.1.0

Initial standalone client: stdio transport, knowledge tool surface.
