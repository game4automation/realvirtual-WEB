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
| Stationarity | over ≥ 5 min: live MUs within ±10 % of target **and** source rate ≥ 0.9× configured **and** sink rate ≥ 0.9× source rate | occupancy alone would call a completely stalled line perfect |
| Heap trend (soak, after GC) | ≤ 5 MiB/h, and no monotonic growth in pools / MUs / listeners | leak indicator |
| `renderer.info.memory` | geometries and textures ±1 % start vs end | GPU-side leaks |

A cell that breaks one limit is **not supported in that configuration**. The matrix
report names the last supported cell per axis, and names which criterion broke.

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

## Files

| Path | What |
|---|---|
| `scripts/lib/perf-bench-lib.mjs` | Vite server, Chromium launch, fingerprint, CDP heap, percentiles, grading, report writing |
| `scripts/perf-scale-matrix.mjs` | the matrix runner |
| `scripts/perf-soak.mjs` | the soak runner |
| `scripts/perf-signal-load.mjs` | the signal-rate runner |
| `src/core/engine/perf/rv-synthetic-line.ts` | the line builder (dev-only) |
| `src/core/engine/perf/rv-perf-probe.ts` | per-frame/per-step probe, histograms, latency clock (dev-only) |
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

They are kept rather than deleted because the plan's own record of what went
wrong is worth more than a clean directory — but no number in them may be quoted.

Everything under `src/core/engine/perf/` and the load interface is behind
`import.meta.env.DEV` and contributes 0 KB to a production build.
