# plan-754 G3 measurement — variant plan757-phase2b

- **Host:** LAPTOP-6BCB6EOI (win32 10.0.26100)
- **CPU:** Intel(R) Core(TM) i9-14900HX (32 logical)
- **RAM:** 63.7 GiB
- **GPU:** Google Inc. (Intel) — ANGLE (Intel, Intel(R) UHD Graphics (0x0000A788) Direct3D11 vs_5_0 ps_5_0, D3D11)
- **Chromium:** 145.0.7632.6, Node v24.14.0
- **DPR/viewport:** 1 @ 1600x900
- **Commit:** bb67d6a5b57882ccbdc6d6e97cfda1d2a5cc793b
- **Long-task observer:** yes; precise heap: yes
- **Timestamp:** 2026-09-22T15:42:07.383Z
- **Protocol:** fresh tab per run, headed, first run discarded, N=1 median, fps = mean of viewer.currentFps over 5 s at a fixed pose, scene bucket of rv-frame-stats, load = model-loaded → whenSceneReady, heap after gc()
- **localStorage:** (none)

| Model | runs | load ms | nav→ready ms | fps | frame ms | scene calls | scene tris | heap MiB | scene nodes | chunk meshes | matrixAutoUpdate nodes | frozen world nodes | bake assets | instances |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| demo | 1 | 3 | 5667 | 100.9 | 9.9 | 120 | 578376 | 243.3 | 389 | 92 | 83 | 183 | 0 | 0 |
| delta | 1 | 2 | 5001 | 168.6 | 5.9 | 17 | 252093 | 188.1 | 74 | 15 | 49 | 3 | 0 | 0 |
| mauser | 1 | 23 | 17852 | 17.6 | 57.0 | 272 | 7473340 | 1247.7 | 19848 | 295 | 429 | 13350 | 0 | 0 |
| planner | 1 | 1953 | 6904 | 75.7 | 13.2 | 197 | 412948 | 182.7 | 2541 | 526 | 1214 | 0 | 0 | 0 |
| nested | 1 | 4286 | 9235 | 69.8 | 14.4 | 324 | 415996 | 188.5 | 4500 | 1052 | 1846 | 0 | 0 | 0 |

## G1 — Phase-0 removal report

| Model | nodes | survivors | removed | removed meshes | merged survivor meshes | releasable geometries | instanced tris | tag-only chunk boundaries | unresolved refs | unresolved claims | G1 violations | ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| demo | 487 | 237 | 250 | 181 | 8 | 124 | 0 | 0 | 0 | 0 | 0 | 7.3 |
| delta | 88 | 40 | 48 | 25 | 0 | 25 | 0 | 0 | 0 | 0 | 0 | 4.3 |
| mauser | 70203 | 18050 | 52153 | 36693 | 2745 | 9603 | 0 | 29 | 46 | 1 | 0 | 618.4 |
| planner | 29 | 10 | 19 | 16 | 0 | 16 | 0 | 0 | 0 | 0 | 0 | 0.5 |
| nested | 29 | 10 | 19 | 16 | 0 | 16 | 0 | 0 | 0 | 0 | 0 | 0.3 |
