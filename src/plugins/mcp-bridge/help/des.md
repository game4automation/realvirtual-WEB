# DES (discrete-event simulation)

Event-driven material-flow simulation — time jumps between events instead of frame stepping.
Enter with `web_execute("workspace.setMode", {"mode":"des"})` (or `?mode=des`); DES tools hint when not active.

## Workflow

1. `web_query("diagnose", {})` — summary first: run state, problems, faults,
   fleet counts and statistics sanity. Follow up with `des.status`, `des.events`,
   `fleet.status` or `problems.list` through `web_query`.
2. `web_query("des.components", {"busyOnly":true})` — per-component load / in-transit / blocked and the
   next/prev wiring. The go-to tool for deadlocks, full zones, wrong connections.
3. `web_query("des.stats", {})` — utilization (Working/Setup/Blocked/Empty/Failure %), output/h, in
   material-flow order — line balance at a glance.
4. `web_query("des.bottleneck", {})` — the constraining component + how many upstream are blocked vs
   downstream starved.
5. `web_execute("des.step", {"count":1})` — advance one event when diagnosing (set `count` for more).
6. `web_execute("des.setMode", {"subMode":"hybrid","multiplier":10})` — animated (1x) | hybrid (Nx) | fastforward (max) | step (manual).

## Run state

`web_query("des.status", {})` uses the toolbar's run-state source. Read `runState`
and `reason`, rather than inferring completion from `pending`:

- `finished` / `duration-reached`: the configured end time was reached; events beyond it can remain pending. This does not mean the model is blocked.
- `finished` / `queue-drained`: an unlimited run has no more model events.
- `stalled` / `queue-empty-before-end`: no more model events before a finite end time; investigate exhausted sources or blocked flow.
- `paused`, `running`, `idle`: paused (see `pauseReasons`), active (including FastForward), or not started. `diagnose` reports `not-des` outside DES mode.

Checkpoint events do not keep a model run alive. Non-finite times are serialized as strings
such as `"Infinity"`. Without scene DESManager settings, the end time defaults to 86400 s (24:00:00).
The **Run finished** or **No more events** toolbar chip opens statistics; its tooltip explains the state.
After "Run finished" (end time reached) **Play continues the run**: the end time grows by one more run
length (24:00:00 -> 48:00:00), the clock runs on, statistics continue. Reset starts again from 0 with the original end time.

## FastForward and clock settings

`web_execute("des.fastForward", {"untilSimTime":"00:01:00:00"})` runs to T (here, one hour).
The event loop stops before the first event after T, including system events and within a batch;
on successful completion, simulation time is T, the previous submode and multiplier are restored,
and the run ends user-paused. `web_execute("sim.playPause", {})` resumes it. An aborted or rejected
target run does not add that user pause. Without `untilSimTime`, `on: true` / `false` enables/disables
FastForward; omitting `on` toggles it.

`des.setEnd {end?, statReset?}` updates the live settings and persists them on the scene DES manager.
Both use `DD:HH:MM:SS`; `end` also accepts `"inf"`. Either setting can be supplied independently.
Like the seed they are Base settings: refused while a variant is shown in the scene, and a refused or
failed scene write leaves the live value unchanged (an error, never a silent success). Called while
the document loads (right after a load or reset), `des.setEnd` and `des.seed.set` wait for the load
(at most 30 s) instead of being refused. The settings survive `sim.reset` and an experiment batch, and
changing them does not make experiment results stale: a column has its own run length and warm-up.

## Random seed

The clock window's **Random seed** setting as commands: `web_query("des.seed.get", {})` returns
`{seed, mode}`; `web_execute("des.seed.set", {"seed":1234, "mode":"fixed"})` sets it. `mode` is
`fixed` (every reset repeats the same run) or `auto` (a new seed is rolled before every new run);
`seed` is an integer from 1 to 2147483647, stored on the scene DES manager like the clock window
does, and is refused in `auto` mode and while a variant is shown in the scene (the seed is a Base
setting). The scene write comes first; a refused or failed write leaves the live seed unchanged.
Either argument can be given alone. Blocked while an experiment batch runs.

## Statistics and hover

`web_execute("des.stats.window", {"open":true})` opens statistics (`false` closes it).
Optional `hiddenKinds` replaces the hidden statistics kinds in the shared window store.
`web_execute("des.badges", {"on":true})` enables in-scene statistics badges (`false` disables them).

`MaterialFlowDefinition.statsKind` sets the statistics kind. AGV/forklift vehicles (`Agv`)
report `'vehicle'` in statistics output and the statistics window chip.
In DES mode, hovering a DES component or a child part under it shows state, load,
utilization and Output/h through the `des-component` tooltip resolver.
Clicking a statistics window bar selects the component via `selectionManager`;
closing the window only clears a selection the window made itself.

## Planning parameters and performance test

Use `web_execute(command, args)` for planning changes and `web_query(command, args)` for status:

1. `planning.param.set` with `values` as a JSON object string of declared keys and values.
2. `planning.param.apply` to commit pending parameters and reset the run; check `ok` before continuing.
3. FastForward with `web_execute("des.setMode", {subMode:"fastforward"})`.
4. `des.status` — check `runState` and its reason: has the run finished or stalled?
5. `planning.param.list` — read back parameters, KPIs, change log and scenario state.

## Experiments

The experiment manager (matrix, replications, batch runs, comparison, export/import and
`experiment.*` commands) is a commercial module (realvirtual Commercial).
`web_help("experiments")` is available when it is installed. Without it, `experiment.*` answers
with error kind `commercial-feature`, and the **Experiments** button shows a notice instead of the
matrix. KPI definitions and the KPI recording of a single run belong to the DES core.

## Snapshots

Use **Save snapshot** / **Load snapshot...** in the DES side toolbar. Checkpoint autosave of a live
run (`des.checkpoints.set`, `des.checkpoint.list`, `des.checkpoint.load`) belongs to the experiment
manager; without it these answer with error kind `commercial-feature`. Snapshots require the same model and RNG version. Pending script timers and declared state are restored; see `web_help("scripting")`.


## Randomness

Ordinary Play defaults to RNG v1. RNG v2 derives named streams from the master seed,
component identity and purpose. Snapshots preserve the RNG version and state.


## Tool reference

<!-- BEGIN GENERATED: tool-reference des — do not edit; run `npm run gen:mcp-docs` -->
_0 tools in this family, generated from the @McpTool decorators — do not edit by hand._

| Tool | Access | Parameters | Summary |
|------|--------|------------|---------|
| _none_ | | | |
<!-- END GENERATED: tool-reference des -->
