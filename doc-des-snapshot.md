# DES Snapshot Data Contract

> **Applies to:** Community runtime and public extension APIs.
> **Reference baseline:** plan-2059 phases 3a to 7 as integrated on main (integration round 13); documentation reviewed 2026-11-01.

## Overview

DES snapshots capture declared continuation data into a detached v4 envelope and validate it before restoring into existing owners. Owners and live services survive; state containers are prepared separately and then committed. This tree contains the core, script, fleet (phases 4 to 6) and behaviour (phase 7) contracts. Phase 8 lifts the Agv migration lock: AGV scenes snapshot and restore in production.

All modules below are in `src/plugins/des/` and exist in this checkout unless marked otherwise. Names omit `.ts`.

| Module / API | Role and source symbol |
|---|---|
| rv-snapshot-contract | `SnapshotJson`, `createCaptureSession`, `toSnapshotData`, `fromSnapshotData`: data boundary and codecs |
| rv-snapshot-registry | `Snapshottable`, `SnapshotRegistry`: owner guard, dependency order, capture |
| rv-snapshot-capture | `captureDetached`: one session for metadata and participants |
| rv-snapshot-restore | `restoreTransaction`, `createDeferredReactions`: transaction and reaction FIFO |
| rv-des-preflight | `preflightSnapshot`: read-only envelope, participant and queue checks |
| rv-des-snapshot-v4 | `DESSnapshotV4`, `isV4Envelope`: transport envelope, shape guard |
| rv-des-fingerprint | `buildDesFingerprint`, `sameDesFingerprint`: model identity |
| rv-des-model-input | `collectModelInput`, `collectFingerprintInput`: authored scene and document input |
| rv-des-identity | Re-export of core `desComponentId`; address plus component type |
| rv-des-named-actions | `registerAction`, `getActionSchema`: named dispatch and persistence schemas |
| rv-des-action-schema | `assertPersistableQueue`, `callbackOriginProblem`: action ownership and payload checks |
| rv-des-runner-participants | `runnerParticipants`: core participants and staged frame application |
| rv-des-script-participant | `scriptParticipants`, `scriptTimerHandleRefs`, `scriptTimerQueueProblems`: guest state and timer ownership |
| registerSnapshotProvider | Phase 4: `DESRunner.registerSnapshotProvider` in `src/plugins/des/des-runner.ts`; duplicate provider IDs fail, registration returns an idempotent unregister function |

## Snapshot contract

`Snapshottable` is declared in `src/plugins/des/rv-snapshot-registry.ts`.

| Member | Contract |
|---|---|
| key, version | Unique nonempty key; positive integer version |
| dependencies | Optional participant keys; restored before this participant |
| services | Optional owner property names classified as live wiring |
| schema | Optional path-specific codec declarations |
| owner, stateKeys | Optional guarded owner and declared state property names |
| capture() | Return continuation data, without retaining live references in the result |
| validate(json) | Return validation problems without mutation |
| prepare(json) | Allocate detached replacement state |
| commit(prepared) | Swap references without notifications |
| onRestore() | Optional reconstruction after all commits |

`SnapshotJson` is null, boolean, string, finite number other than negative zero, arrays or plain string-keyed records. `rv-snapshot-contract.ts` permits explicit `map`, `set` and `number-tags` codecs at declared paths (`[]` matches one index); their reserved wire tags are `$map`, `$set`, `$num`. Number tags represent NaN, Infinity, -Infinity and -0. They are not automatic user-data revivers.

`createCaptureSession` tracks identity across participants and metadata: cycles and aliases fail, including cross-participant aliases. It inspects descriptors without invoking getters and rejects hidden or lossy state (including symbols, accessors and unsupported prototypes). Use explicit IDs for shared identity. `captureDetached` uses this one shared session.

The State-Guard in `SnapshotRegistry.captureAll` requires `Reflect.ownKeys(owner)` to be a subset of `stateKeys + services`; undeclared properties produce `des-state-not-declared`. It cannot inspect closures. `order()` performs a stable dependency sort, choosing the earliest registered ready participant; missing dependencies and cycles fail before participant calls.

`DESSnapshotV4` contains `version: 4`, `fingerprint`, `simTime`, `nextEventId`, `eventQueue`, `muIds`, `parts` and optional display-only `statisticsCurrent`. **`nextEventId` lives in the envelope**, alongside original queue event IDs; it is not a participant counter. `isV4Envelope` checks shape only; preflight checks ranges and references.

## Restore

`preflightSnapshot` runs before state mutation. Legacy v1-v3 are rejected with `des-snapshot-legacy` (start a new run); identity mismatches use `des-snapshot-fingerprint`; invalid contracts use `des-snapshot-contract`. Checks cover finite times, events at or after `simTime`, unique uint32 event IDs below `nextEventId`, Int32 priorities/MU references, known components/MUs, action schemas/payloads/owners, complete participant keys and versions, participant validators, and saved handles against queue action and owner. Reverse queue checks catch orphan timer slices.

`restoreTransaction` prepares **all** participants by pure allocation, commits them in dependency order, calls all `onRestore` callbacks, runs hooks, then drains deferred reactions in FIFO order (including reactions added by reactions). Commit swaps references without notifications. Before the first commit attempt, failure status is `unchanged`; from that attempt onward it is `corrupt`, including finalization failures. There is no rollback. `DESRunner.restoreFull` reports `des-restore-commit-failed` and resets on corruption. The optional detach callback only stops external execution; it must not mutate snapshot state.

`DESRunner.restoreFull` in `src/plugins/des/des-runner.ts` applies this order:

1. `restoreTransaction`: preflight, prepare, commit, `onRestore`.
2. Hook `des.apply`: lifecycle `beginRestore`, then `beginDesRestore`.
3. `_prepareSnapshotApply`, then `frame.apply(simTime)` (including script state).
4. Materialize visual MUs when needed; `tweens.fromSnapshot` restores tween targets.
5. Set render clock/start status; enqueue `finishDesRestore(true)` reactions, end lifecycle restore; transaction drains deferred reactions.

## Fingerprint

`buildDesFingerprint` and `collectFingerprintInput` produce one `modelHash` over document content hashes, scene rows (node address, authored extras, local matrix using rest poses for simulation-moved nodes), component `{id,type}` rows, script source, `pathGraph`, `schemaVersion`, `rngVersion` and `runtimeVersion` (`RV_VERSION.version`, the release version). Document hashes come from `src/core/engine/rv-model-content-ledger.ts`; transient load URLs are not identity.

The final rule is **model plus release version only** (Thomas, 2026-11-01). See `src/plugins/des/rv-des-fingerprint.ts` (`buildDesFingerprint`, `sameDesFingerprint`), `src/plugins/des/rv-des-model-input.ts` (`collectModelInput`) and `src/core/engine/rv-model-content-ledger.ts` (`recordDocumentBytes`, `recordDocumentStream`) (the restore ignores run parameters). `runConfig` does not count; `runConfigHash` is informational and never compared by restore. This includes DESManager `EndTime`, `StatisticsResetTime`, `MasterSeed` in scene extras via `isDesRunConfigField` in `src/core/material-flow/des-manager-settings.ts`.

Document hashing normalizes GLBs with DESManager extras: hash canonical JSON without those three fields, GLB version, declared/actual remainder lengths and the remaining bytes. Other documents retain raw byte hashes. Byte and streaming paths implement the same rule. Creating the Simulation node for the first time remains a structural model edit.

`DESRunner` checks bind identity against capture identity and the model-edit epoch; changes fail with “model changed since run start”. Unaddressable components/drives/scripts fail with `des-snapshot-unaddressable`; programmatic instances require explicit stable IDs. Pending document hashes prevent a valid fingerprint until hashing settles (`documentHashOf`, `whenDocumentHashesSettled` in the ledger).

## Script contract

Call `self.persist(initial)` once during setup and keep mutable continuation data in that container. The guest validator in `src/core/sdk/rv-sdk-self.ts` captures trusted intrinsics before user code runs. Persist data must be JSON-pure: no NaN, Infinity, -0, Map, Set, functions, aliases or cycles. `ScriptComponentAdapter.captureScriptState` in `src/core/sdk/rv-script-component-adapter.ts` transfers validated guest text; `scriptParticipants` revalidates on the host through the snapshot contract.

| Data | Representation |
|---|---|
| Participant key | Script `desId` |
| Script state | `{rng, fsmState, persist, legacy, timers}` (optional fields may be absent) |
| `self.every` timer table | `{next, items: [{pid, interval, hook, data, current}]}`; `current` is the queued event handle |
| `Script.Hook` payload | `{hook, desId, mu, data}`; MU references are persisted as data |
| Timer handle check | Matching owner and `Script.Hook` action, payload hook `__rv.every`, matching `desId` and `data.pid` |
| Reverse check | Every queued `__rv.every` slice belongs to exactly one timer record |

The restored queue already contains timers: do not re-arm them in `onRestore`. Legacy `onSnapshot`/`onRestore` hooks do not exempt a script from the declared-state rule.

`src/core/sdk/rv-des-ast-check.ts` (`checkDesScriptState`, `loadParser`) uses pinned `acorn` 8.16.0 (`package.json`) through a lazy import. `des-script-undeclared-state` refuses undeclared setup/module mutable bindings, retained object/array/factory state outside permitted persist/service bindings, writes to captured bindings or global/captured properties, and unsafe state-retaining factories/classes. Local handler scratch remains possible; declaring hooks alone does not make hidden state safe.

See [the persist counter example](examples/scripts/des-counter-persist.js), [its test](tests/des/script-persist-example.test.ts) and [Component Scripting](doc-scripting.md#snapshot--restore--persisting-script-state).

## Classification: State / Service / Scratch

State = persisted. Service = live wiring/cache surviving the container swap. Scratch = call-local, rebuilt or must be empty at capture. The following condensed inventories are **phase-5 files**, in `src/core/engine/rv-movement-authority-state.ts` and `src/behaviors/_shared/agv-state.ts`. These literal inventories classify fields; the participants supply codecs and guards.

| Movement authority inventory | Classification / fields |
|---|---|
| `vehicleStateKeys` | State: identity/trajectory (`id,p,plan,curIdx,version,usedLeaders,dirty,replansAtInstant`); all event handles; held claims, routing/freeze/direction; scanner continuation; motion marks/timing, release times; missed-stop/orphan guards |
| `vehicleServices` | Service: `traveler,host,locCache`; traveler coordinates require a separate codec, location cache is invalidated |
| `vehicleScratch` | Empty |
| `mbPlanStateKeys` | State: `route,profile,stopCause,stopLeaderId,leaderBound,freeEnd,staticLimits,odo0,capped,dir`; route stores ordered path IDs and offsets |
| `authorityStateKeys` | State: `vehicles,waiters,flushEventTime,instant,replansThisInstant,lastNow,stats,trace,replanCap,serviceReachCheck` |
| `authorityServices` | Service: `kind,network,listenersInstalled,clock,clearance` |
| `authorityScratch` | `order,flushing,callbackDepth,prevWaits,oppositeScratch,touchedZones,staleScratch,occStart,occEnd,occQueue,occPos,occSample`; capture outside flush/build callbacks, `prevWaits` null |
| `authorityEventHandleFields` | `legEvent`: Arrival or Replan/stop; `extendEvent,watchdogEvent,fieldEvent,statEvent,wakeEvent,notifyEvents,releaseEvents`: Replan kinds extend/watchdog/field/stat/wake/notify/zoneRelease; full action prefix `MF.Agv.` |

| Agv inventory | Classification / fields |
|---|---|
| `agvStateKeys` | State: `active,hiddenByActive,task,phase,serviceRemainingSec,desServiceEvent,serviceMode,dockReleaseFlag,servedPathId,atNodeId,desArrivedPathId,cTime,lastCanMove,stepFrame,frozen,frozenServiceSec,maneuver,maneuverEpoch,serviceEpoch` |
| `agvServices` | Service: traveler/host/kernel wiring, resolved speed/acceleration/scanner/body/route/reset configuration, `_pos,_quat,_parentQuat` pose helpers |
| `agvScratch` | `inHook,_relevantZones,_heldScratch`; capture outside hooks |
| `agvTaskStateKeys` | State: `destination,serviceSec,data,serviceState,approach` |
| `agvTaskServices` | `onArrive,onServiceEnd`; reattached by the owning `AgvTaskCodec`, never silently omitted |
| `agvEventHandleFields` | `desServiceEvent`: `MF.Agv.ServiceEnd`, no `data.kind` |

## Behaviour inventory

Phase 7 behaviours (plus the findings fixes). Inventory and remaining findings follow the plan log “Phase 7 - Behaviour-Teil”; implementations are in `src/behaviors/` and its `_shared/*-snapshot.ts` helpers.

| Behaviour | Closure / status |
|---|---|
| Source | Phase-3a adapter captures generated/pending; emitting is scratch, pose warning is diagnostic deduplication; classification guard |
| Sink | Stateless; consumption lives in adapter/MU allocator |
| Conveyor | Closed missing transit membership, sensor and count state: `blockedMUs,transitMUs,partAtSensor,partCount` |
| Turntable | Closed hidden round-robin/calibration state: `lastCommandedAngle,lastOutputPort,lastInputPort,beltCalibrated,beltNeutralAngle`; queued events checked against FSM phase |
| ChainTransfer | Participant added and lock lifted; blocked/transit membership captured; continuous FSM is scratch, timer derives from geometry |
| OverheadConveyor | Not a participant: only `des.movedNodes`, no DES motion hooks; chain stays at start phase, carrier bind poses are fingerprinted, Run uses `des.signals`; chain position/speed are continuous-only scratch |
| Agv | Participant `fleet.agv:<desId>` plus `fleet.authority`; lock lifted in phase 8 |
| PickPlaceStationExample | Script example, not a material-flow behaviour; script contract belongs to phase 3b |
| Plugin defs | Station, Storage, Downtime, IndexingConveyor, RobotHandling, PalletSource, PathTransport, Processing: phase-3a guard/Robot demo continuation; not re-audited in phase 7 |

Phase 7 also closes preflight gaps for behaviour shape, transit anchors against queue/frozen state, MU ownership/generations, payload MU references and frozen descriptors/tweens. Transit handle values are write-only bookkeeping: persist membership and restore sentinel -1; freeze/resume supplies new IDs. See `des.validateSnapshot` and the snapshot helpers at `e34a1209`.

## Participants and keys

Registrations below were verified in code at integration round 13.

Keys verified in code.

| Key | Source / registration |
|---|---|
| `des.manager` | `rv-des-runner-participants.ts`, `runnerParticipants`: run counters/state |
| `des.mus` | Same function: MU allocator, generations and MU records |
| `des.rng` | `rv-des-rng-participant.ts`, `rngParticipant`: run-version selected. v1: `{rngStates: {<desId>: [a,b,c,d]}}` (SFC32 arrays per component). v2 (plan-2061 phase 3): `{masterSeed, streams: [{id, purpose, seedKey64, state: {a,b,c,counter}}]}` from `rv-des-rng-state.ts` (`captureStreamsDoc`, `validateStreamsDoc`, `applyStreamsDoc`); scope is the component ids plus `__manager__`, `masterSeed` must equal the `des.manager` seed, restore applies via `setState` on the stable stream handles and reseeds streams the snapshot does not name. The experiment store pins `rngVersion` per experiment and replication |
| `des.reservations` | `runnerParticipants`: reservations and next reservation ID |
| `des.tweens` | `runnerParticipants`: tween windows |
| `des.drives` | `runnerParticipants`: drive state |
| `des.signals` | `runnerParticipants`: signal values and pins |
| Component `desId` | `runnerParticipants`: one part per component; scripts use `scriptParticipants` |
| Plugin owner `<address>@<Role>` | `DESRunner.registerSnapshotComponents(id, provider, extraServices)`: derived owners (plan-2059 phase 6b), e.g. `fleet.owners` in `src/plugins/des/fleet/des-handover.ts`; the id is the plan-769 address of the owner node plus `@` plus the owner role (`CarrierOwner`, `FloorSlot`, `EndProbe`; an explicit `role`, not the minified class name) (`@EndProbe` owners use the output conveyor address). Duplicate ids fail with `des-snapshot-contract`; owners are topology, not part of the model fingerprint, and a missing owner is rejected by the registry's missing-participant check. Handover snapshots carry carried loads and slots |
| `fleet.takt` | Per-output takt state `{states, handles, generation, rng: (RngStreamState or null)[], rngStart: ...}`; each output has its own stream state (v1 array or v2 object), restored through `setState`. Takt streams are NOT part of `des.rng` v2 (scope is components and `__manager__`), so nothing is saved twice |
| `diag.blockage` | `runnerParticipants`: optional blockage watch state and context budgets |
| `fleet.clock`, `fleet.takt`, `fleet.pause`, `fleet.wait`, `fleet.dispatcher`, `fleet.runner`, `fleet.lift`, `fleet.handover`, `fleet.kpis` | Phase 6: `src/plugins/fleet-job-participants.ts`, `src/plugins/fleet-plugin.ts` (`:jobs` provider) |
| `fleet.orders` | Phase 4: `src/plugins/fleet-snapshot-participants.ts` (FleetPlugin `:fleet` provider) |
| `fleet.authority`, `fleet.zones`, `fleet.agv:<desId>` | Phase 5/8: `src/plugins/des/fleet/des-movement-participants.ts` (registered at the first Agv bind, also without FleetPlugin); Agv depends on authority |

## Phase 8 guards and additions

| Item | Where / rule |
|---|---|
| Snapshot blockers | `src/core/material-flow/des-snapshot-blockers.ts` (`DesSnapshotBlockers`, one instance per viewer: `viewer.snapshotBlockers`, read by the DES runner of that viewer - a second viewer on the page is not coupled). Subsystems that tick in DES mode but have no participant refuse capture AND restore with `des-snapshot-unsupported-component`: running LogicStep roots, active IK paths, playback, replay recordings (`CoreSubsystems`), running PLC programs (Private PlcPlugin) |
| Unclaimed drives | `DESRunner` refuses capture and restore (`des-state-not-declared`) when a viewer drive outside `des.drives` and not claimed by a participant (`Snapshottable.claimsDrives`) moves or rests away from its start position. Follower drives (`Drive_Gear`, `Drive_FollowPosition`) are derived and exempt |
| Lift positions | `fleet.lift` carries `positions` of the fork-lift drives and claims them |
| Drive tween windows | `des.tweens` also holds running DES drive windows (drive address, t0, t1, from, to) linked to their queue event; Turntable rotation continues with the same window |
| Progress sampler | `diag.blockage` carries the progress sampler cadence and remembered positions (`rv-progress-wiring.ts`) |
| Component timings | Component parts persist raw state durations plus `stateStartTime`; the open interval is never folded in at capture |
| Port references | Turntable cursors and `prop.selectedOutput`/`alignedPort` are port indices, never `Object3D.uuid` (new on every load); `Flow.Occupied@<uuid>` signal keys are written as node addresses |
| Visual parent of a riding MU | The Turntable behaviour state carries `ridingMUs` (MUs whose visual is parented under the rotary). The MU part stores only the LOCAL pose, so restore re-parents (`add`, local pose kept) - at once if the visual exists, else through `DESMU.restoredVisualParent` when the headless MU is materialized (plan-2059 O2) |
| Connection ties | Equal-degree 2-cycles and equal-distance candidates of the connection resolver and `breakTwoCycles` are decided by node identity (`identityIdOf`), uuid only as the last tie-break: uuid is random per load, so a reloaded scene must wire the same topology (plan-2059 O3) |
| Parked no-op drive command | `isRunning` alone does not make an unclaimed drive refuse: ChainTransfer setup parks its lift with `moveTo(0)` (target = position = start, speed 0), which DES never moves (plan-2059 O4) |
| Example task codecs | `AgvTaskCodec.validate(task, vehicleId)` runs in the preflight; AGVDemo course and AGVFactory examples register codecs |
| Conveyor restore | No catch-up wake after a restore; a Run value written by the restore is restored state, not an edge |

## Known limits

| Limit | Evidence / consequence |
|---|---|
| AgvTask callbacks | `src/behaviors/_shared/agv-snapshot.ts`: callbacks are never dropped silently; a task needs an `AgvTaskCodec` (`AgvFleet.registerTaskCodec`, used by `fleet.runner`), otherwise capture refuses with `des-snapshot-agv-task-callbacks` |
| RNG v2 | Snapshots work since plan-2061 phase 3 (`des.rng` v2 streams document); the `rng-v2-snapshot-pending` guard is gone. A snapshot restores only into a run of the same `rngVersion` (it is part of the fingerprint) |
| OverheadConveyor | No participant; DES chain motion is not implemented, as described above |
| Script statistics | `src/plugins/web-component-plugin.ts` uses `statisticsManager`; Script StateStatistics are outside the snapshot |
| Guest callbacks | Dynamically registered `_cbs` in `src/core/sdk/rv-sdk-self.ts` are not stored |
| `stats.flushMs` | Wall-clock diagnostic timing is not stored |
| LogicSteps, PLC programs, IK paths | No participant yet: scenes running them (standard demo `DemoRealvirtualWeb`, `LaserWeldingAssemblyStation`) refuse snapshots visibly (blockers above) |
