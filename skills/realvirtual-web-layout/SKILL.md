---
name: realvirtual-web-layout
description: Use when placing, connecting or moving catalog parts (conveyors, pallets, stations) in the realvirtual WEB layout planner through the CONNECT MCP tools — snap-driven chaining, heights taken from the transport surface, MUs on a conveyor.
---

# realvirtual WEB — building a layout

Read `web_help("layout")` once per session. Layout changes are commands, like model changes.

## Workflow

1. `web_status` — a viewer must be connected; then switch to the planner (`web_execute("workspace.setMode", {"mode": "planner"})`).
2. `web_query("library.catalogList", {})` — the catalog ids you may place.
3. **Place the first part:** `web_execute("layout.place", {"catalogId": "...", "x": 0, "y": 0, "z": 0})`.
   The answer carries the placement `id`.
4. **Chain the next parts by snap, never by computed coordinates:**
   `web_execute("layout.snapAttach", {...})` — ports from `web_query("layout.snapList", {"id":"conveyor-1"})` (or the snap list of the
   placement). A chain built from coordinates leaves gaps the material flow cannot cross.
5. **Put a pallet or MU onto a conveyor** with `onto: <placement id>` on `layout.place`: the part is
   centred on that placement and its height comes from the real transport surface. Never guess a height.
6. Move or remove with `web_execute("layout.move", {...})` / `web_execute("layout.remove", {...})`.
7. Look at it: `web_screenshot` or `web_eye`; check gaps between parts with `web_measure`.

## Traps

- Heights are metres of the part origin; `y = 0` is the ground. Use `onto` for anything that rests on
  a conveyor.
- A placement is addressed by its `id`, not by a node path; the agent cursor marks it after `layout.place`.
- When a call answers `running: true`, do not resend it — ask `web_call_pending`.
