# RCA: Linux unit CI failure from import path casing

- Date: 2026-09-19
- Status: resolved by surgical test-import correction
- CI run: `35440924168`

## Symptom

Both Node 22 and Node 24 unit lanes failed in GitHub Actions. The aggregate job failed because the unit lanes could not load `tests/unit/wiki-desktop-genesisblock.test.mjs`.

## Evidence

- GitHub Actions reported: `Cannot find module '../../apps/wiki-desktop/src/Genesisblock-bridge.mjs'`.
- The test imported `apps/wiki-desktop/src/Genesisblock-bridge.mjs` with an uppercase `G`.
- The tracked source file is `apps/wiki-desktop/src/genesisblock-bridge.mjs` with a lowercase `g`.
- The local Windows unit suite passed before the push, while the Linux CI runner failed during module resolution.

## Root Cause

The unit test import path did not match the source filename casing. Windows filesystem resolution is case-insensitive, but the Linux GitHub Actions runner is case-sensitive.

## Why the issue escaped detection

The original CI workflow did not execute `tests/unit`, and the local Windows filesystem masked the casing mismatch. The mismatch became visible only after the unit suite was added as a CI matrix lane.

## Proposed prevention

- Keep the unit suite in the Linux CI matrix so path-case errors are exercised remotely.
- Keep import paths exactly aligned with tracked filename casing.
- Treat local Windows success as insufficient evidence for case-sensitive path correctness.
