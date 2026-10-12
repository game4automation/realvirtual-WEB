# realvirtual WEB — scaling matrix (plan-465)

## Machine fingerprint

- **Host:** desktopmsi (win32 10.0.26200)
- **CPU:** Intel(R) Core(TM) i5-9600K CPU @ 3.70GHz (6 logical)
- **RAM:** 31.9 GiB
- **GPU:** Google Inc. (NVIDIA) — ANGLE (NVIDIA, NVIDIA GeForce GTX 1060 6GB (0x00001C03) Direct3D11 vs_5_0 ps_5_0, D3D11)
- **Chromium:** 153.0.8010.12, Node v24.19.0
- **DPR/viewport:** 1.0000000298023224 @ 1280x720
- **Commit:** 5e59ba2a1221a1f5233f142f463c11576c35a5e8
- **Long-task observer:** yes; precise heap: yes
- **Timestamp:** 2026-09-25T16:52:12.120Z

## Parameters

- Mode: `supported`, 1 run(s) x 60 s observation
- Line geometry: {"lanes":24,"plcs":2,"segments":16,"seglen":5,"speed":1000,"templates":1,"seed":465}
- plan-469: `--proto (none — reference path)`, `--hooks on`
- plan-473 F4: ambient occlusion `gtao`, shadows `on`, no reference source rate supplied
- Draw metric: **frame-all-passes** aggregated as **median-over-window** (hooks-independent; the `draws` column is `calls.p50` over the window)
- Debug plugins: **off** (`DebugEndpointPlugin` and the MCP bridge are not installed under `?perf`)
- Welcome modal: suppressed (`rv-welcome-dismissed`)
- `fill (s)` is the warmup the line needed to fill; the probe is reset AFTER it,
  so `window (s)` and every percentile cover the observation window only.

## Cells

| MUs | sensors/seg | load | renderer | shadows | effects | model | geometry | MU asset | robots | frame p50/p95/p99 (ms) | step p95 | transport p95 | draws | live MUs | pools (cap) | fill (s) | window (s) | lost sim (s) | supported |
|---:|---:|---|---|---|---|---|---|---|---|---|---:|---:|---:|---:|---|---:|---:|---:|---|
| 1000 | 1 | none | webgl | on | on | off | library | pallet | 0/static | 31.3 / 36.5 / 37.3 | 6.50 | 6.25 | 325 | 984 | 24 (3072) | 109 | 60 | 0.000 | **no** (frame p95 <= 33.3 ms) |

## Run validity (plan-473 §1.3)

| cell | run | occupancy | source | sink | sim-time loss | valid |
|---|---:|---|---|---|---|---|
| mu=1000 sensors=1 load=none renderer=webgl shadows=on effects=on keepmodel=off geometry=library muasset=pallet robots=0/static | 1 | ok — 984 live vs target 1000 (band 900..1100) | ok — 12.57/s, no reference rate supplied (graded > 0 only) | ok — 12.77/s vs source 12.57/s (±15 %) | ok — 0.00 s lost of 60.1 s window (limit 5 %) | **yes** |

> No reference source rate was supplied (`--refrate`), so the source condition
> could only be graded as `> 0`. Establish it from a reference run and pass it in.

## plan-469 — per-run figures

Every run is listed and graded on its own (the median-by-frame-p95 run above is
not necessarily the median STEP run, SOL #8). `live MUs` is the actual belt
occupancy of that run — A/B comparisons are only valid within ±5 %.

| cell | proto | hooks | run | live MUs | step p50/p95/max (ms) | transport p95 | frame p95 | long steps | coverage | stationary |
|---|---|---|---:|---:|---|---:|---:|---:|---:|---|
| 1000 | none | on | 1 | 984 | 5.75 / 6.50 / 23.2 | 6.25 | 36.5 | 0 | 91.1 % | yes |
| 1000 | | | **spread** | 0.0 % | comparable (≤ 5 %) | | | | | |

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
| 1000 | 0.15/0.25 | 0.65/0.85 | 0.45/0.85 | 1.30/1.80 | 1.15/1.65 | 0.30/0.40 | 0.90/1.15 | 0.05/0.15 | 0.05/0.15 | 0.05/0.15 | 0.00/0.00 | 0.00/0.00 | 5.75 | 6.25 | 91.1 % |

### Share of the step (p95 exclusive / p95 total)

| cell | sources | surfaceGrid | pick | transportExcl | accumulation | muAabbGrid | sensors | sinks | removal | poolMatrices | adjacency | growth |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1000 | 4.0 % | 13.6 % | 13.6 % | 28.8 % | 26.4 % | 6.4 % | 18.4 % | 2.4 % | 2.4 % | 2.4 % | 0.0 % | 0.0 % |

## plan-469 - simulation stages (exclusive ms per fixed step)

The four stages of `ContinuousRunner.tick()`. `transport` here and `total` in the
attribution table above are the SAME span measured by two instruments - they must
agree to within one clock tick, which is what makes the two tables comparable.

| cell | robots | drives p50/p95 | transport p50/p95 | behaviors p50/p95 | visuals p50/p95 | ticks |
|---|---:|---|---|---|---|---:|
| 1000 | 0 | 0.05/0.15 | 5.55/6.25 | 0.05/0.05 | 0.05/0.10 | 3607 |

## plan-469 - render passes (main vs shadow)

`total` is the whole render callback; `shadow` is measured across
`WebGLShadowMap.render` alone (a dev-only wrapper on the live renderer, not a
patch of three.js); `main` is the difference. Draws and triangles are split the
same way, via `renderer.info` deltas with `autoReset` off. Triangles are reported
in THOUSANDS. A `shadow pass seen` of `no` means the renderer never entered the
shadow pass, so the split is trivially all-main.

| cell | shadows | main ms p50/p95 | shadow ms p50/p95 | total ms p95 | main draws p50 | shadow draws p50 | main kTris p50 | shadow kTris p50 | shadow pass seen |
|---|---|---|---|---:|---:|---:|---:|---:|---|
| 1000 | on | 2.65/3.15 | 0.30/0.40 | 3.40 | 239 | 86 | 59533 | 29767 | yes |

## plan-469 - world-matrix work

Counted by dev-only wrappers on `Object3D.prototype.updateWorldMatrix` /
`updateMatrixWorld` (installed on the live prototype for the run, never a patch
in `node_modules`). `recomposed` is the subset that actually recomputed a world
matrix - the call count alone hides a fan-out that walks a thousand clean nodes.

| cell | robots | uWM/tick | uMW/tick | recomposed/tick | uMW/frame | recomposed/frame | ticks | frames |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1000 | 0 | 9522 | 0 | 0 | 2249 | 2209 | 3607 | 1922 |

## plan-469 - realistic-scene composition

What the scene generator actually built. `MU instanced` is read BACK off
`RVSource.useInstancing` after `init()` - whether a library asset instances is a
property of the asset, never an assumption.

| cell | geometry | conveyor draws | conveyor tris | clones avoided | MU asset | MU meshes | MU tris | MU instanced | robots | robot drives | robot meshes | motion |
|---|---|---:|---:|---:|---|---:|---:|---|---:|---:|---:|---|
| 1000 | library | 45 | 29182464 | 17280 | pallet | 1 | 1780 | **yes** | 0 | 0 | 0 | static |

## plan-469 - hit rates (F1b)

| cell | pick fast-path (i)-(vi) | accum span stable | clone share of MU-AABB | samples (pick / accum / aabb) |
|---|---:|---:|---:|---|
| 1000 | 99.7 % | 88.8 % | 0.0 % | 3567948 / 3567948 / 3567948 |

## plan-469 — long steps (> 100 ms)

_No transport step exceeded 100 ms in the median run of any cell._

## Last supported cell per load column

- `load=none`: none of the measured cells met §1.3

Criteria: frame p95 <= 33.3 ms, p99 <= 66 ms, lost sim time <= 0.1 %, stationarity reached (see `docs/perf/README.md`).
