# Simulation & debugging (HMI runtime)

## Drive not moving

1. `web_drive_list` — position, targetSpeed, isRunning, jog flags, limits (at a limit?)
2. `web_signal_status filter=<drive name>` — are its control signals live or stale?
3. `web_signal_set_bool` / `web_drive_jog` — actuate manually to separate signal vs mechanics
4. `web_screenshot_burst` — visual proof of motion (or none)
5. `web_logs level=error` — runtime errors

## Parts missing / jammed / not spawning

1. `web_transport_status` — spawned/consumed/active/blocked MU counts, per-source stats
2. `web_view_source_markers visible=true` + `web_screenshot` — locate spawn points
3. `web_sensor_list` — which sensors block the flow
4. `web_sim_reset` — clear MUs and logic states; `web_drive_speed_override` — slow everything down to watch

## Take a carrier off the line / put it elsewhere (Commissioning, plan-567)

`web_mu_delete id=<mus[].id>` removes a carrier with everything riding on it; `web_mu_move id x y z
[surface]` sets it onto a transport surface (collider bottom on the surface top, rotation kept,
refused when occupied). Both work while paused (sensors and signals update at once), only in the
Commissioning workspace, never on pooled (instanced), physics-owned or held carriers. An authored
carrier comes back on `web_sim_reset`. The ids come from `web_transport_status` (`mus[].id`).

## Compare Unity vs browser

Run the Unity tool and its `web_*` sibling side by side (e.g. `drive_list` vs `web_drive_list`);
positions should match when playback is synced.

## Placed assets and nested placements (plan-757)

A reference node (`AssetReference`) is a placement — a planner placement, a hand-authored
reference and a reference INSIDE a placed asset alike; `web_status.placements.total` counts
all of them (a layout that places a layout twice reports the inner placements too).
`web_signal_set_bool` / `web_signal_set_float` with `asset` fan out to EVERY instance of that
asset, nested ones included: address a signal of the inner asset by the inner asset; addressed
by the outer asset the fan-out does not reach into its nested placements (they are instances of
their own asset) and reports them as `missing`.

## Logic sequences

`web_logic_flow` — the LogicStep hierarchy with per-step state/progress; find the stuck step,
then check the signal or sensor it waits on.

## Tool reference

<!-- BEGIN GENERATED: tool-reference simulation — do not edit; run `npm run gen:mcp-docs` -->
_23 tools in this family, generated from the @McpTool decorators — do not edit by hand._

| Tool | Access | Parameters | Summary |
|------|--------|------------|---------|
| `web_drive_jog` | write | `name` string **req**, `forward` boolean | Jog a runtime drive forward or backward (sets jog flags; drive names from web_drive_list). |
| `web_drive_list` | read | — | List all drives: current/target position, speed, running/jog flags, direction, limits. |
| `web_drive_speed_override` | write | `factor` number | Master speed factor scaling ALL drives (1 = normal, 0.5 = half, 2 = double, 0 = stopped; relative speeds preserved). |
| `web_drive_stop` | write | `name` string **req** | Stop a drive: clears jog flags and halts motion. |
| `web_logic_flow` | read | — | Get the LogicStep sequence hierarchy with per-step state and progress. |
| `web_mu_delete` | write | `id` number **req** | Remove a workpiece carrier (MU) with the parts on it, also while paused (sensors update at once). |
| `web_mu_move` | write | `id` number **req**, `x` number **req**, `y` number **req**, `z` number **req**, `surface` string | Set a workpiece carrier (MU) onto a transport surface at (x, z): bottom on the surface top, rotation kept; refused when occupied or off every surface. |
| `web_sensor_list` | read | — | List all sensors with occupancy state, mode and their occupied/not-occupied signal names. |
| `web_signal_automap` | write | `interfaceId` string, `mode` string | PLC auto-map: match the model PLC signals (address = comment prefix "<address> · <text>") with a CONNECT S7 / PlcSimAdvanced interface. |
| `web_signal_bind` | write | `targetId` string **req**, `componentPath` string **req**, `slot` string **req**, `signal` string **req** | Bind an external CONNECT signal (or an internal model signal) to one component slot, identified by targetId plus componentPath plus slot. |
| `web_signal_bindings_list` | read | `filter` string, `boundOnly` boolean, `limit` number | List every bindable signal slot in the scene with its canonical identity (targetId, componentPath, slot), current external signal, liveness and comment — plus saved link… |
| `web_signal_list` | read | — | List all PLC signals with current values. For direction/forced/live-vs-stale diagnosis use web_signal_status instead. |
| `web_signal_reconcile` | read | `interfaceId` string | Reconcile report: model PLC signals vs CONNECT interfaces per category (mapped, name-variant = a quoting variant and NOT coupled, missing-in-plc, plc-only, type-mismatch… |
| `web_signal_set_bool` | write | `name` string **req**, `value` boolean **req**, `asset` string | Write a boolean PLC signal in the browser SignalStore. |
| `web_signal_set_float` | write | `name` string **req**, `value` number **req**, `asset` string | Write a float PLC signal in the browser SignalStore. |
| `web_signal_sources_list` | read | `filter` string, `limit` number | List signals available as binding sources: live realvirtual CONNECT signals from every connected interface plus internal model signals, each with direction, data type, p… |
| `web_signal_status` | read | `filter` string, `activeOnly` boolean, `limit` number | List PLC signals with full status: value, type, direction, forced state, live/stale activity, address/comment metadata. |
| `web_signal_unbind` | write | `targetId` string **req**, `componentPath` string **req**, `slot` string **req** | Remove the external signal from one component slot, identified by targetId plus componentPath plus slot. |
| `web_signal_usage` | read | `name` string **req** | List where a signal is used: component fields, logic steps, PLC program lines (read/write), operator panels, bindings and CONNECT bridges — the inspector's "Used by" lis… |
| `web_sim_mode` | write | `mode` string | Simulation / PLC mode: Simulation runs the virtual PLC (Active Disconnected roots), PLC leaves the outputs to a real PLC. |
| `web_sim_play_pause` | write | `paused` boolean | Play or pause the simulation. ALWAYS pass paused=true (pause) or paused=false (play) — omitting it TOGGLES, and the simulation is usually already running, so a bare call… |
| `web_sim_reset` | write | — | Reset the simulation: clears MUs, resets LogicStep states and snaps every drive back to its authored StartPosition. |
| `web_transport_status` | read | — | Get material-flow status: spawned/consumed/active MU counts, blocked and physics-owned MUs, per-source and per-sink stats. |
<!-- END GENERATED: tool-reference simulation -->
