# Simulation & debugging (HMI runtime)

> Dotted names like `editor.setField(…)` / `sim.playPause` are registry commands: run them with
> `web_execute(command="<id>", args={…})` (or `web_batch`). Their old alias tools are not in tools/list.

## Drive not moving

1. `web_query("drive.list", {})` — position, targetSpeed, isRunning, jog flags, limits (at a limit?)
2. `web_signal_status filter=<drive name>` — are its control signals live or stale?
3. `signal.setBool` / `drive.jog` — actuate manually to separate signal vs mechanics
4. `web_screenshot_burst` — visual proof of motion (or none)
5. `web_logs level=error` — runtime errors

**Reading logs and status.** `web_logs` without arguments returns the newest 100 entries at
level info and above; use `level=debug` or `level=trace` for more detail. Levels are
`trace|debug|info|warn|error`; `limit` sets the entry count (default 100). Narrow with `category` (comma list,
e.g. `category="signal,drive"`, filtered before the limit) and `since` (non-negative wall-clock seconds back). An unknown
level or category answers with the valid ones. `web_signal_list filter=<substring>` answers
`{signals, total, truncated}`; matching is case-insensitive and `limit` defaults to 500.
`web_status` is lean by default (`detail="basic"`: connection, model, mode, counts,
`sim{kernelMode, simTime}`, `problems{error,warning,info}`, `placements`); `detail="render"`
adds the render / bake / cache / feature diagnostics (`detail="full"` currently returns the same fields).
Invalid detail values are errors. Any argument a tool does not declare is an
`unknown-param:` error that lists the allowed ones. Supported aliases are `web_logs types` →
`category` and `web_signal_list name` / `pattern` → `filter` (substring, not a glob).
Pass only one spelling; alias conflicts are errors. `_`-prefixed metadata is accepted except `__proto__`.

## Parts missing / jammed / not spawning

1. `web_query("transport.status", {})` — spawned/consumed/active/blocked MU counts, per-source stats
2. `web_execute("view.sourceMarkers", {visible:true})` + `web_screenshot` — locate spawn points
3. `web_query("sensor.list", {})` — which sensors block the flow
4. `sim.reset` — clear MUs and logic states; `sim.speedOverride` — slow everything down to watch

## Take a carrier off the line / put it elsewhere (Commissioning, plan-567)

`mu.delete id=<mus[].id>` removes a carrier with everything riding on it; `mu.move id x y z
[surface]` sets it onto a transport surface (collider bottom on the surface top, rotation kept,
refused when occupied). Both work while paused (sensors and signals update at once), only in the
Commissioning workspace, never on pooled (instanced), physics-owned or held carriers. An authored
carrier comes back on `sim.reset`. The ids come from `web_query("transport.status", {})` (`mus[].id`).

## Find the bottleneck on an AGV path network (congestion trace, plan-629)

1. `web_execute("trace.set", {"blocked":true,"utilization":true,"range":"window"})` - show both bands (Display panel >
   Overlays); `windowSec` (60-3600) sets the sliding window, `range=start` counts since start
2. Run the simulation (DES FastForward is fine - the trace is measured in SIM time, FastForward and
   Animated give identical numbers)
3. `web_query("trace.top", {"view":"blocked","n":5})` - the buckets where vehicles stand although they want to move,
   `value` = share of the sim time (0-1), `pos` = bucket centre in world coordinates
4. `web_query("trace.top", {"view":"utilization"})` - how busy the same stretch is; high utilization without
   blocking is a busy but flowing road
5. `web_camera_focus` on a `pos` + `web_screenshot` for the picture

No cause is listed on purpose - the place tells it (zone entry, junction, dock). `samples = 0` means
nothing was measured yet (no vehicle, or a reset / path change just happened).

## Compare Unity vs browser

Run the Unity tool and its `web_*` sibling side by side (e.g. `drive_list` vs `web_query("drive.list", {})`);
positions should match when playback is synced.

## Placed assets and nested placements (plan-757)

A reference node (`AssetReference`) is a placement — a planner placement, a hand-authored
reference and a reference INSIDE a placed asset alike; `web_status.placements.total` counts
all of them (a layout that places a layout twice reports the inner placements too).
`signal.setBool` / `signal.setFloat` with `asset` fan out to EVERY instance of that
asset, nested ones included: address a signal of the inner asset by the inner asset; addressed
by the outer asset the fan-out does not reach into its nested placements (they are instances of
their own asset) and reports them as `missing`.

## Logic sequences

`web_query("logic.flow", {})` — the LogicStep hierarchy with per-step state/progress; find the stuck step,
then check the signal or sensor it waits on.

## Tool reference

<!-- BEGIN GENERATED: tool-reference simulation — do not edit; run `npm run gen:mcp-docs` -->
_2 tools in this family, generated from the @McpTool decorators — do not edit by hand._

| Tool | Access | Parameters | Summary |
|------|--------|------------|---------|
| `web_signal_list` | read | `filter` string, `limit` number | List PLC signals with values as {signals:[{name,value,type}], total, truncated}. |
| `web_signal_status` | read | `filter` string, `activeOnly` boolean, `limit` number | List PLC signals with full status: value, type, direction, forced state, live/stale activity, address/comment metadata. |
<!-- END GENERATED: tool-reference simulation -->
