# plan-754 G3 measurement — variant B

- **Host:** LAPTOP-6BCB6EOI (win32 10.0.26100)
- **CPU:** Intel(R) Core(TM) i9-14900HX (32 logical)
- **RAM:** 63.7 GiB
- **GPU:** Google Inc. (Intel) — ANGLE (Intel, Intel(R) UHD Graphics (0x0000A788) Direct3D11 vs_5_0 ps_5_0, D3D11)
- **Chromium:** 145.0.7632.6, Node v24.14.0
- **DPR/viewport:** 1 @ 1600x900
- **Commit:** baf9c21b83103c9e8173aa114cb68c236f9108a5
- **Long-task observer:** yes; precise heap: yes
- **Timestamp:** 2026-09-18T16:34:07.449Z
- **Protocol:** fresh tab per run, headed, first run discarded, N=5 median, fps = mean of viewer.currentFps over 5 s at a fixed pose, scene bucket of rv-frame-stats, load = model-loaded → whenSceneReady, heap after gc()
- **localStorage:** rv.bake.destructive=1

| Model | runs | load ms | nav→ready ms | fps | frame ms | scene calls | scene tris | heap MiB | scene nodes | chunk meshes |
|---|---|---|---|---|---|---|---|---|---|---|
| demo | 5 | 4 | 6554 | 59.9 | 16.7 | 150 | 578376 | 249.5 | 421 | 122 |
| delta | 5 | 3 | 5403 | 95.3 | 10.5 | 25 | 252093 | 194.3 | 88 | 23 |
| mauser | 5 | 72 | 40310 | 10.0 | 100.0 | 10714 | 7473340 | 1319.5 | 41870 | 10737 |

## G1 — Phase-0 removal report

| Model | nodes | survivors | removed | removed meshes | merged survivor meshes | releasable geometries | instanced tris | tag-only chunk boundaries | unresolved refs | unresolved claims | G1 violations | ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| demo | 487 | 241 | 246 | 180 | 9 | 124 | 0 | 0 | 11 | 0 | 0 | 8.0 |
| delta | 88 | 52 | 36 | 25 | 0 | 25 | 0 | 0 | 0 | 0 | 0 | 3.7 |
| mauser | 70203 | 30898 | 39305 | 27649 | 11789 | 9603 | 0 | 1 | 2422 | 1 | 0 | 569.9 |
