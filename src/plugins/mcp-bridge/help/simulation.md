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
