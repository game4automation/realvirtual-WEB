# DES (discrete-event simulation)

Event-driven material-flow simulation — time jumps between events instead of frame stepping.
Enter with `web_mode_set("des")` (or `?mode=des`); DES tools hint when not active.

## Workflow

1. `web_des_status` — kernel mode, sub-mode, sim time, processed/pending events.
   `pending=0` + `nextEventTime=null/Infinity` = the run stalled or finished.
2. `web_des_components busyOnly=true` — per-component load / in-transit / blocked and the
   next/prev wiring. The go-to tool for deadlocks, full zones, wrong connections.
3. `web_des_stats` — utilization (Working/Setup/Blocked/Empty/Failure %), output/h, in
   material-flow order — line balance at a glance.
4. `web_des_bottleneck` — the constraining component + how many upstream are blocked vs
   downstream starved.
5. `web_des_step count=N` — advance exactly N events when diagnosing.
6. `web_des_set_mode` — animated (1x) | hybrid (Nx) | fastforward (max) | step (manual).

## Tool reference

<!-- BEGIN GENERATED: tool-reference des — do not edit; run `npm run gen:mcp-docs` -->
_6 tools in this family, generated from the @McpTool decorators — do not edit by hand._

| Tool | Access | Parameters | Summary |
|------|--------|------------|---------|
| `web_des_bottleneck` | read | — | Identify the DES bottleneck — the constraining component (highest Working%). |
| `web_des_components` | read | `busyOnly` boolean | DES component states: per material-flow component the load / in-transit / blocked counts and the next/prev wiring. |
| `web_des_set_mode` | write | `subMode` string **req**, `multiplier` number | Set the DES sub-mode: animated (1x real-time), hybrid (Nx), fastforward (max speed), step (manual). |
| `web_des_stats` | read | — | DES per-component statistics: utilization (Working/Setup/Blocked/Empty/Failure %), output/h, current state and totalProcessed — in MATERIAL-FLOW order (sources first, si… |
| `web_des_status` | read | — | DES status: kernel mode, sub-mode, sim time and processed/pending event counts. |
| `web_des_step` | write | `count` integer | Advance the DES simulation by exactly N events (default 1) and return the new status. |
<!-- END GENERATED: tool-reference des -->
