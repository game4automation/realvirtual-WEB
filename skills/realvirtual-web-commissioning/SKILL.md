---
name: realvirtual-web-commissioning
description: Use when testing a realvirtual WEB model against signals or a PLC through the CONNECT MCP tools — running the simulation, setting and binding signals, watching sensors and drives, finding why a part does not move.
---

# realvirtual WEB — virtual commissioning

Read `web_help("simulation")` and, with a PLC, `web_help("plc")` once per session.

## Workflow

1. `web_status` — viewer connected, and its `gateway` block: `writesAllowed` must be true for any
   signal write (CONNECT tray: Details › MCP server › Allow write access).
2. Run or reset the simulation: `web_execute("sim.playPause", {})`, `web_execute("sim.reset", {})`.
3. Signals in the viewer: `web_signal_list`, then `web_execute("signal.setBool", {...})` /
   `web_execute("signal.setFloat", {...})`. CONNECT's own process image: `signal_list`, `signal_read`,
   `signal_set_bool`, `signal_force` / `signal_unforce`.
4. Watch the effect: `web_query("drive.list", {})`, `web_query("sensor.list", {})`, `web_query("transport.status", {})`, `web_logs`,
   `web_errors`. Debug a part that does not move with `web_help("simulation")`.

## Traps

- Signal direction follows the PLC: PLC outputs are read by the viewer, PLC inputs are written by it.
  Live signals always override local behaviour.
- A session policy (the WEB chat) can refuse a `signal` class call; the refusal text says why.
- When a call answers `running: true`, do not resend it — ask `web_call_pending`.
