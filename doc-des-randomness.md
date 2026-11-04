# DES Randomness

> **Applies to:** DES runs, experiment batches and RNG snapshot state. The DES core is Community (AGPL); experiment batches belong to the experiment manager, which becomes a commercial module (ADR-054).

## Versions and defaults

RNG v1 uses the frozen `SFC32Legacy` sequence, with component seeds derived as `masterSeed + componentIndex`. RNG v2 uses PractRand sfc32 (`SFC32v2`) with named streams. Both generators are in `src/core/rv-rng-distribution.ts`.

`NEW_EXPERIMENT_RNG_VERSION = 2` in `src/plugins/des/rv-des-experiment-model.ts` selects v2 for new, unpinned experiments. `DESRunner` delegates to `DESManager`, whose `rngVersion` defaults to 1: ordinary Play outside batches still defaults to v1 (`des-runner.ts`, `rv-des-manager.ts`, under `src/plugins/des/`).

## Named streams and common random numbers

`desComponentId` is `<plan-769 address>@<Type>` (`src/plugins/des/rv-des-identity.ts`, re-exporting `src/core/material-flow/rv-des-identity.ts`). The address includes the placement occurrence and NodeId. Purposes include `default`, `downtime:mtbf` and `downtime:mttr` (`src/plugins/des/material-flow/Downtime.ts`). Fleet uses the plantId as stream id and `takt:<stationId>` as purpose (`src/plugins/fleet-plugin.ts`, `src/core/fleet/core/order-sources.ts`; an output index is the fallback when no output id is supplied).

`seedKey64(masterSeed, id, purpose)` in `src/core/rv-rng-streams.ts` hashes the tag `rv-rng-v2\0`, the truncated seed as unsigned 64-bit little-endian, and the NFC-normalized UTF-8 id and purpose, each prefixed by its unsigned 32-bit little-endian byte length. It applies FNV-1a 64 followed by the SplitMix64 finalizer. Golden vectors live in `tests/des/fixtures/rng-v2/seedkey-vectors.json` and `sfc32-practrand-vectors.json`; `legacy-sequences.json` pins v1.

`DESManager.stream` caches stable handles by `(id, purpose)`; reseeding replaces generator state inside those handles. Under v1, each purpose returns the supplied component's same legacy instance; callers must supply that instance. Changing component B does not advance component A's stream. Adding, removing or reordering components preserves streams whose ids and purposes remain unchanged.

This supports common random numbers (CRN) across variants, subject to identity and draw count. A type change changes the id. Renaming a Unity-exported node changes its id when the NodeId is derived from its authored path; an explicit, preserved NodeId need not change (`src/core/engine/rv-decode-identity.ts`). Exact alignment requires equal numbers of draws per purpose. A different schedule can change which event consumes a draw even when the underlying sequence is unchanged.

## Snapshot state

`src/plugins/des/rv-des-rng-participant.ts` selects the `des.rng` payload by run version:

- v1: `{ rngStates }`, mapping component ids to four-word legacy states.
- v2: `{ masterSeed, streams: [{ id, purpose, seedKey64, state: { a, b, c, counter } }] }`.

`src/plugins/des/rv-des-rng-state.ts` emits v2 entries sorted by `(id, purpose)`, with a 16-character hexadecimal seed key. An array preserves tuple boundaries when ids contain `|`; concatenated `id|purpose` keys would be ambiguous. The participant scope is the component ids plus `__manager__`. Restore writes into existing handles, creates missing saved handles, and reseeds existing in-scope purposes absent from the snapshot. It validates seed keys and checks the seed against `des.manager`.

`rngVersion` is part of the fingerprint and is compared strictly (`src/plugins/des/rv-des-fingerprint.ts`); manager restore also rejects a different version (`rv-des-manager.ts`). Script RNG state belongs to `src/plugins/des/rv-des-script-participant.ts`, not a `script` purpose in `des.rng`. Fleet plant streams fall outside the component/manager scope: the fleet takt state (one entry per TaktSource output) is saved once by the `fleet.takt` participant of the fleet snapshot (plan-2059 Phase 6, on main), never duplicated in `des.rng`.

## Script RNG contract (V5)

`self.random()` uses mulberry32 with a 32-bit state (`src/core/sdk/rv-sdk-self.ts`). The v1 default seed remains FNV-1a of the component path (the SDK also accepts an explicit seed override). For v2, `scriptSeed32(masterSeed, id)` is `Number(seedKey64(masterSeed, id, 'script') & 0xffffffffn) || 1` (`src/core/rv-rng-streams.ts`). This derives a script seed without registering a manager stream.

`DESRunner.start()` calls each script source's `adapter.setRunRngSeed(seed32, resolver)` and rejects a missing v2 DES id with `des-rng-id-missing`. The resolver uses `_nextRunSeed()` so reset sees the next run's seed, including scene/override changes (`src/plugins/des/des-runner.ts`).

Viewer reset emits `simulation-reset`, including script `onReset`, before calling the runner's reset/start (`src/core/rv-viewer.ts`). The adapter seeds before `onReset`, records `seededByReset`, and avoids rewinding draws when start supplies that same seed. Batches call only `runner.reset()`, with the seed applied in start. Returning to v1 restores the initial path-derived seed through `__rv.rng.initial` (`src/core/sdk/rv-script-component-adapter.ts`).

Scripts created after start, and draws made in `setup()`, use their initial path seed (or explicit SDK seed) until the next applicable reset/run start.

## Experiment pinning and batches

`ExperimentMeta.rngVersion` is pinned by the first recorded run or snapshot. `effectiveRngVersion` treats an unpinned manifest with replications as v1 and an empty unpinned manifest as unpinned. Replication identity is `(masterSeed, rngVersion ?? 1)` (`src/plugins/des/rv-des-experiment-model.ts`).

`src/plugins/des/rv-des-experiment-store.ts` rejects incompatible versions with `rng-version-conflict` before persisting changes in `recordRun`, `writeSnapshot`, `importExperiment` and `writeManifest`. `deleteReplication` materializes an implicit legacy pin before removing replications, preserving it even after the last replication is deleted.

The matrix never averages mixed versions: it displays "mixed RNG versions". It suppresses deltas against a baseline of another version with "other RNG version than baseline" (`src/plugins/sim-controller/des-matrix-helpers.ts`, `DESExperimentMatrixPanel.tsx`). Version labels appear on experiments and runs.

`src/plugins/des/des-batch-runner.ts` calls `host.setRngVersion` before `setSeed` and `beginRun`. Actual version changes require an idle manager (no elapsed time or queued events); otherwise `rng-version-run-in-progress` is thrown. Reasserting the current version is inert.

At batch end, `DESRunner` restores the pre-batch version and seed. If restoration changes the version, it discards the previous run with `clearMUs` and calls `runner.reset()` when the runner had previously started. That run resumes from t=0 after the batch pause is released (`src/plugins/des/des-runner.ts`).

| Error code | Meaning |
|---|---|
| `rng-version-unknown` | Requested version is neither 1 nor 2. |
| `rng-version-run-in-progress` | A version change requires resetting the active run first. |
| `rng-version-mismatch` | Snapshot manager version differs from the run. |
| `rng-version-conflict` | Archive version conflicts with the experiment pin. |
| `des-rng-duplicate-id` | Components share an id when selecting/registering v2. |
| `des-rng-id-missing` | A v2 stream or script lacks its required id. |
| `rng-version-unavailable` | Batch host rejected selection of the requested version (batch abort reason). |

## Known limits

- CRN preserves sequences by identity and purpose; it cannot guarantee equal outcomes or draw counts after model changes.
- Renames affecting exported addresses, placement identity changes and type changes change stream identity.
- Script setup and scripts created during a run are outside the start-time seeding pass.
- Fleet takt snapshots (`fleet.takt`) are independent of `des.rng`; the fleet snapshot as a whole keeps its own limits (see doc-path-fleet-control.md).
- v1 preserves historical registration-order dependence; equal seeds across v1 and v2 do not imply equal results.

## Tests

Relevant files under `tests/des/`:

- Generator and derivation: `rng-v2-reference.node.test.ts`, `rng-v2-seedkey.node.test.ts`, `rng-v2-legacy-contract.node.test.ts`.
- Streams and lifecycle: `rng-v2-crn.node.test.ts`, `rng-v2-registry-lifecycle.node.test.ts`, `rng-v2-s10-draws.node.test.ts`, `rng-v2-runner-retained.node.test.ts`.
- Script/reset and continuation: `rng-v2-script.test.ts`, `rng-v2-continuation.node.test.ts`.
- Versioning and archives: `rng-v2-versioning.node.test.ts`, `rng-v2-run-version.node.test.ts`, `rng-v2-experiment-versioning.node.test.ts`, `rng-v2-experiment-store.test.ts`.
- Batch and matrix: `rng-v2-batch-acceptance.test.ts`, `rng-v2-matrix-helpers.node.test.ts`, `rng-v2-matrix-panel.test.tsx`.
