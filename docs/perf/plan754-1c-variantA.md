# plan-754 G3 measurement — variant A

- **Host:** LAPTOP-6BCB6EOI (win32 10.0.26100)
- **CPU:** Intel(R) Core(TM) i9-14900HX (32 logical)
- **RAM:** 63.7 GiB
- **GPU:** Google Inc. (Intel) — ANGLE (Intel, Intel(R) UHD Graphics (0x0000A788) Direct3D11 vs_5_0 ps_5_0, D3D11)
- **Chromium:** 145.0.7632.6, Node v24.14.0
- **DPR/viewport:** 1 @ 1600x900
- **Commit:** baf9c21b83103c9e8173aa114cb68c236f9108a5
- **Long-task observer:** yes; precise heap: yes
- **Timestamp:** 2026-09-18T16:24:50.619Z
- **Protocol:** fresh tab per run, headed, first run discarded, N=5 median, fps = mean of viewer.currentFps over 5 s at a fixed pose, scene bucket of rv-frame-stats, load = model-loaded → whenSceneReady, heap after gc()
- **localStorage:** rv.bake.destructive=0

| Model | runs | load ms | nav→ready ms | fps | frame ms | scene calls | scene tris | heap MiB | scene nodes | chunk meshes |
|---|---|---|---|---|---|---|---|---|---|---|
| demo | 5 | 4 | 6576 | 61.0 | 16.4 | 150 | 578376 | 248.9 | 314 | 116 |
| delta | 5 | 3 | 5812 | 94.4 | 10.6 | 25 | 252093 | 192.7 | 94 | 23 |
| the large CAD line | 5 | 81 | 37267 | 10.0 | 100.0 | 10715 | 7473352 | 1264.6 | 29565 | 10702 |

## G1 — Phase-0 removal report

| Model | nodes | survivors | removed | removed meshes | merged survivor meshes | releasable geometries | instanced tris | tag-only chunk boundaries | unresolved refs | unresolved claims | G1 violations | ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| demo | 493 | 269 | 224 | 172 | 11 | 119 | 0 | 0 | 0 | 0 | 0 | 9.2 |
| delta | 88 | 52 | 36 | 25 | 0 | 25 | 0 | 0 | 0 | 0 | 0 | 3.7 |
| the large CAD line | 70221 | 31012 | 39209 | 27592 | 11756 | 9654 | 0 | 1 | 46 | 1 | 0 | 461.9 |
