# plan-754 G3 measurement — variant A

- **Host:** LAPTOP-6BCB6EOI (win32 10.0.26100)
- **CPU:** Intel(R) Core(TM) i9-14900HX (32 logical)
- **RAM:** 63.7 GiB
- **GPU:** Google Inc. (Intel) — ANGLE (Intel, Intel(R) UHD Graphics (0x0000A788) Direct3D11 vs_5_0 ps_5_0, D3D11)
- **Chromium:** 145.0.7632.6, Node v24.14.0
- **DPR/viewport:** 1 @ 1600x900
- **Commit:** dca1d885f2d1b61a259ce762fa429869157ecca8
- **Long-task observer:** yes; precise heap: yes
- **Timestamp:** 2026-09-18T09:44:44.359Z
- **Protocol:** fresh tab per run, headed, first run discarded, N=5 median, fps = mean of viewer.currentFps over 5 s at a fixed pose, scene bucket of rv-frame-stats, load = model-loaded → whenSceneReady, heap after gc()
- **localStorage:** (none)

| Model | runs | load ms | nav→ready ms | fps | frame ms | scene calls | scene tris | heap MiB | scene nodes | chunk meshes |
|---|---|---|---|---|---|---|---|---|---|---|
| demo | 5 | 3 | 5573 | 120.5 | 8.3 | 150 | 578376 | 248.8 | 314 | 116 |
| delta | 5 | 2 | 4985 | 181.7 | 5.5 | 25 | 252093 | 192.3 | 94 | 23 |

## G1 — Phase-0 removal report

| Model | nodes | survivors | removed | removed meshes | merged survivor meshes | releasable geometries | instanced tris | unresolved refs | unresolved claims | G1 violations | ms |
|---|---|---|---|---|---|---|---|---|---|---|---|
| demo | 493 | 269 | 224 | 172 | 11 | 119 | 0 | 0 | 0 | 0 | 6.6 |
| delta | 88 | 52 | 36 | 25 | 0 | 25 | 0 | 0 | 0 | 0 | 2.8 |
