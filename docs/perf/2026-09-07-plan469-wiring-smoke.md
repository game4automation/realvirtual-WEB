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
- **Timestamp:** 2026-09-07T15:47:41.502Z

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
| 100 | 1 | none | webgl | on | on | off | 18.5 / 67.3 / 180.3 | 3.75 | 3.25 | 76 | 24 | 24 (3072) | 2 | 15 | 1.203 | ran (smoke — not graded) |

## plan-469 sections could not be rendered

```
ReferenceError: Cannot access 'REGION_ORDER' before initialization
    at renderPlan469 (file:///E:/rv-worktrees/469-webviewer-transport-step-performance/realvirtual-WebViewer%7E/scripts/perf-scale-matrix.mjs:343:26)
    at renderMarkdown (file:///E:/rv-worktrees/469-webviewer-transport-step-performance/realvirtual-WebViewer%7E/scripts/perf-scale-matrix.mjs:452:16)
    at file:///E:/rv-worktrees/469-webviewer-transport-step-performance/realvirtual-WebViewer%7E/scripts/perf-scale-matrix.mjs:190:15
    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
```

The raw per-run data (regions, hit rates, long steps) is in the JSON next to this file.

## Verdict

This was a **smoke** run: it proves the harness chain works end to end
(runner → Vite → `?perf&scenario=line` → `__PERF_RESULTS__` → this report).
It makes no scale statement — run `--mode supported` on a real GPU for that.
