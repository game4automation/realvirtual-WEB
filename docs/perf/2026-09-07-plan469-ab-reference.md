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
- **Timestamp:** 2026-09-07T18:02:42.515Z

## Parameters

- Mode: `supported`, 3 run(s) x 300 s observation
- Line geometry: {"lanes":24,"plcs":2,"segments":9,"seglen":5,"speed":1000,"templates":1,"seed":465}
- plan-469: `--proto (none — reference path)`, `--hooks off`
- Debug plugins: **off** (`DebugEndpointPlugin` and the MCP bridge are not installed under `?perf`)
- Welcome modal: suppressed (`rv-welcome-dismissed`)
- `fill (s)` is the warmup the line needed to fill; the probe is reset AFTER it,
  so `window (s)` and every percentile cover the observation window only.

## Cells

| MUs | sensors/seg | load | renderer | shadows | effects | model | frame p50/p95/p99 (ms) | step p95 | transport p95 | draws | live MUs | pools (cap) | fill (s) | window (s) | lost sim (s) | supported |
|---:|---:|---|---|---|---|---|---|---:|---:|---:|---:|---|---:|---:|---:|---|
| 2400 | 1 | none | webgl | on | on | off | 32.8 / 37.0 / 40.5 | 9.25 | 9.25 | 139 | 2568 | 24 (3072) | 74 | 300 | 0.000 | **no** (frame p95 <= 33.3 ms; stationarity reached) |

## plan-469 — per-run figures

Every run is listed and graded on its own (the median-by-frame-p95 run above is
not necessarily the median STEP run, SOL #8). `live MUs` is the actual belt
occupancy of that run — A/B comparisons are only valid within ±5 %.

| cell | proto | hooks | run | live MUs | step p50/p95/max (ms) | transport p95 | frame p95 | long steps | coverage | stationary |
|---|---|---|---:|---:|---|---:|---:|---:|---:|---|
| 2400 | none | off | 1 | 2568 | 7.00 / 9.25 / 21.6 | 9.25 | 37.0 | — | — | no |
| 2400 | none | off | 2 | 2568 | 8.75 / 13.75 / 252.1 | 13.75 | 39.8 | — | — | no |
| 2400 | none | off | 3 | 2592 | 7.25 / 9.50 / 21.7 | 9.25 | 24.8 | — | — | no |
| 2400 | | | **spread** | 0.9 % | comparable (≤ 5 %) | | | | | |

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

_No region data — the run was made with `--hooks off`._

## Last supported cell per load column

- `load=none`: none of the measured cells met §1.3

Criteria: frame p95 <= 33.3 ms, p99 <= 66 ms, lost sim time <= 0.1 %, stationarity reached (see `docs/perf/README.md`).
