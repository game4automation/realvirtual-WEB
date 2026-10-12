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
- **Timestamp:** 2026-09-07T17:43:03.431Z

## Parameters

- Mode: `supported`, 3 run(s) x 300 s observation
- Line geometry: {"lanes":24,"plcs":2,"segments":9,"seglen":5,"speed":1000,"templates":1,"seed":465}
- plan-469: `--proto (none — reference path)`, `--hooks on`
- Debug plugins: **off** (`DebugEndpointPlugin` and the MCP bridge are not installed under `?perf`)
- Welcome modal: suppressed (`rv-welcome-dismissed`)
- `fill (s)` is the warmup the line needed to fill; the probe is reset AFTER it,
  so `window (s)` and every percentile cover the observation window only.

## Cells

| MUs | sensors/seg | load | renderer | shadows | effects | model | frame p50/p95/p99 (ms) | step p95 | transport p95 | draws | live MUs | pools (cap) | fill (s) | window (s) | lost sim (s) | supported |
|---:|---:|---|---|---|---|---|---|---:|---:|---:|---:|---|---:|---:|---:|---|
| 100 | 1 | none | webgl | on | on | off | 32.8 / 35.5 / 39.3 | 3.75 | 3.50 | 194 | 120 | 24 (3072) | 74 | 300 | 0.000 | **no** (frame p95 <= 33.3 ms; stationarity reached) |
| 500 | 1 | none | webgl | on | on | off | 32.8 / 35.0 / 37.0 | 4.50 | 4.25 | 131 | 504 | 24 (3072) | 74 | 300 | 0.000 | **no** (frame p95 <= 33.3 ms) |
| 2400 | 1 | none | webgl | on | on | off | 33.5 / 64.8 / 72.0 | 17.75 | 17.50 | 141 | 2592 | 24 (3072) | 74 | 300 | 0.000 | **no** (frame p95 <= 33.3 ms; frame p99 <= 66 ms; stationarity reached) |

## plan-469 — per-run figures

Every run is listed and graded on its own (the median-by-frame-p95 run above is
not necessarily the median STEP run, SOL #8). `live MUs` is the actual belt
occupancy of that run — A/B comparisons are only valid within ±5 %.

| cell | proto | hooks | run | live MUs | step p50/p95/max (ms) | transport p95 | frame p95 | long steps | coverage | stationary |
|---|---|---|---:|---:|---|---:|---:|---:|---:|---|
| 100 | none | on | 1 | 120 | 2.50 / 6.25 / 30.6 | 6.00 | 35.8 | 0 | 96.7 % | no |
| 100 | none | on | 2 | 120 | 1.75 / 4.75 / 115.7 | 4.25 | 35.0 | 1 | 97.1 % | no |
| 100 | none | on | 3 | 120 | 2.00 / 3.75 / 25.4 | 3.50 | 35.5 | 0 | 96.2 % | no |
| 100 | | | **spread** | 0.0 % | comparable (≤ 5 %) | | | | | |
| 500 | none | on | 1 | 504 | 3.25 / 4.50 / 21.3 | 4.25 | 35.0 | 0 | 92.5 % | yes |
| 500 | none | on | 2 | 528 | 3.25 / 4.00 / 19.3 | 4.00 | 34.8 | 0 | 92.6 % | yes |
| 500 | none | on | 3 | 504 | 4.00 / 14.50 / 536.5 | 14.25 | 72.0 | 6 | 93.3 % | no |
| 500 | | | **spread** | 4.5 % | comparable (≤ 5 %) | | | | | |
| 2400 | none | on | 1 | 2592 | 14.25 / 18.75 / 44.9 | 18.50 | 69.3 | 0 | 89.4 % | no |
| 2400 | none | on | 2 | 2592 | 13.25 / 17.75 / 55.6 | 17.50 | 64.8 | 0 | 89.0 % | no |
| 2400 | none | on | 3 | 2592 | 11.75 / 14.75 / 54.1 | 14.50 | 38.8 | 0 | 88.5 % | no |
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
| 100 | 0.05/0.05 | 0.40/0.90 | 0.20/0.45 | 0.35/0.65 | 0.15/0.40 | 0.05/0.15 | 0.40/0.75 | 0.10/0.15 | 0.05/0.05 | 0.05/0.15 | 0.00/0.00 | 0.00/0.00 | 3.15 | 3.30 | 96.2 % |
| 500 | 0.05/0.15 | 0.35/0.55 | 0.65/1.05 | 0.80/1.30 | 0.55/0.95 | 0.20/0.35 | 0.40/0.55 | 0.05/0.15 | 0.05/0.15 | 0.05/0.15 | 0.00/0.00 | 0.00/0.00 | 3.95 | 4.25 | 92.5 % |
| 2400 | 0.10/0.25 | 0.35/0.75 | 3.05/4.55 | 2.65/3.85 | 3.45/5.15 | 1.05/1.60 | 0.65/1.10 | 0.10/0.25 | 0.10/0.25 | 0.15/0.25 | 0.00/0.00 | 0.00/0.00 | 15.70 | 17.45 | 89.0 % |

### Share of the step (p95 exclusive / p95 total)

| cell | sources | surfaceGrid | pick | transportExcl | accumulation | muAabbGrid | sensors | sinks | removal | poolMatrices | adjacency | growth |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 100 | 1.5 % | 27.3 % | 13.6 % | 19.7 % | 12.1 % | 4.5 % | 22.7 % | 4.5 % | 1.5 % | 4.5 % | 0.0 % | 0.0 % |
| 500 | 3.5 % | 12.9 % | 24.7 % | 30.6 % | 22.4 % | 8.2 % | 12.9 % | 3.5 % | 3.5 % | 3.5 % | 0.0 % | 0.0 % |
| 2400 | 1.4 % | 4.3 % | 26.1 % | 22.1 % | 29.5 % | 9.2 % | 6.3 % | 1.4 % | 1.4 % | 1.4 % | 0.0 % | 0.0 % |

## plan-469 — hit rates (F1b)

| cell | pick fast-path (i)-(vi) | accum span stable | clone share of MU-AABB | samples (pick / accum / aabb) |
|---|---:|---:|---:|---|
| 100 | 99.7 % | 94.3 % | 0.0 % | 2161560 / 2161560 / 2161560 |
| 500 | 99.7 % | 91.7 % | 0.0 % | 9116472 / 9116472 / 9116472 |
| 2400 | 99.7 % | 72.1 % | 0.0 % | 46561728 / 46561728 / 46561728 |

## plan-469 — long steps (> 100 ms)

_No transport step exceeded 100 ms in the median run of any cell._

## Last supported cell per load column

- `load=none`: none of the measured cells met §1.3

Criteria: frame p95 <= 33.3 ms, p99 <= 66 ms, lost sim time <= 0.1 %, stationarity reached (see `docs/perf/README.md`).
