# plan-754 G3 measurement — variant plan757-phase3

- **Host:** LAPTOP-6BCB6EOI (win32 10.0.26100)
- **CPU:** Intel(R) Core(TM) i9-14900HX (32 logical)
- **RAM:** 63.7 GiB
- **GPU:** Google Inc. (Intel) — ANGLE (Intel, Intel(R) UHD Graphics (0x0000A788) Direct3D11 vs_5_0 ps_5_0, D3D11)
- **Chromium:** 145.0.7632.6, Node v24.14.0
- **DPR/viewport:** 1 @ 1600x900
- **Commit:** 47e532fa2adea2dae64df99d05cd5f759b07bdee
- **Long-task observer:** yes; precise heap: yes
- **Timestamp:** 2026-09-22T19:50:41.081Z
- **Protocol:** fresh tab per run, headed, first run discarded, N=1 median, fps = mean of viewer.currentFps over 5 s at a fixed pose, scene bucket of rv-frame-stats, load = model-loaded → whenSceneReady, heap after gc()
- **localStorage:** (none)

| Model | runs | load ms | nav→ready ms | fps | frame ms | scene calls | scene tris | heap MiB | scene nodes | chunk meshes | matrixAutoUpdate nodes | frozen world nodes | bake assets | instances |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| custom | 1 | 30 | 20535 | 14.0 | 71.1 | 272 | 7473436 | 1242.7 | 18741 | 295 | 419 | 13350 | 0 | 0 |

## G1 — Phase-0 removal report

| Model | nodes | survivors | removed | removed meshes | merged survivor meshes | releasable geometries | instanced tris | tag-only chunk boundaries | unresolved refs | unresolved claims | G1 violations | ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| custom | 70203 | 18047 | 52156 | 36694 | 2745 | 9604 | 0 | 28 | 46 | 0 | 0 | 705.8 |
