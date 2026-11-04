# plan-754 G3 measurement — variant A

- **Host:** surfacelaptop (win32 10.0.26200)
- **CPU:** Snapdragon(R) X 12-core X1E80100 @ 3.40 GHz (12 logical)
- **RAM:** 15.6 GiB
- **GPU:** Google Inc. (Qualcomm) — ANGLE (Qualcomm, Qualcomm(R) Adreno(TM) X1-85 GPU (0x36334330) Direct3D11 vs_5_0 ps_5_0, D3D11)
- **Chromium:** 145.0.7632.6, Node v24.19.0
- **DPR/viewport:** 1.0000000298023224 @ 1600x900
- **Commit:** 9f6de32217595ff42f53c7068cd88d3f27283077
- **Long-task observer:** yes; precise heap: yes
- **Timestamp:** 2026-10-19T11:29:55.713Z
- **Protocol:** fresh tab per run, headed, first run discarded, N=1 median, fps = mean of viewer.currentFps over 5 s at a fixed pose, scene bucket of rv-frame-stats, load = model-loaded → whenSceneReady, heap after gc()
- **localStorage:** (none)

| Model | runs | load ms | nav→ready ms | fps | frame ms | scene calls | scene tris | heap MiB | scene nodes | chunk meshes | matrixAutoUpdate nodes | frozen world nodes | bake assets | instances |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| the large CAD line | 1 | 1160 | 50827 | 21.3 | 46.9 | 272 | 7473340 | 1389.8 | 18719 | 295 | 376 | 13360 | 0 | 0 |

## G1 — Phase-0 removal report

| Model | nodes | survivors | removed | removed meshes | merged survivor meshes | releasable geometries | instanced tris | tag-only chunk boundaries | unresolved refs | unresolved claims | G1 violations | ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| the large CAD line | 70203 | 18060 | 52143 | 36693 | 2745 | 9603 | 0 | 29 | 46 | 1 | 0 | 874.2 |
