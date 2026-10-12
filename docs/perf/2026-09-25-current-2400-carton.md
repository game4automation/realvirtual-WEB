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
- **Timestamp:** 2026-09-25T16:48:58.391Z

## Parameters

- Mode: `supported`, 1 run(s) x 60 s observation
- Line geometry: {"lanes":24,"plcs":2,"segments":9,"seglen":5,"speed":1000,"templates":1,"seed":465}
- plan-469: `--proto (none — reference path)`, `--hooks on`
- plan-473 F4: ambient occlusion `gtao`, shadows `on,off`, no reference source rate supplied
- Draw metric: **frame-all-passes** aggregated as **median-over-window** (hooks-independent; the `draws` column is `calls.p50` over the window)
- Debug plugins: **off** (`DebugEndpointPlugin` and the MCP bridge are not installed under `?perf`)
- Welcome modal: suppressed (`rv-welcome-dismissed`)
- `fill (s)` is the warmup the line needed to fill; the probe is reset AFTER it,
  so `window (s)` and every percentile cover the observation window only.

## Cells

| MUs | sensors/seg | load | renderer | shadows | effects | model | geometry | MU asset | robots | frame p50/p95/p99 (ms) | step p95 | transport p95 | draws | live MUs | pools (cap) | fill (s) | window (s) | lost sim (s) | supported |
|---:|---:|---|---|---|---|---|---|---|---|---|---:|---:|---:|---:|---|---:|---:|---:|---|
| 2400 | 1 | none | webgl | on | on | off | library | cartonbox | 0/static | 18.3 / 25.3 / 26.8 | 8.50 | 8.50 | 244 | 2400 | 24 (3072) | 74 | 60 | 0.000 | **yes** |
| 2400 | 1 | none | webgl | off | on | off | library | cartonbox | 0/static | 31.5 / 40.3 / 2186.9 | 9.50 | 9.25 | 208 | 2376 | 24 (3072) | 74 | 60 | 27.843 | **no** (frame p95 <= 33.3 ms; frame p99 <= 66 ms; lost sim time <= 0.1 %; stationarity reached) |

## Run validity (plan-473 §1.3)

| cell | run | occupancy | source | sink | sim-time loss | valid |
|---|---:|---|---|---|---|---|
| mu=2400 sensors=1 load=none renderer=webgl shadows=on effects=on keepmodel=off geometry=library muasset=cartonbox robots=0/static | 1 | ok — 2400 live vs target 2400 (band 2160..2640) | ok — 54.59/s, no reference rate supplied (graded > 0 only) | ok — 54.59/s vs source 54.59/s (±15 %) | ok — 0.00 s lost of 60.2 s window (limit 5 %) | **yes** |
| mu=2400 sensors=1 load=none renderer=webgl shadows=off effects=on keepmodel=off geometry=library muasset=cartonbox robots=0/static | 1 | ok — 2400 live vs target 2400 (band 2160..2640) | ok — 30.37/s, no reference rate supplied (graded > 0 only) | **FAIL** — 19.98/s vs source 30.37/s (±15 %) | **FAIL** — 27.84 s lost of 60.1 s window (limit 5 %) | no |

> No reference source rate was supplied (`--refrate`), so the source condition
> could only be graded as `> 0`. Establish it from a reference run and pass it in.

## plan-469 — per-run figures

Every run is listed and graded on its own (the median-by-frame-p95 run above is
not necessarily the median STEP run, SOL #8). `live MUs` is the actual belt
occupancy of that run — A/B comparisons are only valid within ±5 %.

| cell | proto | hooks | run | live MUs | step p50/p95/max (ms) | transport p95 | frame p95 | long steps | coverage | stationary |
|---|---|---|---:|---:|---|---:|---:|---:|---:|---|
| 2400 | none | on | 1 | 2400 | 7.75 / 8.50 / 21.3 | 8.50 | 25.3 | 0 | 84.2 % | yes |
| 2400 | | | **spread** | 0.0 % | comparable (≤ 5 %) | | | | | |
| 2400 | none | on | 1 | 2376 | 8.25 / 9.50 / 196.5 | 9.25 | 40.3 | 1 | 84.8 % | no |
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
| 2400 | 0.15/0.25 | 0.40/0.55 | 0.90/1.40 | 1.85/2.55 | 2.05/2.75 | 0.45/0.65 | 0.55/0.65 | 0.05/0.15 | 0.05/0.15 | 0.15/0.25 | 0.00/0.00 | 0.00/0.00 | 7.15 | 8.30 | 84.2 % |
| 2400 | 0.10/0.25 | 0.40/0.65 | 0.90/1.45 | 1.90/2.70 | 2.10/2.85 | 0.65/0.90 | 0.55/0.75 | 0.10/0.15 | 0.05/0.15 | 0.15/0.25 | 0.00/0.00 | 0.00/0.00 | 7.95 | 9.15 | 84.8 % |

### Share of the step (p95 exclusive / p95 total)

| cell | sources | surfaceGrid | pick | transportExcl | accumulation | muAabbGrid | sensors | sinks | removal | poolMatrices | adjacency | growth |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 2400 | 3.0 % | 6.6 % | 16.9 % | 30.7 % | 33.1 % | 7.8 % | 7.8 % | 1.8 % | 1.8 % | 3.0 % | 0.0 % | 0.0 % |
| 2400 | 2.7 % | 7.1 % | 15.8 % | 29.5 % | 31.1 % | 9.8 % | 8.2 % | 1.6 % | 1.6 % | 2.7 % | 0.0 % | 0.0 % |

## plan-469 - simulation stages (exclusive ms per fixed step)

The four stages of `ContinuousRunner.tick()`. `transport` here and `total` in the
attribution table above are the SAME span measured by two instruments - they must
agree to within one clock tick, which is what makes the two tables comparable.

| cell | robots | drives p50/p95 | transport p50/p95 | behaviors p50/p95 | visuals p50/p95 | ticks |
|---|---:|---|---|---|---|---:|
| 2400 | 0 | 0.05/0.15 | 7.40/8.30 | 0.05/0.05 | 0.05/0.10 | 3613 |
| 2400 | 0 | 0.05/0.15 | 8.05/9.15 | 0.05/0.05 | 0.05/0.15 | 1985 |

## plan-469 - render passes (main vs shadow)

`total` is the whole render callback; `shadow` is measured across
`WebGLShadowMap.render` alone (a dev-only wrapper on the live renderer, not a
patch of three.js); `main` is the difference. Draws and triangles are split the
same way, via `renderer.info` deltas with `autoReset` off. Triangles are reported
in THOUSANDS. A `shadow pass seen` of `no` means the renderer never entered the
shadow pass, so the split is trivially all-main.

| cell | shadows | main ms p50/p95 | shadow ms p50/p95 | total ms p95 | main draws p50 | shadow draws p50 | main kTris p50 | shadow kTris p50 | shadow pass seen |
|---|---|---|---|---:|---:|---:|---:|---:|---|
| 2400 | on | 2.10/2.75 | 0.30/0.40 | 3.10 | 183 | 61 | 33608 | 16934 | yes |
| 2400 | off | 2.60/3.60 | 0.05/0.15 | 3.65 | 208 | 0 | 34371 | 0 | yes |

## plan-469 - world-matrix work

Counted by dev-only wrappers on `Object3D.prototype.updateWorldMatrix` /
`updateMatrixWorld` (installed on the live prototype for the run, never a patch
in `node_modules`). `recomposed` is the subset that actually recomputed a world
matrix - the call count alone hides a fan-out that walks a thousand clean nodes.

| cell | robots | uWM/tick | uMW/tick | recomposed/tick | uMW/frame | recomposed/frame | ticks | frames |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 2400 | 0 | 5515 | 0 | 0 | 1577 | 1537 | 3613 | 3290 |
| 2400 | 0 | 5461 | 0 | 0 | 1576 | 1537 | 1985 | 992 |

## plan-469 - realistic-scene composition

What the scene generator actually built. `MU instanced` is read BACK off
`RVSource.useInstancing` after `init()` - whether a library asset instances is a
property of the asset, never an assumption.

| cell | geometry | conveyor draws | conveyor tris | clones avoided | MU asset | MU meshes | MU tris | MU instanced | robots | robot drives | robot meshes | motion |
|---|---|---:|---:|---:|---|---:|---:|---|---:|---:|---:|---|
| 2400 | library | 45 | 16415136 | 9720 | cartonbox | 1 | 324 | **yes** | 0 | 0 | 0 | static |
| 2400 | library | 45 | 16415136 | 9720 | cartonbox | 1 | 324 | **yes** | 0 | 0 | 0 | static |

## plan-469 - hit rates (F1b)

| cell | pick fast-path (i)-(vi) | accum span stable | clone share of MU-AABB | samples (pick / accum / aabb) |
|---|---:|---:|---:|---|
| 2400 | 99.7 % | 83.0 % | 0.0 % | 8635032 / 8635032 / 8635032 |
| 2400 | 99.7 % | 83.0 % | 0.0 % | 4542624 / 4542624 / 4542624 |

## plan-469 — long steps (> 100 ms)

### cell 2400 MUs — 1 long step(s)

| tick | total (ms) | sum excl. | top regions (excl. ms) | grew | adjacency | grid rebuild |
|---:|---:|---:|---|---|---|---|
| 55 | 196.1 | 11.3 | accumulation 6.5, transportExcl 1.9, muAabbGrid 0.9, pick 0.7 | no | no | no |


## Last supported cell per load column

- `load=none`: 2400 MUs (1 sensors/segment, webgl)

Criteria: frame p95 <= 33.3 ms, p99 <= 66 ms, lost sim time <= 0.1 %, stationarity reached (see `docs/perf/README.md`).
