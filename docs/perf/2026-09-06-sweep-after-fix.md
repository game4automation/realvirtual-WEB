# realvirtual WEB — scaling matrix (plan-465)

## Machine fingerprint

- **Host:** desktopmsi (win32 10.0.26200)
- **CPU:** Intel(R) Core(TM) i5-9600K CPU @ 3.70GHz (6 logical)
- **RAM:** 31.9 GiB
- **GPU:** Google Inc. (NVIDIA) — ANGLE (NVIDIA, NVIDIA GeForce GTX 1060 6GB (0x00001C03) Direct3D11 vs_5_0 ps_5_0, D3D11)
- **Chromium:** 145.0.7632.6, Node v24.19.0
- **DPR/viewport:** 1 @ 1280x720
- **Commit:** 2abcc7483b0812676dcdb56b6b03de1021da5d65
- **Long-task observer:** yes; precise heap: yes
- **Timestamp:** 2026-09-06T19:53:30.738Z

## Parameters

- Mode: `supported`, 1 run(s) x 300 s observation
- Line geometry: {"lanes":24,"plcs":2,"segments":9,"seglen":5,"speed":1000,"templates":1,"seed":465}
- Debug plugins: **off** (`DebugEndpointPlugin` and the MCP bridge are not installed under `?perf`)
- Welcome modal: suppressed (`rv-welcome-dismissed`)
- `fill (s)` is the warmup the line needed to fill; the probe is reset AFTER it,
  so `window (s)` and every percentile cover the observation window only.

## Cells

| MUs | sensors/seg | load | renderer | shadows | effects | model | frame p50/p95/p99 (ms) | step p95 | transport p95 | draws | live MUs | pools (cap) | fill (s) | window (s) | lost sim (s) | supported |
|---:|---:|---|---|---|---|---|---|---:|---:|---:|---:|---|---:|---:|---:|---|
| 500 | 1 | none | webgl | on | on | off | 19.0 / 128.8 / 310.3 | 10.25 | 10.00 | 131 | 504 | 24 (3072) | 74 | 300 | 58.389 | **no** (frame p95 <= 33.3 ms; frame p99 <= 66 ms; lost sim time <= 0.1 %; stationarity reached) |
| 1000 | 1 | none | webgl | on | on | off | 21.0 / 158.0 / 353.5 | 16.75 | 16.25 | 139 | 1032 | 24 (3072) | 74 | 300 | 59.612 | **no** (frame p95 <= 33.3 ms; frame p99 <= 66 ms; lost sim time <= 0.1 %; stationarity reached) |
| 2400 | 1 | none | webgl | on | on | off | 54.3 / 218.0 / 466.3 | 26.25 | 26.25 | 139 | 2568 | 24 (3072) | 74 | 300 | 62.071 | **no** (frame p95 <= 33.3 ms; frame p99 <= 66 ms; lost sim time <= 0.1 %; stationarity reached) |
| 500 | 1 | none | webgl | off | on | off | 19.0 / 140.8 / 323.0 | 14.75 | 14.00 | 109 | 504 | 24 (3072) | 74 | 300 | 55.002 | **no** (frame p95 <= 33.3 ms; frame p99 <= 66 ms; lost sim time <= 0.1 %; stationarity reached) |
| 1000 | 1 | none | webgl | off | on | off | 19.0 / 116.3 / 292.5 | 13.75 | 13.50 | 115 | 1032 | 24 (3072) | 74 | 300 | 47.685 | **no** (frame p95 <= 33.3 ms; frame p99 <= 66 ms; lost sim time <= 0.1 %; stationarity reached) |
| 2400 | 1 | none | webgl | off | on | off | 37.3 / 167.0 / 408.8 | 24.50 | 24.25 | 117 | 2592 | 24 (3072) | 74 | 300 | 53.459 | **no** (frame p95 <= 33.3 ms; frame p99 <= 66 ms; lost sim time <= 0.1 %; stationarity reached) |

## Last supported cell per load column

- `load=none`: none of the measured cells met §1.3

Criteria: frame p95 <= 33.3 ms, p99 <= 66 ms, lost sim time <= 0.1 %, stationarity reached (see `docs/perf/README.md`).
