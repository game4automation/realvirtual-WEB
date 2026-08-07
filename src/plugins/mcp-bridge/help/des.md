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
