# plan-754 G3 measurement — variant plan757-phase1a

- **Host:** LAPTOP-6BCB6EOI (win32 10.0.26100)
- **CPU:** Intel(R) Core(TM) i9-14900HX (32 logical)
- **RAM:** 63.7 GiB
- **GPU:** Google Inc. (Intel) — ANGLE (Intel, Intel(R) UHD Graphics (0x0000A788) Direct3D11 vs_5_0 ps_5_0, D3D11)
- **Chromium:** 145.0.7632.6, Node v24.14.0
- **DPR/viewport:** 1 @ 1600x900
- **Commit:** bfb47ea7937198c6bf96691241b63dd2dd770111
- **Long-task observer:** yes; precise heap: yes
- **Timestamp:** 2026-09-22T10:57:21.535Z
- **Protocol:** fresh tab per run, headed, first run discarded, N=1 median, fps = mean of viewer.currentFps over 5 s at a fixed pose, scene bucket of rv-frame-stats, load = model-loaded → whenSceneReady, heap after gc()
- **localStorage:** (none)

| Model | runs | load ms | nav→ready ms | fps | frame ms | scene calls | scene tris | heap MiB | scene nodes | chunk meshes | matrixAutoUpdate nodes | frozen world nodes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| demo | 1 | 3 | 5469 | 110.3 | 9.1 | 120 | 578376 | 242.9 | 389 | 92 | 83 | 183 |
| delta | 1 | 3 | 4859 | 176.2 | 5.7 | 17 | 252093 | 187.8 | 74 | 15 | 49 | 3 |
| mauser | 1 | 24 | 17093 | 18.6 | 53.9 | 272 | 7473340 | 1245.5 | 19846 | 295 | 429 | 13350 |
| planner | 1 | 1781 | 6367 | 80.9 | 12.4 | 197 | 412948 | 182.0 | 2541 | 526 | 1214 | 0 |

## G1 — Phase-0 removal report

| Model | nodes | survivors | removed | removed meshes | merged survivor meshes | releasable geometries | instanced tris | tag-only chunk boundaries | unresolved refs | unresolved claims | G1 violations | ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| demo | 487 | 237 | 250 | 181 | 8 | 124 | 0 | 0 | 0 | 0 | 0 | 7.1 |
| delta | 88 | 40 | 48 | 25 | 0 | 25 | 0 | 0 | 0 | 0 | 0 | 3.6 |
| mauser | 70203 | 18050 | 52153 | 36693 | 2745 | 9603 | 0 | 29 | 46 | 1 | 0 | 670.7 |
| planner | 29 | 10 | 19 | 16 | 0 | 16 | 0 | 0 | 0 | 0 | 0 | 0.3 |
