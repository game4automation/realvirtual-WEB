# realvirtual WEB — scaling matrix (plan-465)

## Machine fingerprint

- **Host:** desktopmsi (win32 10.0.26200)
- **CPU:** Intel(R) Core(TM) i5-9600K CPU @ 3.70GHz (6 logical)
- **RAM:** 31.9 GiB
- **GPU:** Google Inc. (NVIDIA) — ANGLE (NVIDIA, NVIDIA GeForce GTX 1060 6GB (0x00001C03) Direct3D11 vs_5_0 ps_5_0, D3D11)
- **Chromium:** 145.0.7632.6, Node v24.19.0
- **DPR/viewport:** 1 @ 1280x720
- **Commit:** e892cd2838cc325cd8e5c99611d7b75f08928d00
- **Long-task observer:** yes; precise heap: yes
- **Timestamp:** 2026-09-08T17:05:28.329Z

## Parameters

- Mode: `supported`, 1 run(s) x 120 s observation
- Line geometry: {"lanes":24,"plcs":2,"segments":9,"seglen":5,"speed":1000,"templates":1,"seed":465}
- plan-469: `--proto (none — reference path)`, `--hooks on`
- Debug plugins: **off** (`DebugEndpointPlugin` and the MCP bridge are not installed under `?perf`)
- Welcome modal: suppressed (`rv-welcome-dismissed`)
- `fill (s)` is the warmup the line needed to fill; the probe is reset AFTER it,
  so `window (s)` and every percentile cover the observation window only.

## Cells

| MUs | sensors/seg | load | renderer | shadows | effects | model | geometry | MU asset | robots | frame p50/p95/p99 (ms) | step p95 | transport p95 | draws | live MUs | pools (cap) | fill (s) | window (s) | lost sim (s) | supported |
|---:|---:|---|---|---|---|---|---|---|---|---|---:|---:|---:|---:|---|---:|---:|---:|---|
| 2400 | 1 | none | webgl | on | on | off | library | cartonbox | 0/static | 35.3 / 79.3 / 124.8 | 17.75 | 17.50 | 276 | 2400 | 24 (3072) | 74 | 120 | 1.232 | **no** (frame p95 <= 33.3 ms; frame p99 <= 66 ms; lost sim time <= 0.1 %; stationarity reached) |

## plan-469 — per-run figures

Every run is listed and graded on its own (the median-by-frame-p95 run above is
not necessarily the median STEP run, SOL #8). `live MUs` is the actual belt
occupancy of that run — A/B comparisons are only valid within ±5 %.

| cell | proto | hooks | run | live MUs | step p50/p95/max (ms) | transport p95 | frame p95 | long steps | coverage | stationary |
|---|---|---|---:|---:|---|---:|---:|---:|---:|---|
| 2400 | none | on | 1 | 2400 | 12.25 / 17.75 / 78.7 | 17.50 | 79.3 | 0 | 89.8 % | no |
| 2400 | | | **spread** | 0.0 % | comparable (≤ 5 %) | | | | | |

## plan-469 — transport-step attribution (exclusive ms per tick)

Regions are EXCLUSIVE: a nested region (`accumulation` inside the per-MU
transport body, `adjacency` inside it) is subtracted from its parent. Per-MU
regions are the per-tick SUM over all MUs. `sum` is the sum of the exclusive
regions, `total` the instrumented transport step; the rest is unattributed.

`performance.now()` is clamped to 100 us in this (not cross-origin-isolated)
context, so a single per-MU region visit reads as 0 or 0.1 ms. The boundaries
CHAIN, so the per-tick SUM telescopes and is exact to one clock tick; the split
between regions is an unbiased stratified sample that converges over the run.
Region histograms use 0.05 ms bins (half the clock tick) and every percentile is
clamped to the value actually observed, so a region that never ran reports 0.

| cell | sources p50/p95 | surfaceGrid p50/p95 | pick p50/p95 | transportExcl p50/p95 | accumulation p50/p95 | muAabbGrid p50/p95 | sensors p50/p95 | sinks p50/p95 | removal p50/p95 | poolMatrices p50/p95 | adjacency p50/p95 | growth p50/p95 | sum p95 | total p95 | coverage p50 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---:|---:|---:|
| 2400 | 0.10/0.25 | 0.55/0.90 | 2.75/4.35 | 2.45/3.85 | 3.05/4.80 | 0.95/1.55 | 0.75/1.25 | 0.10/0.25 | 0.10/0.25 | 0.10/0.25 | 0.00/0.00 | 0.00/0.00 | 15.60 | 17.30 | 89.8 % |

### Share of the step (p95 exclusive / p95 total)

| cell | sources | surfaceGrid | pick | transportExcl | accumulation | muAabbGrid | sensors | sinks | removal | poolMatrices | adjacency | growth |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 2400 | 1.4 % | 5.2 % | 25.1 % | 22.3 % | 27.7 % | 9.0 % | 7.2 % | 1.4 % | 1.4 % | 1.4 % | 0.0 % | 0.0 % |

## plan-469 - simulation stages (exclusive ms per fixed step)

The four stages of `ContinuousRunner.tick()`. `transport` here and `total` in the
attribution table above are the SAME span measured by two instruments - they must
agree to within one clock tick, which is what makes the two tables comparable.

| cell | robots | drives p50/p95 | transport p50/p95 | behaviors p50/p95 | visuals p50/p95 | ticks |
|---|---:|---|---|---|---|---:|
| 2400 | 0 | 0.05/0.15 | 12.05/17.30 | 0.05/0.05 | 0.05/0.15 | 7141 |

## plan-469 - render passes (main vs shadow)

`total` is the whole render callback; `shadow` is measured across
`WebGLShadowMap.render` alone (a dev-only wrapper on the live renderer, not a
patch of three.js); `main` is the difference. Draws and triangles are split the
same way, via `renderer.info` deltas with `autoReset` off. Triangles are reported
in THOUSANDS. A `shadow pass seen` of `no` means the renderer never entered the
shadow pass, so the split is trivially all-main.

| cell | shadows | main ms p50/p95 | shadow ms p50/p95 | total ms p95 | main draws p50 | shadow draws p50 | main kTris p50 | shadow kTris p50 | shadow pass seen |
|---|---|---|---|---:|---:|---:|---:|---:|---|
| 2400 | on | 5.05/8.20 | 0.55/1.15 | 9.15 | 207 | 69 | 34386 | 17193 | yes |

## plan-469 - world-matrix work

Counted by dev-only wrappers on `Object3D.prototype.updateWorldMatrix` /
`updateMatrixWorld` (installed on the live prototype for the run, never a patch
in `node_modules`). `recomposed` is the subset that actually recomputed a world
matrix - the call count alone hides a fan-out that walks a thousand clean nodes.

| cell | robots | uWM/tick | uMW/tick | recomposed/tick | uMW/frame | recomposed/frame | ticks | frames |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 2400 | 0 | 5515 | 0 | 0 | 2337 | 2296 | 7141 | 2957 |

## plan-469 - realistic-scene composition

What the scene generator actually built. `MU instanced` is read BACK off
`RVSource.useInstancing` after `init()` - whether a library asset instances is a
property of the asset, never an assumption.

| cell | geometry | conveyor draws | conveyor tris | clones avoided | MU asset | MU meshes | MU tris | MU instanced | robots | robot drives | robot meshes | motion |
|---|---|---:|---:|---:|---|---:|---:|---|---:|---:|---:|---|
| 2400 | library | 45 | 16415136 | 9720 | cartonbox | 1 | 324 | **yes** | 0 | 0 | 0 | static |

## plan-469 - hit rates (F1b)

| cell | pick fast-path (i)-(vi) | accum span stable | clone share of MU-AABB | samples (pick / accum / aabb) |
|---|---:|---:|---:|---|
| 2400 | 99.7 % | 71.8 % | 0.0 % | 17066904 / 17066904 / 17066904 |

## plan-469 — long steps (> 100 ms)

_No transport step exceeded 100 ms in the median run of any cell._

## Last supported cell per load column

- `load=none`: none of the measured cells met §1.3

Criteria: frame p95 <= 33.3 ms, p99 <= 66 ms, lost sim time <= 0.1 %, stationarity reached (see `docs/perf/README.md`).
