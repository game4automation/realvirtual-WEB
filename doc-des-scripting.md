# DES Scripting

This contract covers event-kernel component scripts. See [Component Scripting](doc-scripting.md) for the general SDK, [DES snapshots](doc-des-snapshot.md) for preflight and restore, and [DES randomness](doc-des-randomness.md) for versioned run seeding.

## Execution and scheduling

All Model-Scripts (`WebComponent`) run on the DES event clock in animated, fast-forward and batch runs. Lint findings warn; `DesSafe` escalates tick polling and undeclared state to errors (geometry sampling stays advisory). `setup(self)` returns handlers. DES advances its simulation clock between scheduled events; `self.now` exposes that clock. Material-flow hooks (`canAccept`, `onAccept`, `onDownstreamReady`) handle flow; `des.on(hook, mu, data)` receives scheduled script hooks.

Frame hooks (`fixedUpdate`, `lateFixedUpdate`) run only with animation (animated, hybrid or step), display-only, never in fast-forward or batch. SDK reads and logging are allowed; state-changing SDK calls throw `des-frame-hook-write` (one warning per script instance), and frame-hook RNG draws are rolled back. Guest-local persist/closure writes are not prevented: do not use them here; the `fixed-update` lint warns.

`self.in`, `self.at` and `self.every` schedule named hooks rather than persisting executable callbacks. The event queue represents these as `Script.Hook` actions with `{hook, desId, mu, data}` payloads. Repeating timers carry an owner and timer identity; keep the returned ID in persist state if later cancellation is required. Restored queue entries already contain pending timers: do not re-arm them in `onRestore`.

Sources: `src/core/sdk/rv-sdk-self.ts`, `src/core/sdk/rv-script-component-adapter.ts`, `src/plugins/des/rv-des-script-participant.ts` (`scriptTimerHandleRefs`, `scriptTimerQueueProblems`), and `src/plugins/des/rv-des-named-actions.ts` (`registerAction`, `getActionSchema`).

## Sink arrivals

`self.sink(path).on(cb)` fires synchronously at each sink arrival, at the arrival's DES time. Address sinks by placement name, for example `self.sink('Sink_V1')`. Multiple listeners on one sink run in script node path order. Register and unsubscribe only in `setup()` during DES: runtime subscription changes are refused with a `des-script-sink-runtime` problem. An unresolved sink reports `des-script-sink-unresolved`. Instance teardown removes its listeners automatically.

MU IDs seen by scripts are deterministic across animated, fast-forward, batch and snapshot/restore continuation for the same model and seeds. Consumed MUs retire at the end of the consuming event, independently of visual cleanup.

Sources: `src/plugins/web-component-plugin.ts`, `src/plugins/des/material-flow-adapter.ts`, `src/plugins/des/rv-des-manager.ts`.

## Declared state and code checks

Call `self.persist(initial)` once during setup and retain its returned object. Restore refills that object in place. Persisted continuation data must be JSON-pure: no handles, functions, aliases, cycles, accessors, sparse arrays, unsupported prototypes, non-finite numbers or negative zero. `self.prop` is configuration, not persisted runtime state. Legacy synchronous `onSnapshot`/`onRestore` hooks do not exempt a script from the declared-state contract.

`checkDesScriptState` in `src/core/sdk/rv-des-ast-check.ts` reports `des-script-undeclared-state`: it conservatively rejects mutable setup/module bindings, captured/global writes, retained objects outside persist/service bindings, and unsafe factories/classes. Literal handlers and handler-local scratch are supported; SDK-derived service handles are wiring, but captured property writes remain protected. Diagnostics are warnings unless `desSafe` escalates them to errors.

```js
// Rejected: retained mutable closure state.
function setup(self) {
  let count = 0;
  return { des: { on() { count++; } } };
}

// Declared continuation state.
function setup(self) {
  const st = self.persist({ count: 0 });
  return { des: { on() { st.count++; } } };
}
```

A setup factory such as `return makeHandlers()` is also refused. Inline the returned handlers and move their changing data into the persist object.

`src/core/sdk/rv-des-lint.ts` additionally reports `fixed-update`, `dt-accumulation`, `blocked-global` and `geometry-sampling`. Replace tick-polled countdowns with named scheduled hooks. Wall-clock globals and `Math.random` are unavailable. These are the source rule names; the source does not define rules named R7 or R8.

## Randomness and reset order

`self.random()` uses mulberry32. V1 defaults to FNV-1a of the component path (or an explicit SDK seed). V2 derives `scriptSeed32(masterSeed, id)` from the low 32 bits of `seedKey64(masterSeed, id, 'script')`, replacing zero with one. It does not allocate a manager RNG stream. The same model, run seed and draw order reproduce the sequence.

Every DES run and replication rebuilds Model-Scripts from their initial persist, FSM and timer state. The runner binds scripts after discovery and seed selection, before material startup. With v2, the master seed and script address determine the run seed **before `setup()`**, so setup draws use that run's stream; later-created scripts use the active DES binding too. Legacy v1 keeps path-based seeding. A missing v2 script ID fails with `des-rng-id-missing`. Instances retain their end state after run end until rebind/unbind; switching to continuous mode, reset or disposal unbinds them.

With a cold script host, the run waits for wiring before its first DES event. A script-host load failure reports `des-scripts-unavailable`; the run continues without scripts.

Sources: `src/core/rv-rng-streams.ts` (`scriptSeed32`), `src/core/sdk/rv-sdk-self.ts`, `src/core/sdk/rv-script-component-adapter.ts`, `src/core/rv-viewer.ts`, `src/plugins/des/des-runner.ts`; detailed lifecycle in [DES randomness](doc-des-randomness.md#script-rng-contract-v5).

## Snapshots and replications

`scriptParticipants` in `src/plugins/des/rv-des-script-participant.ts` captures guest state through `ScriptComponentAdapter.captureScriptState`. The script payload contains RNG state, FSM state, persist state, optional legacy state, timer metadata and published `self.statValue` rows. These are restored before `onRestore`; do not re-arm pending timers. Script RNG belongs here, not in the manager's `des.rng` participant. The host revalidates guest data and timer ownership before restore. The Statistics window lists scripts by node path.

Scripts with `des-script-undeclared-state` warnings keep running, but snapshot capture and restore are visibly refused with that code. Capture is also refused with `des-snapshot-scripts-pending` while a cold script host is still loading.

The experiment manager is a commercial module (realvirtual Commercial), documented in the private repository and at [des/experiments](https://doc.realvirtual.io/web/des/experiments/).

## Limits

Register callbacks in setup: dynamically registered guest callbacks are not saved. Script KPI state-time statistics are outside snapshots. Hot reload creates a fresh instance without state transfer. Snapshots require stable script IDs, matching source/model fingerprints and the same RNG version. CRN aligns sequences only while identity and draw counts agree; it cannot guarantee identical outcomes after model changes.

Sources: [DES snapshots](doc-des-snapshot.md#script-contract), [Component Scripting](doc-scripting.md#hot-reload-is-always-cold), and [DES randomness](doc-des-randomness.md#known-limits).
