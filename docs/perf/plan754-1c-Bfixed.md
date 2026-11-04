# plan-754 G3 measurement — variant Bfixed

- **Host:** LAPTOP-6BCB6EOI (win32 10.0.26100)
- **CPU:** Intel(R) Core(TM) i9-14900HX (32 logical)
- **RAM:** 63.7 GiB
- **GPU:** Google Inc. (Intel) — ANGLE (Intel, Intel(R) UHD Graphics (0x0000A788) Direct3D11 vs_5_0 ps_5_0, D3D11)
- **Chromium:** 145.0.7632.6, Node v24.14.0
- **DPR/viewport:** 1 @ 1600x900
- **Commit:** 524770f62e189b06ebb32b295ffdde3a08bafb5c
- **Long-task observer:** yes; precise heap: yes
- **Timestamp:** 2026-09-18T18:11:32.514Z
- **Protocol:** fresh tab per run, headed, first run discarded, N=1 median, fps = mean of viewer.currentFps over 5 s at a fixed pose, scene bucket of rv-frame-stats, load = model-loaded → whenSceneReady, heap after gc()
- **localStorage:** rv.bake.destructive=1

| Model | runs | load ms | nav→ready ms | fps | frame ms | scene calls | scene tris | heap MiB | scene nodes | chunk meshes |
|---|---|---|---|---|---|---|---|---|---|---|
| the large CAD line | 1 | 115 | 46555 | 10.0 | 100.0 | 10714 | 7473340 | 1340.8 | 41870 | 10737 |

## G1 — Phase-0 removal report

| Model | nodes | survivors | removed | removed meshes | merged survivor meshes | releasable geometries | instanced tris | tag-only chunk boundaries | unresolved refs | unresolved claims | G1 violations | ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| the large CAD line | 70203 | 30898 | 39305 | 27649 | 11789 | 9603 | 0 | 1 | 46 | 1 | 0 | 846.9 |
