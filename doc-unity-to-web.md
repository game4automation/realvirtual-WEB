# From Unity to realvirtual WEB — Customization and Coding-Agent Workflow

> **Applies to:** Community runtime and extension workflows; Unity Professional export and commercial browser authoring are optional, separate workflows.
> **Reference baseline:** 6.3.43, documentation reviewed 2026-09-16.
> See the [edition comparison](README.md#community-edition-vs-commercial) and [getting started](doc-getting-started.md).

This document is written **for users coming from realvirtual on Unity**.

> Authoring note: everything you reference across nodes in Unity — drive signals, sensor
> targets, kinematic bodies — is exported as a **node path**, not as an object identity.
> [doc-node-paths.md](doc-node-paths.md) explains how those paths are built and resolved, and
> why node names must be unique across the *whole* export rather than just among siblings.

## Choose an authoring and delivery workflow

realvirtual WEB includes a Community viewer, HMI runtime, layout planner and public
extension APIs. A standalone Community checkout builds without Unity or a private
repository. You can use GLB files from any compatible authoring tool.

Commercial WEB builds can additionally include the browser **Asset & Kinematics
Editor**, CAD import, DES and other licensed modules. These features are not enabled
by installing the Community source. See the [edition comparison](README.md#community-edition-vs-commercial).

realvirtual on Unity remains an optional authoring and virtual-commissioning platform.
Use its Professional exporter when you want to bring Unity-authored components and
metadata into WEB. Browser plugins, UI customizations and project scripts can be
written directly in TypeScript; a coding assistant is optional.

| Workflow | Where you work | Result |
|---|---|---|
| Community runtime and layouts | Browser plus public TypeScript APIs | View, connect, arrange and extend supported GLB content |
| Commercial browser authoring | Licensed WEB modules | Edit assets/kinematics and use the enabled analysis/import tools |
| Unity authoring and commissioning | realvirtual on Unity | Export geometry and supported `rv_extras` for WEB delivery |

The remaining sections explain Unity migration and native extension patterns. Start
with [Getting started](doc-getting-started.md) and the public
[project plugin example](doc-project-plugin-example.md) when you do not have Unity.

### Why the split exists

1. **Web technology cannot be fully represented in the Unity Editor.**
   React components, MUI panels, browser-only features (WebXR, multiuser
   over WebRTC/relay, PDF rendering, MQTT-over-WebSocket, layout planner,
   gaussian splats, ...) have no faithful counterpart in Unity. Forcing
   them into Unity properties would either lie about what is possible or
   reduce the web side to the least-common-denominator of what Unity can
   serialize.
2. **The web HMI changes faster than the machine.** Customer dashboards,
   carts, document links and status panels evolve weekly. Re-exporting a
   1 GB GLB from Unity every time a label changes is the wrong workflow.
   Keeping HMI in code, next to the GLB, makes it fast to iterate and
   easy for an agent to maintain.
3. **Coding-agent development is faster than editor + code + UI split.**
   In Unity, a non-trivial feature usually means: edit C#, recompile,
   reconfigure an inspector, hook up scene references, save, hit Play,
   verify. In realvirtual WEB with a coding agent, the same feature is
   *one prompt* against an already-instrumented codebase: the agent
   writes the plugin, registers it in the model pack, runs the dev
   server, queries the live MCP/debug API for verification, and reports
   back. Empirically this is **multiple times faster** than the
   editor-centric Unity loop for the things WEB is built for — HMI,
   dashboards, document flows, multiuser, integrations.

So: **not every web HMI feature is — or will be — exposed as a Unity
component**, and that is intentional. What Unity owns is everything about
the **machine and its commissioning**. What WEB owns is everything about
the **product that the end user opens in a browser**.

This doc explains where the line is, how to cross it cleanly, and how to
use coding agents to do the WEB-side work efficiently.

---

## 0. What Unity owns vs. what WEB owns

A short cheat-sheet for Unity users. This is the most common source of
confusion when comparing a Unity scene with the WEB Demo side-by-side.

| Concern | Owned by Unity (GLB) | Owned by WEB (TypeScript/React) |
|---------|---------------------|----------------------------------|
| Geometry, materials, hierarchy | yes | — |
| Drives, sensors, transport surfaces, sources/sinks | yes | runtime port reads `rv_extras` |
| LogicStep sequencing | yes | runtime port reads `rv_extras` |
| Signal definitions, signal directions | yes | runtime port reads `rv_extras` |
| Kinematic chains / robot definitions | yes | runtime port reads `rv_extras` |
| Camera presets / start position | yes | runtime port reads `rv_extras` |
| AAS metadata (vendor, part, datasheet URLs) | yes | consumed by AAS / Cart / Docs plugins |
| Maintenance procedure content (steps, target cameras, highlights) | yes | rendered by `MaintenancePlugin` |
| `Web*` marker components (e.g. `WebSensor`) | yes (as marker only) | rendered by the matching `RVWeb*` TS class |
| KPI bars, message panels, dashboards | **no** | yes — plugins + UI slots |
| Cart / order basket | **no** | yes — `OrderManagerPlugin` |
| Document / PDF viewer | **no** | yes — `DocViewerOverlay`, fed by `AasLinkPlugin` |
| Multiuser sessions, avatars, follow-cam | **no** | yes — `MultiuserPlugin` + relay |
| WebXR (VR / AR) | **no** | yes — `WebXRPlugin` |
| Layout planner, annotations, measurements | **no** | yes — dedicated plugins |
| Industrial interfaces (WebSocket, MQTT, ctrlX) | **no** | yes — adapters in `src/interfaces/` |
| Lock / kiosk mode, login gate, settings persistence | **no** | yes — WEB-only |

Drive behaviours are ported one for one and keep their Unity name in
`rv_extras`; the WEB loader instantiates the matching `RV…` class:

| Unity DriveBehaviour | TypeScript port | File |
|----------------------|-----------------|------|
| `Drive_Simple` | `RVDriveSimple` | `rv-drive-simple.ts` |
| `Drive_Speed` | `RVDriveSpeed` | `rv-drive-speed.ts` |
| `Drive_Cylinder` | `RVDriveCylinder` | `rv-drive-cylinder.ts` |
| `Drive_DestinationMotor` | `RVDriveDestinationMotor` | `rv-drive-destination-motor.ts` |
| `Drive_FollowPosition` | `RVDriveFollowPosition` | `rv-drive-follow-position.ts` |
| `Drive_Gear` | `RVDriveGear` | `rv-drive-gear.ts` |
| `Drive_PositionSwitch` | `RVDrivePositionSwitch` | `rv-drive-position-switch.ts` |
| `Drive_ErraticPosition` | `RVErraticDriver` | `rv-erratic.ts` |
| `Drive_SEWMovilink` | `RVDriveSEWMovilink` | `rv-drive-sew-movilink.ts` |
| `Drive_ContinousDestination` | `RVDriveContinousDestination` | `rv-drive-continous-destination.ts` |
| `Drive_ProfidriveSpeed` | `RVDriveProfidriveSpeed` | `rv-drive-profidrive-speed.ts` |
| `Drive_ProfidrivePos` | `RVDriveProfidrivePos` | `rv-drive-profidrive-pos.ts` |
| `Drive_FestoFHPP` | `RVDriveFestoFHPP` | `rv-drive-festo-fhpp.ts` |
| `Drive_UniDriveMotor` | `RVDriveUniDriveMotor` | `rv-drive-unidrive-motor.ts` |
| `Drive_ProportionalValve` | `RVDriveProportionalValve` | `rv-drive-proportional-valve.ts` |
| `DrivePulseEncoder` | `RVDrivePulseEncoder` | `rv-drive-pulse-encoder.ts` |

Not ported, by decision: `Drive_Sequence`, `Drive_MeasureSpeedPosition`,
`ForceDrive`, `StartDriveOnCondition` and `LogicStopDriveOnSensor`. Two
things to know about the ported set: `DrivePulseEncoder` is not a `Drive_*`
behaviour (no underscore in its Unity name), so it sits on the drive node
NEXT TO the one active `Drive_*` behaviour instead of competing with it; and
`Drive_ProportionalValve` replaces its Unity `FlowCurve` (an `AnimationCurve`,
which the GLB exporter cannot carry) with a `FlowExponent` number — 1 is the
linear default curve, above 1 progressive. All drive behaviours are
`authorable`, i.e. they appear in the asset editor's *Add Component* list, but
only while the selected node already carries a Drive.

`Drive_SEWMovilink` carries the
SEW MOVI-C profile — MOVILINK control word 1 / status word 1 with the priority
cascade fault > inhibit > rapid stop > stop > enable and both speed encodings
(`PercentNmax`, `Rpm`) — so a station modelled with SEW drives also runs in
Standalone mode. Live, it is fed through CONNECT's MQTT **Json** topic mode
(see [doc-connect.md § MQTT Json topic mode (SEW)](https://realvirtual.io/doc/web/connect/)).

The rule of thumb: **if it is about the machine, it belongs in Unity. If it
is about the application around the machine, it belongs in the WEB
codebase.** Adding more Unity components for things in the lower half of
this table is not on the roadmap — the limitations of expressing browser
UI inside Unity make that the wrong place for them.

### 0.1 `NodeId` and the Unity → WEB → Unity round-trip

WEB addresses nodes by a stable `NodeId` in `extras.realvirtual` (plan-397,
rv-ODT §5a) as well as by path. It matters to a Unity user in exactly one
situation: a **round-trip**, where a GLB exported from Unity is edited in WEB
and comes back.

- **Unity does not have to produce `NodeId`s.** A file without them loads
  unchanged — that is the entire existing Unity export corpus. For such a file
  WEB *derives* the id deterministically from the file's own hash plus the glTF
  node index, so the same bytes always yield the same ids and an override
  written against them survives a reload.
- **Unity must not strip them.** If a GLB that already carries `NodeId` is
  re-imported and re-exported by Unity, dropping the field silently orphans
  every override a referencing file holds against it. `NodeId` deliberately has
  no `_` prefix so WEB's own export sanitiser keeps it; the Unity side needs the
  same care.
- **`NodeId` is unique within its file, never globally.** Reference one asset
  ten times and all ten occurrences carry identical ids — occurrences are told
  apart at runtime by the chain of reference-node ids above them, which is never
  written into any file.

See [`doc-node-paths.md`](doc-node-paths.md) for the addressing model and
[`schema/v1/specification.md`](schema/v1/specification.md) §5a for the
normative derivation.

---

## 1. Two layers, one runtime

realvirtual WEB is split into two clearly separated layers:

| Layer | Source | What it contains |
|-------|--------|------------------|
| **Scene + simulation** | Unity → GLB (`rv_extras`) | Geometry, materials, drives, sensors, transport surfaces, sources/sinks, LogicSteps, signal definitions, kinematic links, camera presets |
| **HMI / application** | realvirtual WEB plugins (TypeScript/React) | KPI bars, message panels, machine status overlays, cart, PDF / document viewer, maintenance procedures, multiuser, WebXR |

The GLB is the **single source of truth for the digital twin**. Everything you can
see in the 3D scene and all simulation behavior is reconstructed from `rv_extras`
metadata embedded in the GLB file.

The HMI on top of the scene is **not** in the GLB. realvirtual composes it at
load time from plugins, UI slots and per-model plugin packs.

```
┌────────────────────────────────────────────────────────────────────┐
│ realvirtual WEB (browser)                                          │
│                                                                    │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │ HMI layer  ── plugins (React + MUI)                          │  │
│  │   KPI bar │ Messages │ Machine status │ Cart │ Docs │ ...    │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                    │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │ Scene + simulation  ── reconstructed from GLB rv_extras      │  │
│  │   drives │ sensors │ transports │ logic steps │ signals      │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                       ▲                                            │
└───────────────────────┼────────────────────────────────────────────┘
                        │
                  Unity export
                  (GLB + rv_extras)
```

---

## 2. Answer to the typical customer question

> *"The Demo has machine status UI on top, left and right, but my exported GLB
> doesn't contain it. Where does it come from?"*

The status overlays in the Demo are **not customized into the export**. They are
implemented as **demo plugins** that realvirtual registers automatically when
one of the demo GLB files is loaded.

The complete registration list lives in
`src/plugins/models/DemoRealvirtualWeb/index.ts` — this is the whole set, in
registration order:

| Plugin | What it does |
|--------|--------------|
| `ModelOptionPlugin` | Applies the active `?option=` variant (the AAS supplier swap). **Registered first on purpose** — see [doc-document-linking.md](doc-document-linking.md) |
| `OperatorHmiControlsPlugin` | Hides the engineering sim controls (Play/Pause/Reset, Realtime/DES) in HMI mode |
| `RobotFollowPositionPlugin` | Follow-camera anchor on the robot |
| `KpiDemoPlugin` | OEE / Parts-per-hour / Cycle-time KPI cards (top KPI bar) |
| `DemoHMIPlugin` | Messages, status badges, tiles |
| `TestAxesPlugin` | Manual axis tester — floating panel with sliders for A1–A6 robot axis control |
| `MachineControlPlugin` | Docked left "Machine Control" panel |
| `MaintenancePlugin` | Maintenance dialog + step-by-step / flythrough procedures |
| `WebXRPlugin` | VR / AR entry |
| `MultiuserPlugin` | Shared sessions (presence, avatars, follow-cam) |
| `FpvPlugin` | First-person walkthrough camera |
| `AnnotationPlugin` | 3D annotations |
| `AasLinkPlugin` | Asset-Administration-Shell tooltips, side panel and the PDF links that feed the document viewer |
| `OrderManagerPlugin` | Cart / order basket |

These plugins are part of the AGPL codebase. None of their content lives
inside the demo GLB. They are activated only for the Demo model — they appear
because the model-plugin manager matches the loaded filename against
`models = ['DemoRealvirtualWeb', 'RealvirtualWebTest']`.

If you load your own GLB, none of these demo plugins activate. The 3D scene and
simulation will run, but the HMI overlay will only contain the **generic**
realvirtual chrome (top-bar, hierarchy, settings, search bar, drive chart overlay,
etc.).

---

## 3. How to add HMI / status UI on top of your own GLB

There are three customization paths, ordered from least to most code.

### 3.1 Component Behaviors — for per-node visualization

For markers that should follow a specific node (status lamps, gizmos, sensor
state visualizations), use **Component Behaviors**. They are auto-discovered
per GLB and run scoped to the matching model.

The recommended pattern is the `Web*` marker-component convention on the Unity
side (e.g. `WebSensor`) with a TypeScript counterpart (`RVWebSensor`) that reads
`rv_extras` and drives the rendering.

See **[doc-behaviors.md](doc-behaviors.md)**.

### 3.2 Plugins + UI Slots — for application-level UI

For dashboards, status bars, sidebars and modal panels, write a plugin and
contribute to one of the predefined UI slots:

| Slot | Where it shows |
|------|----------------|
| `kpi-bar` | Top-center KPI badges |
| `activity-bar` | Left sidebar window-opener buttons |
| `button-group` | Floating left contextual tool toolbar |
| `search-bar` | Bottom search/filter bar |
| `messages` | Right sidebar message list |
| `views` | Bottom-right floating views (charts, tables) |
| `settings-tab` | Settings dialog tab |
| `toolbar-button-leading` | TopBar primary sim controls before Hierarchy |
| `toolbar-button` | TopBar extra action buttons |
| `toolbar-button-center` | TopBar center region (reserved) |
| `toolbar-button-trailing` | TopBar right region before camera group |
| `overlay` | Full-screen overlays |

Plugins also have lifecycle hooks (`onModelLoaded`, `onFixedUpdatePre`,
`onRender`, ...) and a typed event bus (`viewer.on / viewer.emit`) for
loose coupling.

Architecture, examples and slot reference: **[doc-extending-webviewer.md](doc-extending-webviewer.md)**.

### 3.3 Project plugins for a specific document

Bind a project module through `documents[].scriptRef`, rather than matching a GLB
filename. The module exports `registerModelPlugins(viewer)` and
`unregisterModelPlugins(viewer)`. Register plugins with `viewer.use()` and remove
the same IDs with `viewer.removePlugin()`; dispose event listeners, timers and DOM.

The [public project example](doc-project-plugin-example.md) includes the complete
folder layout, compilable TypeScript, manifest and cleanup. Several documents can
reference one module. A direct `plugins/my-plugin.ts` is sufficient; a collecting
`index.ts` is optional. Changing a document filename does not change this binding.

Built-in `src/plugins/models/*/index.ts` packs are source-tree integrations shipped
with the viewer. Their filename matching and bundled imports are not the contract
for a portable runtime project module. See [Scripting](doc-scripting.md) for the
three extension paths and [Extending WEB](doc-extending-webviewer.md) for APIs.

#### 3.3.3 Workflow — adding customization for a new machine

1. Export a GLB from Unity, or use a compatible GLB from another authoring tool.
2. Import it into a writable project. The project manifest lists its document path;
   folders are not scanned into a model selector automatically.
3. Put your TypeScript module under the project's `plugins/` folder and export
   `registerModelPlugins` and `unregisterModelPlugins`.
4. Bind the document's **PLUGIN** slot to that module (`documents[].scriptRef`).
5. Compile with `npm run build:project-scripts -- <projectDir>`, reopen the document,
   and allow that project's native code when prompted.
6. Test model switching and cleanup as well as the visible customization.

Follow the complete [public project example](doc-project-plugin-example.md).
The source-tree model packs described above are build-time integration examples;
project code should use an explicit manifest binding instead of a model filename.

---

## 4. Cart and PDF / Machine Information

Both features are **shipped with the AGPL codebase**. They are not part of the
GLB — they are plugins that you can enable for your own model.

### 4.1 Cart — `OrderManagerPlugin`

Source: `src/plugins/order-manager-plugin.tsx`

What it does:

- Adds a "shopping cart" left-panel + nav button.
- Lets users add components into the cart, adjust quantities, and export the
  cart as **CSV**, **email** or an **online order**.
- Cart contents are persisted in `sessionStorage` (per browser tab).

How it knows what is orderable:

- Cart items are sourced from **AAS link** metadata. Any node that has an AAS
  link (vendor, part number, datasheet URL, ...) attached can be added to the
  cart.
- AAS links can be authored in Unity via the `AASLink` component or any
  `Web*` AAS marker component, and exported through `rv_extras`.

To enable for your model:

1. Author AAS metadata on the relevant Unity components (vendor, part number,
   description, datasheet/order URLs).
2. Re-export the GLB.
3. In your model plugin pack (`src/plugins/models/<YourModel>/index.ts`),
   register `new OrderManagerPlugin()` and `new AasLinkPlugin()`.

### 4.2 PDF / Machine Information System

There is no single "PDF system", and the Demo does **not** use a dedicated
document-browser plugin. What you see there is two registered plugins plus one
core overlay:

| Piece | Role |
|-------|------|
| `AasLinkPlugin` (`src/plugins/aas-link-plugin.tsx`) | Hover/click on a component → tooltip and side panel with vendor / part / datasheet data pulled from the AAS metadata in the GLB. It also extracts the PDFs out of the AASX packages and writes them to `node.userData._rvPdfLinks`. |
| `DocViewerOverlay` (core HMI, not a plugin) | The built-in PDF reader. It opens automatically for any node that carries `_rvPdfLinks` — no registration, no configuration. |
| `MaintenancePlugin` (`src/plugins/demo/maintenance-plugin.ts`) | Authored maintenance procedures: step-by-step or flythrough with camera animation, highlighting and result capture |

> `DocsBrowserPlugin` (`src/plugins/docs-browser-plugin.tsx`) also exists in the
> codebase — a sidebar "document browsing mode". It is **not instantiated
> anywhere**, including in the Demo. Treat it as available-but-unused, not as
> part of the Demo stack.

To implement "machine information" for your own GLB:

1. **Author the content on the Unity side** as AAS links (datasheets, manuals,
   BOM URLs) — these travel with the GLB.
2. **Place the documents** — either AASX packages under `public/aasx/` (indexed
   by `scripts/build-aasx-index.mjs`) or plain PDFs mapped by node path in the
   model's sidecar config. Both routes end in `_rvPdfLinks`.
   See **[doc-document-linking.md](doc-document-linking.md)** for the full contract.
3. **Author maintenance procedures** as part of `rv_extras` (parsed by
   `maintenance-parser.ts`) — each procedure is a sequence of steps with a
   camera pose, optional highlight nodes and a description.
4. **Register `AasLinkPlugin`** (and `MaintenancePlugin` if you use procedures)
   in your model plugin pack. The PDF viewer needs no registration.

For the full procedure format, see `core/maintenance-parser.ts`.

---

## 5. Maturity

realvirtual WEB as a whole still carries a **beta** notice (the welcome
dialog states it: features, file formats and APIs may still change, and it is
not intended for production use yet). That is a product-level statement, not a
per-feature one.

Inside the UI there is exactly **one** feature carrying an explicit "Beta"
badge today:

| Feature | Marked in the UI | Notes |
|---------|------------------|-------|
| **Full physics — all conveyors** (Settings ▸ Simulation) | Yes — `BetaChip` in `SimulationTab.tsx` | Runs every non-radial conveyor as a physical belt. Experimental, off by default, takes effect on the next model load. |
| Layout Planner | No badge | Shipped; the persistence format is still evolving — see [doc-layout-planner.md](doc-layout-planner.md) |
| Multiuser Sessions | No badge | Local mode and presence/avatars are solid; the relay-server deployment story and large-room scaling are the parts that see the least testing. See **[doc-multiuser-system.md](doc-multiuser-system.md)** |
| WebXR VR/AR | No badge | Works across the browsers that support WebXR |

What "beta" means in practice, for the product and for the badged feature
alike: the API surface, configuration format and UI may still change in a minor
version; edge cases (large scenes, weak hardware, slow networks, exotic
browsers, unusual relay configurations) surface issues first; bug reports are
very welcome — that is why these ship before being declared stable.

If a feature is not visible in your build, check the **Settings panel** — some
plugins are opt-in per deployment, and lock / kiosk mode can hide them on
purpose. See [doc-ui-visibility.md](doc-ui-visibility.md) for the two
independent axes that decide whether an element shows up.

---

## 6. AI-first product — build with Claude Code (or any coding agent)

This is the part that often surprises Unity users: **for the WEB side, the
intended development model is not "click together components in an editor".
It is "describe what you want to a coding agent and review the result".**

That is not a workaround for missing tooling — it is the deliberate
positioning of realvirtual WEB. realvirtual WEB is an **IT product**, not
an editor product. It runs on the same stack and the same workflows as any
modern web application: TypeScript, React, npm, CI, CDN. People who deploy
and customize realvirtual WEB are doing **web/IT work**, not Unity scene
authoring — and the productivity gains from coding agents are largest
exactly in that environment:

- Modern web HMI is **too rich and too fast-moving** to be expressed as a
  fixed set of editor properties. React, MUI, WebXR, MQTT/WebSocket
  adapters, multiuser, PDF and layout planning all live on the web and
  evolve there.
- LLM coding agents have become **good enough that the natural authoring
  surface for browser HMI is now natural language + code**, not editor
  inspectors. The repo is shaped to take advantage of that.

Use the built-in Inspector and, when licensed, the browser Asset & Kinematics Editor for supported authoring tasks. Custom React dashboards and integration logic use the public TypeScript extension APIs. Coding assistants can help write those extensions but are not required.

realvirtual WEB is designed as an **AI-first product**. The codebase is
structured, documented and instrumented so that a coding agent (Claude Code,
Cursor, Aider, Continue, ...) can do the bulk of the customization work for
you, including:

- writing a new per-model plugin pack from a verbal description,
- porting Unity C# components to TypeScript counterparts,
- wiring KPI panels to your PLC signal names,
- generating React HMI panels into the existing UI slots,
- adding new industrial interfaces (WebSocket, MQTT, REST).

This is not a side feature — **it is the intended primary development model**
for customer customizations on top of realvirtual WEB.

### 6.1 What ships in the repo for agents

The repository contains everything an agent needs to work productively in
this codebase, without you having to brief it manually:

| Artifact | Purpose |
|----------|---------|
| `CLAUDE.md` (repo root) | Project-wide guidance: stack, code conventions, naming, license headers, operating modes, test policy, git workflow. Claude Code reads this automatically. |
| `.claude/commands/` | Pre-wired slash commands: `/dev`, `/build`, `/test`, `/debug`, `/inspect`, `/license-check`. They encode the standard "run the right thing the right way" workflow. |
| `.claude/settings.json` | Shared agent settings for the project. |
| `doc-*.md` files | Per-area architectural documents (this one, behaviors, lifecycle, extending, multiuser, persistence, interfaces, debugging). They are the agent's reference material when it needs to look up *how something works* before changing it. |
| `webviewer.mcp.md` | MCP tool reference: lists tools the agent can use to **inspect the running session** (signals, drives, sensors, errors, scene state). |
| Built-in `mcp-bridge-plugin` | Exposes the running scene over the debug API. Together with the [realvirtual-MCP](https://github.com/game4automation/realvirtual-MCP) server, agents can inspect and control the live browser session. |
| `debug-endpoint-plugin` | HTTP debug API (`/__api/debug`) for snapshotting signals/drives/sensors/logs — the same data an agent reads to verify its changes worked. |

### 6.2 Recommended workflow

1. **Open the WEB folder with Claude Code** (or another agent that picks up
   `CLAUDE.md`). The project-level instructions and conventions are
   loaded automatically.
2. **Describe the customization in natural language** — e.g. *"Create a
   model plugin pack for `LineA.glb` that shows a KPI bar with parts/h,
   OEE and downtime, plus a maintenance panel with three procedures."*
3. **Let the agent scaffold the model plugin pack** under
   `src/plugins/models/<YourModel>/` using the contract from §3.3.2.
4. **Let the agent run `npm run dev`, the MCP/debug API, and the test
   commands** to verify the result against the live browser. The MCP
   bridge gives it eyes on the running scene.
5. **Iterate.** Because the customization is a pure TypeScript folder that
   the manager auto-discovers, the agent can rewrite, rename, split or
   delete the pack without touching anything else in the codebase.

### 6.3 Why this is faster than the Unity editor loop

The editor-centric Unity workflow has three places where state lives at the
same time: **C# code**, **inspector properties on components**, and **scene
references wired up in the editor**. Any non-trivial change usually touches
all three, and the resulting iteration loop is:

```
edit code → recompile → reconfigure inspector → re-wire references
         → save scene → enter Play mode → verify → exit Play mode → repeat
```

The realvirtual WEB loop collapses all of that into one place — code —
with hot-reload, a live debug API and a coding agent that can both write
and verify:

```
agent edits a plugin file → Vite HMR refreshes the browser
                          → agent reads /__api/debug to verify
                          → done, or one more pass
```

There is **no editor state to keep in sync**, no scene to save, no
inspector to re-wire, no separate Play mode. The plugin pack folder is
the single source of truth for the customization; everything else (UI
slots, lifecycle, persistence) is the framework's job. This is why a
non-trivial WEB customization (a new KPI dashboard, a new docs flow, a
new industrial interface) is typically a one-prompt task for a coding
agent — and why it usually lands in minutes rather than the hours an
equivalent change would take through the Unity editor.

### 6.4 Why this works well

- **Component-naming parity** between Unity C# (`Drive`, `Sensor`,
  `TransportSurface`, ...) and the TypeScript runtime (`RVDrive`,
  `RVSensor`, `RVTransportSurface`) makes near-mechanical, AI-assisted
  porting realistic.
- **GLB as single source of truth** means the agent never has to chase
  config across multiple files — `rv_extras` is the canonical input.
- **Tight conventions** (file naming, `rv-` prefix, license headers,
  named exports only, slot-based HMI) give the agent a small, predictable
  rule-set to follow.
- **Live introspection** (debug endpoints, MCP bridge, structured
  logging) lets the agent verify its own work end-to-end inside the
  browser, not just at compile time.

If you are evaluating realvirtual WEB for a customer project, the realistic
mental model is: *"I describe the machine and the HMI; an agent writes the
plugin pack; I review and ship."*

---

## 6b. Web handling: a component designed to be ported back

Fabric / web handling (`RibbonRoller`, `RibbonWinder`, `RibbonPath`) is the first feature
built **web-first with the Unity port in mind**, and it is the template for the
next one.

The whole of the mathematics sits in two files under
`src/core/engine/ribbon/` that import **nothing** — not `three`, not an engine
module, not a utility:

| File | What it owns |
|------|--------------|
| `ribbon-geometry.ts` | two-circle tangents with side logic, wrap arcs, arc-length sampling |
| `ribbon-winder-math.ts` | roll build-up `R(L)`, its inverse, and `omega = v/r` |

They work on plain `{x, y}` tuples and numbers, so the C# port is a
transcription rather than a re-derivation. The guard is a grep that must stay
empty:

```bash
rg -n "from 'three'" src/core/engine/ribbon/
```

**The unit contract is the part to copy first.** Lengths, radii and thicknesses
are **millimetres**, speeds **mm/s** (linear) or **deg/s** (rotational, exactly
as `Drive.currentSpeed`), angles **radians** internally. Field names carry the
unit (`WoundLengthMm`, `CoreRadiusMm`) so a mixed-unit assignment does not
type-check past a reviewer. Metres appear in exactly one place: the band mesh
writes them, because glTF world units are metres. A second conversion point is
how a unit contract rots — there is not one.

What Unity has to export is the three rv_extras blocks in
`schema/v1/specification.md` §7a.53–7a.55, and nothing else: the path geometry,
the sample table and the band mesh are all recomputed in the reader from the
roller poses. `GLBComponentSerializer.cs` therefore gains three component
writers and no baking step — unlike `Chain`, whose spline Unity must bake
because Unity's spline evaluator is the source of truth for it.

## 7. Where to go from here

This document is the **developer** view. For the end-user manual — what the
buttons do, how an operator drives the UI, the feature tour — use the product
documentation site instead of restating it here:
**<https://realvirtual.io/doc/web/>**.

| You want to ... | Read |
|------------------|------|
| Understand the overall architecture | [doc-webviewer.md](doc-webviewer.md) |
| Build a plugin, contribute a UI slot, hook lifecycle | [doc-extending-webviewer.md](doc-extending-webviewer.md) |
| Write per-node behaviors against `rv_extras` | [doc-behaviors.md](doc-behaviors.md) |
| Attach custom logic *inside* the GLB (JS-in-GLB) | [doc-scripting.md](doc-scripting.md) |
| Link PDFs / AASX packages to nodes | [doc-document-linking.md](doc-document-linking.md) |
| Add an industrial interface (WebSocket / MQTT / ctrlX) | [doc-webviewer-interface.md](doc-webviewer-interface.md) |
| Wire multiuser sessions / shared views | [doc-multiuser-system.md](doc-multiuser-system.md) |
| Debug a running session | [doc-web-debugging.md](doc-web-debugging.md) |

---

## 8. TL;DR for Unity users

- The Demo's machine status UI **is not in the GLB**. It is a stack of WEB
  plugins (`KpiDemoPlugin`, `DemoHMIPlugin`, `MachineControlPlugin`,
  `MaintenancePlugin`, ...) activated only for the demo GLB filenames — the
  full list is in §2.
- Customization for a customer model is done by writing **plugins** and
  packaging them as a **per-model plugin pack** (`src/plugins/models/<YourModel>/index.ts`)
  that auto-loads when that GLB is opened.
- **Cart** is the AGPL-shipped `OrderManagerPlugin`, fed by **AAS-link
  metadata** authored in Unity.
- **PDF / Machine Information** is `AasLinkPlugin` (which produces
  `node.userData._rvPdfLinks`) plus the core `DocViewerOverlay` reader, and
  `MaintenancePlugin` for authored procedures — all fed by metadata you author
  in Unity and ship in the GLB. `DocsBrowserPlugin` exists but is not used.
- realvirtual WEB as a product is still **beta** (see the welcome dialog);
  inside the UI only "Full physics — all conveyors" carries an explicit Beta
  badge.
- **Not every WEB feature has — or will have — a Unity counterpart.** The
  WEB side is built and customized in TypeScript/React, and the intended
  development model is **with a coding agent (Claude Code) using the
  `CLAUDE.md` and `.claude/commands/` already shipped in this folder.**
- **realvirtual WEB is not for virtual commissioning.** Deep engineering,
  PLC sign-off and commissioning stay in realvirtual on Unity. WEB is the
  **runtime / delivery platform** for end users — operators, service
  technicians, customers, sales — and it is an **IT project**, not an
  editor project. Customization with coding agents in this codebase is
  **measurably faster** than the equivalent code-plus-inspector-plus-scene
  workflow on the Unity side.
