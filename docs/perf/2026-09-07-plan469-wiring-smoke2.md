# realvirtual WEB — scaling matrix (plan-465)

## Machine fingerprint

- **Host:** desktopmsi (win32 10.0.26200)
- **CPU:** Intel(R) Core(TM) i5-9600K CPU @ 3.70GHz (6 logical)
- **RAM:** 31.9 GiB
- **GPU:** Google Inc. (NVIDIA) — ANGLE (NVIDIA, NVIDIA GeForce GTX 1060 6GB (0x00001C03) Direct3D11 vs_5_0 ps_5_0, D3D11)
- **Chromium:** 145.0.7632.6, Node v24.19.0
- **DPR/viewport:** 1.0000000298023224 @ 1280x720
- **Commit:** e892cd2838cc325cd8e5c99611d7b75f08928d00
- **Long-task observer:** yes; precise heap: yes
- **Timestamp:** 2026-09-07T16:44:45.055Z

## Parameters

- Mode: `smoke`, 1 run(s) x 15 s observation
- Line geometry: {"lanes":24,"plcs":2,"segments":9,"seglen":5,"speed":1000,"templates":1,"seed":465}
- plan-469: `--proto (none — reference path)`, `--hooks on`
- Debug plugins: **off** (`DebugEndpointPlugin` and the MCP bridge are not installed under `?perf`)
- Welcome modal: suppressed (`rv-welcome-dismissed`)
- `fill (s)` is the warmup the line needed to fill; the probe is reset AFTER it,
  so `window (s)` and every percentile cover the observation window only.

## Cells

| MUs | sensors/seg | load | renderer | shadows | effects | model | frame p50/p95/p99 (ms) | step p95 | transport p95 | draws | live MUs | pools (cap) | fill (s) | window (s) | lost sim (s) | supported |
|---:|---:|---|---|---|---|---|---|---:|---:|---:|---:|---|---:|---:|---:|---|
| 100 | 1 | none | webgl | on | on | off | 31.5 / 36.3 / 39.5 | 5.00 | 4.50 | 75 | 24 | 24 (3072) | 2 | 15 | 0.057 | **failed to run** (smoke: spawnRate 1.58/s, sensorTriggered false) |

## plan-469 — per-run figures

Every run is listed and graded on its own (the median-by-frame-p95 run above is
not necessarily the median STEP run, SOL #8). `live MUs` is the actual belt
occupancy of that run — A/B comparisons are only valid within ±5 %.

| cell | proto | hooks | run | live MUs | step p50/p95/max (ms) | transport p95 | frame p95 | long steps | coverage | stationary |
|---|---|---|---:|---:|---|---:|---:|---:|---:|---|
| 100 | none | on | 1 | 24 | 1.75 / 5.00 / 9.8 | 4.50 | 36.3 | 0 | 100.0 % | no |
| 100 | | | **spread** | 0.0 % | comparable (≤ 5 %) | | | | | |

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
| 100 | 0.10/0.25 | 0.55/1.80 | 0.05/0.25 | 0.05/0.35 | 0.00/0.00 | 0.05/0.15 | 0.40/1.25 | 0.05/0.25 | 0.05/0.05 | 0.05/0.15 | 0.00/0.00 | 0.00/0.00 | 4.35 | 4.40 | 100.0 % |

### Share of the step (p95 exclusive / p95 total)

| cell | sources | surfaceGrid | pick | transportExcl | accumulation | muAabbGrid | sensors | sinks | removal | poolMatrices | adjacency | growth |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 100 | 5.7 % | 40.9 % | 5.7 % | 8.0 % | 0.0 % | 3.4 % | 28.4 % | 5.7 % | 1.1 % | 3.4 % | 0.0 % | 0.0 % |

## plan-469 — hit rates (F1b)

| cell | pick fast-path (i)-(vi) | accum span stable | clone share of MU-AABB | samples (pick / accum / aabb) |
|---|---:|---:|---:|---|
| 100 | 99.5 % | 0.0 % | 0.0 % | 9864 / 0 / 9864 |

## plan-469 — long steps (> 100 ms)

_No transport step exceeded 100 ms in the median run of any cell._

## Verdict

This was a **smoke** run: it proves the harness chain works end to end
(runner → Vite → `?perf&scenario=line` → `__PERF_RESULTS__` → this report).
It makes no scale statement — run `--mode supported` on a real GPU for that.
