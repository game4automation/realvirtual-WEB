# perf:first-frame — time to the first plant frame (plan-598)

Headless Chromium from this repo's `node_modules` with the real GPU (`--use-angle=d3d11`),
a fresh browser per cold run. Results land in `runs/` (git-ignored).

```bash
npm run perf:first-frame -- "<url>" [n=5] [--label p] [--repeat [k]] [--report-only]
# e.g. against a local production build:
npm run build && npx vite preview --port 5598 --strictPort
npm run perf:first-frame -- "http://localhost:5598/?consent=decline" 5
```

## Measurement definition (binding, plan-598 Phase 0)

Implemented once in `lib.cjs`; the cold run (`measure.cjs`) and the repeat visit (`repeat.cjs`) share it.

| Item | Rule |
|---|---|
| Endpoint "Bild sichtbar" | The loading overlay starts to go away: its class list gains `fade-out` **or** `hidden`, whichever comes first (MutationObserver, exact). |
| Content check | At the endpoint `viewer.renderer.info.render.calls > 0` (last frame) **and** `viewer.currentModel` set — otherwise the run is **invalid**. |
| Long-task window | Navigation start → endpoint. |
| Per-run acceptance | Every valid run has no long task > 500 ms in the window. |
| Time target | Median of the endpoint ≤ 3.0 s cold (`--target-ms`), ≤ 2.0 s repeat. |
| Invalid / aborted run | Fails the series — never filtered out. |
| Logged per run | GPU string (`WEBGL_debug_renderer_info`), build hash (entry chunk hash, `dev` on a dev server), GLB request start/end, manifest requests. |

Exit code of `series.cjs` / `repeat.cjs`: `0` pass, `1` acceptance violation, `2` invalid or aborted run.
`--report-only` always exits `0` (for baselines taken before the goal is reached).

Measure the live demo with `?consent=decline`. The perf phase tables are switched on via
`localStorage rv-debug=perf` — **never** `?debug=…`, which also loads eruda from a CDN.

## Scripts

| Script | Purpose |
|---|---|
| `series.cjs` | n cold runs, median table, verdict (the `npm run perf:first-frame` entry). |
| `measure.cjs <url> <label>` | One cold run: resource waterfall, long tasks, CPU profile (`.cpuprofile`), perf phase tables. |
| `repeat.cjs <url> [k]` | First visit + k repeat visits with one persistent profile. |
| `categorize.cjs <run.json>` | Main-thread time per window (boot / GLB→model-loaded / after) by cause. |
| `aftercallers.cjs <run.json>` | Callers of synchronous shader links after `model-loaded`. |
| `keydiff.cjs <url>` | Program keys at `model-loaded` vs. after the first frame — which parameter creates new variants. |
| `programs.cjs [url]` | Program/material count. |
| `composition.cjs <chunk.js>` | Bytes of a chunk per source (needs a build with `RV_SOURCEMAP=1`). |
