# plan-754 G3 measurement — variant plan757-phase3

- **Host:** LAPTOP-6BCB6EOI (win32 10.0.26100)
- **CPU:** Intel(R) Core(TM) i9-14900HX (32 logical)
- **RAM:** 63.7 GiB
- **GPU:** Google Inc. (Intel) — ANGLE (Intel, Intel(R) UHD Graphics (0x0000A788) Direct3D11 vs_5_0 ps_5_0, D3D11)
- **Chromium:** 145.0.7632.6, Node v24.14.0
- **DPR/viewport:** 1 @ 1600x900
- **Commit:** 47e532fa2adea2dae64df99d05cd5f759b07bdee
- **Long-task observer:** yes; precise heap: yes
- **Timestamp:** 2026-09-22T19:46:45.406Z
- **Protocol:** fresh tab per run, headed, first run discarded, N=1 median, fps = mean of viewer.currentFps over 5 s at a fixed pose, scene bucket of rv-frame-stats, load = model-loaded → whenSceneReady, heap after gc()
- **localStorage:** (none)

| Model | runs | load ms | nav→ready ms | fps | frame ms | scene calls | scene tris | heap MiB | scene nodes | chunk meshes | matrixAutoUpdate nodes | frozen world nodes | bake assets | instances |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| demo | 1 | 4 | 7167 | 91.4 | 11.0 | 120 | 578376 | 243.2 | 389 | 92 | 83 | 183 | 0 | 0 |
| delta | 1 | 3 | 6130 | 148.3 | 6.7 | 17 | 252093 | 188.1 | 74 | 15 | 49 | 3 | 0 | 0 |
| the large CAD line | 1 | 27 | 22385 | 14.2 | 70.8 | 272 | 7473340 | 1247.2 | 19878 | 295 | 429 | 13350 | 0 | 0 |
| planner | 1 | 2395 | 8158 | 72.4 | 13.9 | 197 | 412948 | 182.5 | 2541 | 526 | 1214 | 0 | 4 | 128 |
| nested | 1 | 5129 | 10931 | 58.8 | 17.4 | 324 | 415996 | 188.5 | 4500 | 1052 | 1846 | 0 | 4 | 256 |

## G1 — Phase-0 removal report

| Model | nodes | survivors | removed | removed meshes | merged survivor meshes | releasable geometries | instanced tris | tag-only chunk boundaries | unresolved refs | unresolved claims | G1 violations | ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| demo | 487 | 237 | 250 | 181 | 8 | 124 | 0 | 0 | 0 | 0 | 0 | 11.0 |
| delta | 88 | 40 | 48 | 25 | 0 | 25 | 0 | 0 | 0 | 0 | 0 | 5.1 |
| the large CAD line | 70203 | 18050 | 52153 | 36693 | 2745 | 9603 | 0 | 29 | 46 | 1 | 0 | 773.0 |
| planner | 29 | 10 | 19 | 16 | 0 | 16 | 0 | 0 | 0 | 0 | 0 | 0.7 |
| nested | 29 | 10 | 19 | 16 | 0 | 16 | 0 | 0 | 0 | 0 | 0 | 0.4 |
