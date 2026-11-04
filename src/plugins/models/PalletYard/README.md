# PalletYard — project plugin (plan-612)

Three forklift AGVs (AGV-Stacker; the count is a parameter, see *AGV count*
below) on a one-way loop serve two production outputs
(A1, A2), two shipping inputs (V1, V2), six floor slots (P1..P6) and two chargers
(L1, L2), with a wait point (W) in front of the chargers. Scene:
`scenes/PalletYard.glb`, bound through `project.json` (`scriptRef:
plugins/pallet-yard/index.ts`).

## Files

| File | Role |
|------|------|
| `layout.ts` | The one source of geometry, path graph (split zones) and `PALLET_YARD_CONFIG` — used by the generator, the plugin and the tests |
| `dispatch-policy.ts` | Configuration mapping and retrieval rules for the fleet dispatch core |
| `src/core/fleet/core/` | Shared dispatch, storage, reservations, battery, routes and takt/pause sources (plan-559 Phase 4) |
| `src/core/fleet/exec/job-runner.ts` | The fleet core's fixed forklift executor: jobs → Agv tasks, docks, fork first, stich exit, wait point, charging, wait states, task ownership (plan-559 Phase 5) |
| `src/plugins/des/fleet/` | DES kernel adapters: clock (`DesSimClock`), lift (`DesLift`), hand-over (`DesHandoverBackend`: end probe + `nextComponents` swap, `CarrierOwner` on `ForkAnchor`, `FloorSlot`, seat reconcile, owner registry) |
| `src/core/fleet/continuous/handover.ts` | Shared continuous kernel adapters (`ContinuousHandover`) |
| `continuous-bind.ts` | PalletYard scene lookup and geometry for `bindContinuousYard` |
| `parameters.ts` | The planning-window declaration (`Size`, `Production load`, `Stations`, `Shipping`, `Fleet` — the AGV count lives here as `vehicles`) and the mapping of committed values onto the runtime configuration |
| `index.ts` | The yard's configuration of the executor (`createYardRun`, `yardSite`), the DES scene bind (`bindDesYard`: nodes + hand-over poses), live planning values, viewer plugin (`bakeClaims`, bind per kernel, reset, per-frame work, planning lifecycle) |

## Flow

1. The takt releases a pallet onto an output head (`Source` with `AutomaticGeneration:false`).
2. The pallet's arrival at the belt end is a pick order. The dispatcher picks a destination
   at assignment: a free, not paused input — otherwise the floor slot free the longest.
3. The stacker drives to the stich, backs in fork first (`AgvTask.approach: 'reverse'`), the
   dock holds it: fork to approach height, take, lift, release. Out forward, fork back to
   travel height once clear.
4. At an input it lifts above the head and puts the pallet down — during a pause or with
   the head occupied it waits in the dock until the pause end / the head frees.
5. After every stay the vehicle gets its next job, the wait point (one vehicle; the charger
   queue first) or cruises the loop (`clear()`). Below 30 % SOC it charges (task
   `serviceState: 'Charging'`), the SOC is published as `node.userData._rvStateOfCharge`
   (DES tooltip and the SOC row of the in-scene DES badge, which rides along with the
   stacker). While a stacker charges, "⚡ n %" floats above its charger
   (`charger-label.ts`, always on, redrawn at most every 500 ms wall clock and only on a
   new whole percent).

## Continuous mode (CP2)

Without a DES runner the plugin binds `ContinuousHandover` (the same executor, the same
order logic; a mode switch unbinds one backend and binds the other):

- Production: one rising edge of `GenerateMU` on the `Pallet_<output>` source per takt
  (automatic / interval generation are switched off at bind). An edge without a spawn is
  counted and reported (`pallet-yard-spawn-missing`); only spawned pallets count.
- Ready to pick: the output conveyor stops at its own end sensor; the sensor seeing the
  pallet is the pick order. A pallet waiting there is kept away from the planner's
  end-of-line vanish.
- Pick: `holdMU(…, 'grip')` on `ForkAnchor` with the world pose kept (no jump); the sensor
  stops the pallet 44 mm before the DES hand-off pose, so the held pallet glides onto the
  fork seat by at most 1 mm per tick (collider bottom `PALLET_SEAT_M` below the fork top).
- Drop: placement check while held, then `detachMU` + `placeMUOnSurface` at the pallet's own
  collider centre. A refusal after the detach restores hold and seat pose; the stacker stays in
  the dock and retries when the head frees, at the latest every second.
- Shipping pause: `<input conveyor>.Flow.Run`. Floor slots: free MUs where the fork set them down.
- Ticked through `ContinuousHandover.attach(context.simLoop)` at `TickStage.POST` (lift ends, source edges, sensors, glide, clock); allocation-free.
- The shipping conveyors hand over to `ConveyorOut_*` through their paired snaps — the
  snap-point plugin must be registered (it is in the app).

## Layout rules (split zones, plan-595 §2.3)

- Stich dock = own capacity-1 zone `Stich_<id>`; the quarter arc (mouth) and the lane
  pieces `_In` (1.8 m) / `_Out` (0.6 m, turn point at its end) form `Merge_<junction>`.
- 1.8 m before a junction covers the stacker body on a mouth (finding #194, about 1.68 m
  needed); the scene test runs `findShortMergeEntries`.
- 1.0 m free lane after each merge piece: a vehicle at the turn point must not reach into
  the next merge zone (that claim is not released by the reverse leg).
- Every junction except W is a twin (an inside and an outside stich).

## AGV count (plan-2015)

The size of the fleet is a parameter, in three places that are ONE value:

- **Property**: `PalletYard.VehicleCount` on `PalletYardRoot` — the only authored
  scalar of the component beside the read-only `Size`. Editable in the Inspector
  (integer, 1 .. `maxVehiclesFor(size)`), and because the type declares
  `paramApply: 'rebuild'` it carries variant and experiment values and shows the
  variant icon.
- **Planning window**: `Fleet ▸ Vehicles`, `apply: 'reset'` — the same kind of
  structural row as `Size` and `Buffer slots per module`.
- **Effect**: every path ends in `rebuildYard()` → `composeYardWithVehicles(size, n)`
  → `materializeYard`, i.e. AGVs are PLACED and removed through the normal
  `AssetReference` / instancer route, with one reset at the close of the structural
  transaction. No GLB change is needed to go above the three AGVs the file carries.

What follows from the count, derived, never stored twice: the `vehicles[]` name
list (`Stapler_1..n`), the `Agv` placements with their `PathId`/`StartPosition`,
and `battery.startSoc` (90 % down to 50 % spread over the fleet; a surplus value
is simply not produced). `production.phaseSec` and `shippingPauses.offsetSec`
belong to outputs and inputs, not to vehicles, and are untouched.

Precedence when the sources differ: an explicit planning value, else the stored
`VehicleCount`, else the size's own default (`vehiclesPerModule` — so a pure size
change still scales the fleet as it did before this parameter existed). Raising
the count appends AGVs; the ones already there keep their start path.

A run includes only vehicles with `Agv.Active` enabled (missing means enabled), sampled when the run is bound at start/reset. Use the `Vehicles` count for structural changes. Use `Active` in the inspector, or in the planning window via "Show in planning window", to take a single vehicle out of service at the next reset. At least one vehicle must be active.

## AGV breakdowns and the Experiments example

Three more scalars on `PalletYard` (same rebuild path as `VehicleCount`, so they
are variant / experiment properties too):

- **`AgvMtbf`** (s, default 0 = no breakdowns): mean time between failures per AGV.
- **`AgvMttr`** (s, default 300, min 1): mean time to repair.
- **`AgvDowntimeStochastic`** (default true): exponential draws from the seeded RNG
  instead of fixed times.

With `AgvMtbf > 0` the composition places one `Downtime` node per vehicle
(`Downtime_Stapler_k`, `TargetComponentPath` = the vehicle's DES path
`PalletYard/PalletYardRoot/Stapler_k`), so any AGV count gets exactly its own
breakdowns. A breakdown freezes the AGV where it stands, and it keeps the zones it
holds, so on the one-way loop the vehicles behind it wait too. The document's own breakdown
nodes are never re-created by a rebuild. They are updated in place (re-parameterised,
or `Enabled: false` when their vehicle is gone or `AgvMtbf` is 0). Only a vehicle the
document has no node for gets a runtime node. A re-created node would get a
new runtime identity and change the DES base key.

**The demo document is an experiment.** Base = 3 AGVs, MTBF 3600 s, MTTR 600 s
(86 % availability, about 7 breakdowns per AGV per 8 h shift). The scene extras carry
three variants: **2 AGVs**, **4 AGVs**, **No downtime**. The column settings ship in
`public/demo-realvirtual/experiments/doc_palletyard_hzmdb6.rvexp.ndjson`: 8 h, 5 runs
per column, matching seeds, and `VehicleCount` / `AgvMtbf` / `AgvMttr` pinned as rows.
Its row in `project.json` declares the file (`"experiments"`): the deployed demo fetches
only declared archives, so keep the declaration in step with the file.
A fresh browser profile imports these when the document opens. Open **Experiments**
and press **Run all**. Typical result (5 runs): No downtime ≈ 52 /h; Base ≈ 41 /h;
2 AGVs ≈ 35 /h; 4 AGVs ≈ 37 /h. The AGVs are the bottleneck (production takt is
80 /h), and a broken AGV also holds up the others. More vehicles do not raise
throughput here because they block each other on the one-way loop.

## Regenerate the scene

```bash
node tools/des-examples/pallet-yard.mjs
```

Idempotent: the GLB is written only when its bytes change; the `project.json` row is
inserted when missing and re-stamped only after a write. Library assets are embedded —
re-run after a library update.

## Asset provenance (plan-680 Phase 3)

The scene's library models are realvirtual's own, not third-party/Asset-Store imports:
`EuropalletLoaded`/`Europallet` (`Assets/realvirtual-Library/PalletHandling/`, checked in
2025-10-07 on branch `feature-DESSimulation`) and the pallet scanner geometry behind the web
`PalletScanner.glb` (`PalletizingScanner.fbx`, `Assets/realvirtual-Library/PalettConveyors/Models/`,
checked in 2026-06-30/07-01 on branch `Release63/dev-scannercell`) — both committed directly by
realvirtual team members into the in-house `realvirtual-Library` package, the same provenance
pattern already confirmed for the AGV family (plan-680 E22).

## Status

- DES runtime: done (CP1). Continuous backend and DES ↔ continuous parity: CP2. Soak: CP3.
- DES snapshots are not supported: loading one reports `pallet-yard-snapshot-unsupported`
  in the Problems panel and the yard restarts.
- plan-559: the yard runs on the fleet core — dispatch since Phase 4, the job execution and
  the DES adapters since Phase 5 (wait reports `fleet-wait-timeout:<vehicle>:fork|exit`).
