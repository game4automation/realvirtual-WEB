# realvirtual WEB — scaling matrix (plan-465)

> **Headless run — not a scale statement.** Chromium falls back to SwiftShader,
> so the frame times below say only that the configuration RUNS (§5.2).

## Machine fingerprint

- **Host:** desktopmsi (win32 10.0.26200)
- **CPU:** Intel(R) Core(TM) i5-9600K CPU @ 3.70GHz (6 logical)
- **RAM:** 31.9 GiB
- **GPU:** Google Inc. (Google) — ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)
- **Chromium:** 145.0.7632.6, Node v24.19.0
- **DPR/viewport:** 1 @ 1280x720
- **Commit:** 408e7d22235b34dc9b09b1bbc04cf23a8f36baf5
- **Long-task observer:** yes; precise heap: yes
- **Timestamp:** 2026-09-06T03:18:33.704Z

## Parameters

- Mode: `smoke`, 1 run(s) x 30 s observation
- Line geometry: {"lanes":4,"plcs":2,"segments":4,"seglen":5,"speed":5000,"templates":1,"seed":465}

## Cells

| MUs | sensors/seg | load | renderer | frame p50/p95/p99 (ms) | step p95 | transport p95 | draws | live MUs | pools (cap) | lost sim (s) | supported |
|---:|---:|---|---|---|---:|---:|---:|---:|---|---:|---|
| 100 | 1 | none | webgl | 3498.8 / 3498.8 / 3498.8 | 4.25 | 4.00 | 404 | 33 | 4 (512) | 37.248 | ran (smoke — not graded) |

## Verdict

This was a **smoke** run: it proves the harness chain works end to end
(runner → Vite → `?perf&scenario=line` → `__PERF_RESULTS__` → this report).
It makes no scale statement — run `--mode supported` on a real GPU for that.
