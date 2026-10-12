# Cell-matrix performance benchmark (plan-492)

N customer-shaped cells — a lane of chain conveyors plus a six-axis robot —
built on the PRODUCTION placement path (`resolveBaked` + `materialize`), so every
number below includes the destructive bake, the chunk meshes, the BVH and the
shadow pass on real CAD.

- **Host:** desktopmsi (win32 10.0.26200)
- **CPU:** Intel(R) Core(TM) i5-9600K CPU @ 3.70GHz (6 logical)
- **RAM:** 31.9 GiB
- **GPU:** Google Inc. (NVIDIA) — ANGLE (NVIDIA, NVIDIA GeForce GTX 1060 6GB (0x00001C03) Direct3D11 vs_5_0 ps_5_0, D3D11)
- **Chromium:** 153.0.8010.12, Node v24.19.0
- **DPR/viewport:** 1 @ 1280x720
- **Commit:** e0dfec6553d1a2967cf764fb91b76f7dad088769
- **Long-task observer:** yes; precise heap: yes
- **Timestamp:** 2026-09-20T19:56:24.897Z

> **VSYNC-CAPPED.** Every cell reports p50 ≈ 16.7 ms, i.e. the renderer finished
> inside the frame budget everywhere in this sweep and waited for the display.
> Read the DRAW CALLS, triangles and chunk-mesh columns as the scaling evidence,
> not the frame times, and treat the knee row as "where jitter starts", not as a
> capacity limit. A capacity number needs a larger sweep or an uncapped run.

## Cell matrix (placements)

| cells | conv | motion | renderer | placements | bakes | mat ms | bake ms | bvh ms | chunks | chunk meshes | dyn/total | calls scene | calls shadow | tri | p50 | p95 | p99 | gpu | valid |
|---:|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|---:|---:|---|---|
| 1 | 3 | none | webgl | 4 | 2 | 353 | 1063 | 445 | 27 | 35 | 69/69 | 37 | 0 | 502870 | 16.75 | 18 | 19.25 | hardware | yes |
| 4 | 3 | none | webgl | 16 | 2 | 225 | 996 | 384 | 27 | 140 | 273/273 | 142 | 0 | 2011408 | 16.75 | 17.75 | 18.5 | hardware | yes |
| 16 | 3 | none | webgl | 64 | 2 | 261 | 1049 | 380 | 27 | 560 | 1089/1089 | 562 | 0 | 8045560 | 16.75 | 18 | 18.5 | hardware | yes |
| 1 | 3 | all | webgl | 4 | 2 | 173 | 937 | 419 | 27 | 35 | 69/69 | 37 | 35 | 754293 | 16.75 | 18 | 18.75 | hardware | yes |
| 4 | 3 | all | webgl | 16 | 2 | 232 | 1015 | 393 | 27 | 140 | 273/273 | 142 | 140 | 3017100 | 16.75 | 18 | 18.5 | hardware | yes |
| 16 | 3 | all | webgl | 64 | 2 | 277 | 1167 | 435 | 27 | 560 | 1089/1089 | 562 | 413 | 11040241 | 16.75 | 18 | 18.75 | hardware | yes |

## Cost per placement

| cells | motion | draw calls / placement | triangles / placement | chunk meshes / placement |
|---:|---|---:|---:|---:|
| 1 | none | 9.25 | 125717.5 | 8.75 |
| 4 | none | 8.88 | 125713 | 8.75 |
| 16 | none | 8.78 | 125711.88 | 8.75 |
| 1 | all | 9.25 | 188573.25 | 8.75 |
| 4 | all | 8.88 | 188568.75 | 8.75 |
| 16 | all | 8.78 | 172503.77 | 8.75 |

## Knee

First cell count whose p95 crosses the budget. `-` = not reached in this sweep.

| motion | > 16.7 ms (60 Hz) | > 33.3 ms (30 Hz) |
|---|---:|---:|
| none | 1 | - |
| all | 1 | - |

## Options

```
{
  "scenario": "cells",
  "mode": "smoke",
  "durationS": 20,
  "runs": 1,
  "headless": true,
  "gpuMode": "default",
  "proto": "",
  "axes": {
    "cellsAxis": [
      1,
      4,
      16
    ],
    "cellConvAxis": [
      3
    ],
    "cellMotionAxis": [
      "none",
      "all"
    ],
    "rendererAxis": [
      "webgl"
    ]
  }
}
```
