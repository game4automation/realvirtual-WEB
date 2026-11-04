# plan-754 G3 measurement — variant plan757-phase0

- **Host:** LAPTOP-6BCB6EOI (win32 10.0.26100)
- **CPU:** Intel(R) Core(TM) i9-14900HX (32 logical)
- **RAM:** 63.7 GiB
- **GPU:** Google Inc. (Intel) — ANGLE (Intel, Intel(R) UHD Graphics (0x0000A788) Direct3D11 vs_5_0 ps_5_0, D3D11)
- **Chromium:** 145.0.7632.6, Node v24.14.0
- **DPR/viewport:** 1 @ 1600x900
- **Commit:** 86c05913b93bbcee6416a8a2a7c4be9220517862
- **Long-task observer:** yes; precise heap: yes
- **Timestamp:** 2026-09-22T09:44:15.576Z
- **Protocol:** fresh tab per run, headed, first run discarded, N=1 median, fps = mean of viewer.currentFps over 5 s at a fixed pose, scene bucket of rv-frame-stats, load = model-loaded → whenSceneReady, heap after gc()
- **localStorage:** (none)

| Model | runs | load ms | nav→ready ms | fps | frame ms | scene calls | scene tris | heap MiB | scene nodes | chunk meshes | matrixAutoUpdate nodes | frozen world nodes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| demo | 1 | 3 | 5850 | 114.6 | 8.7 | 120 | 578376 | 242.7 | 389 | 92 | 83 | 183 |
| delta | 1 | 3 | 5044 | 176.6 | 5.7 | 17 | 252093 | 187.6 | 74 | 15 | 49 | 3 |
| the large CAD line | 1 | 27 | 18466 | 18.6 | 53.9 | 272 | 7473340 | 1243.9 | 19876 | 295 | 429 | 13350 |
| planner | 1 | 1925 | 6844 | 77.8 | 12.8 | 197 | 412948 | 181.8 | 2541 | 526 | 2015 | 0 |

## G1 — Phase-0 removal report

| Model | nodes | survivors | removed | removed meshes | merged survivor meshes | releasable geometries | instanced tris | tag-only chunk boundaries | unresolved refs | unresolved claims | G1 violations | ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| demo | 487 | 237 | 250 | 181 | 8 | 124 | 0 | 0 | 0 | 0 | 0 | 7.6 |
| delta | 88 | 40 | 48 | 25 | 0 | 25 | 0 | 0 | 0 | 0 | 0 | 3.4 |
| the large CAD line | 70203 | 18050 | 52153 | 36693 | 2745 | 9603 | 0 | 29 | 46 | 1 | 0 | 777.7 |
| planner | no report | | | | | | | | | | | |
