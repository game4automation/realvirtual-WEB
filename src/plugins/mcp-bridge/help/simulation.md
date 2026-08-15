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

## Compare Unity vs browser

Run the Unity tool and its `web_*` sibling side by side (e.g. `drive_list` vs `web_drive_list`);
positions should match when playback is synced.

## Logic sequences

`web_logic_flow` — the LogicStep hierarchy with per-step state/progress; find the stuck step,
then check the signal or sensor it waits on.

## Tool reference

<!-- BEGIN GENERATED: tool-reference simulation — do not edit; run `npm run gen:mcp-docs` -->
_17 tools in this family, generated from the @McpTool decorators — do not edit by hand._

| Tool | Access | Parameters | Summary |
|------|--------|------------|---------|
| `web_drive_jog` | write | `name` string **req**, `forward` boolean | Jog a runtime drive forward or backward (sets jog flags; drive names from web_drive_list). |
| `web_drive_list` | read | — | List all drives: current/target position, speed, running/jog flags, direction, limits. |
| `web_drive_speed_override` | write | `factor` number | Master speed factor scaling ALL drives (1 = normal, 0.5 = half, 2 = double, 0 = stopped; relative speeds preserved). |
| `web_drive_stop` | write | `name` string **req** | Stop a drive: clears jog flags and halts motion. |
| `web_logic_flow` | read | — | Get the LogicStep sequence hierarchy with per-step state and progress. |
| `web_sensor_list` | read | — | List all sensors with occupancy state, mode and their occupied/not-occupied signal names. |
| `web_signal_bind` | write | `targetId` string **req**, `componentPath` string **req**, `slot` string **req**, `signal` string **req** | Bind an external CONNECT signal (or an internal model signal) to one component slot, identified by targetId plus componentPath plus slot. |
| `web_signal_bindings_list` | read | `filter` string, `boundOnly` boolean, `limit` number | List every bindable signal slot in the scene with its canonical identity (targetId, componentPath, slot), current external signal, liveness and comment — plus saved link… |
| `web_signal_list` | read | — | List all PLC signals with current values. For direction/forced/live-vs-stale diagnosis use web_signal_status instead. |
| `web_signal_set_bool` | write | `name` string **req**, `value` boolean **req** | Write a boolean PLC signal in the browser SignalStore. |
| `web_signal_set_float` | write | `name` string **req**, `value` number **req** | Write a float PLC signal in the browser SignalStore. |
| `web_signal_sources_list` | read | `filter` string, `limit` number | List signals available as binding sources: live realvirtual CONNECT signals from every connected interface plus internal model signals, each with direction, data type, p… |
| `web_signal_status` | read | `filter` string, `activeOnly` boolean, `limit` number | List PLC signals with full status: value, type, direction, forced state, live/stale activity, address/comment metadata. |
| `web_signal_unbind` | write | `targetId` string **req**, `componentPath` string **req**, `slot` string **req** | Remove the external signal from one component slot, identified by targetId plus componentPath plus slot. |
| `web_sim_play_pause` | write | `paused` boolean | Play or pause the simulation. Pass paused=true/false, or omit to toggle. |
| `web_sim_reset` | write | — | Reset the simulation: clears MUs, resets LogicStep states and snaps every drive back to its authored StartPosition. |
| `web_transport_status` | read | — | Get material-flow status: spawned/consumed/active MU counts, blocked and physics-owned MUs, per-source and per-sink stats. |
<!-- END GENERATED: tool-reference simulation -->
