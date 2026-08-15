# AI Integration & the MCP Bridge

realvirtual WEB exposes its running 3D scene to AI assistants (Claude Code, Claude
Desktop) through an **MCP bridge**. Once connected, the assistant can inspect
and control the live browser scene — read drives, signals, sensors and transport
state, drive the simulation, capture screenshots, and build layouts in the Layout
Planner — using a set of `web_*` tools.

**realvirtual CONNECT is the default transport.** It hosts the MCP endpoint itself, so
nothing extra has to be installed. The local **Node bridge** remains fully supported as the
documented emergency fallback — it is not deprecated and not scheduled for removal here.

This document covers the architecture, setup, the client matrix, the fallback route, the
in-app **AI Bridge** status panel, the AI activity indicator, the `web_screenshot` cropping
options, and troubleshooting. For the exhaustive per-tool reference see
[`webviewer.mcp.md`](webviewer.mcp.md).

## Tool ownership: which server serves what

Exactly one MCP host owns each tool family. There is no overlap:

| Host | Owns | Tool prefix |
|------|------|-------------|
| **realvirtual CONNECT** (C#, `http://localhost:5100/mcp`) | the `web_*` browser tools **and** the CONNECT gateway tools (`signal_list`, `signal_read`, `interfaces_status`, `health`) | `mcp__realvirtual-CONNECT__…` |
| **Unity MCP server** (Python, `unity_mcp_server.py`) | the 80+ Unity Editor tools (scene, prefabs, play mode, recompile) | `mcp__UnityMCP__…` |

CONNECT is the default transport for `web_*`: it is same-origin with the delivered HMI,
needs neither Node nor Vite on the customer machine, and is the only path that works for a
static WebViewer delivery.

The Python server still carries a historic `web_*` proxy on port 18712. It is **not** the
intended path. Its `--no-webviewer` switch exists, but is deliberately **not** armed on the
start paths yet — so the Python server may still announce `web_*` tools alongside CONNECT.
Ignore them and always call `web_*` through CONNECT.

## Architecture

The connection is a three-link chain. Only the middle link differs between the two transports:

```
  CONNECT (default)

   Claude (MCP host)              realvirtual CONNECT              Browser (realvirtual WEB)
 ┌───────────────────┐  HTTP    ┌──────────────────────┐ WebSocket ┌──────────────────────┐
 │ Claude Code /      │ (MCP) ⟷ │ :5100/mcp             │  :5100    │ McpBridgePlugin       │
 │ Claude Code Desktop│         │ embedded C# MCP server│ /webviewer│  → RVViewer scene     │
 └───────────────────┘         └──────────────────────┘ ⟷ browser └──────────────────────┘

  Node bridge (fallback)

   Claude (MCP host)                 Node bridge                   Browser (realvirtual WEB)
 ┌───────────────────┐  stdio   ┌──────────────────────┐ WebSocket ┌──────────────────────┐
 │ Claude Code /      │ (MCP) ⟷ │ mcp-bridge/dist/      │  :<port>  │ McpBridgePlugin       │
 │ Claude Desktop     │         │ index.js              │ /webviewer│  → RVViewer scene     │
 └───────────────────┘         └──────────────────────┘ ⟷ browser └──────────────────────┘
```

- **CONNECT** is already running as the gateway; its MCP server is a hosted endpoint, not a
  child process. `McpEnabled` and `McpAllowWrite` both default to **`true`**, so nothing has
  to be switched on locally. The tray icon still offers both (*MCP server ▸ Enabled*, takes
  effect after a CONNECT restart; *Allow write access*, live) for installations that want
  them off. Access from another machine needs the CONNECT API key.
- The **Node bridge** is instead launched by Claude as a stdio child process (from
  `.mcp.json` / the Claude Desktop config) and hosts its own WebSocket server.
- Either way the **browser** connects as a WebSocket client to `/webviewer`.
- The browser **owns the tools**: on connect it sends a `discover` message with the
  `web_*` tool schemas (generated from `@McpTool` decorators in
  `src/plugins/mcp-bridge-plugin.ts`) plus the `webviewer.mcp.md` instructions. The
  server registers them as MCP tools and forwards every tool call to the browser.

Because the browser defines the tools, neither server needs tool knowledge — both are
generic relays. A tool added to `McpBridgePlugin` appears automatically after a reconnect.

### Ports

The browser connects to **exactly one** port at a time — that decides which assistant
drives it. Switch it in the AI Bridge panel (see below), or with `?mcpPort=<port>` in the
URL.

| Port  | Bridge                          | Driven by        |
|-------|---------------------------------|------------------|
| 5100  | CONNECT (`/mcp` + `/webviewer`) | **default** — any MCP client on `:5100/mcp` |
| 18714 | Node bridge                     | Claude Desktop (fallback) |
| 18715 | Node bridge                     | Claude Code (fallback) |
| 18712 | Python bridge (Unity MCP server)| historic `web_*` proxy — **do not use**, see *Tool ownership* |

CONNECT does **not** drift to another port when 5100 is taken, unlike the Node bridge
(which walks `+1..+20`). Clients address CONNECT by URL — `.mcp.json`, the HMI, the REST
API and the `/ws` signal channel all name 5100 — so a silent drift would point every one
of them at a dead port. A collision is reported and refused instead. For a second instance
(e.g. a parallel worktree) set `REALVIRTUAL_CONNECT_PORT` on the CONNECT side and use the
matching `?mcpPort=` in the browser.

### Which client needs what

There is no single answer for "Claude" — the three clients differ:

| Client | Reaches CONNECT via | Needs `mcp-remote`? |
|--------|---------------------|---------------------|
| **Claude Code (CLI)** | native Streamable HTTP; `"type": "http"` entry in `.mcp.json`. Custom headers via `--header` / `headers` | No |
| **Claude Code Desktop** | same engine and same configuration files as the CLI | No |
| **Claude Desktop (classic)** | local stdio only — `npx -y mcp-remote http://localhost:5100/mcp --allow-http`. Requires Node.js on the user machine | Yes |

**Remote Custom Connectors (claude.ai / Cowork) are not supported.** That path connects from
Anthropic's cloud and would require exposing CONNECT publicly, which contradicts the rule that
realvirtual does not host productive machine endpoints. Putting your own gateway in front of
CONNECT is possible but out of scope and at your own risk.

## Setup

1. **Nothing to enable.** CONNECT's MCP server and its write access are on by default; an
   installation that predates this default is migrated once on first load. Only if someone
   turned them off: tray icon ▸ *MCP server ▸ Enabled* (writes `McpEnabled` to
   `connect-config.json`; restart CONNECT) and ▸ *Allow write access* (`McpAllowWrite`, live).

2. **Register CONNECT with your client.** In Unity:
   *Tools ▸ realvirtual ▸ Settings ▸ Configure Claude Desktop MCP* writes both client
   configurations. Or add it by hand to `.mcp.json` (Claude Code / Code Desktop):

   ```json
   "realvirtual-CONNECT": {
     "type": "http",
     "url": "http://localhost:5100/mcp"
   }
   ```

   For **Claude Desktop (classic)** in `claude_desktop_config.json`:

   ```json
   "realvirtual-CONNECT": {
     "command": "npx",
     "args": ["-y", "mcp-remote", "http://localhost:5100/mcp", "--allow-http"]
   }
   ```

3. **Restart the client**, then enable **AI Bridge** in the WebViewer (toggle in the panel).
   Leave **CONNECT** selected under *Connect to*. This also works against the Vite dev
   server on 5173 — the default already targets 5100, and `?mcpPort=5100` pins it
   explicitly.

### Authentication

If CONNECT has an `ApiKey` configured:

- The **MCP client** sends it as a header — `Authorization: Bearer <key>` or the legacy
  `X-API-Key`. A key in the query string is rejected on `/mcp`.
- The **browser** proves itself on the `/webviewer` WebSocket handshake with either CONNECT's
  session cookie or `?apikey=`, because the browser WebSocket API cannot set headers. The key
  is taken from the WS Realtime interface setting (`wsAuthToken`).
  - **Same-origin** (the HMI served by CONNECT) uses the **cookie** and keeps the key out of
    the URL — a credential in a URL is written to every proxy and server log on the way. The
    cookie comes from opening the gateway once as `?apikey=<key>`.
  - **Cross-origin** (Vite dev on 5173, a pinned port, an `AllowedOrigins` host) keeps
    `?apikey=`: a `SameSite=Strict` cookie is not sent cross-site, so it is the only proof a
    browser can present there.
  - If a cookie-only handshake fails — an expired cookie, most likely — the client falls back
    to `?apikey=` for the rest of the session rather than reconnect-looping on a 401.

### What the guardrails do and do not cover

Stated plainly, because a half-described boundary is worse than a named one:

- **The write gate** (`McpAllowWrite`, plus the per-tool `readOnlyHint`) prevents *accidental*
  mutation by an agent. It does not defend against a manipulated browser — the browser decides
  what a tool actually does, and could offer mutating behaviour under a read-only name.
- **Timeouts do not guarantee "not executed".** When a call exceeds its `timeoutMs`, CONNECT
  reports the browser call id together with `outcome: unknown` and does **not** retry. The work
  may well have completed in the browser. There is deliberately **no idempotency key and no
  cancellation acknowledgement**: a client that retries on its own can therefore trigger a
  mutation twice (a CAD import running twice, for example). Treat a timed-out writing tool as
  "state unknown" and verify before repeating it.
- **A late result never reaches the MCP client.** After a `tools/call` error the protocol has no
  way back. Late results land in a bounded, TTL-limited audit and in the browser log only.
- **DNS rebinding against `/webviewer` remains possible without a configured `ApiKey`.** The
  same-origin rule cannot close it, because CONNECT is meant to serve remote HMIs under arbitrary
  host names — during a rebind the attacker's Origin and Host agree. The effective countermeasure
  is an `ApiKey` or a narrow `AllowedOrigins` list, not the gate.
- **`/ws` has no Origin gate** (only `/mcp` and `/webviewer` do). That is the signal channel of
  every HMI and was left unchanged deliberately.

CONNECT also validates the browser `Origin` on `/mcp` and `/webviewer`. Loopback origins
(including the Vite dev server on 5173) and pages served by CONNECT itself always pass. A
WebViewer hosted on a **foreign** origin — e.g. loaded from a CDN domain while talking to a
CONNECT elsewhere — is rejected with 403; add that origin to CONNECT's `AllowedOrigins` to
allow it. Behind a reverse proxy, `X-Forwarded-For` is honoured only when the proxy address
is listed in `TrustedProxies` (empty by default, and absent from the shipped
`appsettings.json` — set it explicitly).

## Falling back to the Node bridge

The Node bridge is the documented emergency route when CONNECT is unavailable. It is not
deprecated, and switching in either direction is a single move.

1. **Build it once** (`dist/` is git- and Plastic-ignored):

   ```bash
   cd Assets/realvirtual-WebViewer~/mcp-bridge
   npm run setup        # = npm install && npm run build  (or double-click setup.cmd)
   ```

2. **Activate the client entry.** In the project `.mcp.json` the bridge is parked under the
   top-level `_disabledMcpServers` key, which Claude Code never launches (it reads
   `mcpServers` only — a merely renamed key stays active). Move the `WebViewerMCP` block
   into `mcpServers` and restart the client. To go back, move it there again.

   In `claude_desktop_config.json` the configurator removes an active entry instead of
   parking it, because that file belongs to a third-party app. The previous file is kept as
   `claude_desktop_config.json.backup`; to restore the fallback, add:

   ```json
   "realvirtual-WebViewerMCP": {
     "command": "node",
     "args": [
       "<project>/Assets/realvirtual-WebViewer~/mcp-bridge/dist/index.js",
       "--web-port", "18714"
     ]
   }
   ```

3. **Point the browser at it** — *Connect to ▸ Node · Desktop* (18714) or *Node · Code*
   (18715) in the AI Bridge panel, or open realvirtual with `?mcpPort=18714`.

> `claude mcp add|remove --scope project` rewrites `.mcp.json` from `mcpServers` alone and
> silently drops `_disabledMcpServers` and `_ownership`. Restore both by hand after using it.

## The AI Bridge panel

Open it from the **AI Bridge** button in the activity bar, or *Settings ▸ AI*. The
status section shows the **full chain** — not just the WebSocket link, but whether a
live AI client is actually attached and what it is doing.

The button is always offered, whether or not a bridge is connected — a deploy can still
remove it through the activity-bar feature matrix. On mobile the activity bar has no room
for it, so *Settings ▸ AI* is the only entry there.

Two things happen before the panel appears:

- **No CONNECT answered.** CONNECT hosts the MCP server, so without it there is nothing to
  configure. The click answers with a short note and the CONNECT download (stable, plus beta
  when one exists) instead of an empty panel.
- **First open on this device.** A one-time dialog states what a connected assistant may
  reach — the full scene, every PLC signal including writes, and the simulation — and how far
  that reaches: usable on this machine without any configuration, answerable from another
  machine only with a valid `ApiKey`. *Got it* and *Configure…* both record the
  acknowledgement and open the panel; *Not now* (or Escape) leaves without agreeing to
  anything. The acknowledgement is stored per device under the key `rv-ai-bridge-consent`,
  and it stores the accepted **scope version**, so widening what the bridge may reach asks
  once more. It is never granted implicitly.

![The AI Bridge panel: full-chain status, port presets, server controls and the live tool list](docs/images/screenshot-ai-bridge-panel.png)

### Status rows

![Full-chain status: Browser to Bridge, the attached AI client, last activity, and bridge identity](docs/images/screenshot-ai-bridge-status.png)

| Row | Meaning |
|-----|---------|
| **Browser → Bridge** | The browser↔bridge WebSocket link: *Connected*, *Reconnecting*, *Disconnected* or *Disabled*. |
| **AI client** | The MCP host attached to the bridge, e.g. `claude-code`. This is the real proof an assistant is connected — a connected WebSocket alone does not mean a live AI is present. |
| **Last AI activity** | Time since the assistant's last request (a tool call or tool list), e.g. *just now* / *2s ago*. *idle* when nothing has happened yet. |
| **Tools** | Number of `web_*` tools registered from the browser. |
| **Port** | The port the browser is connected to. |
| **Bridge** | Bridge process identity: `pid · :port · uptime`. Disambiguates duplicate bridges and shows how long it has been running. |

### Controls

- **Connect to** — one-click switch between **CONNECT** (5100, the default), **Node · Desktop**
  (18714) and **Node · Code** (18715). The **Port** field sets any custom port; picking
  CONNECT's default port also restores same-origin resolution, so an HMI served by a remote
  CONNECT keeps using its own origin instead of `localhost`.
- **Pause / Resume** — stop or resume accepting browser connections.
- **Shutdown** — ask the bridge process to exit (it can only be relaunched by the AI
  host, not from the browser).
- **Registered Tools** — the live list of `web_*` tools the assistant can call.
- **Server Log** — log lines streamed from the bridge (bind, connect, discover, …).

## AI activity indicator

The **AI Bridge button** itself carries the connection: its icon stands in the
**accent color** for as long as the bridge is connected, and stays neutral when it is
off or still reconnecting. Its tooltip names the state — *off*, *connecting…* or
*connected (N tools)*, with the running operation appended while one is in flight.

While the assistant performs an action, a pill in the accent color appears next to
the AI Bridge button (over the 3D scene) showing the current operation, e.g.
`AI · Drive list`. It auto-clears a few seconds after the last action.

![The AI activity pill in the accent color, shown while the assistant is working](docs/images/screenshot-ai-activity-overlay.png)

The accent color follows the theme, so custom branding recolors it automatically.

## Tools overview

The `web_*` tools fall into these groups (full reference in
[`webviewer.mcp.md`](webviewer.mcp.md)):

- **Inspect** — `web_status`, `web_drive_list`, `web_signal_list`, `web_sensor_list`,
  `web_transport_status`, `web_logic_flow`, `web_node_find`, `web_node_tree`,
  `web_component_get`, `web_component_get_all`, `web_component_list`, `web_logs`.
- **Control** — `web_signal_set_bool`, `web_signal_set_float`, `web_drive_jog`,
  `web_drive_stop`, `web_drive_speed_override`, `web_sim_play_pause`, `web_sim_reset`,
  `web_view_source_markers`.
- **Screenshot** — `web_screenshot`, `web_screenshot_burst`, `web_screenshot_annotated`,
  `web_screenshot_analyze` (see below).
- **Authoring** (Layout Planner) — `web_mode_set`, `web_library_list`,
  `web_library_describe`, `web_layout_place`, `web_layout_move`, `web_layout_remove`,
  `web_layout_list`, `web_layout_snap_list`, `web_layout_snap_suggest`,
  `web_layout_snap_attach`, `web_component_set`, `web_scene_new`, `web_scene_save`,
  `web_scene_open`, `web_scene_list`, `web_scene_export`.
- **Signal binding** (plan-425) — `web_signal_bindings_list`, `web_signal_sources_list`
  (read-only) and `web_signal_bind`, `web_signal_unbind` (write). See *Autobinding a PLC*
  below.
- **Node knowledge** (plan-394) — `web_knowledge_get`, `web_knowledge_list` (read-only) and
  `web_knowledge_set` (write): one overwritable Markdown note per scene node, stored in the
  GLB, so what one session works out is available to the next. See *Node knowledge (agent
  memory)* below.
- **Help** — `web_help(topic)` serves the deep workflow guides
  (`src/plugins/mcp-bridge/help/*.md`) on demand; the always-loaded server
  instructions stay a compact map.
- **Orient** (plan-707) — `web_describe` answers "where am I, what is blocked, what next"
  in one read-only call. See *Orientation and effect verification* below.
- **Perceive & navigate** (all modes) — `web_node_bounds`, `web_view_pick`,
  `web_view_gaze`, `web_view_isolate`, `web_screenshot_annotated`, `web_camera_get`,
  `web_camera_set`, `web_camera_focus`, `web_camera_orbit`, `web_select`,
  `web_selection_get`, `web_select_similar`. Camera tools animate the REAL viewport
  camera, so a watching user sees exactly what the agent looks at.
- **Measure & analyse** (`McpObserveTools`, all read-only) — `web_measure` (pairwise
  distances, per-axis gaps and AABB separation between parts), `web_node_shape` (PCA
  shape class and the functional rotation axis of a part), `web_scene_query` (read-only
  JavaScript over a frozen plain-data scene snapshot — the escape hatch for questions no
  dedicated tool answers) and `web_render` (offscreen render from an arbitrary camera
  pose, `beauty` or a flat-colored `idmask` segmentation view with a color→path legend,
  never touching the user's viewport or selection).
- **Asset Editor** — the `web_editor_*` family: lifecycle (`open`/`close`/`status`/
  `undo`/`redo`/`save`/`import_glb`/`import_cad`), transform + pivot + structure +
  component + signal + material primitives, the compounds `web_editor_kinematize` /
  `web_editor_materialize` (one undo step each), and `web_editor_verify_drive`
  (pose-sweep montage with exact restore). Every tool calls the same action functions
  the Quick Edit / Materials panel buttons call, against the op-logged AssetDocument —
  agent edits are undoable and reflected live in the UI.

## Orientation and effect verification

Two questions the tool list has never been able to answer are *what is true right now* and
*did that call actually do anything*. Since plan-707 both have an answer, and neither
changed the wire protocol — `web_describe` is an ordinary tool, and the verification rides
inside the result JSON.

### `web_describe` — where am I, what next

One read-only call replaces the `web_status` + `web_editor_status` + `web_selection_get`
round trip and adds the two fields that make it actionable:

```jsonc
{
  "mode": "editor",
  "availableModes": ["hmi", "planner", "des", "editor"],
  "document": { "name": "Robot", "baseKind": "libraryGlb", "dirty": true,
                "busy": false, "opCount": 41, "nodeCount": 884, "canUndo": true },
  "selection": { "count": 2, "firstPath": "Robot/Axis2/Arm" },
  "runtime": { "connectionState": "Connected", "simRunning": false,
               "modelUrl": null, "driveCount": 6, "signalCount": 18 },
  "blocked": [{ "family": "web_layout_*",
                "reason": "Needs planner mode — call web_mode_set(\"planner\")" }],
  "next": "Verify the authored motion with web_editor_verify_drive before web_editor_save",
  "guide": "web_help(\"editor\")"
}
```

`next` comes from a declarative rule table (`NEXT_RULES` in `rv-mcp-describe-tool.ts`),
first match wins — a recommendation that varied between calls would be worse than none.
The first three rules encode known dead ends: a `busy` editor (poll, do not push another
call), a `libraryGlb` document with `nodeCount <= 1` (it opened EMPTY — re-import), and a
document nothing has been perceived in yet.

It **complements `web_help`, it does not replace it**: `guide` names a topic, it never
copies guide text. And it is `readOnly: true` in the strict sense — no selection, no panel,
no camera move, unlike `web_node_bounds`.

### `verified` — what the call actually did

Every writing tool with persistent state now carries a `verified` block in its result.
There is no opt-in and no parameter: the three dead ends this exists for are all cases
where the agent did not know it needed to check.

```jsonc
{ "name": "StartSignal", "value": false, "previous": true,
  "verified": { "changed": ["StartSignal.value: true→false"] } }

{ "ok": true, "kinematicPath": "Robot/Axis2", "groupName": "Axis2",
  "verified": { "changed": ["setField×1"] } }        // named, but nothing moved

{ "ok": true,
  "verified": { "noop": true, "why": "the tool reported success but appended no op" } }
```

- **`noop: true` is the valuable bit.** The tool reported success and the probe observed
  no change. Treat it as a failure the tool did not notice.
- **`changed` counts op KINDS for editor tools.** `setField×1` alone means a kinematic
  group was *named*; `reparentNode×8` means its members actually moved under the axis.
  That distinction is the difference between a working axis and a silent no-op.
- **`ambiguous: true` means two calls overlapped on the same scope**, so the observed
  change cannot be attributed to this one. `changed` is then withheld deliberately — a
  wrongly attributed delta claims an effect the call did not have. `noop` stays valid
  under overlap: "nothing happened" needs no attribution.
- **A result carrying `error` never gets `verified`.** A failure is already the answer.
- The delta is capped (`DELTA_MAX_ENTRIES` / `DELTA_MAX_BYTES` in
  `rv-mcp-delta-probes.ts`, both with their measured provenance in a comment); overflow is
  reported as `more: N`.

Not every write is probed, and the gaps are decisions: `web_camera_*`, `web_view_*`,
`web_select*` and `web_node_bounds` are classified as writes because a watching operator
sees the view jump, but they persist nothing, so a delta over a camera matrix would be
noise charged to the token budget. `web_editor_verify_drive` and
`web_editor_mechanism_jog` are transient by design.

### The generated tool reference

The tool tables in `webviewer.mcp.md` and the five `help/*.md` guides are **generated from
the decorators and checked in**, inside `<!-- BEGIN GENERATED: … -->` fences.
`tests/rv-mcp-docs-drift.test.ts` fails in both directions — a new tool without a
regeneration run, and a hand-edited block — so the reference cannot quietly fall behind
the code. Regenerate with `npm run gen:mcp-docs`; everything outside the fences is prose
and is never touched.

> `webviewer.mcp.md` is an `EmbeddedResource` in `Connect.csproj`. A regenerated
> instruction reaches CONNECT clients only after `realvirtual-Connect.exe` is rebuilt.

### Naming, description & response rules (enforced)

Tool discoverability rules — linted by `tests/rv-mcp-tool-conventions.test.ts`
(a new tool that violates them fails CI):

- **Names**: `web_<domain>_<action>`, snake_case (auto-derived from the camelCase
  method name). Approved domains: node, component, view, camera, select(ion),
  screenshot, drive, signal, sensor, sim, transport, logic, mode, layout, library,
  scene, editor, des, plc — extend the whitelist AND the domain table in
  `webviewer.mcp.md` deliberately. Root-level tools (`web_status`, `web_logs`,
  `web_errors`, `web_help`) are the fixed exceptions.
- **Descriptions**: verb-first keyword sentence, then when-to-use (point to the
  better sibling), units/gotchas, return shape. Budget ≤ ~110 words; deep lore
  belongs in a `web_help` topic, not the description.
- **Responses teach**: every error names the fix or the discovery tool that finds
  valid input (e.g. "use web_layout_list"); workflow-tool successes carry one
  `next` hint; plain reads stay hint-free.

### Tool delegate architecture & per-tool timeouts

Tools are declared browser-side via `@McpTool` decorators and merged from **five**
delegate objects at `discover` time (`_sendDiscover` in
`src/plugins/mcp-bridge-plugin.ts`): `McpBridgePlugin` itself (the historical set),
`McpViewTools` (`rv-mcp-view-tools.ts`), `McpObserveTools` (`rv-mcp-observe-tools.ts` —
`web_measure`, `web_node_shape`, `web_scene_query`, `web_render`), `McpEditorTools`
(`rv-mcp-editor-tools.ts`) and `McpHelpTool` (`rv-mcp-help-tool.ts`), all under
`src/plugins/mcp-bridge/`. The merge uses
`generateToolSchemasMulti` / `buildMultiDispatcher` (`rv-mcp-tools.ts`) — decorator
metadata is per-prototype, so splitting by delegate objects (not subclassing) is the
supported pattern; duplicate tool names throw at discover time. `McpEditorTools`
loads the asset-editor action modules via dynamic import so the editor stays a lazy
chunk.

Long-running tools declare `@McpTool(desc, { timeoutMs })`; the hint travels in the
`discover` schema and **both** servers apply it per call, stripping it from the
client-visible tool list. Default remains 15 s, capped at 600 s. Tools also declare
`readOnly`, which travels as the standard MCP `annotations.readOnlyHint` and drives
CONNECT's write gate (missing or `false` counts as writing). **The Node bridge must be
rebuilt once (`npm run setup` in `mcp-bridge/`) after pulling this change** — an old
bridge ignores the hints and long tools (e.g. `web_editor_verify_drive`,
`web_screenshot_burst`) time out early. CONNECT embeds `webviewer.mcp.md` at build time,
so changing that file requires a CONNECT rebuild.

### web_screenshot — full frame or cropped

`web_screenshot` returns an image of the 3D scene. Without arguments it captures the
whole view. It can also crop to a sub-region:

- **Frame a node** — pass `path` (a node's hierarchy path) to crop to that object's
  on-screen bounding box plus a small margin. Useful for focusing on one machine.
- **Manual rectangle** — pass `x`, `y`, `w`, `h` as fractions `0..1` of the canvas
  (top-left origin) for an explicit crop. This overrides `path`.

![web_screenshot cropped to a single node's on-screen bounding box](docs/images/screenshot-web-screenshot-crop.png)

## Autobinding a PLC to a shared model

Connecting a customer's own PLC to a model somebody else built is the workflow plan-425
exists for, and it is a LANGUAGE problem before it is a technical one: nothing in
`MC04_01_Motor_Run` says it belongs on the slot called `Forward` of `Conveyor_03`. Matching
those two vocabularies is what a language model is good at, which is why the viewer ships
tools rather than a heuristic auto-map wizard.

The loop is three calls:

1. **`web_signal_bindings_list`** — every bindable slot with its canonical identity
   (`targetId`, `componentPath`, `slot`), what is currently on it, its liveness, and the
   slot signal's **comment**.
2. **`web_signal_sources_list`** — every signal the connected interfaces offer, with
   direction, data type, provider and again the **comment**.
3. **`web_signal_bind`** per matched pair.

The comments are the load-bearing part. They come from Unity's `Signal.Comment`, travel in
the GLB, and are usually the only place a tag's *meaning* is written down — a symbol name
alone rarely carries enough to match on.

### What the tools refuse to do

- **Guess a slot.** A Planner placement aggregates its whole subtree, so one target can
  carry the same slot name on several components. `targetId + slot` is refused with the
  candidate list; pass `componentPath` too.
- **Bind something a manual drag would not.** Type, direction and provider identity run
  through the same validation as drag-and-drop, and a refusal returns the same sentence a
  user would read.
- **Claim a success that will not survive.** Persistence is checked BEFORE the runtime
  mutation, so a bind either sticks or does not happen. `persisted: true` in the answer is
  a read-back, not an intention.
- **Repair a broken link.** Orphans appear in the `orphans` section of
  `web_signal_bindings_list`, with `candidateComponentPath` when the component merely
  moved — but reconnecting stays a human click in the bindings overview panel. A repair
  that picked the wrong component would silently rewire a machine.

### Oversight

Direct binding is deliberate: a confirmation prompt per link would undo the point of
binding a hundred signals in one pass. The oversight is the **bindings overview panel**
(activity bar, beside the signal-link toggle) — every link in one table, jump to any of
them in the 3D scene, unlink with one click. Each successful bind also pulses its chip
once, so a watching operator sees the agent working.

Both mutating tools sit behind CONNECT's write switch (*Details ▸ MCP server ▸ Allow write
access*). With it off they are not offered, and calling them by name is refused.

## Node knowledge (agent memory)

An agent that kinematizes, analyses or debugs a machine works out things the CAD never
said: which axis carries which role, where the real limits are, which node is not the
thing its name claims. Three tools let it keep that:

| Tool | Purpose |
|------|---------|
| `web_knowledge_set(path, markdown, author?, confidence?)` | Store or replace the note on one node. Overwrites; never appends. Empty/whitespace deletes it. |
| `web_knowledge_get(path)` | The note as raw Markdown plus `updatedAt` / `author` / `confidence`. |
| `web_knowledge_list(query?, limit?)` | Every annotated node, newest first, with excerpts. Full-text `query` over note text and node path. |

The note is stored as the `NodeKnowledge` rv_extras entry on the glTF node, so it travels
inside the GLB — no sidecar file, consistent with *GLB is the single source of truth*.
There is **no HMI panel** for it: this is agent memory and a prompt input, not a UI feature.

`confidence` (`observed` | `inferred` | `unverified`) is the part worth insisting on. A
hallucinated guess becomes an apparent fact simply by being written down, and the next
session has no way to tell. `observed` means measured or seen; the other two mark a guess
as a guess. `updatedAt` is stamped automatically and is the only staleness signal a reader
gets — there is no automatic conflict resolution between a note and the scene.

### `persistedTo` — read it, it is not decoration

Every `set` reports where the write actually landed, and the three answers are genuinely
different promises:

| `persistedTo` | Meaning |
|---------------|---------|
| `asset` | In the AssetDocument. Call `web_editor_save` to write the asset GLB. |
| `scene` | In the scene op log. **Optimistic:** the debounced draft autosave carries it, and a workspace teardown (a model switch) CANCELS that timer rather than flushing it — a note written seconds before a switch is lost despite this answer. |
| `none` | Nothing is persisted. Either no edit target exists, or the workspace is **transient** (an Example model or a shared link, which persists nothing by design — see [`doc-persistence.md`](doc-persistence.md)). The note is gone on reload. |

The distinction needs **two** signals, which is why it is not derived from
`EditTarget.available`: a transient workspace reports `available: true`, accepts ops and
supports undo, and persists nothing. `getActivePersistenceTarget()`
(`src/core/hmi/rv-edit-target.ts`) combines `available` with `SceneStore.isTransient()`.

### Prompt embedding

A node's note is also fed into the Ask AI / diagnosis prompt (see *Model context in the
answer* below), as its own block **after** the alarm lines, capped at 600 characters. Two
properties matter and are pinned by tests:

- **Every note line is given a code-generated `| ` prefix**, under a header naming the block
  as author-written. Without it a note containing `Alarm: Safety light curtain fault` would
  be indistinguishable from a real alarm line, and an agentic chain could act on it.
- **Line breaks survive, but only LF.** `sanitizeKnowledgeText` neutralizes CR, VT, FF, NEL,
  U+2028 and U+2029 — a renderer treats them as breaks while a split on LF does not see
  them, which would put text into the prompt without the prefix. CONNECT cannot catch
  U+2028/U+2029 (they are Unicode Zl/Zp, so .NET `char.IsControl` is false), so the client
  sanitizer is the only guard. `[MACHINE_STATUS]` is neutralized too: CONNECT deletes
  everything following a line that trims to exactly that.

The block sits **last** on purpose. The node block is capped at 1500 characters, so whatever
is at the end is lost first — a stale note losing its tail beats live signals or an active
alarm being pushed out of the prompt by one.

### Known limitations

- **A Unity re-export of the model DROPS every note.** There is no Unity `WebKnowledge`
  component, by decision, so Unity does not carry the entry and rewrites the GLB without it.
- **A Unity re-import LOGS ONE CONSOLE ERROR PER ANNOTATED NODE.**
  `GLBComponentDeserializer` cannot resolve the `NodeKnowledge` type and calls
  `GLBDebugLogger.Error`, which is *always logged* regardless of verbosity. This is
  accepted, permanent, and lives in the DATA rather than the code: reverting the feature
  does not clean already-exported GLBs. Note that `/finaltest` ("fail on any realvirtual
  package error") can trip on it and then needs judging by hand.
- **Notes are invisible to `web_component_get` / `_get_all`.** `NodeKnowledge` registers no
  create-factory, so no live instance exists and those tools (which serialize registry
  instances) see nothing. Read notes with `web_knowledge_get`.
- **Undo shares one stack with user edits.** A note goes through the same op log, so Ctrl+Z
  can remove one. Same as `web_component_set`.
- **No multiuser live sync.** Other participants see a note after save + reload.
- **`NodeIdAtWrite` is blind across multiple references.** A NodeId is unique within a file,
  not globally, so ten placements of one asset share it. `get` reports a mismatch for a
  renumbering re-import, never for the wrong placement — absence of a mismatch is not proof
  of identity.

## Operating with and without Unity

- **Standalone** — run the WebViewer dev server (`npm run dev`, `localhost:5173`) or a
  built/deployed instance. CONNECT serves the `web_*` tools; no Unity required. Without a
  CONNECT instance, fall back to the Node bridge as described under
  *Falling back to the Node bridge*.
- **With Unity** — the Unity MCP server adds its 80+ editor/scene tools on top. It does
  **not** drive the browser: `web_*` stays with CONNECT, so both hosts can be registered
  side by side without competing for the same tool names.

## Troubleshooting

- **No `web_*` tools in the assistant.** The tools register only after the browser
  connects to the bridge. Confirm the AI Bridge panel shows *Connected* with an
  **AI client** and a non-zero tool count, and that the browser port matches the
  client's bridge port. If the tools never appear, restart the AI client.

- **Only some `web_*` tools appear.** CONNECT's write gate was closed (`McpAllowWrite=false`;
  the default is `true`), so only tools annotated `readOnly` are listed. Re-enable it in the
  tray — it protects against accidental mutation by an agent, not against a manipulated
  browser.

- **`/mcp` returns 404.** `McpEnabled` was switched off (the default is `true`). Enable it via
  the tray icon and restart CONNECT.

- **The browser cannot connect to CONNECT (401 / 403).** 401 means the request satisfied
  neither half of the access rule — it did not come from CONNECT's own machine and carried no
  valid key. For a remote HMI set the `?apikey=` token under the WS Realtime interface
  settings (the same token `/ws` uses), or open the gateway once as `?apikey=<key>` to trade
  it for a session cookie. 403 means the Origin **or** Host gate refused the page: loopback and
  CONNECT's own pages pass, a foreign origin needs to be listed in `AllowedOrigins`, and the
  `Host` header must name the machine — a loopback name, a bare IP address, or a configured
  origin's host. A DNS name that is not configured is refused even from the same machine,
  because that is what a rebinding attack looks like.

- **"Connected" but no AI client.** The *Browser → Bridge* link is up but no live AI
  host is attached — the **AI client** row makes this explicit. Restart the AI client
  (Claude Code reload / Claude Desktop restart).

- **Port already in use.** Two AI clients cannot share one Node bridge port. Give each its own
  `--web-port`. When a host quits or reloads, its bridge exits and releases the port,
  and a replacement binds it after a short retry — so a reload self-heals within a
  few seconds. CONNECT behaves differently: it refuses to start on an occupied port rather
  than drifting (see *Ports*).

- **Wrong assistant is driving the browser.** Use **Connect to** in the AI Bridge
  panel to point the browser at the intended host (CONNECT / Node · Desktop / Node · Code).

- **Every call times out after 15 s, but CONNECT is healthy.** The classic symptom is
  `WebViewer tool call '…' timed out after 15 seconds (browserCallId=N, outcome=unknown)`
  from every tool, while `curl http://127.0.0.1:5100/health` answers `status: ok` instantly.
  That combination means the **browser tab is throttled**, not that anything is broken.

  Call **`web_ping`** first — it is strictly synchronous (no timer, no frame, no import), and
  because WebSocket `onmessage`/`send` are not throttled it still answers from a throttled tab
  and reports `hidden: true` with a diagnosis line. One call separates *tab in the background*
  from *browser gone* from *CONNECT down*.

  Chrome throttles along two independent axes:

  | Mechanism | Trigger | Effect |
  |---|---|---|
  | Timer throttling | page hidden | `setTimeout` clamped to ≥ 1 s; after ~5 min hidden, *intensive wake-up throttling* clamps to once per **minute** |
  | Renderer backgrounding / native window occlusion | Chrome's window **covered** by another window | renderer deprioritised — hits even the ACTIVE tab of that window |

  The second one is why this bites a normal session: working in the IDE with the viewer behind
  it is enough. Every `sleep()` in the MCP path (choreography beat, camera settle, the
  `verify_drive` glide) then takes a minute instead of 80 ms.

  **Fix — launch Chrome with throttling disabled:**

  ```bash
  npm run viewer:chrome                                    # default http://localhost:5100/
  npm run viewer:chrome -- --url "http://localhost:5100/?project=myproject"
  ```

  `scripts/launch-viewer-chrome.mjs` passes the Playwright/Puppeteer switch set
  (`--disable-background-timer-throttling`, `--disable-backgrounding-occluded-windows`,
  `--disable-renderer-backgrounding`, and one combined `--disable-features=` for
  `CalculateNativeWinOcclusion,IntensiveWakeUpThrottling,HighEfficiencyModeAvailable`). It uses
  a **dedicated `--user-data-dir`** on purpose: starting a second `chrome.exe` against an
  already-running profile just forwards the URL to the existing process and **drops the
  switches**, which is the usual reason "I passed the flags and nothing changed".

  What no flag fixes: a genuinely **background tab** (another tab selected in the same window)
  gets no `requestAnimationFrame` at all, because the compositor produces no frames for it.
  Keep the viewer the active tab of its window — the window may sit behind the IDE. MCP
  screenshots survive even that, since `captureFrameCanvas()` drives `renderFrameForCapture()`
  synchronously; only camera *animations* need live frames.

- **A call hangs and a modal dialog is sitting on screen.** The editor's dialogs
  (`draft-conflict`, `shelved-drafts`, `draft-recovery`, `unsaved`, `cad-missing`, …) settle on
  a *click*. During an MCP call nobody clicks, so the call blocks until its timeout and the
  dialog stays up, poisoning every call after it. The bridge now installs a policy
  (`rv-mcp-dialog-policy.ts`) around every call: safe dialogs are answered automatically,
  ambiguous ones are still left to the human, and whatever was answered comes back in the tool
  result as `autoAnsweredDialogs` — including the detail of informational ones, so a
  "CAD geometry missing" report is never silently swallowed. The defaults never destroy work:
  `draft-conflict` → `open-requested` (keeps the draft), `draft-recovery` → `restore`,
  `unsaved` → `cancel`.

- **Chrome's "Reload site? Changes you made may not be saved" on every TS edit (dev).** That is
  Vite doing a full reload for a module it cannot hot-patch, hitting the page's `beforeunload`
  guard. It is a **native browser dialog**: nothing in the page and no MCP tool can dismiss it,
  so an agent session stops dead behind it. `main.ts` now listens for Vite's
  `vite:beforeFullReload` and stands the guard down for exactly that reload, so the page
  reloads by itself. Dev-only (`import.meta.hot` does not exist in a production build), and
  nothing is at risk because the draft autosave carries the document across the reload — the
  same reason the guard asks `hasUnpersistedWork()` rather than `hasUnsavedWork()`.

- **The agent is in the wrong project.** Use `web_project_list` / `web_project_open` — the
  switch happens **in place**, so the bridge connection, the MCP session and the editor
  document all survive it. Do **not** navigate to `?project=<slug>`: that reloads into a new
  tab which immediately takes bridge ownership (`_active` is last-writer-wins and force-closes
  the previous socket), costing the editor document and several seconds of boot during which
  every call fails. `web_project_open` refuses when there is unsaved work unless `force=true`,
  because the underlying switch would otherwise raise a modal dialog no agent can answer.

## Ask AI in the global search

The global search bar (bottom center) can send the typed text as a free-text
question to the machine documentation through CONNECT's RAG diagnosis endpoint
(`POST {diagnoseUrl}/diagnose`, the same backend the `WebDiagnostics` error
diagnosis uses — see [`doc-webviewer.md`](doc-webviewer.md)).

- **Capability-gated.** An **Ask AI** button appears at the end of the expanded
  search bar only when `diagnostics.diagnoseUrl` is configured in `settings.json`
  AND the CONNECT gateway reports `diagnose: true` on `/health` at startup.
  Without both, the search bar is a pure node search and knows nothing about
  CONNECT. The probe runs once at init — a CONNECT started after realvirtual
  needs a page reload. With the button present, the expanded bar widens to take
  full typed questions.
- **Explicit trigger only.** The AI request runs only on an **Ask AI** click
  (disabled while the field is empty) — never on-type (CONNECT rate-limits
  `/diagnose`). The instant node search stays synchronous and is never blocked
  by the AI request.
- **Answer dialog.** The answer opens as an *AI Assistant* dialog: a live
  elapsed-seconds indicator while the documentation is searched (a RAG + LLM
  answer typically takes 25–35 s), then typewriter-revealed **Answer** /
  **Recommendation** sections plus cited PDF sources — each source is a page
  deep-link into the embedded PDF viewer (relative source URLs are resolved
  against the CONNECT base URL). On transient errors (rate limit, timeout,
  network) a *Try again* button re-runs the question — successful answers are
  deterministic backend-side, so there is no general re-run. Closing the
  dialog aborts an in-flight request. The reveal respects
  `prefers-reduced-motion`, and the content region announces itself to screen
  readers (`role="status"`, `aria-live="polite"`).
- **Keyboard route.** `/` (or Ctrl/Cmd+K) expands and focuses the global
  search from anywhere — except while typing in another input field.

### Model context in the answer

Beyond the plain documentation search, an Ask AI request carries what only the
digital twin knows about the current node, so answers combine the manual with the
live machine state:

- **Selection context.** With a node selected, the request adds its `nodePath`,
  `docHints` (the exact PDFs linked to the node via `_rvPdfLinks`, node + parents)
  and a compact, size-capped `machineContext` block — component type, whitelisted
  rv_extras (e.g. Drive `TargetSpeed`/limits), current values of the node's signals,
  and its active alarms. The backend gives the hinted documents a small retrieval
  boost (never a hard filter) and injects the state block into the prompt as a
  clearly delimited **data** block. A removable context chip in the dialog shows
  the included node; removing it re-runs the question without context. An
  expandable *Context sent* line shows exactly what travelled with the request.
- **Node knowledge.** If an earlier session left a note on the selected node
  (`web_knowledge_set`), it rides along as its own block after the alarm lines —
  line-prefixed and capped at 600 characters, so the manual, the live state and what an
  agent previously worked out all reach the model together. Notes are **not** inherited
  from ancestors and are **not** included for unselected query hits: a root-level note
  would otherwise be reported as knowledge about every node in the scene, and ten hits ×
  600 characters would blow the 2600-character context budget on its own. See *Node
  knowledge (agent memory)* above.
- **Query→part matching (no selection needed).** Even without a selection, the
  docs of the top node search hits for the typed question are added as `docHints`,
  so a question that names a part still gets a part-specific answer.
- **Affected parts.** Each answer lists the scene nodes whose linked documentation
  matches the cited sources as clickable **Affected parts** chips — clicking one
  selects and focuses the part in 3D (the dialog stays open).
- **Privacy switch.** Sending the live state to the (cloud) chat model can be
  disabled operator-side with `Diagnosis:MachineContext=false` in CONNECT; the
  documentation search still works, only the state block is suppressed.

## Related documentation

- [`webviewer.mcp.md`](webviewer.mcp.md) — full `web_*` tool reference.
- [`doc-webviewer.md`](doc-webviewer.md) — overall architecture and configuration.
- [`doc-layout-planner.md`](doc-layout-planner.md) — the Layout Planner the authoring tools drive.
- [`doc-web-debugging.md`](doc-web-debugging.md) — debugging tools and workflow.
