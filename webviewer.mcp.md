# realvirtual WebViewer MCP Tools

Product: **realvirtual WEB** (browser-based 3D viewer for industrial digital twins)

The `web_*` tools provide runtime access to the WebViewer running in a browser.
They read and control the Three.js scene directly — no Unity Editor required.

## When to Use web_* vs Unity Tools

| Scenario | Use |
|----------|-----|
| Working in Unity Editor only | Unity tools (`drive_list`, `component_get`, etc.) |
| Debugging WebViewer rendering or behavior | `web_*` tools |
| WebViewer standalone (no Unity running) | `web_*` tools only |
| Comparing Unity vs WebViewer state | BOTH — e.g. `drive_list` AND `web_drive_list` |
| Writing signals when Unity is not running | `web_signal_set_bool` / `web_signal_set_float` |

## Important: web_* Tools Operate on Browser State

- `web_drive_list` shows Three.js drive positions (may differ from Unity if playback diverges)
- `web_signal_set_bool` / `web_signal_set_float` write directly in the browser's SignalStore
- Unity tools modify the Unity scene; `web_*` tools modify the browser scene
- Both can run simultaneously for side-by-side comparison

## Available Tools

| Tool | Description | Parameters |
|------|-------------|------------|
| `web_status` | Connection info, FPS, model URL, drive/signal/sensor counts | none |
| `web_drive_list` | All drives with current position, speed, direction, limits | none |
| `web_signal_list` | All PLC signals with current values (bool/int/float) | none |
| `web_signal_set_bool` | Write a boolean signal in the browser | `name`, `value` |
| `web_signal_set_float` | Write a float signal in the browser | `name`, `value` |
| `web_drive_jog` | Jog a drive forward or backward | `name`, `forward` (optional, default true) |
| `web_drive_stop` | Stop a drive (clear jog flags) | `name` |
| `web_sensor_list` | All sensors with occupancy status | none |
| `web_transport_status` | MU counts, source/sink stats, active transport surfaces | none |
| `web_logic_flow` | LogicStep hierarchy with step states and progress | none |
| `web_logs` | Recent browser console logs (errors, warnings, debug) | `level` (optional), `limit` (optional) |

## Common Workflows

### Debug a drive not moving in WebViewer
1. `web_drive_list` — check position, speed, isRunning
2. `web_signal_list` — check if control signals are set correctly
3. `web_logs` — look for errors during drive initialization

### Compare Unity and WebViewer state
1. `drive_list` (Unity) — get Unity drive positions
2. `web_drive_list` (WebViewer) — get browser drive positions
3. Compare positions — they should match if playback is synced

### Control WebViewer without Unity
1. `web_signal_set_bool` — set start/stop signals
2. `web_drive_jog` — manually jog drives
3. `web_transport_status` — monitor MU flow

### Diagnose sensor issues
1. `web_sensor_list` — check which sensors are occupied
2. `web_transport_status` — verify MUs are being created and consumed
3. `web_signal_list` — check sensor output signals

## Architecture

The WebViewer MCP bridge uses WebSocket communication:

```
Claude Code <-- stdio (MCP) --> Python MCP server
                                   |
                                   |-- WS SERVER (:18712)
                                       <-- WS CLIENT (Browser)
```

The browser connects automatically when the WebViewer loads (dev mode or `?mcp=1`).
Tools are auto-discovered via TypeScript `@McpTool` / `@McpParam` decorators.

## Connection States

- **Connected**: Browser is connected, all `web_*` tools operational
- **Not connected**: Browser closed or not loaded — tools return `"WebViewer not connected"`
- **Reconnecting**: Browser auto-reconnects with exponential backoff (1s to 30s)

## Troubleshooting

- If `web_*` tools return "WebViewer not connected":
  - Check if the browser tab is open
  - Check browser DevTools console for WebSocket errors
  - The WebViewer connects to `ws://localhost:18712/webviewer`
- If data seems stale, the browser pushes fresh data on every tool call (no polling)
