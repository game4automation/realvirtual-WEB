# Large-scale performance measurement (plan-465)

How to produce a **citable** statement about how much a realvirtual WEB scene can
carry — and what such a statement may and may not claim.

Every other perf tool in this repo measures seconds of a scene that is already
loaded. None of them can build a large material-flow line without Unity, none of
them watches the heap over hours, and none of them puts PLC signal traffic and
transported parts in the same experiment. That gap is what the tooling here
closes.

---

## What is measured

A **synthetic transport line**: N lanes of chained belt segments, a source at each
lane head, a sink at each tail, sensors every so often, and — unless the load axis
is `none` — real PLC signals bound to the belts (`LINE/PLC<p>/Conv<i>/Run` and
`/Speed` drive the drives, `LINE/PLC<p>/Sensor<j>` reports back).

The line is built programmatically in the browser (`window.__rvSyntheticLine`), so
a parameter sweep costs a page reload rather than a Unity round-trip, and the same
seed always produces the same geometry.

**Before anything is built, the configuration is validated.** A target MU count
the belts cannot hold, or that the source could never spawn — `RVSource` emits at
most one part per fixed step, and the spawn point stays blocked until the previous
part has cleared it — is rejected as INVALID. This matters more than it sounds: an
unvalidated configuration does not fail, it quietly runs half-empty and produces a
confident number about a line that was never full.

---

## What the run is measured IN (and why it used to be wrong)

A frame-time percentile is only readable next to the environment that produced
it. Every report now carries an `env` block, and the runner prints it in the
parameter section:

| Switch | URL | Default (`scenario=line`) | What it changes |
|---|---|---|---|
| debug plugins | — | **off** | `DebugEndpointPlugin` and the MCP bridge are not installed under `?perf`. The debug endpoint snapshots every drive, sensor, surface and signal once a second and POSTs the result to Vite; on a 216-sensor line that was ~14 % of CPU plus fetch stalls, and removing it took frame p50 at 100 MUs from ~45 ms to ~22 ms. |
| welcome modal | — | suppressed | the runner writes `rv-welcome-dismissed` before the page loads; a fresh Playwright profile is always a first visit, and the dialog covers the canvas. |
| `keepmodel` | `?keepmodel=on\|off` | **off** | keeps the loaded demo GLB standing next to the line. With it on, the line (4 128 triangles, 24 instanced draws) was measured on top of `DemoRealvirtualWeb.glb` (265 meshes, ~1.75 M triangles, ~500 draws): draw calls and the shadow pass were properties of that model, not of the MU count. NOT `?model=` — that name is already the viewer's model selector. |
| line origin | `?originx` / `?originz` | **0** when the model is stripped | the line is parked at (1000, 0, 1000) only to stay clear of a loaded model's surfaces. With `keepmodel=off` there is nothing to avoid, and 1.4 km away it sat outside the camera frustum — the first sweep reported 120 triangles for 120 live MUs, i.e. it rendered nothing. |
| camera | — | framed after warmup | `frameSceneContent()` walks VISIBLE meshes, and an MU pool's `InstancedMesh` does not exist until its source has spawned. Framing before the line fills silently leaves the camera where it was. |
| `shadows` | `?shadows=on\|off` | **on** | production behaviour. The product marks shadows dirty whenever the live-MU count changes, so a continuously flowing line re-renders the shadow map nearly every frame; the axis prices that, it does not change it. |
| `effects` | `?effects=on\|off` | **on** | the MU spawn/vanish clip effects. Each install CLONES every material of the MU, and a fresh material instance costs three.js a full `getParameters`/`getProgram` pass on its first draw. Instanced MUs never get the effect (`_startGrow` returns early), so this axis only bites on the clone path — which is exactly where a real GLB scene lives. |

The probe is also **reset after the warmup**, not before it: `durationMs` and every
percentile now cover the observation window alone, and the fill phase is reported
separately as `fill (s)`.

---

## Acceptance criteria (fixed BEFORE measuring)

A cell or a soak is **supported** when all of these hold in the measurement window
(after warmup, excluding hidden-tab and GC-forced samples):

| Criterion | Limit | Why |
|---|---|---|
| Frame time p95 | ≤ 33.3 ms | 30 fps — the HMI fluidity bar |
| Frame time p99 | ≤ 66 ms | individual hitches visible but rare |
| Lost simulation time | ≤ 0.1 % of runtime | beyond that the display drifts away from PLC time |
| Signal jitter p95 (CONNECT cell) | ≤ `PublishIntervalMs` + 50 ms over the running minimum | coalescing window plus one frame |
| **Run validity** (plan-473 F4) | four conditions, each reported individually: live MUs within ±10 % of target; source rate **> 0** and within ±15 % of a REFERENCE run's rate (`--refrate`); sink rate within ±15 % of the source rate; lost simulation time ≤ 5 % of the window | see below — this REPLACES the old `stationary` flag |
| Heap trend (soak, after GC) | ≤ 5 MiB/h, and no monotonic growth in pools / MUs / listeners | leak indicator |
| `renderer.info.memory` | geometries and textures ±1 % start vs end | GPU-side leaks |

A cell that breaks one limit is **not supported in that configuration**. The matrix
report names the last supported cell per axis, and names which criterion broke.

### Run validity: did the run measure what it claims to? (plan-473 F4)

Validity is not a performance criterion — it is the question of whether a run's
percentiles mean anything at all. It is reported in its own section of every
Markdown report, one line per run, with each of the four conditions separately.

The criterion it replaces graded the source against the rate the configuration
ASKS for (`lanes / sourceIntervalS`, e.g. 100 MU/s) while the line physically
tops out around 59 MU/s, because `RVSource` emits at most one part per fixed step
and the spawn point stays blocked until the previous part cleared it. Every cell
therefore printed FAIL and the flag became unreadable — it said nothing about the
run either way.

What changed:

- **Source throughput is graded against an ACHIEVABLE rate**, taken from a
  reference run of the same configuration and handed in with `--refrate <MU/s>`.
  Without it the gate can only require `> 0` and says so, in the report and in
  the JSON (`validity.referenceMissing`).
- **A standstill is explicitly invalid.** `source = sink = 0` on a full belt used
  to satisfy an occupancy-only reading of steady state; `spawnRate > 0` is now a
  hard precondition of the source condition.
- **Lost simulation time enters the validity verdict** (≤ 5 % of the window), not
  just the support verdict. A run that spent a fifth of its window catching up
  measured a stalled tab, whatever its percentiles say.

A run that fails any condition must not be quoted. This is not theoretical: in
the plan-473 campaign the gate invalidated whole cells that another process on
the machine had starved — runs whose frame percentiles looked merely mediocre but
whose source rate had collapsed to 36 MU/s with 23 s of lost simulation time.

**Establishing the reference rate:** run the cell once without `--refrate`, read
the source rate from the run-validity section (or `stationarity.spawnRate` in the
JSON), and pass that number to every later run of the same configuration.

**Known limit:** small cells (`--mu 100` on the default geometry) settle at ~120
live MUs against a target of 100 and can therefore never satisfy the occupancy
condition. That is a property of the line builder's fill control, not of the gate;
pick a target the configuration actually holds.

### The draw-call metric (plan-473 F4)

`draws` in the cell table is **not** a snapshot any more. It has a defined pass
scope and a defined temporal aggregation, both printed in the report header:

- **Scope `frame-all-passes`** — every draw call issued inside one render
  callback: main pass, shadow pass and every post-processing pass together.
  `renderer.info.autoReset` is turned off for the run and `info.reset()` is
  called exactly once per render callback; otherwise three.js zeroes the counters
  at the start of each `renderer.render()` and the last pass wins by accident.
- **Aggregation `median-over-window`** — a per-frame histogram over the whole
  measurement window; the quoted figure is its p50 (`drawMetric.calls.p50` in the
  JSON, which also carries p95/p99/max and the frame count).
- **No hooks required.** Unlike the main/shadow split (`renderPasses`), the draw
  metric is installed for every run that has a renderer, so it is available in the
  `--hooks off` runs that acceptance figures must come from. It costs one
  `info.reset()` and two counter reads per FRAME.

Figures produced before plan-473 used the end-state snapshot and are **not**
comparable; re-measure the reference with the current metric.

### Ambient occlusion and shadows in the header

Both are now in the report header and in the JSON (`env.aoMode`, `env.shadows`).
AO is a default-ON screen-space pass (`gtao` under WebGL, TSL-GTAO under WebGPU),
and until plan-473 it was not protocolled at all — two reports could differ by a
whole post pass without saying so.

---

## Running the tools

All three runners take `--headless` but **headless numbers are not a scale
statement**: Chromium falls back to SwiftShader, and the frame times then describe
a software rasteriser. Reports from a headless run say so at the top. Use headless
only to check that a configuration runs.

```bash
# Scaling matrix — the main tool
npm run perf:matrix -- --mu 500,1000,2400 --sensors 1,4 --load none,browser --duration 300 --runs 3

# Soak: 8 h with heap sampling, then the mandatory control run without GC
npm run perf:soak -- --hours 8 --mu 2400 --load connect --base http://localhost:5100 --gc-interval 5
npm run perf:soak -- --hours 8 --mu 2400 --load connect --base http://localhost:5100 --gc-interval 0

# Signal load — separates what was produced from what arrived
npm run perf:load -- --source browser --rates 1000,5000,20000,50000
```

The `npm run perf:*` scripts take the shared `test-lock`, so a long run cannot
collide with a test suite started in another worktree on the same machine.

Reports land in `docs/perf/<date>-<host>-<kind>.{md,json}` (plus `.jsonl` for a
soak). Each carries a machine fingerprint — CPU, RAM, GPU via
`WEBGL_debug_renderer_info`, Chromium version, DPR/viewport, git commit. **A
percentile without that header is not a citable number.**

### `load=connect`: the real chain

`--load connect` needs the page to be same-origin with the CONNECT gateway, so the
runner must be pointed at it instead of starting its own Vite server:

1. Start CONNECT and verify the licence — without a valid token `GatewayAllowed`
   is false and `MaxSignals` is 0, and the whole run would measure nothing.
   `MaxSignals` must cover `P × filler signals + 2 × P + the line's own signals`.
   Note `PublishIntervalMs`; the jitter criterion is defined against it.
2. Start a broker and the PLC simulator (matching the browser-side geometry):

   ```bash
   cd Assets/realvirtual-Connect~/tools/mqtt-test
   python publish-load-plcs.py --plcs 2 --lanes 24 --segments 9 --signals 500 --cycle-ms 50
   ```

   Configure one MQTT worker per simulated PLC in CONNECT, subscribed to
   `rv/perf/out/#` and publishing viewer writes to `rv/perf/in/`.
3. Run the browser side against the gateway:

   ```bash
   node scripts/perf-scale-matrix.mjs --base http://localhost:5100 --load connect --mu 2400 --sensors 4
   ```

The publisher prints its **produced** rate; the runner reports the **arrived**
rate. They are different numbers by design — the worker coalesces, and the
incoming buffer keeps only the last value per signal per tick — and a report that
quotes only one of them is misleading. `SEQ` gaps count exactly what was
coalesced away.

### The GLB control cell

`scenario=model` (the default `?perf` run) now carries the SAME probe as the
synthetic scenario, so a real GLB — `DemoRealvirtualWeb.glb` with its source
turned up — produces frame percentiles measured with the same instrument. That
is the point of the control: multi-mesh MU templates take the clone path instead
of instancing, and a synthetic-only measurement would silently generalise from
the instanced curve to a scene that is not on it.

```bash
node scripts/perf-scale-matrix.mjs --base http://localhost:5199 --mode supported   # synthetic
# and, in the same session, a model run for the control:
#   open /?perf&scenario=model&duration=300 against the same server
```

Report `pools` and whether the source used instancing next to the control
figures — that is what makes the comparison interpretable.

---

## Reading the latency figures

There is **no clock synchronisation** between the Python publisher and the
browser, so an absolute latency is not measurable and is deliberately not
reported. What is reported:

- **Jitter** — the deviation of `tRecv − tPublisherTS` from its running minimum,
  where `tRecv` is the main-thread arrival of a `delta` message. Exact.
  A constant transport delay present from the first sample is **invisible** here.
  That is a property of the method, not an error bar.
- **Flush latency** — `tCommit − tRecv`, entirely inside the browser. Exact.
- **Coalesced gaps** — missing `SEQ` numbers.
- A `SEQ` rollback is treated as a publisher restart and resets the minimum.

---

## The GC pair

Forcing a collection is what makes a heap slope meaningful (an unforced reading
mostly samples where in the sawtooth you happened to land) and it is also what
perturbs frame timing. So a soak conclusion needs **two runs**:

- `--gc-interval 5` — heap trend valid, timing perturbed (perturbed samples are
  marked and excluded from the percentiles, but the run is still the noisier one).
- `--gc-interval 0` — timing clean, no heap trend.

A 24 h figure quoted from an 8 h run is an **extrapolation of the fitted slope** and
must be labelled as such wherever it appears.

---

## Quoting this to a customer

State the conditions with the number. A supported scale figure from this harness
holds for: kinematic transport **without** physics, **instanceable** single-mesh MU
templates, the stated number of PLCs over CONNECT, and the machine in the report's
fingerprint. Multi-mesh templates take the clone path instead of instancing and
belong to a different curve — that is what the GLB control cell is for.

There is **no reference customer** at this scale in the material reviewed for this
plan. The numbers here are our own conditional synthetic measurement, and saying
so is part of the claim.

---

## Transport-step attribution (plan-469)

The matrix runner can additionally attribute the transport fixed step to the
phases it is built from, and price minimal optimisation prototypes against the
very same cell. Everything here is **dev-only**: in production
`RVTransportManager.regionHooks` and `probeCounters` are `null` and every
prototype switch is `false`, so the whole mechanism reduces to a handful of null
checks and boolean tests.

### Regions

`RVPerfProbe` installs an {@link RVRegionTimer} on the manager for the duration
of a run. The manager brackets each phase with `enter`/`leave`; the timer keeps a
small stack, so a **nested** region is subtracted from its parent automatically.
Every reported number is therefore **exclusive**, and the regions sum to at most
the step.

| Region | What it covers |
|---|---|
| `sources` | step 1, source spawning |
| `surfaceGrid` | step 2, surface AABB update + grid re-index (+ any rebuild) |
| `pick` | `_pickDrivingSurface`, per MU, summed over the tick |
| `transportExcl` | the per-MU transport body MINUS `accumulation` and `adjacency` |
| `accumulation` | `queryLeadingMU`, nested inside the transport body |
| `muAabbGrid` | step 4, MU AABB update + MU-grid re-index |
| `sensors` / `sinks` / `removal` | steps 5, 6, 7 |
| `poolMatrices` | step 8, instance-matrix compose |
| `adjacency` | a dead-end adjacency cache REBUILD (cold, nested) |
| `growth` | `MUInstancePool._grow()` (cold; measured in `rv-mu.ts`, charged per tick) |

Regions that run per MU are entered N times per tick and **accumulate** — the
report shows the per-tick SUM, never a per-MU value.

`coverage` = `sum(exclusive regions) / total`. The plan wants >= 90 %; the
remainder is honestly reported as unattributed rather than assumed to be GC.
**GC is never inferred from missing attribution** — it is measured separately,
either with `--js-flags=--trace-gc` or from a CDP profile's `(garbage collector)`
share, and the report says which method was used.

### Long steps

Every transport step above **100 ms** produces a record with its exclusive
regions and three flags — `poolGrew`, `adjacencyRebuilt`, `surfaceGridRebuilt` —
so a 400 ms outlier names its own cause instead of being guessed at. Records are
capped at 200 per run; the report states how many were dropped.

### Hit rates (F1b)

| Probe | Meaning |
|---|---|
| pick fast-path | fraction of MUs per tick for which the REAL fast-path predicates (i)-(vi) hold — membership, non-radial, XZ overlap, active, band against the cell upper bound. Not "rule 1 would apply": a tall non-overlapping surface in the same cell raises `cellMaxTopY` and blocks the fast path (SOL R2#3). |
| accum span stable | fraction of accumulation queries whose cell span is unchanged AND none of whose cells changed since the last query (the exact validity condition of the stage-1 union cache). |
| clone share | share of MU-AABB updates on clone MUs (the only ones that walk the world matrix); instanced MUs read typed arrays and are unaffected by F4. |

While the probe is on, the `pick` region **also contains** the fast-path
predicate evaluation, so it slightly over-states the reference cost. The honest
price of the fast path is the A/B cell, not that over-estimate.

### Switches

```bash
# Baseline WITH attribution
node scripts/perf-scale-matrix.mjs --mu 100,500,2400 --sensors 1 --load none \
  --renderer webgl --keepmodel off --shadows on --duration 300 --runs 3 \
  --hooks on --out <date>-plan469-baseline

# Instrumentation overhead: same cell, hooks uninstalled
node scripts/perf-scale-matrix.mjs --mu 2400 ... --runs 1 --hooks off

# One A/B pair against the same cell: reference side, then production side
node scripts/perf-scale-matrix.mjs --mu 2400 ... --runs 3 --proto refslowpick,refaabb
node scripts/perf-scale-matrix.mjs --mu 2400 ... --runs 3 --refrate 59
```

`--proto` and `--hooks` are **not axes**: one setting per invocation, so an A/B
pair is two runs of the runner and the report names which side it is (the `proto`
and `hooks` columns of the per-run table come from the page's own `env`, not from
the command line, so a typo cannot be mistaken for a measurement).

Switch names (plan-473 revised the inventory):

| Name | Kind | What it does |
|---|---|---|
| `refslowpick` | reference | turns the **production** sticky-ownership fast path OFF, restoring the full surface-pick slow path. This is the comparison side of an F3 A/B pair. |
| `refaabb` | reference | turns the **production** instanced AABB cache OFF, restoring the unconditional rotated-extent recompute. Comparison side of an F2 A/B pair. |
| `walk` | prototype | one world-matrix walk for clone MUs (plan-469 F4). |
| `bounds` | prototype | pool extents in the compose loop (plan-469 F5). |

Comma-separating them arms them together, so
`--proto refslowpick,refaabb` is the full pre-plan-473 reference path and no
`--proto` at all is production.

`fastpath` and `union` are **gone**: plan-473 made the fast path production and
deleted the cell-union cache (it was slower than its reference in both plan-469
campaigns). A reference switch is the inverse of a prototype switch, and that
inversion is deliberate: the comparison side of a parity test or an A/B pair must
not be able to run the very code under test.

### Comparing runs

The runner grades and reports **every** run, not only the median-by-frame-p95 one
(SOL #8), and prints the live-MU occupancy of each. Two cells are only comparable
while their occupancy spread is <= 5 % — the per-run table says so explicitly.

---

## Files

| Path | What |
|---|---|
| `scripts/lib/perf-bench-lib.mjs` | Vite server, Chromium launch, fingerprint, CDP heap, percentiles, grading, report writing |
| `scripts/perf-scale-matrix.mjs` | the matrix runner |
| `scripts/perf-soak.mjs` | the soak runner |
| `scripts/perf-signal-load.mjs` | the signal-rate runner |
| `src/core/engine/perf/rv-synthetic-line.ts` | the line builder (dev-only) |
| `src/core/engine/perf/rv-perf-probe.ts` | per-frame/per-step probe, histograms, latency clock, transport-step region attribution, simulation stages, main/shadow render split, world-matrix counters (dev-only) |
| `src/core/engine/perf/rv-synthetic-assets.ts` | realistic-scene ingredients: library conveyors, library MU template, robot farm (dev-only, plan-469 Phase 0d) |
| `src/core/engine/perf/rv-sim-stage-hooks.ts` | the `ContinuousRunner.tick()` stage seam (holder only; `null` in production) |
| `tests/perf/synthetic-realistic-scene.test.ts` | realistic-scene generator: defaults unchanged, robot determinism, topology untouched, dispose (plan-469 Phase 0d) |
| `tests/perf/sim-stage-hooks.test.ts` | stage seam inert with hooks null; enter/leave order; `RVStageTimer` |
| `tests/perf/accumulation-candidate-count.test.ts` | measured candidate-count distribution of the accumulation query |
| `tests/perf/transport-phase-timing.test.ts` | region attribution: hooks neutral, accumulation exclusive, long-step flags (plan-469 §9.1) |
| `tests/rv-transport-prototype-switches-off.test.ts` | prototype switches off == reference path; switch-on parity (plan-469 §9.2) |
| `src/interfaces/synthetic-load-interface.ts` | in-browser load generator (dev-only) |
| `Assets/realvirtual-Connect~/tools/mqtt-test/publish-load-plcs.py` | the multi-PLC MQTT load source |

### Stored reports

| Report | Status |
|---|---|
| `2026-09-06-smoke-runner-check.*` | **before fix — not citable.** Wiring check only. |
| `2026-09-06-first-2400-cell.*` | **before fix — not citable.** Debug plugin running, probe reset before warmup, demo model in the scene, line off-camera. |
| `2026-09-06-sweep-500-1500.*` | **before fix — not citable.** Same four defects. |
| `2026-09-06-control-100.*` | **before fix — not citable.** Same four defects. |
| `2026-09-06-soak-100-6min.*` | **before fix — not citable.** Same four defects. |
| `2026-09-06-sweep-after-fix.*` | first report taken with the corrected harness. |
| `2026-09-07-plan469-*` | Phase 0 baseline, A/B prototype pairs and the GC profile. The `ab-*` pairs are only comparable WITHIN a near-in-time pair — the reference cell drifted from 9,25 to 14,50 ms step p95 over that evening. |
| `2026-09-08-plan469-realistic-*` | Phase 0d realistic scene (library conveyors + CartonBox MU + 100 robots), ladder S0-S4 in both directions, robot-scaling axis and the `hooks=off` price. Window is **120 s**, not the 300 s of §1.3. `2026-09-08-plan469-realistic-campaign.sh` is the exact invocation list. |

They are kept rather than deleted because the plan's own record of what went
wrong is worth more than a clean directory — but no number in them may be quoted.

Everything under `src/core/engine/perf/` and the load interface is behind
`import.meta.env.DEV` and contributes 0 KB to a production build.

### Realistic-scene axes (plan-469 Phase 0d)

`--geometry primitive|library` draws real `RollConveyor-*.glb` on every belt as
`InstancedMesh` (the transport topology is identical either way);
`--muasset primitive|cartonbox` swaps the MU template for `CartonBox.glb`;
`--robots <N>` with `--robotmotion static|erratic` adds six-axis robots beside the
lanes that never touch the material flow. All four default to the plan-465 cell, so
an existing invocation measures exactly what it measured before.

Two properties of the numbers these produce:

* **`--hooks off` is the only production-like frame time.** The world-matrix
  wrappers intercept > 6 000 calls per frame; measured price on 2026-09-08 was
  ~4,7 ms step p95 and 25-45 ms frame p95.
* **A library asset is not automatically a usable MU.** `CartonBox.glb` carries a
  ~1,7 m geometry offset from its own node origin; the generator bakes the
  transform into cloned geometry and turns the long horizontal axis onto X, because
  otherwise the MUs sit beside the belt (sink rate 0) or measure only 134 mm along
  the belt (occupancy off by 11 %).
