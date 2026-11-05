# AI Integration & the MCP Bridge

> **Applies to:** Community browser inspection/control through CONNECT or the Node fallback. Tools for commercial authoring or the virtual PLC require those modules; DES core tools are Community; experiment-manager tools become commercial (ADR-054). CONNECT and Unity are separate installations.
> **Reference baseline:** 6.3.43, documentation reviewed 2026-09-16.
> See the [edition comparison](README.md#community-edition-vs-commercial) and [getting started](doc-getting-started.md).

realvirtual WEB exposes its running 3D scene to AI assistants (Claude Code, Claude
Desktop) through an **MCP bridge**. Once connected, the assistant can inspect
and control the live browser scene — read drives, signals, sensors and transport
state, drive the simulation, capture screenshots, and build layouts in the Layout
Planner — using a set of `web_*` tools.

## Tools, commands and the read door (plan-2007)

Tools cover session, navigation, meta operations and images. Every model or simulation
change goes through a registry command via `web_execute("<id>", args)` or `web_batch`:
the same rule check and, where supported, undo step and macro line as the UI.
Domain queries are read-only commands via `web_query("<id>", args)`;
`web_commands(query)` lists ids, argument schemas and the appropriate `door`.

Long commands with `timeoutMs > 120000` (120 s), including `editor.importCad` and
`mechanism.trajectoryRun`, automatically return a `jobId`. Follow it with
`web_macro_status` or request cancellation with `web_macro_cancel`; imports are
not cancellable and return `kind:"not-cancellable"` while continuing to completion.
For one release, an old tool name returns
`{"error":"MOVED", movedTo, use, example, removedAfter:"6.8.0"}` with its replacement;
it is absent from `tools/list`.

CONNECT classifies `web_execute` and `web_batch` by the strictest named command in
`McpCommandClassAllowlist.cs`; unparsable calls are `destructive`, and `web_query`
is `read`. `web_macro_replay` uses the strictest class of all macro-enabled commands.
An outdated CONNECT without `capabilities.commandClasses` refuses moved sim/signal/file
commands (and other moved targets stricter than edit) with `kind:'gateway-outdated'`.

**realvirtual CONNECT is the default transport.** It hosts the MCP endpoint itself, so
nothing extra has to be installed. The local **Node bridge** remains fully supported as the
documented emergency fallback — it is not deprecated and not scheduled for removal here.

This document covers the architecture, setup, the client matrix, the fallback route, the
in-app **AI Bridge** status panel, the AI activity indicator, the `web_screenshot` cropping
options, and troubleshooting. For the exhaustive per-tool reference see
[`webviewer.mcp.md`](webviewer.mcp.md).

## Choosing viewer or CONNECT configuration tools

Choose by the object being changed:

| Coupling | Task | Tools |
|---|---|---|
| K1: model signal ↔ interface signal | Configure a controller signal under the exact model signal name | CONNECT `interface_signal_list`, then `interface_signals_apply` |
| K2: interface ↔ interface | Mirror a source into MQTT/SHM, or map one signal to another | CONNECT `bridge_list`, then `bridges_apply` |
| K3: component slot ↔ signal | Assign a signal to a model component's slot | Viewer `web_query("signal.bindingsList")`, `web_query("signal.sourcesList")`, then `web_execute` with `signal.bind` |

Use `web_*` for inspecting or editing the viewer, scene, components and slot bindings. The CONNECT
configuration tools run against the gateway and do not require a browser scene. They do not edit
model slots. Read first: `interface_signal_list` returns the address schema and containers, and both
read tools return `revision` and `instance`. Pass those as `expectedRevision` and `expectedInstance`
to the corresponding apply tool. Each apply is one atomic batch of at most 500 operations; after a
`revision-conflict`, read again and review the changes before retrying.

`interface_signals_apply` accepts `signal.upsert`, `signal.remove` and `container.replace` for one
interface. `bridges_apply` accepts `mirror.upsert/remove` and `mapping.upsert/remove`. Both require
CONNECT's **MCP server → Allow write access** switch (`McpAllowWrite`). The read tools remain
available with that switch off. This configuration permission is separate from an interface's
**Allow web to PLC** switch, which controls runtime writes to the controller.

**Address ownership (plan-589).** Keep the exact symbolic name in `name`; store the controller
address only in CONNECT's `protocolAddress`. Match discovery `symbolKey` exactly and copy its
`protocolAddress`, not its display label. Comments describe meaning; do not put addresses into
comments, model metadata or GLB fields. Use `addressMode: "fillEmpty"` to preserve existing
addresses. Case and quote variants are suggestions to review, never automatic matches.

The viewer's **Fill addresses from controller** and **Import address table** dialogs provide
previews. There are no `signal.fillAddresses` or `signal.importAddressTable` commands; automation
uses the CONNECT configuration tools with the corresponding signal operations.

## Tool ownership: which server serves what

Exactly one MCP host owns each tool family. There is no overlap:

| Host | Owns | Tool prefix |
|------|------|-------------|
| **realvirtual CONNECT** (C#, `http://localhost:5100/mcp`) | the `web_*` browser tools **and** native gateway tools: runtime signals/status plus `interface_signal_list`, `interface_signals_apply`, `bridge_list`, `bridges_apply` | `mcp__realvirtual-CONNECT__…` |
| **Unity MCP server** (Python, `unity_mcp_server.py`) | the 80+ Unity Editor tools (scene, prefabs, play mode, recompile) | `mcp__UnityMCP__…` |

CONNECT is the default transport for `web_*`: it is same-origin with the delivered HMI,
needs neither Node nor Vite on the customer machine, and is the only path that works for a
static WebViewer delivery.

The `/webviewer` socket is **CONNECT infrastructure**, separate from **AI control**. When
CONNECT serves the page (marker cookie or same-origin `/health` with CONNECT's signature,
including the dev proxy), the channel stays connected with AI on or off. SolidCraft sync,
server log relay and owner/standby status use it without AI. The switch in *Settings ▸ AI*
only permits AI agents / MCP clients to control this tab. CONNECT publishes browser tools only
for an AI-on owner and also enforces the switch on calls, including local MCP calls.

The Python server still carries a historic `web_*` proxy on port 18712. It is **not** the
intended path, and since MCP package 1.1.2 it no longer starts by default: it needs the opt-in
`--webviewer` (the old `--no-webviewer` is still accepted and now does nothing). It was switched
off because it answered `web_*` **without a token and without a license check** — the one way
around the community registration CONNECT requires for the very same tools. Always call `web_*`
through CONNECT.

**Registration applies to CONNECT only.** Neither the Node bridge below nor the Python proxy
verifies a license; both are loopback developer paths. On CONNECT an unregistered gateway answers
the MCP handshake and lists its native tools — so the client can say why — and then refuses every
`tools/call` with `LICENSE_REQUIRED` plus the URL to register on, with `web_*` filtered out of the
list entirely. Registering takes effect on the open session.

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
- The browser **owns the tools**: on connect it sends `discover` with `ai` and the `web_*`
  tool schemas (generated from `@McpTool` decorators in `src/plugins/mcp-bridge-plugin.ts`)
  plus the `webviewer.mcp.md` instructions. With AI off it announces `tools: []`, `ai: false`;
  `viewer_status` also carries `ai`. CONNECT publishes only the AI-on owner's catalog.
  The browser refuses every non-internal call with `AI_DISABLED:`, including calls by name,
  aliases and `web_ping`.

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
| 18712 | Python bridge (Unity MCP server)| historic `web_*` proxy — **do not use**, see *Tool ownership*; off unless started with `--webviewer`, and unlicensed either way |

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

3. **Restart the client**, then switch on **AI control** in the WebViewer (*Settings ▸ AI*)
   and accept the one-time consent dialog. Leave **Port** at its CONNECT default (5100).
   A dev page served through CONNECT's proxy
   talks to the CONNECT that serves it (same-origin `/health` probe) — a worktree CONNECT on
   another port included, no `?mcpPort=` needed. A bare Vite page (no CONNECT behind its
   origin) targets 5100; `?mcpPort=<port>` pins any port explicitly. On a **hosted** page (the demo on `web.realvirtual.io`, a customer site) the
   bridge connects to `ws://localhost:5100/webviewer` by itself; CONNECT asks once in its tray
   whether that site may — see *Hosted page → local CONNECT (pairing)* below.

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
  - **Cross-origin** (Vite dev on 5173, a pinned port, a hosted page, an `AllowedOrigins`
    host) keeps `?apikey=`: a `SameSite=Strict` cookie is not sent cross-site, so it is the only proof a
    browser can present there.
  - If a cookie-only handshake fails — an expired cookie, most likely — the client falls back
    to `?apikey=` for the rest of the session rather than reconnect-looping on a 401.

### What the guardrails do and do not cover

Stated plainly, because a half-described boundary is worse than a named one:

- **The write gate** (`McpAllowWrite`, plus the per-tool `readOnlyHint`) prevents *accidental*
  mutation by an agent. It does not defend against a manipulated browser — the browser decides
  what a tool actually does, and could offer mutating behaviour under a read-only name.
- **A timeout is `running: true`, not an error (plan-626).** When a call exceeds its
  `timeoutMs`, CONNECT answers `{running: true, callId, message: "Still running. Do not resend.
  Call web_call_pending {callId}."}` and keeps following the call for the asking MCP session.
  `web_call_pending {callId}` reports `running`, `done` (with the result), `error`, `expired` or
  `cancelled`; `{callId, cancel: true}` stops following it — the browser may still execute it, and
  a result arriving afterwards only lands in the audit. CONNECT keeps at most 64 followed calls and
  32 MiB of results, each for 5 minutes; a session that ends or a tab change expires them. There is
  still **no retry and no idempotency key**: resending a running writing call can execute it twice.
  The Node bridge fallback has no `web_call_pending` and still answers a timeout with
  `outcome: unknown`.
- **Tool classes and the call policy (plan-626).** Every tool has a class — `read`, `edit`, `sim`,
  `signal`, `save`, `destructive` or `file` — derived in `src/plugins/mcp-bridge/rv-mcp-tool-class.ts`
  and generated into CONNECT's `McpToolClassAllowlist.cs` (`npm run gen:mcp-docs`). The class is
  never announced by the browser. CONNECT hands it to the session's call policy before it routes
  the call (native and `web_*` alike); the default policy allows everything and leaves the gates
  above unchanged, a chat session can register one that denies or asks.
- **DNS rebinding against `/webviewer` remains possible without a configured `ApiKey`.** The
  same-origin rule cannot close it, because CONNECT is meant to serve remote HMIs under arbitrary
  host names — during a rebind the attacker's Origin and Host agree. The effective countermeasure
  is an `ApiKey` or a narrow `AllowedOrigins` list, not the gate.
- **`/ws` has no Origin gate** (only `/mcp` and `/webviewer` do). That is the signal channel of
  every HMI and was left unchanged deliberately.

CONNECT also validates the browser `Origin` on `/mcp` and `/webviewer`. Loopback origins
(including the Vite dev server on 5173), pages served by CONNECT itself and origins listed in
`AllowedOrigins` always pass. `/mcp` refuses every other origin with 403. On `/webviewer` a
foreign **https** origin is not refused but **paired** — see the next section. Behind a reverse
proxy, `X-Forwarded-For` is honoured only when the proxy address is listed in `TrustedProxies`
(empty by default, and absent from the shipped `appsettings.json` — set it explicitly).

### Hosted page → local CONNECT (pairing)

A page that CONNECT did not serve — the demo on `https://web.realvirtual.io`, a customer's own
site — has no `/webviewer` of its own. When AI control or an explicit connection action needs
the channel, the bridge connects to CONNECT on **this** machine instead:

- **Target.** Not served by CONNECT (no `rv_connect_origin` marker cookie, and the page's own
  `/health` does not answer like CONNECT), not a loopback page, not the Vite dev server →
  `ws://localhost:<port>/webviewer`, port from the panel (default 5100). No URL parameter is
  needed; the **Target** row in the panel shows the exact address. The `/health` check is
  same-origin and runs once even with AI off, without a Local-Network-Access prompt. A hosted
  page, bare Vite server or foreign loopback port does not open a channel automatically: it
  needs AI control on or `acquireChannel(holder)` from a user action such as SolidCraft Connect.
  `releaseChannel(holder)` closes it when neither AI nor another holder needs it.
- **Pairing.** CONNECT does not know the site yet, so it accepts the WebSocket, closes it with
  `4401 pairing-pending` and shows a prompt in its **tray**: the site's origin and what it may
  do (*control the 3D viewer for your AI assistant and send it content*). There is no default
  button, Enter/Esc do nothing, and after 60 s without an answer the prompt closes. While it is
  open the browser retries every 2 s (for at most 90 s), so **Allow** connects without touching
  the browser.
- **Remembered.** *Allow* and *Deny* are both permanent and both revocable under
  *Tray ▸ MCP server ▸ AI Bridge origins* (✓ allowed, ✗ denied). Removing an allowed origin
  closes its live connection at once. A pairing never restarts PLC/MQTT/FMU interfaces.
- **Limits.** One prompt at a time, at most five per hour, five minutes of cooldown after a
  timeout, and a denied origin is never asked again. Only **https** origins can be paired; an
  http page on another host and an opaque (`null`) origin are config-only. A headless CONNECT
  (no tray, e.g. ctrlX) cannot ask — add the origin to `AllowedOrigins` there, which still works
  everywhere and skips the prompt.
- **Who wins.** The bridge serves one browser. A paired page that connects takes over from
  another tab, exactly like a second local tab does (the prompt says so).
- **Browsers.** Chrome and Edge ask once for *local network access*; allow it. Firefox works
  likewise. Safari blocks `ws://localhost` from an https page — open the viewer from CONNECT
  itself (`http://localhost:5100`) instead.

The panel names the cause whenever the bridge does not connect. Pairing answers arrive as
WebSocket close codes; a bare `1006` (the browser shows nothing more for a refused handshake) is
followed by one `/health` probe against the gateway the bridge targets:

| Panel status | Source | What to do |
|--------------|--------|------------|
| Waiting for approval | close `4401` | Confirm in the CONNECT tray icon. |
| Denied by CONNECT | close `4403` | Remove the origin under *Tray ▸ MCP server ▸ AI Bridge origins*. |
| Approval timed out | close `4429` | Try again in a few minutes. |
| Pairing not available | close `4405` | Headless CONNECT: add the origin to `AllowedOrigins`. |
| Origin not allowed | close `4406` | Use https, or open the viewer via `http://localhost:5100`. |
| CONNECT is busy | close `4430` | Too many approval requests — try again later. |
| Blocked by the browser | WebSocket constructor threw | Use Chrome/Edge, or open `http://localhost:5100`. |
| CONNECT not reachable | `/health` failed | Start CONNECT; allow local network access; a restrictive `AllowedOrigins` (CORS) or the site's CSP (`connect-src`) can block the probe too. |
| CONNECT is starting | `/health` → `starting` | Connects automatically. |
| MCP server off | `/health` → `bridgeEnabled: false` | *Tray ▸ MCP server ▸ Enabled*, then restart CONNECT. |
| CONNECT too old | `/health` without `bridgeEnabled` | Update CONNECT, or add the origin to `AllowedOrigins`. |
| Connection refused | `/health` ok, bridge on | API key, licence, the browser's local-network permission, Safari. |

The bridge counts as **Connected** only once CONNECT (or the Node bridge) has sent its first
`status` frame — an open socket alone is not enough, because a pairing close follows an open.

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

3. **Point the browser at it** — set **Port** to 18714 (Node · Desktop) or 18715 (Node · Code)
   in *Settings ▸ AI*, or open realvirtual with `?mcpPort=18714`; switch on **AI control**.

> `claude mcp add|remove --scope project` rewrites `.mcp.json` from `mcpServers` alone and
> silently drops `_disabledMcpServers` and `_ownership`. Restore both by hand after using it.

## The AI Bridge panel

Open it from the activity bar, or *Settings ▸ AI*. The panel separates the **CONNECT channel**
from **AI control**. The channel section is outside the consent gate, so its state, target,
failure cause and **Retry Now** remain visible without accepting AI access.

The activity-bar entry is always offered unless removed through the feature matrix. On mobile,
use *Settings ▸ AI*. Before **AI control** is switched on, a one-time consent dialog explains
access to the scene, PLC signals (including writes) and simulation. Consent is stored per device
as a scope version under `rv-ai-bridge-consent`; widening the scope asks again. Opening or using
the CONNECT channel does not grant consent.

The AI prompt panel (private builds, plan-2041) stores two per-device keys
(`rv-storage-keys.ts`): `rv-ai-prompt-backend` (preferred local CLI backend) and
`rv-ai-prompt-sessions` (workspace-partitioned resume metadata of prompt sessions).

The switch keeps the existing localStorage `rv-ai-bridge` format (`enabled` and port);
`rv-ai-bridge.enabled` now governs AI control only. On an open channel, toggling sends fresh
`discover` and `viewer_status` frames immediately, without reconnecting. A call already running
when AI is switched off ends normally. Only the UI switch enables AI in product code; the
launcher script writes storage directly. SolidCraft Connect no longer switches AI on.

![The AI Bridge panel: channel status, AI control and the live tool list](docs/images/screenshot-ai-bridge-panel.png)

### Status rows

![Full-chain status: Browser to Bridge, the attached AI client, last activity, and bridge identity](docs/images/screenshot-ai-bridge-status.png)

| Row | Meaning |
|-----|---------|
| **CONNECT channel** | *Connected*, *Connecting*, *Not connected*, or reconnect/failure details with a hint and **Retry Now**; independent of AI consent and the AI switch. |
| **Why** | *served by CONNECT*, *opened for AI control*, or *opened for a connection (e.g. SolidCraft)*. |
| **Target** | The WebSocket address the bridge connects to (never with the key), e.g. `ws://localhost:5100/webviewer`. |
| **AI control** | Whether AI agents / MCP clients may control this tab. The AI section sits below the channel section. |
| **This tab** | Owner/standby status; a new connection stays pending until CONNECT has its first announcement. |
| **AI client** | The MCP host attached to the bridge, e.g. `claude-code`. This is the real proof an assistant is connected — a connected WebSocket alone does not mean a live AI is present. |
| **Last AI activity** | Time since the assistant's last request (a tool call or tool list), e.g. *just now* / *2s ago*. *idle* when nothing has happened yet. |
| **Tools** | Number of announced `web_*` tools, or **0 (AI off)**. |
| **Port** | The port the browser is connected to. |
| **Bridge** | Bridge process identity: `pid · :port · uptime`. Disambiguates duplicate bridges and shows how long it has been running. |

### Controls

- **AI control** — allow AI agents / MCP clients to control the tab, after consent. It does
  not disable a channel needed by CONNECT or a connection such as SolidCraft.
- **Port** — CONNECT defaults to 5100; the Node fallbacks use 18714 (Desktop) / 18715 (Code).
  Setting CONNECT's default port restores same-origin resolution, so an HMI served by a remote
  CONNECT keeps using its own origin instead of `localhost`.
- **Show AI clicks** — on by default, per device (`rv-mcp-ai-clicks`): animate AI button clicks; turn off for fast agent runs. Also available in the AI prompt toolbar.
- **Follow agent** — on by default, per device (`rv-mcp-follow-agent`): the camera flies to
  what the assistant changes while you are not using the view. See *Follow agent* below.
- **Pause / Resume** — stop or resume accepting browser connections.
- **Shutdown** — ask the bridge process to exit (it can only be relaunched by the AI
  host, not from the browser).
- **Registered Tools** — the live list of `web_*` tools the assistant can call.
- **Server Log** — log lines streamed from the bridge (bind, connect, discover, …).

### AI prompt panel

When CONNECT reports at least one local AI backend as available, the **AI Bridge** entry in the
activity bar opens a floating **AI** panel. Clicking the entry again closes the panel; the entry
stays highlighted while either AI control is connected or the panel is open. Enable
*Details › MCP server › Allow prompt window* in the CONNECT tray first. CONNECT asks for
confirmation because the panel runs the selected signed-in CLI with the permissions and
configuration of that local installation. If the prompt service is unavailable, the entry keeps
its normal route to *Settings › AI*. The gear in the panel title bar opens that settings page.

The backend selector lists only available installations: **Claude Code**, **Codex**, or both.
Changing backend starts a new session. **New session**, `/clear`, and `/new` also clear the current
session locally; any other slash command, such as `/weblayout`, is passed unchanged to the selected
CLI. The **Recent** menu lists up to 20 sessions from the current CONNECT workspace. Choosing one
resumes it and shows a `Continuing session from <time> — <title>` notice; the old transcript is not
reconstructed.

The selection chip above the input follows the live Viewer selection (`◎ Cell/Cylinder` or
`◎ 3 selected`). Its **×** omits that selection from the next prompt only. Sent user entries retain
their selection snapshot even if the Viewer selection changes later. Tool-result images appear as
thumbnails in their tool row; click a thumbnail to open the full image in a dialog.

The global search dropdown adds **Ask AI agent: "<query>"** above node results whenever the prompt
backend is available, including when the query has no node matches. It opens the panel and submits
the query. The existing **Ask AI** documentation search remains a separate action.

A run can be started or cancelled through the command registry as well as through the visible controls:

```text
web_execute("ai.prompt", {"prompt":"Inspect the active document and kinematize the selected part."})
web_execute("ai.cancel", {})
```

Tutorial storyboards can use `[data-rv-ai="panel"]`, `[data-rv-ai="input"]`,
`[data-rv-ai="send"]`, `[data-rv-ai="cancel"]`, `[data-rv-ai="selection"]`,
`[data-rv-ai="backend"]` and `[data-rv-ai="settings"]`. The panel exposes its run state as
`data-rv-ai-state="idle|running|error"`; the recording target `ai-prompt` provides the keys
`input`, `send`, `cancel`, `selection`, `backend` and `settings` for pointer actions.

## AI activity indicator

The activity-bar entry is titled **AI control — off** or **AI control — on (N tools)**.
Its icon uses the **accent color** only when the channel is connected **and** AI control is on.
The AI activity overlay and agent-eye badge are also shown only with AI control on.

While AI control is on and the assistant performs an action, a pill in the accent color appears next to
the AI Bridge button (over the 3D scene) showing the current operation, e.g.
`AI · Drive list`. It auto-clears a few seconds after the last action.

![The AI activity pill in the accent color, shown while the assistant is working](docs/images/screenshot-ai-activity-overlay.png)

The accent color follows the theme, so custom branding recolors it automatically.

**Agent cursor (plan-626).** Every *writing* call marks what it touches — the nodes named in its
arguments and the ones its result creates (the placement `layout.place` just made, a node
`editor.createEmpty` added) — in the hover colour, steady, for the call and 1.5 s after it. Tools
outside the editor feedback table also ask the follow-agent policy whether to move the camera.
The last 50 writing calls (tool, class, targets, ok) stay in `agent-cursor-store.ts` for the chat
panel.

## Tools overview

The `web_*` tools fall into these groups (full reference in
[`webviewer.mcp.md`](webviewer.mcp.md)):

Dotted names (`drive.jog`, `editor.setField`, `layout.place`, …) are registry commands, run with
`web_execute` / `web_batch`. Their command-bound alias tools (`web_drive_jog`, …) still answer
`tools/call` but are not in tools/list since 2026-10-21 (plan-641); emergency switch: viewer URL
`?mcpAliases=1` or `localStorage['rv-mcp-list-aliases']='1'`, Node bridge `RV_MCP_LIST_ALIASES=1`.

- **Inspect** — `web_status`, `web_query("drive.list", {})`, `web_signal_list`, `web_query("sensor.list", {})`,
  `web_query("transport.status", {})`, `web_query("logic.flow", {})`, `web_node_find`, `web_node_tree`,
  `web_component_get`, `web_component_get_all`, `web_component_list`, `web_logs`.
- **Control** — `signal.setBool`, `signal.setFloat`, `drive.jog`,
  `drive.stop`, `sim.speedOverride`, `sim.playPause`, `sim.reset`,
  `web_execute("view.sourceMarkers", {visible:true})`.
- **Screenshot** — `web_screenshot`, `web_screenshot_burst`,
  `web_screenshot_analyze` (see below).
- **Authoring** (Layout Planner) — `web_execute("workspace.setMode", {mode:"planner"})`, `web_query("library.catalogList", {})`,
  `web_query("library.catalogDescribe", {catalogId})`, `layout.place`, `layout.move`, `layout.remove`,
  `web_query("layout.list", {})`, `web_query("layout.snapList", {id})`, `web_query("layout.snapSuggest", {targetId})`,
  `layout.snapAttach`, `web_execute("component.setFields", {path, type, props})`, `web_execute("document.create", {name})`, `web_document_save`,
  `web_query("layout.export", {})`, `web_document_list`, `web_document_open`.
  *(2026-08-19 rework: asset = document = model — one concept, one `web_document_*`
  family. The old `web_scene_*`, `web_model_*` and `web_library_*` names are retired;
  the parts catalogue is `web_catalog_*`, and the planner-snapshot export is
  `web_layout_export` (now `layout.export` via `web_query`).)*
- **Signal binding** (plan-425) — `web_query("signal.bindingsList", {})`, `web_query("signal.sourcesList", {})`
  (read-only) and `signal.bind`, `signal.unbind` (write). See *Autobinding a PLC*
  below.
- **Node knowledge** (plan-394) — `web_query("knowledge.get", {path})`, `web_query("knowledge.list", {})` (read-only) and
  `knowledge.set` (write): one overwritable Markdown note per scene node, stored in the
  GLB, so what one session works out is available to the next. See *Node knowledge (agent
  memory)* below.
- **Help** — `web_help(topic)` serves the deep workflow guides, including `scripting` for component scripts,
  (`src/plugins/mcp-bridge/help/*.md`) on demand; the always-loaded server
  instructions stay a compact map.
- **Orient** (plan-707) — `web_describe` answers "where am I, what is blocked, what next"
  in one read-only call. See *Orientation and effect verification* below.
- **Link out** (plan-437) — `web_query("link.compose", {})` is the counterpart to every tool that OPENS
  something: it hands back a URL. Called with no arguments it snapshots the current state
  (document or model, the *live* active mode, the model option) into a link that reproduces
  it; called with `model`/`glb`/`doc`/`scene`/`mode`/`option` it validates each against the
  live catalogues and composes a canonical URL, plus an optional `base` override. Unknown
  values are returned in `warnings[]` and still set, so a link is never withheld over a
  catalogue miss. It is read-only, mints no share (an existing `s:<id>` is passed through,
  never created), and composes from a strict allowlist — the current address bar is never
  copied, so `devkey`/`sharetoken` cannot leak into a link that gets mailed or bookmarked.
- **Perceive & navigate** (all modes) — `web_node_bounds`,
  `web_execute("view.isolate", {paths})`, `web_camera_get`,
  `web_camera_set`, `web_camera_focus`, `web_camera_orbit`, `web_camera_fly`,
  `web_view_sweep`, `web_view_ortho`, `web_select`, `web_selection_get`, `web_select_similar`. Since plan-740
  these drive the AGENT's own camera body, not the viewport (see *The agent eye* below).

## The agent eye — camera moves, images and what the human sees

Until plan-740 the agent and the operator shared one camera and one frame buffer, and all
three complaints that followed from it were the same bug: the moment a human navigated, the
agent's picture no longer matched its last pose; the image size was the canvas size and shrank
with every open UI panel; and there was no way to ask for more resolution than the window
happened to have.

The agent now has a **camera body of its own** — a pose (position, target, fov, aspect,
projection) that no user input ever changes, persisted per tab across a reload, drawn in the
scene as a small wireframe frustum cone labelled "AI" (Settings ▸ Visual ▸ *Show AI eye*).

**Camera moves are instant. There is nothing to wait for.** Every `web_camera_*` verb sets the
agent pose and returns; nothing is animated, no `sleep` runs, the orbit controls are never
frozen. `durationMs` survives on `web_camera_set` / `web_camera_fly` as an ignored parameter so
callers written against the old schema still validate. The old refusal `{ error, blockedBy }`
while FPV, camera-follow or XR owned the camera is **gone** from these tools — those own the
operator's viewport, which the agent no longer touches. The guard moved to exactly one place:
**attaching** the human viewport to the agent (below) is still refused in those states.

- **`web_camera_fly`** moves RELATIVE to the current pose — metres forward/right/up, degrees
  of yaw/pitch — which is what travelling through a long line needs; `web_camera_orbit`
  circles a fixed point and cannot do it. `ground=true` walks at eye height above the nearest
  surface below, probed through the ordinary pick path, so modelled floors and platforms count,
  not just the viewer's grid fixture. There is deliberately no wall collision.
- **`web_camera_view`** (plan-713 F9) moves to a NAMED view — `iso | top | front | back |
  left | right | home` — with `target` choosing what to frame (`"selection"`, a node path, or
  the whole scene). The framing distance comes from the same canonical fit formula
  `web_camera_focus` uses, evaluated through the agent's own fov/aspect.
- **`web_camera_set`** additionally takes `fov` (5..120°) and `aspect` (0.2..5): the agent's
  LENS is its own, so it can frame a 16:9 overview and a square detail without touching the
  window. `web_camera_projection` switches it between perspective and orthographic; in ortho
  the sidecar reports `orthoHalfHeight` in metres.

**Attach — how a human rides along.** Double-clicking the cone attaches the viewport to the
agent pose: it follows with easing and the cone hides. The first drag detaches it again, and so
does any bookmark, preset, focus double-click, FPV entry or XR session. It is the operator's
gesture, never the agent's, and it changes nothing about how the tools behave.

**What the human sees.** `web_screenshot` is the one deliberate exception in the whole surface:
it reads the VISIBLE drawing buffer, so it answers "what is on the operator's screen right now",
at their canvas size, with their panels. Everything else — `web_eye`,
`web_view_sweep`, `web_view_ortho`, `web_screenshot_burst/_annotated/_analyze`, `web_editor_verify_drive` —
renders offscreen through the agent camera.

**Image tiers.** `web_eye(size)` takes the long edge, 256..2048 (default 1024). Useful rungs:
**512** for a quick look, **1024** for work, **1568** for detail (the model's own image cap),
**2048** when the agent intends to crop. The whole envelope — every channel plus the sidecar —
is budgeted together, so channels stay pixel-aligned when it has to scale.

**WebGPU, net effect.** Navigation works under both renderers; capture does not. Under WebGPU
`web_eye` and — new in Phase 3 — `web_screenshot_burst`, `web_screenshot_analyze`
and `web_editor_verify_drive` answer with a defined error naming Settings ▸ Visual ▸ Renderer.
Before Phase 3 the first two of those returned a *viewport* frame under WebGPU; they no longer
do, which is the intended trade: a refusal an agent can act on beats a picture from a camera it
did not choose.

### Show AI clicks (plan-2210)

Turn off **Show AI clicks** in *Settings ▸ AI* or with the finger icon beside
*New session* in the AI prompt toolbar for fast agent runs. Both controls share
the per-device preference `rv-mcp-ai-clicks` (default on). Agents can call
`view.aiClicks {on:false}` through `web_execute`; omit `on` to toggle. The command
returns `{on}`. Off skips hover/press dwell, the 80 ms panel beat and waiting for
Inspector rows. Selection, Inspector opening and field reveal, panel opening,
Follow agent and result afterglow remain active. A running click finishes normally.

### Follow agent — the viewport follows the agent's EDITS (plan-520)

The agent eye keeps the human viewport out of the agent's way. *Follow agent* is the one
deliberate bridge in the other direction, and it is limited to **writes**: when a tool changes a
node, the operator's camera flies to that node so the change happens in view.

**Which tools.** The node-addressing write tools of the MCP feedback table
(`EDITOR_FEEDBACK` in `rv-mcp-editor-feedback.ts`, column `follow`): `web_execute("component.setFields", {path, type, props})`,
`editor.setField`, the transform verbs (`transform`, `zero_position`, `rotate90`,
`to_ground`, `pivot`, `reparent`), `add_component` / `remove_component`, the 11
`web_editor_mechanism_*` tools, `assign_material`, and the runtime `drive.jog` /
`drive.stop` (the drive is resolved by name and selected as well). Arg-addressed targets are
followed BEFORE the write (`follow: 'pre'`); targets that only exist or are only known after it —
`create_empty`, `rename`, `create_kinematic`, `assign_to_kinematic`, `kinematize`, `import_glb`,
`import_cad` — follow AFTER it (`'post'`). Never followed: read tools, `web_camera_*` and every
other perception tool (they stay with the agent eye), `editor.delete` (the target is gone),
`editor.setVisible` (it may be hidden), `web_signal_set_*` (a signal is not a place).

**When the camera moves** (`decideFollow`, `rv-mcp-follow-policy.ts`, in this order):

1. Follow agent switched off, or the user used the viewport in the last **3 s** → the old
   behaviour: frame only an offscreen target, at most every 4 s, only for tools that frame.
2. Hidden tab, WebXR session, camera in Follow / Sit-On (including riding the agent eye), or a
   target without geometry → no camera move.
3. Same target as the previous follow verdict → no move (a series of writes does not bounce) — until you use the view again; after that the next write to the same node follows again once you are idle.
4. Less than **1.5 s** after the last follow flight → no move.
5. Target offscreen or behind the camera → fly.
6. Target small (less than 12.5 % of the screen edge) or clearly off-center → fly.
7. Otherwise the target is well visible → stay.

The flight is a 0.7 s ease-in-out `fitToNodes`; with `prefers-reduced-motion: reduce` the camera
jumps instead. In viewer mode or on a narrow screen the camera and the selection follow — no
Inspector is opened.

**The user always wins.** Only real viewport input counts as use: an orbit / pan / pinch / wheel
gesture, a press on the canvas, a key in the viewer's keyboard scope. Clicks and typing in HMI
panels (Inspector, Settings) do not, so you can edit in the Inspector while watching the agent.
Any gesture cancels a running follow flight at once — and only that flight: a bookmark or focus
flight is not affected (the flight carries the camera-animation tag `follow-agent`). In a shared
multiuser view the follow flight is part of the host's camera and followers see it too.

### Agent Eye Monitor — the pictures, not just the camera (plan-481)

The cone above shows the agent's **body**. The **Agent Eye Monitor** shows its **pictures**: a
filmstrip of the last 12 captures, reachable from a small badge beside the AI button in the
activity bar and displayed in a floating "Agent Eye" panel.

The strip is tapped at the two encoders every image answer passes through
(`canvasToRvImage` / `canvasesToRvImages` in `plugins/mcp-bridge/rv-frame-capture.ts`), so it
costs **no extra render pass and no second encode** — it shows the very bytes the encoder
produced, idmask channel and burnt-in Set-of-Mark numbers included. A new tool does not have to
opt in; it only has to pass its own name, and one that forgets is labelled `unknown` rather than
breaking.

- **One tool call = one cell**, however many channels it carried. A five-channel `web_eye`
  occupies one cell with a channel switch behind it, not five cells.
- **The buffer is doubly capped**: 12 captures *and* 12 MB of decoded blob bytes, whichever
  gives first. Nothing is persisted — no `localStorage`, no project write — and everything is
  released on clear and on viewer teardown.
- **A new capture opens the panel** if it was closed. It never takes focus, and a panel you
  closed stays closed until the next capture.

What it deliberately does **not** claim:

- **Not a live image.** It is a history of finished captures, not a viewfinder on the agent
  camera. There is no continuous render of the agent pose.
- **Not a delivery receipt.** The label reads *"produced for the agent"*, because after the
  encode the bridge can still skip the send (closed socket) or an outer envelope-budget failure
  can replace the frame. Proving receipt would mean coupling to `_sendResult` and is out of
  scope.
- **Failures leave no trace.** An error envelope — "renderer not ready", "image budget
  exceeded" — produces no cell. A `saveError` does not suppress the cell: the project write
  failed, the image did not.

Edge behaviour worth knowing: under **WebGPU** the offscreen tools refuse (see above), so only
`web_screenshot` keeps feeding the strip — switching renderer does not erase what is already
there. A **model switch** keeps the history; each cell carries its own timestamp. In a
**multiuser** session the monitor is strictly local — you see your own tab's captures and
nobody else's. The **embed viewer** (`rv-embed-viewer.ts`) has neither MCP bridge nor React HMI,
so the monitor is simply absent there, exactly like the cone.

**Timeouts.** CONNECT and the Node bridge both default to a 15 s call timeout. `web_view_sweep`
keeps `timeoutMs: 120_000` and `web_eye` declares `60_000` — the sweep is six offscreen renders
now rather than six animated flights, so the budget is generous rather than necessary.
`web_camera_fly` and `web_camera_view` keep `30_000`. CONNECT clamps only at 600 s
(`MaxToolTimeoutMs`) and the Node bridge passes the value through unclamped.

**Where the notes arrive.** An image payload carries its metadata as a separate TEXT block
beside the image. For `web_eye` that is the sidecar (`channels[]`, camera, depth range, legend,
`visible[]`); for `web_view_sweep` it is `views`, `center` and `radius`. Angles are burned into
the montage because they are meaningless without the picture; node paths stay in the text
because they would be unreadable and expensive as pixels. Each sweep note carries its
`cameraPosition`, so pulling one cell up in full resolution is a single `web_camera_set`.

**Six orthographic views.** `web_view_ortho(paths, channels, size, labels, clip, groupBy, savePath,
topN)` is the sweep's drawing-office sibling: front, back, left, right, top and bottom of a part,
rendered orthographically through the agent eye into one labelled 3×2 mosaic PER CHANNEL
(`beauty` by default; `idmask` and `xray` on request, every mosaic from the
same six poses; `xray` is the requested subtree alone on a near-black ground, translucent fill plus
crease edges with the depth test off on both, so every internal surface draws and bores, cavities
and buried components are visible through the shell; `xrayColorBy="group"` colours it by the
same grouping the idmask uses and emits the legend with it). `labels` burns Set-of-Mark markers per cell, numbered per view, and the sidecar carries
one note per view with `topNodes` (mark, path, ownerPath, coverage), `background`, `depthRange`
and the camera pose. `clip` (default on) places each camera on the part's bounding-box face, so
the eye's near plane sections the scene there and a part inside an enclosure is seen without its
walls; `clip=false` stands two bounding radii out like the sweep and keeps the occluders. Axis
conventions are the `web_camera_view` presets' (front = +Z, top with −Z up). `timeoutMs: 120_000`,
like the sweep.
- **Measure & analyse** (`McpObserveTools`, all read-only) — `web_measure` (pairwise
  distances, per-axis gaps and AABB separation between parts), `web_node_shape` (PCA
  shape class and the functional rotation axis of a part), `web_scene_query` (read-only
  JavaScript over a frozen plain-data scene snapshot — the escape hatch for questions no
  dedicated tool answers). Captures go through `web_eye` (up to three aligned
  channels — `beauty`, a flat-coloured `idmask` segmentation with white crease edges
  over the identity colours and a Set-of-Mark sidecar, and `xray`),
  never touching the user's viewport or selection.
- **Robot IK** (`McpRobotTools`) — `web_query("ik.robot.list", {})`,
  `web_query("ik.robot.chain", {path})`, `web_query("ik.robot.state", {path})` and
  `web_query("ik.robot.verifyFk", {path})` are the web pendants of Unity's
  `ik_get_chain` / `ik_get_state` / `ik_verify_fk`, all read-only and all answering at
  every solver tier (what the tier cannot do is said in a sentence, never shown as an
  empty result). `ik.robot.verifyFk` is the measuring instrument: it runs forward kinematics over
  the DERIVED JOINT CHAIN — the one the viewer really solves and replays with, not the OPW
  model — and answers `positionErrorMm`, `orientationErrorDeg` and `toolLengthM`, so a TCP
  the bake dropped or a pose expressed in the wrong frame is a number instead of a wrong
  robot. `web_query("ik.robot.rigDiagnose", {path})` and `web_robot_rig_from_library` build a rig: the first derives chain,
  wrist type and OPW parameters from a node tree and reports them without writing (it
  works on a robot that has no `RobotIK` at all — the normal case for an imported robot;
  the shipped library CRX comes rigged since 2026-10-25, with a rig written by this same
  derivation and a demo `IKPath` `Robotpath` you switch on with `StartPath`), the second writes the whole component in one call
  and reads it back off the live scene before reporting `ok`. Every derived OPW value
  carries its provenance and a confidence verdict, and `WristType` is measured rather than
  defaulted. `RobotIK` / `IKPath` / `IKTarget` are deliberately not `authorable`: a rig is
  a transaction of six ordered references and seven measured constants, each wrong on its
  own, so there is no "Add Component ▸ RobotIK" and this family is the way in.
  The second half of the family authors the PROGRAM: `_path_create` puts an `IKPath` on a
  new node **under** the robot (that nesting IS the robot reference — a path node outside
  the robot resolves no axes), `_target_add` / `_target_set` / `_target_remove` /
  `_target_reorder` maintain the ordered waypoints, `web_query("ik.path.inspect", {pathPath})` prints them with the
  index the other tools take, and `_solve_target` lists every reachable joint
  configuration, applies one and drives the robot onto it. Two properties are the point of
  this half. **A pose and its joint angles are written together or not at all:** an
  unreachable pose creates and moves nothing, and with `allowUnreachable` the waypoint is
  stored or moved with an EMPTY `AxisPos` — never with the angles of another pose. The
  gizmo keeps the same rule since plan-773 Phase 4: a drag into an unreachable pose
  persists the transform and EMPTIES the `AxisPos`, so the waypoint is visibly replay-less
  instead of silently carrying the previous pose's angles. Both routes share the two
  writes (`writeLiveAxisPos` / `reportTargetReplayAngles` in `rv-ik-authoring.ts`) —
  `AxisPos` is a raw extras field that no `setField` executor puts back on the live
  instance, so that assignment belongs next to every `AxisPos` write.
  **And unreachability is visible:** the answer carries the reason as a
  sentence plus, where one applies, the matching `robot-ik-*` code, and an angle-less
  waypoint gets the existing `robot-ik-target-no-angles` entry in the Problems panel — the
  six codes of plan-772 are the vocabulary, and no seventh spelling was invented.
  **Joint limits are a hard gate on the selection** (plan-772 Phase 5): the analytic
  solvers are given no limits, so `reachable` only means the geometry closes. A
  configuration whose drive limits refuse it in every 360° representation is therefore
  dropped BEFORE a selection happens, in the gizmo, in the LIN replay and here, and the
  answer says what it dropped (`limitRejectedSolutions`, `limitRejectedAxes`,
  `limitNote`). "Outside the joint limits" is its own refusal sentence, distinct from
  "outside the workspace". The limit of that: it is a rejection, not a search — when EVERY
  reachable configuration violates a limit the pose stays unreachable, even though a
  limit-aware solver might have found an admissible one. Closing that would mean handing
  the limits to the solver (an ABI change in the Rust crate), which is deliberately out of
  scope. These
  seven tools write into the planner's document (node ops in the scene op log) and refuse
  inside the asset editor, which has its own document and its own route.
  All SEVEN writes of the family (`_rig_from_library` included) are **views of `ik.*`
  commands** — `ik.robot.rig`, `ik.path.create`, `ik.target.add` / `.set` / `.remove` /
  `.reorder` / `.solve`, declared in `rv-mcp-robot-tools.ts`. The wire args are the command
  args, so `web_execute(command="ik.target.add", args={…})` and `web_batch` do exactly what
  the tool does; being bound also takes them OUT of `tools/list` (they still answer
  `tools/call`), which is why the robot domain lists six read tools and not thirteen. One
  caveat to know: the commands are `macro: true`, but the macro recorder books lines into
  the macro book of the document open in the editor, and this family works in the planner's document — so a
  path authored over MCP is not recorded yet. Extending the recorder to the planner's document
  is its own piece of work.
- **Asset Editor** — session tools (`web_editor_open` / `web_editor_close` /
  `web_editor_status` / `web_editor_save`) and registry commands, including
  `web_execute("editor.importGlb", {relPath})` / `web_execute("editor.importCad", {relPath})`,
  undo/redo, transform + pivot + structure +
  component + signal + material primitives, the compounds `web_execute("editor.kinematize", {paths, groupName, direction})` /
  `editor.materialize` (one undo step each), and `web_editor_verify_drive`
  (pose-sweep montage with exact restore). Every tool calls the same action functions
  the Quick Edit / Materials panel buttons call, against the op-logged AssetDocument —
  agent edits are undoable and reflected live in the UI.
- **Document lifecycle** (plan-713, unified 2026-08-19) — `web_document_list` is THE one
  list: every GLB document the project owns, with name, path, `section`, size and mtime
  (`withNodeCount=true` adds a node count read from the GLB header alone), plus the
  read-only built-in and published sources. Do not confuse it with `web_query("library.catalogList", {})`,
  which is the placeable planner *catalogue*.
  `web_execute("document.delete", {relPath})`, `web_execute("document.rename", {relPath, newName})`
  and `web_execute("document.move", {relPath, toFolder})` manage saved files.
  Delete is classified as destructive; all three require a writable project and refuse
  the file of the document currently open in the editor. A
  delete moves the bytes to `.trash/`; a rename is copy-then-delete and says so in its
  result. `web_query("editor.projectFiles", {dir, glob})` browses the whole project, and answers
  with the same `projectOpen:false` shape as `web_query("editor.projectInfo", {})` when nothing is open.
  Both save tools (`web_editor_save`, `web_document_save`) report `saveVerb` — `save`,
  `save-into-project` (the write COPIES and changes the document's identity) or `blocked`
  with a reason — the same verb the save card shows.
- **Hierarchical editing** (plan-713 F10) — `web_editor_descend(path)` enters a referenced
  asset as its own document one level deeper (the double-click gesture), and
  `web_editor_back()` leaves it again. The chain is in `web_editor_status` as `depth` plus
  `breadcrumb`. Editor mode only; `web_editor_back` refuses at the root, where
  `web_editor_close` is the right verb.

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
                "reason": "Needs planner mode — call web_execute(\"workspace.setMode\", {mode:\"planner\"})" }],
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
`mechanism.jog` are transient by design.

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
  robot, scene, editor, des, plc — extend the whitelist AND the domain table in
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
`web_measure`, `web_node_shape`, `web_scene_query`, `web_eye`), `McpEditorTools`
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

### Internal bridge tools and control frames (plan-621)

The CONNECT channel carries two generic mechanisms besides the announced `web_*` catalog.
Both live in `McpBridgePlugin`, work with **AI control off**, and know nothing about any
particular feature:

- **Internal tools** (`registerInternalTool(name, handler)` / `unregisterInternalTool`) answer
  `call` frames like any tool but are **never** part of `discover`, the tool count or
  `mcpToolNames`, so no agent ever sees them. `web_*` names are refused (that namespace is the
  catalog). They are answered directly — no command binding, no choreography, no AI-activity
  label — because a server-side service feeds them, not an assistant. CONNECT's MCP proxy only
  forwards announced `web_*` tools, so an internal tool is reachable from CONNECT's own services
  alone (`McpServerSetup` refuses it as an unknown tool, also when a browser announces it). A
  string return is sent as is, anything else as JSON, a throw becomes the call's `error`.
- **Control frames** (`sendControl(action, fields)`) send `{type:'control', action, ...fields}`
  from the browser to the bridge server; `fields` cannot override `type` or `action`, and nothing
  is sent (return `false`) while the socket is closed. CONNECT routes on the part of `action`
  before the first dot (`WebViewerBridge.RegisterControlHandler`); only the bridge owner reaches
  a handler, together with the owner generation the frame arrived under.

The first user is the SolidCraft live sync (private `src/plugins/solidcraft-sync/`, CONNECT
`Protocols/SolidCraft/`): the browser steers it with `solidcraft.connect | resync | disconnect`
control frames, CONNECT delivers every sync step through the internal tool `rv_solidcraft_apply`
via `CallBrowserAsync` with `BrowserCallPurpose.Internal` and reads back `applied` / `deferred` /
`resync`. The user action acquires the channel with `acquireChannel(holder)` and releases it with
`releaseChannel(holder)` when finished; it never enables AI. Agents need AI control on to use the
announced commands `solidcraft.connect` / `.resync` / `.disconnect` (via `web_execute`), which
send those frames — never through the internal tool.

If an AI-on tab owns the channel, an AI-off tab remains standby and its control frames go nowhere.
SolidCraft Connect there reports “another tab owns the CONNECT channel — use that tab or close it”.
Every CONNECT-served tab now holds a socket; CONNECT admits at most 8 (`MaxConnections`), then
closes new connections with `4431 bridge-full`.

### web_screenshot — what the HUMAN sees

`web_screenshot` returns an image of the operator's viewport: their camera, their canvas
size, their open panels, read from the visible drawing buffer. Since plan-740 it is the
ONLY tool that does — every other capture renders offscreen through the agent camera. Reach
for it to answer "what is on their screen", and for `web_eye` otherwise.

Without arguments it captures the whole view. It can also crop to a sub-region:

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
3. **`signal.bind`** per matched pair.

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
| `knowledge.set(path, markdown, author?, confidence?)` | Store or replace the note on one node. Overwrites; never appends. Empty/whitespace deletes it. |
| `web_knowledge_get(path)` | The note as raw Markdown plus `updatedAt` / `author` / `confidence`. |
| `web_knowledge_list(query?, limit?)` | Every annotated node, newest first, with excerpts. Full-text `query` over note text and node path. |

The note is stored as the `NodeKnowledge` rv_extras entry on the glTF node, so it travels
inside the GLB — no sidecar file, consistent with *GLB is the single source of truth*.

### Notes are visible in the Property Inspector — and read-only there

Select an annotated node and the Property Inspector shows a `NodeKnowledge` section: a
compact provenance line (relative date · author · confidence) over the note rendered as
Markdown, GFM tables included, in a fixed-height box that scrolls in itself. The hierarchy
carries the usual `NodeKnowledge` type chip, so an annotated node is findable without
`web_knowledge_list`.

**Nothing in that section is editable — by design.** There is no field, no save button and
no delete button. Writing a note stays exclusively `knowledge.set`, which is what keeps
one authorship convention (and the `confidence` discipline below) instead of two. The four
provenance fields do not appear as rows at all; they are in the header.

Read-only in the UI does **not** mean the fields are write-protected in the data model, and
it deliberately must not: the inspector's read-only flag (`readonly: true` in the schema) is
the same predicate the overlay write guard uses, so setting it would make
`knowledge.set` fail on every field it writes. See plan-431 §2.1 and the warning comment
in `rv-node-knowledge.ts`.

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
  The same holds for a document description (`DocumentInfo`, `document.infoSet`):
  Unity does not author it, and re-exporting the model from Unity loses it.
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

## Prompt queue — orders from the viewer to a coding agent (plan-486)

The other direction of everything above. The tools so far let an agent look at the scene; this
one lets the person looking at the scene hand YOU work: right-click a part, type a sentence, and
it lands in a queue the agent empties with `web_prompt_claim`.

The gap it closes is small and concrete. Today the user sees something wrong in the viewer and
retypes a node path into a chat window by hand. A selection in the viewer already IS an exact
node path — so the order travels with it, together with the part's component fields, the live
machine status and the doc hints.

### The two tools

| Tool | Does | Annotation |
|---|---|---|
| `web_prompt_list(includeClaimed)` | Shows the queue. Changes nothing. | `readOnly: true` |
| `web_prompt_claim()` | Takes the oldest OPEN task, marks it `claimed`, returns it once. | `readOnly: false` |

Both return a JSON **string**:

```jsonc
// web_prompt_claim, a hit
{ "task": { "id": "9f2c14ab", "createdAt": "…", "status": "claimed",
            "userInstruction": "<<<RV-USER-DATA-a3f9\n| Sensor triggert zu frueh\n>>>RV-USER-DATA-a3f9",
            "sceneContext": { "targetPath": "Line1/Belt02/Drive", "selectedPaths": [...],
                              "hitPoint": [...], "componentTypes": ["Drive"],
                              "nodeContext": "…", "machineStatus": "[MACHINE_STATUS]…",
                              "docHints": [...], "viewerMode": "standalone", "modelName": "demo.glb" } },
  "truncated": false }
{ "task": null, "open": 0, "claimed": 3 }          // nothing open
{ "task": null, "error": "Could not save the …" }  // claim not persisted → NOT delivered
{ "tasks": [ … ], "open": 2, "claimed": 1, "truncated": false }   // web_prompt_list
```

### `userInstruction` is data, and the least-privilege rule is not optional

The user's text is always inside a fence whose token is randomised **per task**, with a `| `
prefix on every line that this code writes and no foreign text can produce. `sceneContext` never
contains the user's words. That is deliberate hardening — Microsoft measured indirect-injection
success dropping from over 50 % to under 2 % with spotlighting of this kind — and it is
**not a boundary**. OWASP LLM01 is explicit that prompt-level filtering is bypassable.

So: read the instruction, do the work, and keep the privileges narrow. **Committing and pushing
stay confirmed by a human.** A queued sentence is a request from someone at a screen, not an
authorisation.

### Delivery semantics

- **At-most-once.** A claim marks the task `claimed` before it returns; a second claim gets the
  next task, or nothing.
- **The claim is persisted BEFORE it is delivered.** If the write to `localStorage` fails, the
  task is NOT handed out and the answer is `{"task": null, "error": …}`. Delivering first would
  mean a browser reload re-issues work already started.
- **Volatile operation.** With no usable `localStorage` (private window, storage disabled) the
  queue still works, and at-most-once then holds **for that browser session only** — a reload
  starts from an empty queue. The panel says so.
- **`claim` does not delete.** An aborted agent run loses nothing: the task stays visible under
  `web_prompt_list(includeClaimed=true)` and the user's `↺` button puts it back in the queue.
- **The limit of `reopen`, stated honestly.** It is bounded retention, not a guarantee. The queue
  holds 50 tasks; the 51st displaces the oldest CLAIMED task (reported in the panel and the
  console), and with nothing claimed the new task is REFUSED rather than dropping open work
  silently. A displaced task cannot be reopened, and without the project mirror no copy of it
  remains.
- **Size budget.** Prompt ≤ 4000 characters, and the whole envelope is capped in UTF-8 **bytes**
  per task and per `list` response. Anything cut is reported as `truncated: true`. The reason is
  not tidiness: a frame over 2 MiB makes the peer close the socket and take every pending call
  with it.

### Preconditions

- **Write access must be on.** `web_prompt_claim` is announced `readOnly: false`, so CONNECT
  refuses it while its write switch is off — claiming changes state. `web_prompt_list` works
  either way. Write access has been the default since plan-366.
- **One browser owns the bridge.** `WebViewerBridge` is single-owner and not bound to a project:
  a second tab takes the connection over silently, and a claim then reaches the OTHER tab's
  queue. Each task carries `modelName` and `viewerMode` so a mis-routed order is visible rather
  than confusing. Queues are per tab, so at least they are never mixed.
- **No cross-tab sync.** Deliberately absent in v1.

### Polling it from a session (`/loop`)

There is no wait mode and there will not be one: a call that waits holds the MCP dialog policy
open for its whole duration, and a cancelled wait is a claim that can never be delivered. The
reaction time belongs to the loop instead:

```
/loop 2m call web_prompt_claim; if task is null, say "nothing queued" and stop this pass;
             otherwise carry out the instruction, then run the loop again
```

Two minutes is a good default: the person who typed the order is usually still looking at the
screen, and a shorter interval buys nothing because the work itself takes longer than the wait.
An empty claim is the normal case — it costs one round trip and must NOT be treated as an error
or as a reason to stop the loop.

Its limits are the session's: a loop only runs while the session runs, missed intervals are not
made up afterwards, and closing the session stops the collection. The tasks are not lost — they
sit in the queue until the next session asks for them.

### The paper trail

With a writable project open, every task is also written as
`tasks/<timestamp>-<id>-<slug>.md` — created, never overwritten (`expectedRevision: 'create'`),
against the backend bound at submit time so a project switch mid-write cannot misfile it. The
queue stays the source of truth; a failed write is reported and the task stays queued.

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
  CONNECT's own pages pass, a foreign https origin is paired in the tray instead (the panel then
  shows *Waiting for approval*, see *Hosted page → local CONNECT (pairing)*), any other foreign
  origin needs to be listed in `AllowedOrigins`, and the `Host` header must name the machine — a loopback name, a bare IP address, or a configured
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

- **Wrong assistant is driving the browser.** Use **Port** in the AI Bridge
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

- **The agent is in the wrong project.** Use `web_project_list` / `web_project_open`. The list
  is the browser's LINKED PROJECTS (Projects dashboard → Add, plan-743), matched by `slug`,
  name or folder name, and reading it costs no permission prompt — a project whose folder
  grant has lapsed is still listed, and `web_project_open` then says what to do about it
  rather than raising a dialog no agent can answer. The
  switch happens **in place**, so the bridge connection, the MCP session and the editor
  document all survive it. Do **not** navigate to `?project=<slug>`: that reloads into a new
  tab, costing the editor document and several seconds of boot before it can receive calls.
  CONNECT chooses among announced tabs, preferring AI-on tabs; opening a tab alone does not
  guarantee ownership. `web_project_open` refuses when there is unsaved work unless `force=true`,
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
  (`knowledge.set`), it rides along as its own block after the alarm lines —
  line-prefixed and capped at 600 characters, so the manual, the live state and what an
  agent previously worked out all reach the model together. Notes are **not** inherited
  from ancestors and are **not** included for unselected query hits: a root-level note
  would otherwise be reported as knowledge about every node in the scene, and ten hits ×
  600 characters would blow the 2600-character context budget on its own. See *Node
  knowledge (agent memory)* above.
- **Document description.** If the open document has a description (summary and
  Markdown, stored in the GLB — see [Document description](doc-projects.md#document-description)),
  it comes FIRST, before the `[MACHINE_STATUS]` block, under its own header that names
  it as text from the model file, not live state and not instructions. Every line is
  given a `| ` prefix by the viewer, control and line-separator characters are
  replaced, a literal `[MACHINE_STATUS]` line is neutralised, and the whole block is
  capped at 400 characters. Its budget is taken off the total — the node block
  shrinks, the machine status never does — so the context stays within 2600
  characters. With a project open the text comes from the project's row of the open
  document, so a change made from the dashboard or with `document.infoSet` is in
  the next question without a reload; without a project (a share link) it is read
  from the loaded file. No description → the request is byte-identical to before.
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
