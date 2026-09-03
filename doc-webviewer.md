# realvirtual WEB

**The open standard for browser-based 3D-HMI and Digital Twins in manufacturing.**

realvirtual WEB brings industrial 3D visualization to the browser — load realvirtual GLB exports and run transport simulation, sensor collision, LogicStep sequencing, and drive animation with no installation required. WebGL, WebGPU, and WebXR (VR/AR) supported out of the box.

**One link. Any device. Live Digital Twin.** Share an interactive 3D model of your machine or production line with anyone — customers, operators, service technicians — across desktop, tablet, and VR/AR headsets.

**Built for manufacturing:**
- **3D HMI / operator dashboards** — Web-based HMI connected to real PLCs via WebSocket or MQTT. Live signal visualization, KPI overlays, drive monitoring — replacing desktop HMI applications.
- **Sales & presales** — Interactive 3D models that let prospects explore machines live in the browser. More convincing than slides, more accessible than installed software.
- **Maintenance & service** — Technicians open a link on their tablet, interact with 3D components, check sensor states and drive positions — on-site or remote.
- **Training & onboarding** — Operators learn machine behavior interactively before touching the real system.
- **Remote acceptance** — Share virtual commissioning models with customers for review and sign-off — worldwide, instantly.

> For building custom plugins and extending the viewer, see **[doc-extending-webviewer.md](doc-extending-webviewer.md)**.
> For how scenes, drafts, and edits are stored and resumed across reloads, see **[doc-persistence.md](doc-persistence.md)**.
> For attaching custom JavaScript/TypeScript behavior directly to a node inside the GLB (sandboxed, hot-reloaded, no separate build), see **[doc-scripting.md](doc-scripting.md)**.
> For how component and signal references are written as node paths and resolved by the `NodeRegistry` — the three naming layers, alias mechanics, resolution order — see **[doc-node-paths.md](doc-node-paths.md)**. Read it before changing anything that stores or resolves a path.

## Live signal binding

Signal linking is INLINE in the Property Inspector: every schema signal slot of
a selected component (`componentRef + signal` fields) always appears as a
two-column row in its component section — LEFT the slot name, RIGHT the
assigned signal (an internal model signal or a CONNECT signal) or "not linked".
Empty slots are shown too (e.g. `Drive_Simple` always shows Forward AND
Backward). Each row is a drop target for dragged signal chips and opens a
combined picker with two groups: **CONNECT (live)** signals and **Model
signals** (internal SignalStore entries; a slot never offers its own target
signal). A slot assigned to an internal signal shows that signal's external
CONNECT mapping as a chain indicator on the chip. Auto-assign and Unbind-all
are component-section actions with a two-click confirm.

Each persisted mapping is a Slot → Signal assignment keyed by component path,
slot kind, and slot name. `sourceKind: 'connect' | 'internal'` determines
whether `signal` resolves through a CONNECT provider or the model's
SignalStore; mappings without `sourceKind` are legacy CONNECT mappings.
Internal assignments relay through the binding manager and do not rewrite the
authored `componentRef` or mutate the GLB.

Enable **Signal link mode** from the icon bar to keep bindable component badges
visible, or Shift-drag a discovered CONNECT signal for a temporary linking
gesture. Shift-drag activates only after the pointer crosses the drag threshold
and never changes the persisted icon-bar setting. While a signal-link mode is
active (`isSignalLinkModeActive()` — the icon-bar toggle or a running signal
drag), clicking or tapping a badge without holding Shift opens the binding
popover — the in-scene quick path, rendering the SAME two-column slot rows as
the inspector. Outside an active link mode a scene click never surfaces the
popover. The popover separates **Control ·
PLC → Viewer** from **Feedback · Viewer → PLC** and validates type and
direction.

### Internal PLC signals as link targets

A raw `PLCInput*` / `PLCOutput*` node is itself a link target: the node IS the
signal, so it offers exactly ONE slot named **Value**, whose value type and
direction come straight from the signal type (`PLCOutput…` = the PLC writes it,
`PLCInput…` = the viewer writes it). This is how an integrator points an
external CONNECT tag at a model's own signals and drives the whole scene from
the outside.

All three surfaces work the same way as for component slots: the badge and drop
target in signal link mode, the **Value** row in the node's Property Inspector
section, and **Link signal…** in the hierarchy-tree context menu (right-click or
long-press on a row in the *Signals* filter).

> **Inspector row and node paths (plan-422 F3).** The inspector row locates
> itself by subtracting the bind-target root path from the selected node's path,
> and that subtraction is only sound when both are spelled the same way. A node
> is reachable under several registry keys (see `doc-node-paths.md`), and
> `selectNode()` stores whatever string its caller had — a viewport pick, a deep
> link, an MCP call, a value restored from `localStorage`. Reached through an
> ALIAS the subtraction produced the whole path instead of `.`, no row matched
> the slot, and the inspector fell through to "not offered as a link target" on
> a perfectly bindable signal. `InlineSignalSlots` now canonicalises the path
> through the registry first (`canonicalNodePath`), which is what the resolver
> does on the other side of the comparison. The menu item names the exact node
it will bind — it never falls back to an ancestor, and it disappears entirely
when the node is not bindable. The reason then stays readable on the inspector
row, which is the only surface that shows it:

| Reason | What it means |
|--------|---------------|
| *not registered in the loaded model* | The extras declare a signal the loader never registered (older GLBs) — there is nothing to write into. |
| *another node registers the same signal name* | Two nodes share one signal name. Everything below binds BY NAME, so linking one would silently drive the other; both are refused until the model is fixed. |

A bound signal is **name-keyed live-controlled**: the built-in `SetSignal*`
LogicSteps and `ConnectSignal` relays targeting it stay silent while the
external source owns it, and take over again the moment it is unlinked — a
`ConnectSignal` immediately re-copies its current source value rather than
waiting for the next source change. Custom SDK behaviors are NOT gated
automatically; a script that writes a signal must check `self.isWired` itself.

Signal nodes inside a Planner placement are not separate targets: the placement
is one aggregate element, so their **Value** slots appear in the placement's
popover and persist with the placement (`placed.signalMappings`). A free signal
node persists as a `SignalLinks` scene overlay on the node — never inside the
shared GLB.

Bindings are available for Planner placements and regular GLB component nodes.
An explicitly wired component keeps its existing **Mapped** SignalStore path.
A drive whose standard control signals were created automatically by the WEB
loader instead exposes rows that call the component's normal command methods
directly (no model signal; the row tooltip explains why forcing is
unavailable). This decision is made per component instance from loader
provenance, not from signal metadata. Direct v1 support is limited to
`Drive_Simple` (including Speed, Accelaration, and ScaleSpeed),
`Drive_Cylinder`, and `Drive_DestinationMotor`; `Drive_Speed` and
`Drive_FollowPosition` remain mapped only.

Green badges mean live, Instrument Blue means pending while CONNECT discovery or
ownership is not ready, amber means a previously known provider is disconnected,
red means a provider/type/fan-in conflict, and grey means unbound. Direct rows
always require a registered CONNECT provider; a same-named standalone signal
does not make them live. Live controls suppress only the affected component
instance. Feedback stays owned by the model and writes back through the
connected interface. See [doc-signal-architecture.md](doc-signal-architecture.md)
for the provider, priority, and liveness contracts.

During a Shift-drag, every compatible 3D target is shown proactively with a
constant-screen-size connector marker. The 50 targets nearest the camera also
receive a subtle Instrument Blue box outline. The compatible port nearest the
pointer is emphasized by swapping its marker for a larger white *active* sprite
— picked by a screen-space magnet radius (`NEAREST_MAGNET_RADIUS_PX = 42` in
`drop-target-overlay.ts`) around the cursor, with a full NDC frustum test so
off-screen ports never win. Screen distance alone let the magnet reach THROUGH
geometry (a conveyor badge behind a machine winning on pixels), so since
plan-422 the overlay depth-tests the winner: a ray from the camera to the
candidate's world position against the merged pick meshes
(`raycastManager.raycastGeometry` → `staticGroup.mesh` + the `kinematicGroups`
meshes). An occluded winner yields to the nearest UNOCCLUDED candidate in the
radius; if every candidate is occluded the screen-nearest is kept, so a drag is
never left without a target. The check runs only when the raw screen winner
CHANGES — never per frame — and `nearestCompatibleTarget()` itself stays a pure
screen-space function; no `rv-raycast-*` file is touched. **No connector line is drawn** between the drag chip
and the port. Compatibility uses the same slot type, direction, eligibility, and
binding resolution as the popover; targets that cannot accept the signal stay
unmarked. The existing scene-hover behavior continues to auto-open the binding
popover so the signal can still be dropped directly onto a slot row. All
markers disappear immediately after a drop, cancellation, model clear, or
switch away from the Three.js rendering backend.

## Quick Start

```bash
cd Assets/realvirtual-WebViewer~
npm install
npm run dev          # Vite dev server with HMR
```

Drop `.glb` files into `public/models/` and they appear in the dev model
selector - but that folder is **only for models that ship**. There are three
places, and the difference is not cosmetic:

| Place | What lives there |
|---|---|
| `public/models/` | **What is delivered.** Only the demo models `public/project.json` declares. Enforced by the `publicModels_OnlyShippedDemos` guard test. |
| `public/library/` | The delivered standard library (`PalletHandling` + `catalog.json`). |
| `../realvirtual-WebViewer-Private~/projects/Development/` | **Everything internal** - test fixtures, internal reference models, the custom library, and `scratch/` for experiments. Never delivered, never published. |

Put an experiment in `scratch/`. `public/models/` used to be where everything
landed, for the simple reason that there was nowhere else; the Development
project is that somewhere else (plan-395).

```bash
npm run build        # Production build → dist/
npm run preview      # Preview production build
npm test             # Run browser tests (headless Chromium via Playwright)
npm run test:node    # Run Node.js tests (fs, glob, ESLint — see below)
npm run test:all     # Run both: Node tests + browser tests
npm run test:watch   # Watch mode
npm run lint         # ESLint (flat-config, boundaries/dependencies rule)
```

**Test naming convention:** Files matching `tests/*.node.test.ts` run in Node
environment (use `vitest.node.config.ts`). Files matching `tests/*.test.ts` run in the
browser environment. Use the Node config for tests that require `fs`, glob imports,
or the ESLint instance itself.

## Workspace Modes

realvirtual WEB is organized into **workspace modes** — switch them from the mode
dropdown in the top-left toolbar. Exactly one mode is active at a time; switching a
mode swaps both the active plugin set and the UI (each plugin declares its mode
membership via `plugin.modes`). The same asset stays open across a switch.

**A mode selects verbs, not documents.** There is one content type — an
**asset**, which is a GLB — and every asset can be opened in every mode. What
the mode changes is which class of operation is on offer over the one op log
(see [doc-persistence.md](doc-persistence.md) §2.1a):

| Op class | What it does | Where it is offered | Reaches inside a referenced asset? |
|---|---|---|---|
| **Content** | The file's own substance: mesh, material, hierarchy, kinematics, components | Editor | **No** |
| **Composition** | Arranging *other* assets inside this one: place, transform and remove references, snap, connect | Planner | The reference nodes themselves: yes |
| **Override** | Patching values *inside* a reference — always badged, always revertible | Every mode except Viewer | Yes, and only this class |

A part simply has no references to arrange and a plant has little loose mesh to
merge, which is why the modes still feel specialised — but nothing stops you
opening either in either. A referenced asset is entered by double-clicking it:
that pushes a document frame, shows the child on its own, and **Back** returns to
the parent with its op log intact (§2.1b there).

| Mode | Purpose | What it adds |
|---|---|---|
| **Viewer** | Just look at the machine. The asset, the running kinematics, and nothing else to operate — for shared links, embedded showcases and "show the machine" deliveries, where an engineering IDE would only confuse. | Nothing. It *removes*: no authoring, no signals, no panels, no Play/Pause — the one mode where even override ops are off. What remains is Settings, the camera / view controls and the grouping overlay. Kinematics run exactly as in HMI (`runtime: 'simulation'`). |
| **HMI** (default) | Operate and monitor a running asset — the delivery / 3D-HMI view. | Live PLC signals (WebSocket / MQTT / REST), KPI overlays, message panel, drive & sensor tooltips, camera presets, measurement. |
| **DES** | Discrete-event material-flow simulation for throughput and utilization analysis — fast, event-driven rather than per-frame. | DES workspace surface, material-flow statistics, and the **Experiments window**: ONE tree — Project → Experiment → Run → Checkpoint — over full-state snapshots stored chunked in IndexedDB with NDJSON.gz export/import (see [doc-persistence.md](doc-persistence.md) §7.5). Snapshots capture the complete sim state — event queue, components, MUs, RNG streams and script-component state — so any stored point loads back with correct statistics and continues deterministically (script authors persist closure state via the `onSnapshot`/`onRestore` hooks, see [doc-scripting.md](doc-scripting.md)). **Simulation runs** are tracked automatically: every run gets a run id + master seed (fixed or auto-rolled per reset) and is archived with its statistics on reset / sim end under its experiment; **projects** are the comparison boundary. The Experiments window (opened from the DES clock settings or the DES side-tool button) shows all experiments of the active project at once — per-run status/seed/sim-time, expandable checkpoints with load-and-continue, snapshot/export/import/rename/delete on the experiment rows — and run checkboxes across the whole tree feed the project-internal multi-run compare view with mean ± 95% CI (see [doc-persistence.md](doc-persistence.md) §7.5.1). |
| **Planner** | The composition verbs: place other assets inside the open one (conveyors, robots, fixtures) on a grid, snap and position them with gizmos. Authoring, not operation — and it works on *any* asset, not only on a "layout". | Library panel, grid + snap toolbar, translate / rotate gizmos, snap-point connections. See [doc-layout-planner.md](doc-layout-planner.md). |
| **Commissioning** | Put a machine into operation — usually one that arrived through a shared link. The lean surface of the Viewer, *minus* the operator HMI and *plus* the integrator's instruments. Override ops are on here, content and composition are not. | Property Inspector, Hierarchy, the CONNECT panel and its opener, the AI-bridge entry (MCP), and the tools: Signal Link mode, Test Axes, Measure, Section/Clip. It *removes* the operator chrome: KPI cards, message stack, views slot, AI activity overlay. Kinematics run (`runtime: 'simulation'`). |
| **Editor** *(commercial)* | The content verbs on the open asset's own substance: import CAD, restructure the hierarchy, split and merge meshes, assign materials, add components. The only mode registered with `runtime: 'detached'` — the `SimulationRuntime` performs **no** time integration here, because this is authoring, not simulation. | Op log with undo, Materials window, Mesh Separator / Mesh Merge, unified CAD import, `preserveHierarchy` loading (no uber bake, every node keeps its own material). |

**The six modes in one line:** Viewer *only shows* an asset, HMI *runs and shows* it,
DES *analyses material flow through* it, Planner *composes other assets into* it,
Commissioning *connects it to your plant*, Editor *authors its own content*.

Switch modes via the dropdown or the `?mode=viewer|hmi|des|planner|commissioning|editor` URL parameter, so a
shared link can boot directly into a workspace (e.g. `?doc=<documentId>&mode=planner`).
A locked-down deployment can pin a single mode (the dropdown then hides).

Inside an **iframe** the mode switcher additionally disappears: embedding a viewer in a foreign
page should not offer a way out into the full app. This is driven by the `embedded` UI context
(set at boot from `window.self !== window.top`), so a deployment can re-enable the switcher
through `ui.visibilityOverrides` for the `mode-switcher` element.

### Editor continuity — what opens, and testing without leaving

Switching into the Editor should feel like picking up a tool, not like starting
an app. Three behaviours make that true (plan-410):

**It opens what you were looking at.** Select a placed object in the Planner and
switch to the Editor: it opens the library asset that object was placed from.
The selection is read at the *start* of the switch, before the Planner clears
it — so this works from the dropdown, no separate "Edit asset" click needed.
Objects without a local library origin (cloud/provider assets, splats, DES
gizmos, plain scene nodes) fall through to the next step.

**It remembers where you left off.** With nothing selected, the Editor re-opens
the asset you last worked on — across a browser restart. The full order is:
an explicit *Edit asset* request, then a recovered draft, then any draft you set
aside earlier, then the last edited asset, and only then a blank *Untitled*.

**Drafts are never lost.** If you have unsaved work and then ask to edit a
different asset, the Editor asks: continue the draft, discard it, or open the
requested asset. Choosing the last one **sets the draft aside** rather than
dropping it — it is offered again the next time you enter the Editor with
nothing specific to open, and only an explicit discard deletes it.

**The scene you are looking at stays the document you are editing.** When the
Editor opens the very scene the Planner/HMI/DES side is already showing, the two
do not run two copies any more — they are two *projections of one document*
(plan-711). One change made in either is there in the other, **one Undo stack**
reaches across the switch (undo an editor change from the Planner, or a Planner
placement from the Editor), the unsaved dot means the same thing on both sides,
and Save writes the same scene from either. The card does not flash a "handed
over between modes" state any more, because nothing is handed over.

What the switch does under the hood is a *recompose*, not a second load: the
tree is rebuilt for the projection you are entering and the log is put back on
top of it — so the switch costs what it always cost (the scene reloads either
way) and nothing about your history is rebuilt from a file. Two details are
worth knowing as a user:

- **Discard, while the Editor holds a shared scene, really discards.** It rolls
  back exactly the changes made since you entered the Editor; the Planner never
  sees them.
- **Editing a *different* document is unchanged.** The Editor opens it beside
  the scene exactly as before, the scene is restored on the way back, and the
  two documents keep their own histories.

**Test the asset where you are authoring it.** The **▶ Test** button sits top
left, in the same action group the Planner and DES put their sim controls in. It
materialises the current state exactly the way saving would, and runs it: drives
move, signals switch, LogicSteps sequence. Authoring stays locked while it lasts
— what you see is a running copy, not the document, and the authoring buttons
say so by going grey (their tooltips name the reason).

While a run is live the group grows into the Planner's controls, the same ones:
**⏸ Pause**, **↺ Reset**, the speed factor and the elapsed sim clock. They sit
next to a **■ Stop**, and the two are not the same verb — Pause holds *time*
inside the run, Stop ends the *run*. Only Stop gives the authoring tools back,
and it puts the authoring state back precisely: node transforms, the unsaved
marker, and both the undo *and* redo history are exactly as before. Switching
modes during a run stops it first, then switches.

Each of these transitions reloads the scene, which is why a short *"Preparing
test run…"* / *"Leaving editor…"* overlay appears instead of a blank viewport.
Big assets take a moment on both edges of a test run — that is the export and
re-import that guarantee the test behaves like the saved asset.

### Pending placements (Planner)

Dragging a library asset must not wait for its GLB — a large CAD asset can take
ten seconds to fetch and decode. A **pending placement** is a fully committed
placement whose root node temporarily carries *placeholder* geometry. It is not a
draft and not a special store state: `PlacedComponent` carries its `glbUrl` from
the first frame, so in the layout store a pending placement is indistinguishable
from a finished one, and it can be moved, snapped, selected, deleted and undone
while its geometry is still decoding.

The drag sequence (all files in `src/plugins/layout-planner/`):

| Step | What happens |
|---|---|
| **Hover** a library card | After an 80 ms intent delay (`PREFETCH_INTENT_MS`, `LayoutLibraryPanel.tsx`) the card warms its geometry — `ModelCache.prefetch(url)` for a catalog entry, `prefetchEntry` → `prefetchResolved(cacheKey, …)` for a project document. `pointerdown` fires it immediately — touch has no hover. Virtual/DES and splat entries are skipped: they never take this path. |
| **`dragstart`** | `_startGlbDraft` builds a catalog-sized wireframe box with an optional thumbnail billboard (`placeholder-node.ts`, well under a millisecond) and registers it as a real placement in **`light`** mode. `_moveDraft` therefore works from the very first pointer frame. |
| **`drop`** | `_commitDraft` records the store entry and the `addPlacement` undo op immediately. The gesture never blocks, and the user can start the next drag. |
| **decode lands** | `swapPlacedGeometry` (`scene-mutations.ts`) replaces the placeholder's **children** under the same root and re-registers the placement in **`full`** mode. |

Entry-kind routing happens first (`_startDraft`): only GLB assets get a
placeholder. Virtual/DES entries are detected by the `virtual` **flag** (their
`glbUrl` is the empty string, not `undefined`) and keep the existing synchronous
ghost path; splats are still placed via `placeComponent`.

**`light` vs `full` registration.** Both modes clear the preview flags, run
`resolveUniqueName`, fill `objectMap`/`idByObject`, register the root in the
`NodeRegistry`, add raycast aux targets and dirty the shadow map — so a
placeholder is addressable by path and hittable like any placement.
`full` additionally runs the naming-convention scan, `processExtras`
(signals / drives / components), behavior dispatch, LogicStep merge, snap-port
registration, the grouped-BVH rebuild and the `layout-content-added` event. A
placeholder has no `userData.realvirtual` to process, and running `processExtras`
twice would duplicate or orphan its registrations. `mode` defaults to `'full'`
everywhere — exactly one call site passes `'light'`.

While a placement is pending, **snap-point mating is skipped** (the box has no
real ports); grid snap, magnetic bbox snap and drop-to-surface work purely on the
AABB and stay active. Real ports become available for the *next* drag once the
swap has landed — a dropped object never re-snaps itself.

**Two cache layers, two kinds of de-duplication** (`model-cache.ts`,
`core/engine/rv-asset-blob-cache.ts`): the blob cache de-duplicates in-flight
*fetches* URL-wide and persists bytes in the Cache API bucket `rv-planner-glbs`;
`ModelCache._inflight` de-duplicates in-flight *decodes*, which is what makes the
hover prefetch pay off — the drag's own `getOrLoad` joins the prefetch's promise
instead of decoding the same GLB a second time. Every caller still receives its
own `.clone()`; only the decode is shared. `getOrLoad(url, { signal })` detaches
*this* consumer on abort and deliberately lets the shared work finish, so
deleting one placement cannot tear down an unrelated second placement of the
same asset.

**Feedback and failure.** A pending placeholder pulses at 1.5 Hz through the
shared `GizmoOverlayManager` (`pending-pulse.ts`; `prefers-reduced-motion: reduce`
switches the pulse **off** rather than damping it), and a status tile in the
`'messages'` slot names each loading asset (`PendingLoadMessage.tsx`, no progress
bar — `LoadingManager.onProgress` is unreliable for GLTF). A failed load leaves
the placement in place and marks it red **and** dashed **and** badged, with
**Wiederholen** / **Entfernen** on the status tile. Retry bumps the load's
generation without creating a new undo entry — the placement itself was never
rolled back.

See [doc-lifecycle.md](doc-lifecycle.md) §3.4 for the swap order and the
cancellation paths, and [doc-layout-planner.md](doc-layout-planner.md) for
pivot, snap and library semantics.

### The Planner's Library window

The dropdown is fed from the **library source registry**
(`core/library/library-source-registry.ts`) — the same list the Projects
dashboard reads — and not from `LibraryStore.catalogUrls`. That is what puts the
**active project first, and makes it the default selection**: a project *is* a
library, and since plan-716 every document it owns (`scenes/`, `models/`,
`library/`) is one placeable kind, filtered by the existing folder chips rather
than by which folder it sits in.

| Source | Where the tab comes from | Tab id |
|---|---|---|
| Active project (or a bundled deploy) | registry provider `project` | `project:<projectId>` |
| Subscribed catalogs (URL / GitHub / bundled) | registry provider `global`, itself a bridge over `LibraryStore` | `global:<url>` |
| Asset Manager connections | `plugin.cloudStore` — the registry's `unity-asset-manager` provider is filtered OUT so each connection appears once | `am:<connId>` |

Three rules are easy to get wrong and are therefore pure, exported and tested
(`buildLibraryTabs`, `resolveDefaultTab`, `storeTabUrlOf` in
`LayoutLibraryPanel.tsx`; `tests/layout-library-panel-registry.test.ts`):

- **Selection persistence is split.** A `global:` pick still writes
  `LibraryStore.setActiveTab(url)` — a catalog can stay the default. A
  `project:` or `am:` pick cannot: `setActiveTab` ignores anything that is not a
  known catalog URL, so those go to the panel key `rv-planner-active-library`,
  which is also read first and can express every tab. A legacy bare-URL value is
  re-prefixed on read.
- **Deploy dedup, project wins.** A deployed standard catalog and the project's
  own `library/` list the same files. `crossSourceKeyOf`
  (`core/hmi/projects/assets-library-groups.ts`) is the canonical identity — the
  path below the last `library/` segment — and colliding entries are hidden from
  the *catalog* tab. A tab left with nothing disappears from the dropdown.
  Entries with no `library/` segment have no identity and are never deduped.
- **Dedup waits for `loaded: true`.** Deduplicating against a half-filled
  project source would make catalog cards blink out and back in during the async
  listing.

**Placing a project document.** Its catalog entry carries `glbUrl: ''`, because
`LibrarySource.resolveAsset()` mints a fresh, volatile `blob:` URL per call.
Every placement path — drag, click, snap, duplicate, restore, preview — goes
through the single `LayoutPlannerPlugin.loadEntryModel(entry)`, which finds the
owning source by asset id (`findRegistryOrigin`) and loads through
`ModelCache.getOrLoadResolved(cacheKey, resolve)`. The cache key is the asset's
stable identity, `resolved:<providerId>:<sourceId>:<entryId>` — never the URL,
which would guarantee a cache miss every time — and the cache owns the
`revokeUrl` obligation in the success, failure *and* abort paths. Saving the
document in the editor evicts that key (`document-saved`), so the next placement
re-reads the new bytes.

### Public material-flow kernel contracts

The public material-flow API describes event-safe state without importing the
private DES engine. `MaterialFlowSelf` exposes the MUs currently held by a
component through `self.mus`, together with `currentLoad`, `reservedLoad`,
`downstreamFreeCapacity()`, `reserveDownstream()`, and `reservation()`. A
`ReservationRecord` is JSON data for one active capacity promise; it identifies
holder, target, optional port, quantity, and optional carrier slots by stable
`MuRef`. The runtime `ReservationHandle` commits a batch atomically or rolls the
record back.

`FrozenDescriptor` is the JSON-only representation of scheduled work paused by
a component failure. It stores the named action, optional MU reference, payload,
remaining time, and position/path tween data. No live event or tween handle is
part of this contract, so the private runner can resolve actions and paths again
after snapshot restore.

`self.pathTween()` creates a data-only path tween for a duration event. Persisted
events use a stable `pathRef` plus arc-length addresses in metres; FastForward
does not write transforms and settles the MU at the exact path position when a
visual is available again. The same `self` surface also provides convention-based
node access (`find()`/`findAll()` for single or multiple transport axes), typed
signals, ports, scheduling, statistics, MU transfer/spawn, and the snapshot-safe
`self.prop` state bag.

`self.axesTween(anchorRef, phases, ease)` creates a JSON-safe multi-axis spec.
Each phase uses normalized `at0`/`at1` event-window fractions and stable drive
paths, so one duration event can stage several robot poses. The public
`TweenRegistry.addDrive()` options expose `ease: 'linear' | 'scurve'` and
`writePolicy: 'always' | 'finalOnly'`. `finalOnly` suppresses intermediate axis
writes while FastForward is active; reasoned `settle()` calls distinguish normal
event-time settling from the final FastForward-exit pose.

## Shared asset links (`?glb=`)

One URL, one parameter, and whoever opens it stands in front of the running
machine — no login, no install (plan-386).

```
https://web.realvirtual.io/?glb=s:<id>                       # hosted by us
https://web.realvirtual.io/?glb=https://host/pick-cell.glb   # hosted by you
```

**There is no content type in the link.** A component, an assembly and a whole
plant are all a GLB and all land in the same viewer. What the thing *is* lives
in the file (`rv_share.level`) and only matters at the moment of escalation.

| Form | Meaning |
|---|---|
| `?glb=s:<id>` | a share **we** host. Opaque: the link carries no storage address and is resolved at runtime to a short-lived signed URL. Buys revocation, a reason code on `410`, and access counts. A hurdle, **not DRM** — the browser has to load the bytes eventually. |
| `?glb=<absolute http(s) url>` | your own host (GitHub raw, a CDN, your server). Nothing is uploaded and no sign-in is needed. |

Precedence on boot: `?doc=` > `?scene=` (a permanent alias, redirected to `?doc=`) >
`?glb=` > `?model=` > the last open document > `defaultModel`. `&mode=` always
wins over the default viewer mode.

### The demo is a project

Since plan-726 there is no channel that opens "the demo model". `public/project.json`
is an authored, checked-in manifest — `id: prj_sample`, slug `demorealvirtual` — and it
is the single source of truth for what the demo contains and what it starts with. All
four delivery channels boot through it:

| Channel | What happens |
|---|---|
| Hosted demo (`web.realvirtual.io`) | `/` opens the project and loads its start document straight into 3D. No dashboard in between. |
| Community download (CONNECT embed) | The gate's "Start the demo" opens the same project and the same start document out of the bundled manifest. |
| Dev checkout | Identical, because the manifest is in `public/` and is served in dev too. |
| Share / embed links | `?doc=<id>` addresses a document of that project; `?project=demorealvirtual` selects the project by slug. |

Three rules follow from it, and each of them is load-bearing:

- **The document ids are derived, never invented.** They are
  `stableDocumentId(path)` — the same function that produces the ids
  `openDocument()` writes into the address bar. A hand-written id would break
  every `?doc=` link the app itself has already handed out.
- **The demo is read-only.** `BundledBackend` is HTTP; there is nothing to write
  to. Saving goes through the existing "Save into project as…" path and lands in
  the writable *My Workspace* project.
- **A broken manifest degrades, it does not break.** A 404, unparseable JSON, or
  a manifest that fails `isValidProjectV2()` falls back to the synthetic demo
  project **and logs a warning** — the demo still loads.

The start-document reference is matched leniently by `findStartDocument()`: exact
path, then id, then a *unique* file name. That last branch exists because five
delivered customer manifests carry a bare filename against a `models/`-prefixed
path; an ambiguous name is refused rather than guessed.

> **Dev built-ins are not the product path.** Dropping a `.glb` into
> `public/models/` still makes it selectable in the dev model list. It does **not**
> make it part of the demo — only `public/project.json` does, and only what that
> file declares is deployed.

### The receiver's view is part of the link

The Share dialog asks **what the recipient should get**, and the answer rides in the link as
`&mode=`:

| Choice | Link | The recipient lands in |
|---|---|---|
| **View only** (default) | `…?glb=…&mode=viewer` | the spectator workspace: the model and its running kinematics |
| **Commissioning** | `…?glb=…&mode=commissioning` | Inspector, Hierarchy, CONNECT and the signal tools |

Before plan-423 a shared link carried no mode at all, so the receiver was dropped into whatever
workspace *his* browser last remembered — usually the operator HMI of a machine he had never
seen.

### Trusting a shared model with your own plant

A shared GLB is loaded **untrusted**: no signal binding manager, no interface auto-connect, no
CONNECT per-model stream (see *What a shared link may and may not do* above). For a spectator
that is the whole point; for the integrator in the Commissioning workspace it is the job, so the
banner there offers one explicit decision — *Allow live connections* — in plain words, naming the
consequence.

- **What is remembered:** the share id (or the normalised own URL) **plus a SHA-256 digest of the
  bytes that were loaded**, under the single localStorage key `rv-share-trust`. Both must match on
  the next visit. Different bytes behind the same link fall back to untrusted and ask again — the
  decision was about a machine somebody looked at, not about an address.
- **How it takes effect:** by reloading. All four gates are decided *during* the load, so the
  page re-enters the one path that is exercised on every visit rather than re-deriving the
  binding manager in a running viewer. The confirmation says so, including that unsaved changes
  to the shared model are lost — a shared link keeps no draft.
- **Withdrawing it:** the same banner offers *Revoke live connections* while a model is trusted;
  it deletes exactly that one record and reloads. Decisions about other shared models are
  untouched.
- **This is not a signature unlock.** plan-397's chain is a separate brake with its own key
  (`rv-sig-unlock:<model>`): an `invalid` or `unverifiable` signature stays gated after the trust
  decision until *Activate logic* is clicked on the signature banner. Trusting a model never
  writes, reads or bypasses that.
- **Writing stays CONNECT's decision.** Forcing, binding and MCP writes go through exactly the
  same functions as in the HMI workspace; whether they reach a PLC is decided by the CONNECT
  gateway's write access, not by the viewer.

### What a shared link may and may not do

- **No trace at the receiver.** A shared link writes no scene draft, no
  active-scene pointer and no last-model entry — not even after editing (F7).
  The one exception is "Add to my library", which is the visitor explicitly
  asking. See doc-persistence.md § *Transient workspaces*.
- **No automatic PLC connection.** Foreign content is loaded untrusted:
  interface auto-connect, the CONNECT per-model stream and live signal binding
  are all gated. The local simulation keeps running — that is what the link
  exists to show.
- **Byte budget.** The download is streamed with a running byte count and an
  `AbortController`; `Content-Length` is treated as a hint, never as a limit.
- **`http(s)` only.** `data:`, `blob:`, `file:` and `javascript:` are refused
  before anything touches the network.

### Metadata travels inside the GLB

There is no sidecar. `rv_share` sits in the scene's `extras` and is written by
`exportAssetGlb(root, name, shareMeta)`:

```ts
interface RvShareMeta {
  v: 1;
  name?: string; author?: string; license?: string;   // SPDX short form
  level?: 'component' | 'assembly' | 'model';
  category?: string; footprintMm?: [number, number]; tags?: string[]; homepage?: string;
  expiresAt?: string;        // ISO 8601 — only when a deadline was chosen
  allowDownload?: boolean;   // false hides the receiver's download button
}
```

Everything is optional: a GLB that was never stamped still opens, and the card
falls back to the filename plus the origin host. On re-export the block is
**replaced, never merged** — and dropped entirely when no `shareMeta` is
supplied, so a re-published file cannot keep claiming the previous author.

### Retention

Links **stay** by default: one in an offer or a piece of documentation should
still work in six months. The sender may choose a deadline (7 / 30 / 90 days)
when sharing, and can delete any share immediately from *My shared links*.
After either, the link answers `410` — with a reason code where the server
supplies one, so the viewer can distinguish "expired" from "deleted by its
owner" instead of guessing.

Uploading to us requires a sign-in (magic link, passwordless): we host the file
indefinitely, so it has to be attributable and the sender needs a way to clean
up. Sharing your **own** URL needs no sign-in — we host nothing.

### Where the code lives

| File | Role |
|---|---|
| `src/core/share/rv-share-target.ts` | the two `?glb=` forms; link builder and parser |
| `src/core/share/rv-share-fetch.ts` | streamed GET, byte budget, scheme whitelist, error classification |
| `src/core/share/rv-share-boot.ts` | the boot branch; calls `RVViewer.loadModel()` directly |
| `src/core/share/rv-share-meta.ts` | `rv_share` parsing and fallbacks |
| `src/core/share/rv-share-session.ts` | magic-link session, dialog draft |
| `src/core/share/rv-share-upload.ts` | signed upload client, my-shares, opaque-id resolver |
| `src/core/share/rv-share-escalate.ts` | "Open in realvirtual WEB" |
| `src/core/share/shared-asset-bookmarks.ts` | "Add to my library" |
| `src/core/share/rv-share-backend-contract.md` | the HTTP contract the server must implement |

## Architecture

```
src/
├── main.ts                              # Entry: viewer creation, plugin registration, HMI init
├── rv-test-runner.ts                    # Dev-only in-browser test runner
├── core/
│   ├── rv-viewer.ts                     # RVViewer facade (scene, sim loop, plugins, events)
│   ├── rv-camera-manager.ts             # Camera (projection, animation, viewport offset)
│   ├── rv-visual-settings-manager.ts    # Lighting, shadows, tone mapping
│   ├── rv-app-config.ts                 # App config singleton (settings.json, lock mode)
│   ├── rv-plugin.ts                     # RVViewerPlugin interface (lifecycle + optional UI slots)
│   ├── rv-behavior.ts                   # RVBehavior abstract base class (MonoBehaviour-like)
│   ├── rv-events.ts                     # Typed EventEmitter<TEvents>
│   ├── rv-model-plugin-manager.ts       # Per-model dynamic plugin loading/unloading
│   ├── rv-ui-plugin.ts                  # UISlot types, UISlotEntry
│   ├── rv-ui-registry.ts                # UIPluginRegistry (slot component lookup)
│   ├── maintenance-parser.ts            # MaintenancePanel content parser
│   ├── types/plugin-types.ts            # Shared plugin API types (decouples core↔plugins)
│   ├── engine/                          # Simulation engine subsystems
│   │   ├── rv-scene-loader.ts           # GLB loading, two-phase component construction
│   │   ├── rv-node-registry.ts          # Object discovery (path, type, hierarchy)
│   │   ├── rv-component-registry.ts     # Schema-based auto-mapping (C# → TS) + capability registry
│   │   ├── rv-model-config.ts           # Per-model plugin config (modelname.json + GLB extras)
│   │   ├── rv-plugin-loader.ts          # Dynamic ESM plugin loading
│   │   ├── rv-simulation-loop.ts        # Fixed 60 Hz accumulator (XR-compatible)
│   │   ├── rv-debug.ts                  # Structured category-based debug logging + ring buffer
│   │   ├── rv-constants.ts              # Shared numeric constants (MM_TO_METERS, etc.)
│   │   ├── rv-coordinate-utils.ts       # Unity ↔ glTF coord conversions
│   │   ├── rv-active-only.ts            # Active-only sub-tree marker
│   │   │
│   │   │── # Components (ports of Unity C#) ───────────────────────────────
│   │   ├── rv-drive.ts                  # RVDrive (Drive.cs)
│   │   ├── rv-drive-simple.ts           # Drive_Simple
│   │   ├── rv-drive-cylinder.ts         # Drive_Cylinder
│   │   ├── rv-drives-playback.ts        # DrivesRecorder playback
│   │   ├── rv-drive-recorder.ts         # Drive data recording
│   │   ├── rv-replay-recording.ts       # ReplayRecording component
│   │   ├── rv-erratic.ts                # Drive_ErraticPosition
│   │   ├── rv-mu.ts                     # MovingUnit (incl. instanced MU pool)
│   │   ├── rv-source.ts                 # MU spawner
│   │   ├── rv-sink.ts                   # MU consumer
│   │   ├── rv-sensor.ts                 # AABB sensor
│   │   ├── rv-sensor-recorder.ts        # Sensor history sampler
│   │   ├── rv-transport-surface.ts      # Conveyor surface
│   │   ├── rv-transport-manager.ts      # Sources → surfaces → sensors → sinks
│   │   ├── rv-path.ts                   # RVPath substrate (line/arc segments, rv_extras.Path schema)
│   │   ├── rv-path-network.ts           # Path graph (successors, routing hooks, project router)
│   │   ├── rv-path-traveler.ts          # Arc-length movement scalar along the path graph
│   │   ├── rv-spacing-controller.ts     # 1D arc-length headway (car following, raycast-free)
│   │   ├── rv-zone-registry.ts          # Zone reservation (control-point model, claim/release)
│   │   ├── rv-grip.ts / rv-grip-target.ts  # Gripping
│   │   ├── rv-signal-store.ts           # PLC signal pub/sub
│   │   ├── rv-signal-wiring.ts          # Signal routing (ConnectSignal)
│   │   ├── rv-connect-signal.ts         # Signal connection component
│   │   ├── rv-logic-step.ts             # LogicStep base + step types
│   │   ├── rv-logic-engine.ts           # LogicStep tree builder
│   │   ├── rv-pipe-flow.ts              # Process pipe flow propagation
│   │   ├── rv-tank-fill.ts              # Tank fill visualization
│   │   ├── rv-safety-door.ts            # Safety door / hazard zone halo
│   │   ├── rv-machining-registry.ts     # MachiningProvider seam (open, Three.js-free) + kill-switch
│   │   ├── rv-machining-volume.ts       # RVMachiningVolume (MachiningVolume.cs) — SDF grid + chunk meshes
│   │   ├── rv-machining-tool.ts         # RVMachiningTool (MachiningTool.cs) — cutter geometry (data-only)
│   │   ├── rv-machining-manager.ts      # Per-tick driver: sweep, segment coalescing, reset, signals
│   │   │
│   │   │── # Rendering, raycast, optimization ────────────────────────────
│   │   ├── rv-raycast-manager.ts        # Unified hover/click/XR raycaster
│   │   ├── rv-raycast-geometry.ts       # BVH groups + face-range hit resolution
│   │   ├── rv-highlight-manager.ts      # Highlight overlays + edge glow
│   │   ├── rv-selection-manager.ts      # Selection state + events
│   │   ├── rv-gizmo-manager.ts          # Generic 3D gizmo overlays (sensors, etc.)
│   │   ├── rv-batched-render.ts         # Motion-blob BatchedMesh arenas (static + per-drive; uber + per-material)
│   │   ├── rv-batch-table.ts            # Arena registry + source-mesh → instance map
│   │   ├── rv-batch-visibility.ts       # Per-instance visibility reconcile (setVisibleAt)
│   │   ├── rv-uber-material.ts          # Uber-material (PBR atlas-shared)
│   │   ├── rv-material-dedup.ts         # Material deduplication
│   │   │
│   │   │── # Plumbing ────────────────────────────────────────────────────
│   │   ├── rv-aabb.ts                   # AABB primitive
│   │   ├── rv-ring-buffer.ts            # Generic RingBuffer
│   │   ├── rv-group-registry.ts         # Group definitions and visibility
│   │   ├── rv-xr-manager.ts             # WebXR session management
│   │   ├── rv-xr-hit-test.ts            # AR hit-test reticle
│   │   ├── rv-avatar-manager.ts         # Multiuser 3D avatar rendering
│   │   ├── rv-mcp-tools.ts              # @McpTool / @McpParam decorators
│   │   ├── rv-component-event-dispatcher.ts # Per-component onHover/onClick/onSelect routing
│   │   ├── rv-auto-filter-registry.ts   # Type-based auto filter registration
│   │   └── rv-extras-validator.ts       # Dev-mode GLB extras parity checker
│   └── hmi/                             # React HMI layout components (MUI-based)
│       ├── rv-app-config.ts             # DEPRECATED re-export barrel → import from core/rv-app-config.ts
│       ├── ui-context-store.ts          # Context-aware UI visibility (activateContext, useUIVisible)
│       ├── context-menu-store.ts        # Plugin-extensible right-click context menus
│       ├── visual-settings-store.ts     # Visual settings (shadows, light, cameras)
│       ├── search-settings-store.ts     # Search/filter settings
│       ├── rv-storage-keys.ts           # Central localStorage key registry
│       ├── App.tsx                      # Root layout (minimal public shell)
│       ├── HMIShell.tsx                 # SlotRenderer for plugin UI
│       ├── KpiBar.tsx                   # Top KPI card container (slot: kpi-bar)
│       ├── ButtonPanel.tsx              # Left sidebar with nav buttons (slot: button-group)
│       ├── MessagePanel.tsx             # Right message panel (slot: messages)
│       ├── settings/                    # Settings panel tabs (extracted from TopBar)
│       │   ├── ModelTab.tsx             # Model/renderer selection
│       │   ├── VisualTab.tsx            # Lighting, shadows, tone mapping
│       │   ├── InterfacesTab.tsx        # WebSocket/MQTT/ctrlX config
│       │   ├── DevToolsTab.tsx          # FPS, benchmarks, debug
│       │   └── TestsTab.tsx             # Feature test runner
│       ├── TopBar.tsx, BottomBar.tsx     # Top/bottom bars
│       ├── KpiCard.tsx, TileCard.tsx     # Reusable card components
│       ├── LeftPanel.tsx                # Standardized docked left panel
│       ├── MachineControlPanel.tsx      # Machine start/stop/mode control
│       ├── MaintenancePanel.tsx         # Maintenance step guides
│       ├── GroupsOverlay.tsx            # Group visibility toggles
│       ├── left-panel-manager.ts        # LeftPanel mutual exclusion coordinator
│       ├── layout-constants.ts          # Shared positioning constants
│       ├── shared-sx.ts                 # Reusable MUI sx style fragments
│       ├── chart-theme.ts              # Shared ECharts theme constants
│       ├── chart-constants.ts           # Chart color/size constants
│       ├── group-visibility-store.ts    # Group visibility state
│       └── tooltip/                       # Generic tooltip system
│           ├── tooltip-store.ts           # TooltipStore (useSyncExternalStore, priority resolution)
│           ├── tooltip-registry.ts        # TooltipContentRegistry (content-type → React, data resolvers, search resolvers)
│           ├── tooltip-utils.ts           # 3D→screen projection, viewport clamping
│           ├── TooltipLayer.tsx           # Tooltip renderer (glassmorphism, cursor/world/fixed)
│           ├── GenericTooltipController.tsx # Single headless controller — reads rv_extras + _rvPdfLinks, calls resolvers
│           ├── DriveTooltipContent.tsx    # Drive content provider + data resolver
│           ├── MetadataTooltipContent.tsx # RuntimeMetadata content provider
│           ├── PipeTooltipContent.tsx     # Pipe/flow content provider
│           ├── PumpTooltipContent.tsx     # Pump content provider
│           ├── TankTooltipContent.tsx     # Tank content provider
│           ├── ProcessingUnitTooltipContent.tsx
│           ├── PdfTooltipSection.tsx      # Generic PDF links section (auto-stacked)
│           └── index.ts                   # Barrel export
├── private-stubs/                       # No-op fallbacks when private folder absent
│   ├── private-plugins.ts              # export function registerPrivatePlugins() {} // no-op
│   └── custom/
│       └── hmi-entry.tsx               # HMI entry (React root) — mounts core/hmi/App.tsx.
│                                       #   Imported as `@rv-private/custom/hmi-entry`;
│                                       #   the private build overrides it.
├── interfaces/                          # Industrial interface plugins
│   ├── interface-manager.ts             # Interface coordinator (mutex, auto-connect) — core: true
│   ├── interface-settings-store.ts      # Interface settings (WS, MQTT, ctrlX)
│   ├── base-industrial-interface.ts     # Abstract interface base class
│   ├── signal-transport-core.ts         # Shared transport/framing core
│   ├── signal-transport.worker.ts       # Off-main-thread signal transport worker
│   ├── reconnect-policy.ts              # Shared backoff/reconnect policy
│   ├── websocket-realtime-interface.ts  # WebSocket Realtime protocol
│   ├── mqtt-interface.ts                # MQTT protocol
│   ├── twincat-hmi-interface.ts         # Beckhoff TwinCAT HMI protocol
│   └── ctrlx-interface.ts              # Bosch Rexroth ctrlX protocol
├── plugins/                             # Plugin implementations
│   │  # Core (`core: true` — always loaded, survive model switches) ───
│   ├── sensor-monitor-plugin.ts         # Event-based sensor monitoring
│   ├── transport-stats-plugin.ts        # 10 Hz RingBuffer transport stats
│   ├── camera-events-plugin.ts          # Camera animation done events
│   ├── drive-order-plugin.ts            # Topological CAM/Gear drive sort
│   ├── camera-startpos-plugin.tsx       # Per-model camera start position
│   ├── connection-system-plugin.ts      # Typed connections (edges, StopOnExit)
│   ├── adaptive-nav-plugin.ts           # Distance-adaptive navigation
│   ├── kiosk-plugin.tsx                 # Kiosk / idle-tour mode
│   ├── signal-bind/                     # Signal-link mode, popover, drop targets
│   │  # Dev-only (NOT core) ────────────────────────────────────────────
│   ├── debug-endpoint-plugin.ts         # /__api/debug HTTP endpoint (dev)
│   ├── mcp-bridge-plugin.ts             # Claude MCP WebSocket bridge (dev)
│   │  # Optional / model-specific ─────────────────────────────────────
│   ├── layout-planner/                  # Planner mode: library panel, gizmos, placements
│   │   └── LayoutLibraryPanel.tsx       # Layout planner library panel (multi-tab)
│   ├── multiuser-plugin.ts              # Multi-user presence + avatars + relay
│   ├── webxr-plugin.ts                  # WebXR VR/AR support
│   ├── fpv-plugin.tsx                   # First-person WASD navigation
│   ├── annotation-plugin.ts             # 3D markers, labels, drawing
│   ├── rv-annotation-renderer.ts        # Annotation render helpers
│   ├── aas-link-plugin.tsx              # AAS / AASX linking + tooltip
│   ├── aas-link-parser.ts               # AASX ZIP/index parser
│   ├── docs-browser-plugin.tsx          # PDF / docs browser panel
│   ├── blueprint-plugin.ts              # Blueprint / 2D plan view
│   ├── drive-recorder-plugin.ts         # Drive recording (runtime)
│   ├── sensor-recorder-plugin.ts        # Sensor history recording
│   ├── order-manager-plugin.tsx         # Production order manager
│   │  # Demo model plugins (loaded per-model) ─────────────────────────
│   ├── demo/
│   │   ├── index.ts                     # Barrel exports
│   │   ├── kpi-demo-plugin.ts           # OEE/Parts/CycleTime demo data
│   │   ├── demo-hmi-plugin.tsx          # Demo KPI cards, buttons, messages
│   │   ├── robot-alarm/                 # FANUC CRX "Ask AI" alarm assistant
│   │   ├── machine-control-plugin.ts    # Machine start/stop panel
│   │   ├── maintenance-plugin.ts        # Maintenance checklists
│   │   ├── test-axes-plugin.tsx         # Manual axis control slider
│   │   ├── perf-test-plugin.ts          # Performance benchmark (?perf)
│   │   ├── DriveChartOverlay.tsx, SensorChartOverlay.tsx  # draggable chart overlays
│   │   └── OeeChart.tsx, PartsChart.tsx, CycleTimeChart.tsx, EnergyChart.tsx
│   └── models/                          # Per-model plugin entry points
│       └── DemoRealvirtualWeb/index.ts  # Registers demo model plugins
├── hooks/                               # React hooks (see hook table in extending guide)
└── ...
```

**Tests** live in [tests/](tests/) (Vitest browser-mode) and [e2e/](e2e/) (Playwright). For the current inventory run `ls tests/*.test.*`; for a particular suite, run `npx vitest run -t '<name>'`.

> **Note:** The `~` suffix in `realvirtual-WebViewer~` prevents Unity from importing `node_modules/`.

## Data Flow

```
Unity GLB Export (UnityGLTF + GLBComponentSerializer)
  → GLB with node.extras.realvirtual.{Drive, TransportSurface, Sensor, Source, Sink, ...}
  → Three.js GLTFLoader → node.userData.realvirtual.*
  → rv-scene-loader.ts: Two-phase construction (register nodes, then build typed instances)
  → LoadResult { drives[], transportManager, signalStore, registry, logicEngine, playback }
  → viewer.use(plugin) — Register plugins
  → SimulationLoop (60Hz fixedUpdate):
      1. LogicEngine         — LogicStep sequencing
      2. Playback            — Recording playback
      3. Plugins Pre         — Set drive targets (ErraticDriver, ReplayRecording, etc.)
      4. Drive physics       — Sorted: master before slave (DriveOrderPlugin)
      5. Transport           — Sources → Surfaces → Sensors → Sinks
      6. Plugins Post        — Sample data (SensorMonitor, TransportStats, DriveRecorder)
      7. Plugins Render      — Camera events, visual overlays
```

## Plugin System

All extensions use the `RVViewerPlugin` interface. `viewer.use(plugin)` calls `plugin.init?(viewer, context)`, giving each plugin a `PluginContext` — a narrower facade over scene, camera, controls, simLoop, and the signal/node/transport live-getters.

For convenience, extend `BaseViewerPlugin` (context-aware) or `RVBehavior` (MonoBehaviour-like, also context-aware) instead of implementing `RVViewerPlugin` directly:

```typescript
// Raw interface (for minimal plugins)
interface RVViewerPlugin {
  readonly id: string;
  readonly order?: number;              // Execution order (lower = earlier)
  readonly handlesTransport?: boolean;  // true = replaces kinematic transport
  readonly core?: boolean;              // true = always active, even in selective mode
  readonly slots?: UISlotEntry[];       // Optional React components for HMI layout

  onModelLoaded?(result, viewer): void;
  onFixedUpdatePre?(dt): void;          // Before drive physics (60Hz)
  onFixedUpdatePost?(dt): void;         // After drive physics + transport (60Hz)
  onRender?(frameDt): void;
  dispose?(): void;
}

// Base class (recommended for most plugins)
abstract class RVBehavior implements RVViewerPlugin {
  abstract readonly id: string;
  protected viewer: RVViewer | null;    // Auto-managed
  protected get drives(): RVDrive[];
  protected get sensors(): RVSensor[];
  protected get signals(): SignalStore | null;
  // Signal access by name (primary)
  protected getSignalBool(name: string): boolean;
  protected setSignal(name: string, value: boolean | number): void;
  protected onSignalChanged(name: string, cb): void;  // Auto-cleanup
  // Generic component discovery (like GetComponent<T>)
  protected find<T>(type, path): T | null;
  protected findAll<T>(type): { path, instance: T }[];
  // Lifecycle hooks
  protected onStart?(result): void;     // Like MonoBehaviour.Start()
  protected onDestroy?(): void;         // Like MonoBehaviour.OnDestroy()
  protected onPreFixedUpdate?(dt): void;  // Before drive physics
  protected onLateFixedUpdate?(dt): void; // After drive physics
  protected onFrame?(frameDt): void;    // Per render frame
}
```

### Registration

Plugins are registered via `viewer.use()` (eager) or `viewer.registerLazy()` (code-split):

```typescript
// Eager registration — plugin is always bundled
viewer
  .use(new DriveOrderPlugin())
  .use(new SensorMonitorPlugin());

// Lazy registration — Vite code-splits into a separate chunk
viewer.registerLazy('maintenance', () => import('./plugins/maintenance-plugin'));
viewer.registerLazy('multiuser', () => import('./plugins/multiuser-plugin'));
```

Lazy plugins are only loaded when a model requests them (via `rv_plugins` or `modelname.json`). This keeps the initial bundle small.

### Plugin Resolution

When a model requests a plugin by ID, the viewer resolves it through a three-level chain:

```
1. Already registered (via use())        → return existing
2. Lazy built-in (via registerLazy())    → import chunk, instantiate, use()
3. External plugin (models/plugins/{id}.js) → dynamic import(), use()
4. Not found                             → null (no crash)
```

External plugins are pre-built `.js` files placed in `models/plugins/`. They must export a default class or instance implementing `RVViewerPlugin`.

### Activation Modes

Plugin activation depends on whether the model declares an `rv_plugins` list:

| Mode | Condition | Behavior |
|------|-----------|----------|
| **ALL-MODE** | No `rv_plugins` declared anywhere | All registered plugins receive `onModelLoaded` |
| **SELECTIVE-MODE** | `rv_plugins` declared in modelname.json, GLB extras, or settings.json | Only declared plugins + `core: true` plugins activate |

In selective mode, core plugins (drive sorting, sensor monitoring) always activate regardless of the `rv_plugins` list. This ensures essential infrastructure is never accidentally disabled.

See **[Model-Specific Plugin Configuration](#model-specific-plugin-configuration)** for how to declare `rv_plugins`.

Plugins with `slots` automatically register React components into HMI layout positions: `kpi-bar`, `button-group`, `messages`, `views`, `search-bar`, `settings-tab`, `toolbar-button`, `overlay`. See **[doc-extending-webviewer.md § 5](doc-extending-webviewer.md)** for the full slot reference.

### Plugin Tiers

| Tier | Loaded when | Can be removed | Examples |
|------|------------|----------------|----------|
| **Core** (`core: true`) | Always — survive model switches | No (`removePlugin()` blocked); `disablePlugin()` works on any plugin | `drive-order`, `sensor-monitor`, `transport-stats`, `camera-events`, `camera-startpos`, `rv-extras-editor`, `signal-bind`, `connection-system`, `adaptive-nav`, `kiosk`, `interface-manager` |
| **Global Private** | Always when private folder present | Yes | `layout-planner`, `des-plugin`, `des-hmi` |
| **Model-Specific** | Only when matching GLB is loaded | Yes (auto-removed on model switch) | `kpi-demo`, `demo-hmi`, `webxr`, `multiuser`, `fpv`, `annotations`, `aas-link`, `docs-browser`, `blueprint`, `drive-recorder`, `sensor-recorder`, `order-manager`, `machine-control`, `maintenance` |

`debug-endpoint` and `mcp-bridge` are registered unconditionally in dev builds but are **not**
`core: true` — a project may remove them.

Model-specific plugins are defined in `plugins/index.ts` files per model folder. The `ModelPluginManager` auto-discovers them via `import.meta.glob` and loads/unloads them when models are switched. See **[doc-extending-webviewer.md](doc-extending-webviewer.md) § Per-Model Plugin System** for how to create model-specific plugins.

See **[doc-extending-webviewer.md](doc-extending-webviewer.md)** for detailed plugin development guide, UI slot system, event bus, hooks reference, and examples.

## Simulation Features

### Transport
Non-physics AABB-based transport. Sources spawn MUs, transport surfaces move them, sensors detect overlap, sinks consume.

#### MU accumulation (gap clamp)
MUs on conveyors do not penetrate each other: each moving MU clamps its per-tick advance to the free distance up to the next MU in its actual (signed) move direction — a jam builds up behind a stopped part and releases automatically when the leader moves on. This is a pure 1D projection along the transport direction over the existing spatial grid (no physics engine, no continuous collision detection), so it also works with forced signals, reversed belts, rotated conveyors and across surface seams. Pre-existing overlaps are ignored (only new penetration is prevented), gripped MUs never block, and Sources hold a spawn while the spawn spot is occupied. Radial (turntable) surfaces are excluded.

Configuration: per TransportSurface via **Accumulate** (boolean, default `true`) and **MinGap** (mm, default `0`) in the GLB/scene extras; deployment-wide off-switch via settings.json `simulation.accumulateDefault: false`. Diagnostics: `mu.blocked` per MU and `blockedMuCount` in the `web_transport_status` MCP tool.

#### Source markers (floor ring + label)
Every Source carries an always-visible **floor marker** — a thin semi-transparent ring on the ground plus a camera-oriented label sprite showing the source's node name. The marker is visible in **Play, Pause, AR and Layout-Planner modes** so spawn locations stay identifiable even before the first MU appears. Each source's ring/label color is derived deterministically from its name (golden-ratio hue hash), giving consistent visual separation across sessions.

Markers are children of the source node, so they follow Layout-Planner drags automatically. They are excluded from raycast hits via the central `RaycastManager.excludeFilters` (the same filter also catches the pause-ghost overlay), so clicking through the marker selects the underlying layout object instead.

Toggle globally via **Settings → Visual → Show source markers** (default ON) or programmatically via `viewer.setSourceMarkersVisible(false)` / the MCP tool `web_view_source_markers`. The choice persists to `localStorage['rv-source-markers-visible']`.

### Physics Zones (optional)

Opt-in rigid-body physics for free 3D material behavior — MUs falling off conveyor ends, sliding down chutes, tipping and stacking in bins. Kinematic transport (including the accumulation gap clamp above) stays the default and is unchanged; physics only takes over per MU at natural handover points.

- **Activation**: Settings → Simulation → **Physics (whole scene)** (default OFF, stored in `localStorage['rv.physics']`, takes effect on the next model load). Without explicit physics zones in the model, enabling the toggle treats the whole scene as one zone with default parameters (friction 0.8, restitution 0).
- **Full physics (Beta)**: a second switch, **Full physics — all conveyors** (`localStorage['rv.physics.full']`, only effective while the main switch is on). Every non-radial transport surface then runs as a physical belt and MUs become dynamic bodies the moment they enter a surface — accumulation pressure is computed by the physics engine instead of the gap clamp. Radial (turntable) surfaces stay kinematic (v1 exclusion).
- **`WebPhysicsZone` extras contract**: zones are box volumes authored as `WebPhysicsZone` rv_extras in the GLB (schema `schema/v1/rv-odt.json`, spec section 7a): `ZoneEnabled`, `WholeScene`, `Friction`, `Restitution`, `RemoveBelowY`, `ShowGizmo`, `StaticColliders` (node paths of additional fixed collision geometry), `BoxCollider` (center/size). Today zones come from test fixtures or programmatic authoring; Layout-Planner zone authoring writes the same contract (follow-up). Overlapping zones: the first registered zone wins, configs are never mixed.
- **Handover at the conveyor end**: a belt is never cut by a zone boundary — a surface is either fully kinematic or fully physics-managed. An MU that runs off a conveyor end inside a zone becomes a dynamic body with the belt's exit velocity (also at v=0); a settled, upright MU (25° tolerance) resting over a kinematic surface returns to the kinematic pipeline with its exact pose. Tipped-over MUs stay physics-owned and rest where they fell.
- **`PhysicsMode` on surfaces and sensors**: per-instance boolean extras flag. A `PhysicsMode` surface fully inside a zone becomes a friction-driven physical belt; a `PhysicsMode` sensor inside a zone detects via physics collider events or a physics raycast (`onChanged` fires exactly as in the kinematic path). Physics-managed sensors only see physics-owned MUs — leave `PhysicsMode` off for sensors that must see both.
- **Implicit static geometry + guards**: a BoxCollider node inside a zone that carries no simulation component becomes fixed collision geometry automatically (bins, chutes, frames). Four guards protect the world against broken model data — each of them silently skips the node, except the last: a node deactivated in Unity (`activeSelf: false` on it or on any ancestor), an invisible node (its own or an ancestor's `visible = false`), a degenerate box definition (NaN/Infinity component, size ≤ 0 in any axis — checked for the legacy `BoxCollider` key *and* every `colliders[]` entry, the first valid entry wins), and a box that spans ≥ 90 % of the scene extent in at least two axes. The last case is almost always a broken CAD collider scale: the box swallows the cell, every MU spawns inside it and gets shot out by the solver's depenetration. It is discarded with one console warning per node:
  ```
  [physics-zone] implicit static box "Turbine-cut" (38.2×38.5×16.0 m) spans the scene — skipped (broken collider scale?)
  ```
  Scenes with empty or planar bounds have fewer than two comparable axes; there the guard deliberately fails open. Collision geometry that is meant to be invisible (invisible walls) must be authored explicitly through the zone's `StaticColliders` node paths — those are registered regardless of visibility.
- **Automatic floor plate**: the synthetic WholeScene zone (the convenience default when the toggle is on and the model has no authored zone) gets an invisible static plate `floor:synthetic`, so MUs that fall stay visible instead of dropping into the `RemoveBelowY` guard. Its top face is flush with `boundingBox.min.y` and it spans the scene footprint plus a margin. Note the fallback semantics: `boundingBox.min.y` is the underside of *all* render geometry, not necessarily the visible hall floor — with pits or basements in the model the plate sits under that geometry (it is never placed above `min.y`, so it can never cut visible geometry). For an exact floor height author an explicit zone with `StaticColliders`. Authored zones never get a plate.
- **Kill switches**: settings.json `simulation.physicsEnabled: false` disables physics deployment-wide (wins over the user toggle); `simulation.physicsSurfaceDefault: false` keeps every surface kinematic (wins over `PhysicsMode` and full physics).
- **Exclusions**: physics runs only in the continuous simulation kernel — switching to DES tears the physics world down; an active multiuser/live connection (Unity is the pose authority) disables physics entirely.
- **Diagnostics**: read-only line in Settings → Simulation ("N zones / M bodies / X ms step") and `physicsOwnedCount` / `physicsBodies` in the `web_transport_status` MCP tool.

The physics engine itself is a **private provider** (Rapier, Rust → WASM) behind the public `PhysicsProvider` registry — open-source builds without a registered provider are a strict no-op and load zero physics bytes. See [doc-extending-webviewer.md](doc-extending-webviewer.md) for the provider contract.

### Machining (CSG material removal)

A **MachiningVolume** is a workpiece whose material is a voxel SDF (signed distance field) grid instead of a fixed mesh. One or more **MachiningTool** cutters listed on it subtract material every fixed tick as they sweep through the grid (milling, drilling) — the changed 16³ voxel chunks are re-tessellated (Marching Cubes or Dual Contouring) into per-chunk `BufferGeometry` meshes that replace the authored workpiece mesh. This is the browser port of the Unity `MachiningVolume`/`MachiningTool` components (`Packages/io.realvirtual.professional/Runtime/CSG/`).

The compute kernel is `rv_csg.wasm` — the same Rust crate (`rv-csg`) that builds the Unity `rv_csg.dll`, additionally compiled for `wasm32-unknown-unknown` with SIMD128, running single-threaded (no `SharedArrayBuffer`/COOP-COEP needed) inside a dedicated Web Worker. Like physics and IK, this is a **private provider** behind a public, Three.js-free registry (`src/core/engine/rv-machining-registry.ts`) — an open-source build without a registered provider leaves every workpiece in its authored, unmachined state and logs one console warning; nothing crashes and nothing is loaded. See [doc-extending-webviewer.md § 21c](doc-extending-webviewer.md#21c-machining-provider-registry-csg-material-removal) for the provider contract, job/ack protocol and backpressure design.

**MachiningVolume** (the workpiece) — key `rv_extras` fields:

| Field | Meaning |
| --- | --- |
| `gridResolution` | Voxel lattice resolution (incl. one padding voxel per side); 4–256 per axis |
| `workpieceSize` | Stock size in mm |
| `Shape` | `Box`, `Cylinder`, or `Mesh` (Mesh uses the node's own render geometry — WYSIWYG) |
| `Tools` | Ordered list of `MachiningTool` references — subtraction order matters |
| `ToolGroup` | Optional group name; tools carrying it are discovered in addition to `Tools` |
| `SweepToolMotion` / `MaxSweepSubsteps` | Whether the tool's motion between ticks is swept (not just sampled at the end pose) |
| `Meshing` | `MarchingCubes` or `DualContouring` |
| `CreaseAngle` | Hard-edge threshold in degrees for the tessellator |
| `StatisticsInterval` | Seconds between `MaterialRemainingPercent` refreshes |

**MachiningTool** (the cutter) is a pure data component — `Shape` (`Sphere`, `Cylinder`, `BallNose`, `Torus`, `ConicalEnd`), `ToolDiameter`, `ToolLength`, `CornerRadius`, `TaperAngleDeg`. Its node's `matrixWorld` is read once per tick by the manager, which builds the swept segments.

**Signals** (read/write follows the usual PLC convention):

| Signal | Direction | Meaning |
| --- | --- | --- |
| `SignalSpindleOn` | read (PLC output) | Subtraction only runs while true |
| `SignalReset` | read (PLC output) | Rising edge re-initializes the grid to its full, unmachined state |
| `SignalMachiningActive` | write (PLC input) | True while the worker still has jobs or chunks pending — a momentary state, not a latch |

**Demo model:** `DemoCSGMachining.glb` — two stations (a Box and a Cylinder stock) driven by `MillingSequence` LogicSteps. It is an **internal** model as of 2026-08-30: it lives in `../realvirtual-WebViewer-Private~/projects/Development/models/` and is not in the public model selector. Tests reach it through `DEV_GLB.csgMachining`.

**Performance:** a 64³ grid is the recommended operating point — milling stays fluid at 60 fps. 128³ works but a demanding sweep can fall behind the worker's per-tick budget; the queue backpressure and segment coalescing (see the extending guide) keep this correct but visibly laggy rather than dropping material or crashing. `rv_csg.wasm` itself is loaded lazily — only when a model actually contains a `MachiningVolume` — so it adds nothing to the entry bundle.

### Path Simulation (AGV / Overhead Conveyor)

> Fleet control, tasks (destination + service time + callbacks), docks
> (path↔station adapter), destination routing and the DES queueing parity are
> documented in depth in **[doc-path-fleet-control.md](doc-path-fleet-control.md)** (plan-921).

Objects can ride **paths** (lines and arcs, arc-length parametrized) instead of flat transport surfaces. The substrate is `RVPath` (`rv-path.ts`), reconstructed from the WebViewer-native `rv_extras.Path` schema — segments (`line`/`arc`), `closed`, `successors` graph links, optional `zone`/`zoneCapacity` attributes. Paths register into the shared `RVPathNetwork`; the graph resolves successor/predecessor links by id.

Two library components ride this substrate (in `src/behaviors/`, built with `defineLibraryComponent` — see [doc-behavior-modelling.md](doc-behavior-modelling.md)):

- **`Agv`** — an autonomous path-following vehicle. One arc-length movement scalar (`PathTraveler`), speed/ramps from the shared drive ramp (drive parity, mm/s), pose from the path tangent. Traffic control is **raycast-free**, the way professional material-flow tools do it: 1D arc-length **headway** to the vehicle ahead (car-following ramp, `SafetyDistance`/`MinGap`/`LookAhead`/`HeadwayGain`) plus **zone reservation** (control-point model — a zoned path must be claimed before entry, `claim`/`release` in `rv-zone-registry.ts`). Signals: `Agv.Run`, `Agv.Moving`, `Agv.Position` (mm), `Agv.AtNode` (pulse), `Agv.Blocked`.
- **`OverheadConveyor`** — a circulating chain on a closed path: one chain phase scalar, N carriers at fixed pitch (`(s_chain + i·pitch) mod L`), gravity-oriented carrier pose.

**Routing is project logic, not built in.** Vehicles follow `successors[0]` by default; junction decisions, arrival tracking, and dispatch come from id-based hooks (`selectNextPath(candidateIds, ctx) → id`, `onArrive(pathId, travelerId)`, `requestDispatch(travelerId)`) that a project script (JS-in-GLB) fills via its `routing.*` handlers — see [doc-scripting.md](doc-scripting.md). Only plain JSON crosses the script boundary; the path graph is queryable by id via `self.paths`.

**DES coupling and its parity boundary.** In the event kernel a path leg is one arrival event (`transit = length / speed`) with a `path` tween for visible arc-true interpolation; an occupied zone reschedules the arrival check (a discrete poll). Determinism parity between the continuous and event kernels holds **for the conflict-free case only** (free track, no zone contention): arrival times, end poses, and FastForward end states match. **Under contention the two kernels intentionally diverge in their momentary trajectory** — continuous runs a smooth car-following ramp per tick, the event kernel a discrete reschedule-until-free — while arrival order, end state, and throughput converge. There is no shared discretized conflict model; only conflict-free trajectories are comparable moment by moment.

### LogicStep Engine
Port of Unity's LogicStep sequencing — roughly 25 step types are built in `rv-logic-engine.ts`:
containers (SerialContainer, ParallelContainer), timing (Delay, Pause), signals (SetSignalBool,
WaitForSignalBool, SetSignalFloat, WaitForSignalFloat, JumpOnSignal), sensors (WaitForSensor),
drives (DriveToPosition / DriveTo, StartDriveTo, SetDriveSpeed, StartDriveSpeed,
WaitForDrivesAtTarget), gripping (GripPick, GripPlace), robots (IKPath), scene control
(Enable, SetActiveOnly, CinemachineCamera) and statistics (StatStartCycle, StatEndCycle,
StatState, StatOutput).

### Signal Store
Central pub/sub for PLC signals (bool/int/float) with two lookup tables:
- **By name** (primary) — Signal.Name if set, otherwise node name (GameObject name). Used by plugins and HMI.
- **By path** (secondary) — Full hierarchy path. Used by GLB object references (ComponentRef) and internal bindings.

Change-only notification. Batch semantics for `setMany()`.

#### Level semantics: signal re-apply after reset and reconnect

The store notifies on **change**, a PLC works on **levels** (IEC 61131 scan
cycle). Two moments would otherwise swallow a level that never changes:

- **`resetSimulation()`** deliberately leaves signals alone but resets the
  components reading them. A `Start = true` that was already standing before the
  reset never fires again — the conveyor stays off for the rest of the session.
- **A reconnect** leaves the store holding pre-disconnect values while the
  components were never told they went stale.

Both are covered by the viewer-owned `SignalReapplyRegistry`
(`rv-signal-reapply-registry.ts`). Every component input wired through the
helpers in `rv-signal-wiring.ts` registers a slot there:

```typescript
// Bool level. Initial read always fires (false on an unresolved path).
wireBoolSignal(ctx.signalStore, this.Forward, (v) => this.commandForward(v),
               'Drive_Simple: Forward', ctx.reapply);

// Numeric level. NO initial read, and no replay until the PLC has actually
// written the signal — the authored TargetSpeed must not be zeroed by a
// registered-but-unwritten value. Never Number(undefined) = NaN.
wireNumberSignal(ctx.signalStore, this.Speed, (v) => this.commandSpeed(v),
                 undefined, ctx.reapply);

// Raw pass-through (bool AND number). Initial read fires when the path
// resolves; that is what the display components did by hand before.
wireValueSignal(ctx.signalStore, addr, (v) => this.apply(v), undefined, ctx.reapply);
```

| helper | initial read | replay |
|---|---|---|
| `wireBoolSignal` | always (`false` when unresolved) | always |
| `wireValueSignal` | only when the path resolves | once a value has been delivered |
| `wireNumberSignal` | never | once a value has been delivered |

`reapplyAll()` then re-reads the **current** store value for each slot and calls
the setter again with `(value, { replay: true })`. Rules worth knowing:

- Only registered COMPONENT inputs are re-applied — this is not a store
  broadcast, so historian, charts, statistics and LogicStep edge detectors never
  see a phantom event.
- The value is PULLED at replay time; nothing cached at wire time is replayed.
- A re-apply restores the level a component **had**. A slot that never delivered
  one (see the table above) is skipped rather than seeded with the store's
  registration value.
- The `replay` flag lets an edge-detecting consumer tell a resync from a real
  change. `RVIKPath.SignalStart` is the one slot that uses it, to re-sync its
  edge baseline instead of starting the robot path.
- `WireResult.unsubscribe` drops the store subscription and the registry slot
  together — always keep the handle and call it from `dispose()`.
- New components should use the helpers rather than `subscribeByPath` directly;
  a direct subscription silently opts out of the level semantics.

Lifecycle and trigger details: [doc-lifecycle.md](doc-lifecycle.md) §6.2 and §7.

### Virtual PLC (Structured Text)
Internal dev builds include a browser-side IEC 61131-3 soft PLC: write Structured Text in a Monaco editor (opened from the Planner), compile it in the browser, and run it as a 60 Hz scan cycle in a QuickJS sandbox against the SignalStore — sensors in, drives out, no Unity and no PLC hardware required. See **[doc-plc-programming.md](doc-plc-programming.md)**.

### Drive Physics
Ported from Drive.cs — acceleration/deceleration, position limits, rotation and linear movement. CAM/Gear master-slave dependencies resolved via topological sort.

### WebSensor (3D-HMI status indicator)
Pure UI marker authored in Unity (`Packages/io.realvirtual.professional/Runtime/WebViewerHMI/WebSensor.cs`) and rendered exclusively by realvirtual WEB (`rv-web-sensor.ts`). Four visual states — **Low / High / Warning / Error** plus an **Unbound** fallback — driven by either:

- a **PLCOutputBool** (`SignalBool`) → `false=Low`, `true=High`, OR
- a **PLCOutputInt** (`SignalInt`) → mapped via flexible `IntStateMap` string (default `0=Low, 1=High, 2=Warning, 3=Error`)

ISA-101-aligned colors (grey / blue / amber / red), with amber blinking at 1 Hz and red at 2 Hz. The visualization is delegated to the generic `GizmoOverlayManager` and supports six shapes (box / transparent-shell / mesh-overlay / sphere / sprite / text). When `Label` is set, an additional camera-facing text gizmo renders the label above the node. See `Sensor isolation` below for the end-user control. For developer-side customization (corporate-design overrides, custom int-mapping defaults), see [doc-extending-webviewer.md § 19](./doc-extending-webviewer.md#19-websensor--initwebsensor-configuration-api).

### Lamp (signal-light material)

`Lamp` is the browser counterpart of Unity's `Lamp.cs`. It changes the
emissive color and intensity of the first eligible mesh on the component node
or below it; helper meshes whose names start with `_` are skipped. The runtime
clones every material slot so a lamp never changes another mesh that shared the
authored material. Lamp meshes stay outside material deduplication, uber
material conversion, and BatchedMesh arenas so signal changes remain visible
and the normal hover/selection path continues to work.

The component reads `SignalLampOn` and the Unity-compatible
`SingalLampFlashing` field (`SignalLampFlashing` is accepted as an alias).
Without a signal, `LampOn` remains the authored state. `OnColor` is read
directly from the object-valued GLB extras; `Intensity` controls HDR emission,
`Flashing` enables blinking, and `Period` is the full on-plus-off cycle in
seconds. The viewer-owned `LampManager` uses a symmetric 50% duty cycle,
including the first cycle. `Period <= 0` produces steady light.

This symmetric blink differs intentionally from the asymmetric coroutine in
Unity's current `Lamp.cs`. Blink phase is deterministic per local viewer but is
not synchronized to a shared multiuser epoch, so clients joining at different
times can be phase-shifted. Emission works on WebGL and WebGPU; visible bloom
still depends on the renderer's active post-processing path and luminance
threshold. The asset editor includes red, amber, green, blue, and white
**Lamp / Signal** presets, with stronger blue and white emission to compensate
for luminance-based bloom.

### Scene buttons (PushButton3D, EmergencyButton3D, HandleSwitch3D)

The 3D control panel of a machine — the buttons an operator actually presses.
Five components mirror the Unity classes one-to-one
(`Packages/io.realvirtual.starter/Runtime/Modules/SceneButtons/`):

| GLB extras key | TypeScript | Role |
|---|---|---|
| `PushButton3D` | `RVPushButton3D` | Momentary (`timer`) or latching (`toggle`) push button, optional `lightSignal` |
| `EmergencyButton3D` | `RVEmergencyButton3D` | Latching mushroom head |
| `HandleSwitch3D` | `RVHandleSwitch3D` | Latching lever |
| `SceneButtonBase` | `RVSceneButtonBase` | Click/hover state machine — the actual pick target |
| `SceneButtonMoveable` | `RVSceneButtonMoveable` | Animated cap plus the button light |

A wrapper only configures the `SceneButtonBase` below it, exactly like Unity's
`Start()`; the base is what the pointer hits, because in Unity it is the node
that carries the collider and `OnMouseDown`. Its fields keep the Unity
camelCase spelling (`stateSignal`, `lightSignal`, `autoLight`, `isToggle`,
`simpleClickTime`, `axis`, `moveSpeed`, `hoverOffset`, `activeOffset`,
`mirrorHoverOffset`, `angularMovement`).

**Signals.** A click writes the `stateSignal` (`PLCInputBool`) as an OPERATOR
write, so it passes a `bound` slot authority and reaches the PLC in live mode.
A momentary click is one pulse: `true` on click, `false` after `timer` seconds
— both flanks through the same writer. The base also SUBSCRIBES to its own
`stateSignal`, so a force, a reconnect or a remote echo resynchronizes the
optics instead of leaving the button visually stuck. `liveControlled` blocks
only autonomous state changes (an `activeOnStart` self-click), never the
operator's own click. The light follows `lightSignal` (`PLCOutputBool`) when
one is wired, otherwise the button's own state (`autoLight`).

**Light.** Unity swaps two material assets; the GLB carries only the "on"
material, so the WebViewer synthesizes the pair at bind time — one clone with
emissive, one without — and swaps between them. Equal `baseMaterial` /
`activeMaterial` names mean the button has no light at all and its authored
material is left untouched.

**Rendering.** The cap mesh is flagged `_rvSceneButtonMesh` and therefore stays
out of material deduplication, uber-material baking and the BatchedMesh arenas
— it moves and changes material at runtime. The static button base stays
batched. Press/turn animation and the momentary release timers run in the
viewer-owned `SceneButtonManager` (`viewer.sceneButtonManager`), ticked in
`CoreSubsystems.visuals(dt)`.

**Deliberate deviation from Unity:** Unity holds a momentary button down until
the mouse is released. The browser click pipeline delivers one click event
after pointerup, so a momentary click is "active for `timer` seconds from the
click", without hold semantics.

### EnergyChain (cable carrier)

`EnergyChain` turns a rigid CAD energy chain (drag chain, cable carrier) into
one that moves with its linear axis. Attaching the component to the CAD node is
the entire user action: drive axis, bend radius, link height, chain length and
the position of the bend are **measured** from the rest pose, and every numeric
field left at `0` keeps auto-calibrating. `Anchor` and `Follower` are node
references (Unity `Transform` fields, wire `componentType`
`UnityEngine.Transform`); they are shown read-only in the inspector and
corrected through `web_editor_set_field`, which the component resolves live —
no reload.

With `Follower` left empty the moving end is derived from the scene context
(`rv-energy-chain-assign.ts`): first from a **drive** whose travel direction is
parallel to the measured chain axis, otherwise from a **`Kinematic` node**. In
both cases the chain end that lies inside — or nearest to — that node's moved
subtree becomes the moving one. The automatic stages refuse to answer rather
than guess: a candidate that cannot tell the two ends apart (they sit only `2R`
apart, so the nearer one has to win by at least `R`), or one further away than
the chain is long, is skipped, and the chain degrades to its rest pose. An
explicit reference always overrides both stages; clearing it falls back to them
without rebuilding the rig, because assignment is path configuration, not
structure.

The motion is a closed formula, not a solver: straight strand → half-circle bend
→ straight strand, with the bend at `c = (L − πR + a + m) / 2`, i.e. travelling
at exactly **half** the follower speed while the chain length stays constant.
It is therefore deterministic, timestep-independent and allocation-free per
frame.

Rendering uses `SkinnedMesh`: **one skinned mesh per source mesh, all bound to a
single shared `Skeleton`**, because a CAD chain is regularly split across
several meshes with their own transforms (the reference part keeps both strands
in one mesh and the bend in another). The originals stay in the tree, hidden.
Bones are concentrated on the bend — the two strands are antiparallel, which is
the degenerate case for linear blend skinning — and the count is clamped up to
the minimum derived from a 15° per-joint limit (21), reported in the status line.

All geometry lives in the **chain-local bind frame**, so a chain under a moving
kinematic parent, a planner-relocated asset or a multiuser transform moves as a
whole without deforming. Chains are excluded from material dedup, uber-material
baking and BatchedMesh arenas; picking runs through an invisible envelope hull
registered as an auxiliary raycast target, since a `SkinnedMesh` never enters
the pick BVH. GLB export restores the original meshes and prunes the rig — the
rig is rebuilt deterministically on load. If calibration or the follower
assignment fails, the chain simply holds its CAD rest pose and says why in its
status line; it is never worse than an unrigged part.

### Chain (chain conveyors, bucket elevators)

`Chain` is the other chain, and it has nothing to do with `EnergyChain` above:
N identical elements — links, buckets, carriers, pallet fixtures — riding a
spline, all moved by ONE `Drive`. It is the browser counterpart of Unity's
`realvirtual.Chain` + `ChainElement`, and Unity remains the single source of
truth for both the curve and its frames.

The curve is **baked at export time**. `Chain.Spline` carries an arc-length
equidistant table of position, tangent and up vector (flat
`[px,py,pz, tx,ty,tz, ux,uy,uz]` per sample, metres, in the chain node's LOCAL
frame) plus `closed` and the true `length`. The viewer only interpolates it:
no spline mathematics is duplicated in TypeScript, and the up vectors come from
Unity's `SplineContainer.EvaluateUpVector` rather than from a browser-side
parallel transport, so there is no frame-flip class of bug to fix.

The elements are **built, not loaded**. On load the component clones the
`ChainElement` template `NumberOfElements` times, after dropping any child that
follows Unity's generated-element convention `<NameChainElement>_<n>` (tolerating
the glTF `_N` de-dup and the Unity `(N)` suffix) — a scene exported with Unity's
edit-mode preview would otherwise deliver a second, stale set. Every clone gets
its inherited rv_extras stripped (the `rv-source.ts` MU rule: `Object3D.clone()`
JSON-round-trips `userData`) and carries `_rvChainElement`, which
`pruneRuntimeHelpers()` drops before an editor save. In an **authoring load**
nothing is cloned at all, so the asset editor saves the template only.

Per tick the element position is `drivePosition + start + OffsetToDrivePosition`
in millimetres, converted to an arc-length fraction over
`ScaledOnFixedLength ? FixedLength : Length`. The wrap is Unity's, verbatim: a
modulo on OPEN and closed splines alike (no clamping), with the negative branch
`1 - |p| / length`. The tick hangs in `CoreSubsystems.visuals()` AFTER the drive
stage so an element never lags its own drive by a frame, and
`resetSimulation()` calls `chainManager.resetAll()` AFTER the `drive.reset()`
loop — deliberately not from the `simulation-reset` event, which fires before
the drives are reset.

Chain subtrees are excluded from BatchedMesh arenas (they move every tick) and
kept matrix-dynamic by the static-freeze pass. Degrading is quiet and total: a
missing or under-sampled `Spline`, or an unresolvable template, makes the chain
inert with a warning; an unresolvable `ConnectedDrive` places the elements and
never moves them — matching Unity, which logs and keeps running.

### Mechanisms (rigid-body kinematics)

`KinematicMechanism` + `KinematicJoint` (+ `KinematicTarget` for inverse mode)
solve a **joint graph**: closed loops and links no parent chain can reach.

Do not confuse this with the `Kinematic` component or the "Kinematics" panel.
Those are the older **axis-group** system — one drive moves one group, and the
hierarchy carries the motion. A mechanism is for parts that constrain *each
other*: four-bar linkages, scissor lifts, Delta platforms. Everything belonging
to it is spelled *Mechanism* (files under `mechanism/`, ops
`web_editor_mechanism_*`, the quick-edit section "Mechanism (Rigid-Body)").

The solver is **not** TypeScript. The same Rust crate Unity uses natively
(`realvirtualReleaseDLLs/rv-kinematic-solver`) is compiled to `wasm32` and
shipped in the private bundle; the TS side ports only the *layout* half —
spanning-tree discovery, free bodies, loop residuals — and serializes it into
the ABI-v2 state blob the core deserializes. That split is the whole point:
there is exactly one implementation of the mathematics, so Unity and the web
cannot drift. There is deliberately **no fallback solver**; a missing,
unreachable, corrupt or version-mismatched artifact disables mechanisms with a
message rather than half-running.

Per tick the manager runs Prepare → Solve → WriteBack on `TickStage.SIM`, i.e.
after the drives — the web equivalent of Unity's `IPostFixedUpdate`, so a
mechanism always sees the current drive positions and downstream sensors always
see the solved pose. Driven joints (`DrivenBy`) are boundary conditions; every
other generalized coordinate is solved by a bounded damped Newton-Raphson
iteration. `KinematicTarget` runs on `TickStage.PRE` instead, writing drive
values that the drive phase then applies normally.

Two data rules are worth knowing because they are easy to get wrong:

- **An ABSENT `BodyA` means "anchored to world"**, not "missing". Unity's
  serializer omits null fields entirely, so the absence *is* the authored world
  anchor. A `BodyA` that is present but unresolvable is an error instead.
- **Anchors are millimetres in the respective body's local frame** and should
  coincide in world space; a gap beyond 0.01 mm raises the auto-fixable
  `AnchorsApart` finding.

Authoring in the Quick Edit produces no bespoke ops: every change is a composite
of the generic `addComponent`/`setField`/`unsetField` primitives inside one
transaction, so undo/redo, atomic rollback and GLB persistence come for free.
Validation and jog are transient and create no undo entries — the jog reports the
solver's real convergence and residual, never a decorative check mark.

#### Authoring in 3D: snap picks, the axis gizmo, and beacons

Typing anchor coordinates is possible but is not how a joint gets authored. Each
joint row has **Anchor A**, **Anchor B** and **Axis**:

- **Anchor A / B** arm a *snap pick*. Hovering the model offers explicit
  candidates — the nearest **vertex**, the nearest **edge midpoint**, the
  **centre of the coplanar face**, and the **centre of any circular boundary
  loop** of that face. The candidate a click would take is drawn as a marker
  (a circle candidate also draws its circle) and named in the panel, so the
  anchor is verified *before* it is committed, not after. A pure cursor
  heuristic was rejected deliberately: a revolute joint is only right when its
  anchor is on the bore axis, which is almost never where the ray happened to
  land. Clicking also assigns that side's **body**, because "this part, at this
  point" is one act and belongs in one undo step.
- **A bore is snapped through its rim, not its wall.** Hover the flat face the
  hole passes through and you get the hole's centre and axis; hovering the
  cylindrical wall itself yields nothing, because the wall is coplanar with
  nothing. This is a known and deliberate limit — no cylinder fit exists.
- **Axis** picks the joint axis from a snap normal (a bore's axis, typically)
  and turns on a **custom axis gizmo** for fine adjustment. It is deliberately
  not a 6-DOF transform gizmo: a joint axis is a direction, and five and a half
  of a 6-DOF gizmo's handles are meaningless here while one of them would move
  geometry instead of editing a field. Dragging only previews; release commits,
  and the direction snaps to a principal axis when it comes within 5°.
- **Findings get beacons.** Joints carrying a finding are marked in the 3D view
  in the finding's colour, errors blinking — a findings list answers *what* is
  wrong, a beacon answers *which of these forty joints*. They register under the
  `status` overlay category and are excluded from raycasting, so a beacon can
  never steal a click from the geometry being authored.
- **Opening the section draws every joint at once** (`mechanism-joint-overview-gizmo.ts`,
  plan-405). Each joint gets an anchor marker at its origin and a dimmed accent
  axis through it, screen-constant under perspective *and* orthographic cameras
  (via `rv-screen-space-scale.ts`, not a fourth copy of the distance formula).
  This is the map, not the instrument: hovering names the joint in a
  world-anchored tooltip (priority 10, so the generic node-hover pipeline at 5
  cannot displace it), clicking selects it and scrolls its row into view, and
  nothing here edits anything. There is no toggle — the section being open *is*
  the trigger, and closing it disposes the overlay.

  Three details are load-bearing. The joint whose per-row axis gizmo is on is
  **hidden** from the overview, so two identically coloured glyphs never stack
  and the drag handle's click cannot be stolen (the section lifts that state out
  of `JointRow` through `onGizmoToggle`); the overview additionally goes passive
  while any pick is armed. The targets **reference** the bridge's world arrays
  instead of copying them into `Vector3`s, because the refresh runs on every jog
  slider tick, not only on the 500 ms poll. And `markRenderDirty()` is
  change-gated, so an unchanged poll over an open section does not force a
  render twice a second on a parked camera.

  This is also what made `Section` (`panel-primitives.tsx`) accept an optional
  controlled `open`/`onOpenChange` pair; every other call site stays
  uncontrolled and unchanged.

The 3D interaction reuses the existing pipelines rather than paralleling them
(see `doc-render-picking.md`): the gated hit comes from
`RaycastManager.raycastForRVNodeDetailed()`, exactly like the `pivot-pick`
eyedropper, and only the geometric refinement — *which triangle* — is a local
raycast against the already-resolved node. Every commit path ends in the same
generic composites the typed fields produce.

The maths is where this can be silently wrong, so it is pure and unit-tested
(`tests/mechanism-interaction.test.ts`): the snap candidates in
`mechanism-snap.ts`, and the frame/unit conversion in `mechanism-frames.ts`.
The latter is the WRITE-side mirror of the read path's single conversion site,
including the rule that trips people up — an anchor is a *position* and takes
the `(-x,y,z)` mirror, while a rotation axis takes `(x,-y,-z)`, because a mirror
is not a rotation. Getting that wrong runs the mechanism backwards, which is
precisely the defect the read path already had once.

#### Force analysis and drive sizing (plan-412)

The same solver handle answers a second question: given the motion it just
produced, **what does it take to produce it?** An actuator force or torque per
driven dof (drive sizing) and a reaction wrench per joint (bearing loads). The
kinematics is untouched — nothing on this path can move a link.

**Masses come first.** Each link needs a `MechanismBody`: a density preset plus
optional mass and centre-of-mass overrides. The mass is *computed* from the
geometry that link owns (Mirtich volume integrals over its subtree minus every
other link's subtree) and is deliberately not stored in the document, so the Body
row is the only place it is visible — and it says how it was obtained. A
bounding-box estimate is labelled as one, because a drive sized against a silent
guess is a purchase order. A link with no usable mass switches the analysis off
for the **whole** mechanism (`massKg = -1` sentinel on the wire) and raises a
finding; it never degrades to a plausible number. Pinning a mass by hand clears
that state — that is what the override is for, and it is the only way a
geometry-less transform rig can be analysed at all.

**The data path, end to end:**

```
rv-kinematic-mechanism.ts::executeTick(dt)
  └─ solver.solve()                     ← pose, as before
  └─ solver.solveDynamics(dt, gravity)  ← ONCE per fixed step, never per sub-step
       └─ wasm: RNEA + own SI constraint Jacobian + loop-closure λ
  → MechanismUiBridge.forcesSnapshot()  ← the CURRENT tick, no solve of its own
       ├─ MechanismForceRecorderPlugin  ← ring buffers @10 Hz → chart + figures
       └─ mechanism-force-gizmo.ts      ← 3D arrows @frame rate
```

**Why a recorder and not the panel poll.** The Mechanism section polls the bridge
every 500 ms for structure. Routing the *series* through that same poll would
lose four samples out of five, and a peak between two polls is a peak the user
never sees — in a feature whose whole purpose is the peak. So
`MechanismForceRecorderPlugin` (public, lazily installed on first use through
`ensureForceRecorder`, exactly like `SensorRecorderPlugin`) owns a `RingBuffer`
per series plus one shared
simulation-time buffer, sampled in `onFixedUpdatePost`. The bridge is asked only
for the values the last tick already computed; reading them never triggers a
solve, so the numbers cannot depend on who is looking.

**Bridge surface** (`rv-kinematic-registry.ts`, plain data only):
`setForceAnalysis(path, on)` arms it (off by default — a mechanism nobody
analyses must not pay for the RNEA), `forcesSnapshot(path)` returns this tick's
channels plus each joint's world wrench and anchor, `solveStatics(path)` answers
the holding question with q̇ = q̈ = 0 and no history, and `resetForces(path)`
drops the pose history. Only `dynamicsValid` (the crate's status `0`) makes the
numbers real; every other status is shown as a sentence, never as a plausible
figure.

**Sizing figures.** Peak is `max |τ|`. RMS is **time-weighted** —
`sqrt(Σ τᵢ²·Δtᵢ / Σ Δtᵢ)` — because a dropped frame or a mid-run validity gap
would otherwise let whichever samples happened to be dense outvote the rest, and
for a duty-cycle figure that is the difference between a motor that fits and one
that overheats. Holding torque comes **only** from the statics export: a dynamic
zero crossing of the velocity is not a machine standing still. Pause freezes both
the samples and the clock, so a break never becomes one enormous Δt.

**Reset semantics** (`§2.4.3`): rebuild and model switch reset by destroying the
handle; play start/stop go through `resetForces`; a detected teleport (the jump
detection sub-stepping a tick) resets inside `executeTick`, because two samples
across a jump do not describe one continuous motion.

**Arrows.** Length is capped at a fraction of the camera distance and magnitude
is carried by colour — a linearly scaled arrow puts the loaded joint off screen
and collapses every other one into its own cone. The overlay is panel-owned like
the axis gizmo, so leaving the editor mode unmounts the section and disposes
every scene object, material and listener with it.

Tests: `tests/test-mechanism-force-recorder.test.ts` (sampling, time-weighted
figures against a hand-computed uneven-Δt sequence, pause, namespaces),
`tests/test-mechanism-force-chart-options.test.ts`,
`tests/test-mechanism-force-gizmo.test.ts`,
`e2e/mechanism-force-analysis.spec.ts` (real wasm, real fixed update),
`e2e/mechanism-force-benchmark.spec.ts` (§9.8 budget).

#### The whole cycle is drivable by an agent (plan-706)

Everything above — reading a mechanism, anchoring it, weighing it, running it and
sizing its drives — is reachable through `web_editor_mechanism_*` and
`web_editor_test_start` / `_stop`, without a panel and without a screenshot loop.
Three things made that possible, and each was a defect or a gap rather than a
feature:

- **Writes now rebuild.** Every writing mechanism tool goes through one
  `_mechCommit` helper that runs the composite and then calls
  `MechanismUiBridge.rebuild()` — which the panel's commit path always did and
  the MCP tools never did, so an anchor an agent set took effect only when a
  human next touched the panel. The mechanism to rebuild is derived in three
  stages (ancestor walk over the `KinematicMechanism` extras → a `bridge.list()`
  reference search → rebuild everything); the ancestor walk is FIRST because a
  freshly added body appears in no `links[]` yet.
- **Snapping is mouse-independent.** `mechanism-snap-query.ts` holds the whole
  pipeline (gated hit → triangle refinement → candidates → ranking → world lift)
  behind a canvas coordinate. `mechanism-pick.ts` is now only the modal
  interaction and takes the `recommended` candidate from the same call, so a
  click and `web_editor_mechanism_snap_list` cannot answer differently at the
  same bore. The tool is `readOnly` and still requires editor mode: the gate is
  the PICK PATH, which is invalid wherever a `BatchTable` exists.
- **Recording follows the session, not the panel.** The
  `running` → `start()` coupling moved out of `MechanismForceChart.tsx` — a
  component that lives inside the expanded Mechanism row — into
  `MechanismForceRecorderPlugin.init`. A test session started from the toolbar
  with the panel closed, or by an agent, previously recorded nothing at all. The
  panel keeps its manual toggle and otherwise mirrors `recorder.recording`; users
  who expand the row mid-run now see the curve from the START of the session.

Only 16 of the 18 tools require the private bundle. `web_editor_test_start` and
`_stop` deliberately do not — the in-place test session has nothing to do with
the solver — and report `forceRecording: false` instead of an error in a public
build.

Tests: `tests/mechanism-mcp-inspect.test.ts` (read-through, the three-stage path
derivation, and that no tool writes without a bridge),
`tests/mechanism-snap-query.test.ts`, `tests/mechanism-authoring.test.ts`
(composite atomicity), `tests/mechanism-force-recorder-session.test.ts` (the
session coupling with NO React rendered),
`tests/mechanism-force-downsample.test.ts`.

### Collision detection (CollisionRole)

Give a node a **Collision Role** in the inspector and the viewer checks it against
every other body of a *different* role while the simulation runs. There is one
dropdown and nothing else — no group names, no exclusion matrix:

`None` · `Tool` · `Workpiece` · `Machine` · `Robot` · `Environment` (default `None`).

- **What a body is.** The role covers the node's whole subtree, down to the next
  descendant carrying a role of its own. A robot marked `Robot` with a gripper
  marked `Tool` is therefore *two* bodies — "the robot counts up to the gripper".
- **What is checked.** Different roles always, identical roles never, `None`
  never, and a body is never checked against a body nested inside it (a robot
  against its own gripper would report the design-inherent flange contact on
  tick one). The check is two-stage: the body's world AABB — re-unioned every
  tick from all its meshes, so it is correct while an arm extends — and then
  exact triangle against triangle.
- **What happens on a hit.** The involved nodes get the pulsing severity
  outline (the same OutlinePass status silhouette the error-message system
  uses) and one **collision card per pair** appears in the right-side messages
  panel — no modal. Card and outline **latch**: they stay after the geometry
  separates, so a brief brush is never missed. Clicking a card frames the
  camera on the collided objects and flashes them. Each card carries two
  buttons: **OK** acknowledges exactly this pair (while the geometry still
  intersects it is re-detected on the next tick), and **Ignore** suppresses
  that collision *type* (the role pair, e.g. Tool ↔ Workpiece) for the rest
  of the current run — the ignore is dropped on the next model load. **The
  simulation never stops** — this is a notice, not a safety halt.
- **Signals.** `CollisionActive` (bool) and `CollisionCount` (int) mirror the
  latched state for the PLC; a rising edge on `ResetCollisions` clears the
  reported state (still-intersecting, non-ignored pairs are re-detected on
  the next tick).
- **Spawned parts.** A Source has its own **Collision Role For MUs** field —
  every MU it spawns joins the check with that role and leaves it at the sink.
  Instanced MUs are checked at box precision only (they share one geometry, so
  there is no per-instance BVH).
- **Only visible geometry participates** (`visible` chain plus render layer), so
  hidden MU templates and batch source meshes cause no phantom hits.
- **Known limits.** Geometry that is deformed at runtime — skinned meshes,
  morph targets, energy chains — is excluded and reported once per model load in
  the console. Geometry that already overlaps when you press Play is reported
  immediately: there is deliberately no baseline, so set floors, frames and
  supports to `None`.

### Sensor isolation (toolbar button)
A single **Isolate Sensors** toolbar button (in the `button-group` slot, registered via `web-sensor-plugin.tsx`) toggles sensor isolation mode. When active, non-sensor meshes are dimmed (opacity `0.55`) and desaturated so only the sensors stand out, and sensor labels are shown for identification. Click the button again to restore the normal view.

The isolation state persists in `localStorage` under key `rv-group-visibility` (field `isolatedAutoFilter`).

### Generic Gizmo Overlay System
The `GizmoOverlayManager` (`viewer.gizmoManager`) is a reusable infrastructure for any component that needs to render a visual overlay over its node. WebSensor is the first consumer; future Drive direction arrows, Grip volumes, Station zones, etc. can all use the same API. Material sharing keyed by `(color, opacity, depthTest, blinkHz)` keeps memory low; one central `tick()` loop modulates all blinking gizmos in sync. Gizmos are tagged onto the on-top overlay layer by default so they never contaminate SSAO (bloom/glow gizmos stay in the composer via `keepInComposer`); see [doc-extending-webviewer.md § 17 — "Keeping 3D UI out of SSAO"](./doc-extending-webviewer.md#17-gizmo-overlay-system-viewergizmomanager).

### Drive Axis Gizmo
Selecting a node with a `Drive` component shows a passive orange overlay visualizing the drive's motion axis (`drive-axis-gizmo-plugin.ts`): linear drives get a **double arrow** along the axis (solid tip = positive direction, dimmed tip = negative), rotary drives get a **dashed centreline plus a rotation ring** with a tangential arrow indicating the positive direction and a dot marking the current angle. With **UseLimits**, linear drives show end-stop disks at the travel limits (the gizmo centre is the current position) and the rotary ring arc is clamped to the limit range; while a drive is running its gizmo subtly pulses. The axis is derived from `Direction` + `ReverseDirection` (via `RVDrive.getAxis()`) and composed into world space including parent and home rotations; `Virtual` drives show nothing. When the selected node itself has no Drive, a subtree search applies — a gizmo appears only if **exactly one** drive is found below it (selecting a robot root shows nothing; select the individual axis node instead). The overlay lives on the highlight overlay layer (no SSAO/toon artifacts), is not pickable, scales with the object size clamped by camera distance, and supports multi-select (one gizmo per drive). Toggle: **Settings ▸ Visual ▸ Display ▸ Drive axis gizmo** (persisted, default on).

### Component Event Dispatcher
Per-component event callbacks for `onHover` / `onClick` / `onSelect` are routed centrally via `viewer.componentEventDispatcher` — components implement optional methods on the `RVComponent` interface and the dispatcher resolves which component matches each viewer-level event (via `node.userData._rvComponentInstance` + parent-chain walk). Exception-isolated and listener-leak-safe. See [doc-extending-webviewer.md § 18](./doc-extending-webviewer.md#18-component-event-dispatcher-viewercomponenteventdispatcher).

### AI Alarm Assistant (demo)
The standard demo ships a FANUC CRX alarm tile (`src/plugins/demo/robot-alarm/`) for **SYST-320 — Contact Force Exceeds Limit**. The card offers a prominent **Ask AI** button and a **History** icon button (badge = note count). Ask AI shows a short "analyzing" spinner, then types out a structured answer: diagnosis, recommended steps, a **live excerpt pulled from the bundled FANUC PDF** with a page deep-link, a summary of what previous operators did, and a **Sources** block whose entries open the manual at the cited page. The History dialog lists the operator notes and lets a visitor add their own (stored in `localStorage`); a new note is considered in the next answer. The assistant answer is generated client-side via an `AlarmAssistantProvider` seam — no backend — while the PDF excerpt and page links are real.

### WebDiagnostics (AI error diagnosis, signal-driven)

The productive counterpart of the alarm-assistant demo. A `WebDiagnostics` rv_extras marker (`rv-web-diagnostics.ts`, rv-ODT §7a.32) binds a PLC error signal to the AI diagnosis:

- **SignalBool** — rising edge triggers a diagnosis for the node, falling edge clears it.
- **SignalInt** — any change to a non-zero error code triggers; `0` clears.
- **DocFilter / ErrorId / Label / AutoOpen** — backend metadata filter, stable comment-store key, display label, and automatic dialog opening.

The marker only emits a typed `diagnose-request` viewer event (leading-edge debounced, 1 s window; unchanged values never re-fire). The diagnosis itself runs in the `WebDiagnosticsPlugin` (private tier): it calls the CONNECT `/diagnose` endpoint (`RemoteDiagnoseProvider`, BFF pattern — no LLM key, vector index or PDF full text in the browser), shows a messages-slot card plus a result dialog (cause / remedy / PDF sources with page deep-links), and offers a shared comment history backed by `GET/POST {notesUrl}/comments`.

Everything is **config-gated via `settings.json`**: `diagnostics.diagnoseUrl` enables the diagnosis backend, `diagnostics.notesUrl` switches the operator notes from `localStorage` to the shared CONNECT comment store. Without these URLs (demo / public builds) the marker events are ignored and the offline demo above stays exactly as it is. Model switches and falling edges abort in-flight requests plugin-side (`onModelCleared`), so no stale answer ever reaches the UI.

### Raycast System

Unified raycast pipeline (`rv-raycast-manager.ts`) consolidates hover, scene click, and XR controller raycasting into a single Three.js `Raycaster`. Hover is throttled at 50 ms.

**BVH-grouped geometry** (`rv-raycast-geometry.ts`):
Instead of iterating all scene meshes per ray, the loader builds **merged BVH groups**:

- **One merged BVH for all static meshes** — never animates, baked once.
- **One merged BVH per kinematic Drive group** — re-used as the drive moves; only the group transform updates.
- **`InstancedMesh` targets for MU pools** — single instanced draw, single BVH.

Each ray is tested against this small set of grouped geometries. Hit-to-node resolution uses **face-range binary search** (O(log n)) — the loader records, for every face range in a group, which `realvirtual` ancestor owns it. No ancestor walk-up at runtime.

**Raycast readiness:** BVH trees are built asynchronously after `model-loaded` — one reused background worker builds the merged groups first, then the per-mesh geometries; a time-sliced inline fallback covers environments without `Worker`. Hover and click work immediately after load through the native three.js raycast fallback and switch to BVH acceleration per geometry as trees complete. The `'raycast-ready'` viewer event signals full completion.

**Hoverability is capability-driven**: `getCapabilities(type).hoverable` (from [rv-component-registry.ts](src/core/engine/rv-component-registry.ts)) decides whether a component type takes part in hover/click. There is no separate Three.js layer per type; the raycaster runs `layers.enableAll()`.

**Key features:**
- **Pointer hover**: Throttled at 50 ms, resolves the hit face to its registered `realvirtual` ancestor via face-range lookup.
- **XR controller ray**: `updateFromXRController(origin, direction)` for VR/AR controller raycasting.
- **AR tap selection**: 9-point sampling (`arTapRaycast()`) for touch tolerance on mobile AR.
- **Click detection**: `raycastForRVNode(e)` for scene click without altering hover state.
- **Exclude filters**: Skip highlight overlays, sensor viz meshes, and custom exclusions.
- **Visibility gate**: Runtime-hidden subtrees (WebVisibility signal, Groups panel) are not hoverable/clickable — the ray falls through to what's behind.
- **Highlight integration**: Instrument-Blue hover/selection highlight via `RVHighlightManager` (OutlinePass silhouette for rendered meshes, overlay fill + edges for batched content).
- **Metrics**: pick-path timings (raycast split, resolve, highlight apply, strategy) live in Settings → Dev Tools → "Picking & Highlight".

**Highlight Manager** (`rv-highlight-manager.ts`):
- Two independent channels: hover (light blue `0x4aa3ff`) and selection (deep blue `0x1e88ff`)
- Strategy per apply: OutlinePass silhouette → overlay fill + `EdgesGeometry` (batched/hidden content) → bounding-box fallback (dense subtrees)
- Cached `EdgesGeometry` (WeakMap) for GC-free repeated highlights
- Two modes: static snapshot (brief hover) and tracked (overlays follow moving meshes)

**Architecture + hard invariants** (batched arenas, pick geometry, layer/AO contracts, do-not-touch rules) are documented in the internal render/picking design note, which is not part of this repository. The canonical source is `src/core/engine/rv-batched-render.ts`, `rv-batch-table.ts`, `rv-batch-visibility.ts` and `rv-raycast-geometry.ts`.

**Events emitted:**
- `object-hover` — `{ node, nodeType, nodePath, pointer, hitPoint, mesh }`
- `object-unhover` — `{ node, nodeType }`
- `object-click` — `{ node, nodeType, nodePath, pointer }`

### Tooltip System

Generic, extensible tooltip system (`core/hmi/tooltip/`) with **a single headless controller**, a content-type registry, and per-component **data resolvers**. New tooltip types are added by registering a content provider + a data resolver — no per-type controllers.

**Architecture:**

```
GenericTooltipController (single, headless)
    ├─ reads node.userData.realvirtual (rv_extras keys)
    ├─ for each key → getCapabilities(key).tooltipType
    ├─ tooltipRegistry.getDataResolver(tooltipType) → data
    └─ tooltipStore.show({ id, data, mode, cursorPos, priority })
                ↓
         TooltipLayer (renderer)
                ↓
         tooltipRegistry.getProvider(contentType)  →  Content Provider (React)
```

The same controller also auto-attaches a **PDF links section** (`PdfTooltipSection`) at the bottom whenever `node.userData._rvPdfLinks` is non-empty.

**Three positioning modes:**
- **cursor** — Follows mouse pointer (ref-based updates, no React re-render on move)
- **world** — Projects a 3D `Object3D` to screen coordinates (for focused/selected objects)
- **fixed** — Uses a fixed screen position

**Key design decisions:**
- **One controller for all types**: `GenericTooltipController` replaced the previous per-type controllers (Drive/Pipeline/Metadata/AAS).
- **Capability-driven dispatch**: which `rv_extras` keys produce a tooltip is decided by `getCapabilities(type).tooltipType` in [rv-component-registry.ts](src/core/engine/rv-component-registry.ts). No controller code per type.
- **Data-only store**: Holds typed data objects, not ReactNodes (avoids re-render storms)
- **Shallow-compare guard**: `show()` only notifies React when data fields actually change
- **Cursor position is ref-based**: Updated via `getCursorPos()`, polled at 100 ms — not in React state
- **Priority resolution**: several bubbles can be visible at once (one per `targetPath`; entries sharing a `targetPath` merge into one bubble with stacked sections). Hover tooltips are the exception — at most one at a time, and the entry with the **highest** `priority` number wins (default `0`)
- **useSyncExternalStore**: React 18+ pattern for efficient subscription without cascading renders

**Built-ins**: Drive, RuntimeMetadata, Pipe, Pump, Tank, ProcessingUnit, Lamp, WebSensor, AASLink. Each ships a content provider + a data resolver.

**Adding a new tooltip type** (e.g., Sensor):

```typescript
// 1. Declare the capability — in rv-component-registry registration:
registerComponent({
  type: 'Sensor',
  // ... other fields ...
  capabilities: { hoverable: true, tooltipType: 'sensor' /* matches step 2 */ },
});

// 2. Register a content provider AND a data resolver — self-registers at module import
import { tooltipRegistry, type TooltipContentProps } from './core/hmi/tooltip/tooltip-registry';

function SensorTooltipContent({ data }: TooltipContentProps) {
  return <Typography>{data.sensorName}: {data.occupied ? 'Occupied' : 'Free'}</Typography>;
}

tooltipRegistry.register({ contentType: 'sensor', component: SensorTooltipContent });

tooltipRegistry.registerDataResolver('sensor', (node, viewer) => {
  // node has rv_extras.Sensor — derive what to display
  const path = viewer.registry.pathFor(node) ?? node.name;
  const sensor = viewer.sensors.find(s => s.path === path);
  if (!sensor) return null;
  return { type: 'sensor', sensorName: node.name, occupied: sensor.occupied };
});

// 3. Side-effect-import the content module so registration runs (in App.tsx)
import './core/hmi/tooltip/SensorTooltipContent';
```

That's it — the single `GenericTooltipController` will now show the sensor tooltip on hover and on selection (pinned). No controller code to write.

**React hook:**
```typescript
import { useTooltipState } from './hooks/use-tooltip';
const { visible } = useTooltipState();  // VisibleTooltip[] — all currently visible bubbles
```

### Hierarchy Panel

The Hierarchy Panel (left dockable panel, owned by `RvExtrasEditorPlugin`) renders a tree of every node carrying `userData.realvirtual` plus the live overlay-override state. Two view modes:

- **All** — virtualised tree with expand/collapse. Its expanded-independent structural tree is cached, while placed LayoutObject/CADLink children are injected lazily without rebuilding unaffected branches (see below).
- **Drives / Sensors / Signals / Logic** — flat, virtualised view filtered by component family. Logic mode preserves container indentation.

#### The model root row

The **All** tree's top row is the loaded GLB's own root (`viewer.currentModelRoot`), expanded by
default. Before plan-715 `buildStructureTree` folded it away as a wrapper; it is a real,
registered node — the asset's identity and the anchor for asset-level metadata — so it is now
shown, selectable and inspectable.

It is also the one row that is **structurally frozen**:

| Verb | Root | Children |
|------|------|----------|
| Select, expand/collapse, edit components & metadata | yes | yes |
| Rename, delete, reparent, transform, hide | **no** | yes |
| Drag as a source | **no** | yes |
| Drop *onto* (move a node back to the top level) | yes | yes |

Three details are load-bearing:

- **The label is the DOCUMENT name**, not `Object3D.name` — document name → GLB file name
  without extension → the node's own name. Renaming the node would rewrite the first segment of
  every stored node path, so the name is never touched (see
  [doc-node-paths.md](doc-node-paths.md) §1a).
- **The lock is central, not cosmetic.** `isModelRoot()` (`src/core/engine/rv-model-root.ts`) is
  the single predicate, and the refusals live in `AssetDocument.renameNode` / `transformNode` /
  `setNodeVisible`, so the UI, the MCP editor tools and any future caller inherit them. The
  Property Inspector shows the root's Transform section permanently locked (no unlock toggle);
  its components and metadata stay fully editable.
- **The flat type-filter views deliberately have no root row.** They are filtered *component*
  lists, not trees, and the root carries no component types.

`web_node_tree` starts at the same node by default and marks it `locked: true`. Child paths are
identical either way — only the root entry and the reachable depth per call differ.

#### LayoutObject expand behavior

Placed catalog items (LayoutObjects from the Layout Planner) are expandable like normal GLB nodes. When the user opens the chevron on a LayoutObject:

- Inner nodes that carry their own `userData.realvirtual` (drives, sensors, signals, etc.) appear as normal child rows and route through the Property Inspector as standalone selections.
- Mesh-only descendants (no `userData.realvirtual`) appear as dimmed/italic rows. They are selectable for highlight + Transform-only inspection.
- Sub-paths are registered on demand into the `NodeRegistry`, so plugins that query by path (`viewer.registry.getNode('RC/Drive-Lin-X')`) see them as first-class nodes.

Selection sources differentiate intent:

- 3D-viewport picks resolve up to the LayoutObject root (so the whole placed object highlights and lifts together).
- Tree clicks keep the explicit sub-path, exposing nested drive properties to the inspector.

When the LayoutObject's `Locked` flag is set, edits on any sub-path are rejected (`updateOverlayField` returns `false` and logs a warning). The root row itself stays editable so the user can unlock it without first reverting nested changes. Deleting a LayoutObject purges every overlay entry whose path falls under that subtree, so re-placing a catalog item with the same root name starts from defaults.

### WebXR (VR/AR)
VR on Quest, Vision Pro, PCVR. AR with hit-test surface detection and model placement. Uses `setAnimationLoop` for XR frame callback.

### Simulation Control (Play / Pause / Reset)

The TopBar SimController plugin exposes two buttons next to the existing tools:

- **Play / Pause toggle** — toggles the `'user'` pause reason via `viewer.setSimulationPaused('user', …)`. Pausing freezes every `onFixedUpdate` consumer (drives, transport, sources, sinks, LogicSteps). `onRender` keeps running so the scene stays interactive (camera, selection, gizmos).
- **Reset** — calls `viewer.resetSimulation()`, which clears all MUs, resets LogicSteps to `Idle` **and snaps every drive back to its authored `StartPosition`** (`RVDrive.reset()`). Only **signals** are intentionally left alone — blanket-resetting them would fight Live mode, so each component re-establishes the signals it owns in its `onReset` / `onStart` handler. See [doc-lifecycle.md](doc-lifecycle.md) §6.2.

Keyboard shortcuts (enabled by default, suppressed inside text inputs):

| Key       | Action                          |
|-----------|---------------------------------|
| `Space`   | Toggle Play / Pause             |
| `Shift+R` | Reset MUs + LogicSteps + drives |

#### Pause is a multi-reason set

Pause is reference-counted by `string` reason. Multiple subsystems can hold it simultaneously, and the simulation only resumes after every holder releases its reason:

| Reason          | Holder                                       |
|-----------------|----------------------------------------------|
| `'user'`        | SimController Play/Pause button (+ shortcut) |
| `'layout-edit'` | Layout-Planner while the planner is active   |
| `'ar-placement'`| WebXR plugin while placing the model in AR   |

The Pause-Badge in the TopBar shows the active reasons live (`paused: user, layout-edit`) so it's easy to debug why the simulation is frozen.

#### Live mode

In Live mode, the WebSocket / MQTT / REST interface listeners **continue to write** into the `SignalStore` while the simulation is paused. Drives and components do not consume those values until the simulation resumes — the next `onFixedUpdate` tick picks up the **current** signal values, which means drives may visibly snap to a new target ("live snap") rather than gradually interpolating. This is intentional: it prevents the viewer from running on stale data after a long pause.

#### Dev-tools escape

If a plugin crashes mid-execution and leaks a pause reason, `viewer.clearPauseReasons(reason?)` is a manual override. Logs a `[SimControl]` warning. Use sparingly — the plugin's own `dispose()` should normally clean up its own reason.

#### MCP tools

When the MCP bridge is connected, the following tools are exposed:

| Tool                  | Purpose                                                    |
|-----------------------|------------------------------------------------------------|
| `web_sim_play_pause`  | Toggle or explicitly set the `'user'` reason                |
| `web_sim_reset`       | Clear MUs + LogicSteps + reset drives (`resetSimulation()`) |

## Context-Sensitive Help

One help button sits at the bottom of the ActivityBar (plus <kbd>F1</kbd>). It opens the
documentation page that matches the current application state in a **new browser tab**. There
is no in-app documentation viewer and no iframe.

### How the target is derived

The context is **derived at call time, never mirrored**. The signals that decide it are already
reactive and already owned by someone, so there is no second store to keep in sync and nothing
that can be left behind:

| Rank | Source | Read from |
|------|--------|-----------|
| 40 | Plugin contribution | `help-topic-registry.ts` |
| 30 | Most recently opened window | `viewer.leftPanelManager` → `snapshot.lastOpenedSide` |
| 20 | Active workspace mode | `viewer.modes.activeMode` |
| 0 | Fallback | documentation root |

`deriveHelpTopic(input)` is a pure function; `readHelpContextInput(viewer)` collects the triple
from the viewer. Both are in `src/core/hmi/help-context.ts`.

Because left and right panels can be open simultaneously, "the active panel" does not exist.
`LeftPanelManager` therefore carries `lastOpenedSide` in its snapshot — the side whose window
was opened last, re-derived on close and on restore, and deliberately **not persisted**
(session state, not a setting).

Nothing is ever a dead end: an unknown panel id or mode falls through to the next rank and
finally to the documentation root.

### Files

| File | Contents |
|------|----------|
| `src/core/hmi/help-topics.ts` | Topic tables (panel → slug, mode → slug), labels, and `KNOWN_DOC_SLUGS` — an offline sitemap snapshot the tests check every slug against |
| `src/core/hmi/help-context.ts` | `deriveHelpTopic`, `readHelpContextInput`, `openCurrentHelp`, `useHelpTopic`, `useHelpShortcut` |
| `src/core/hmi/help-url.ts` | `buildHelpUrl` (slash normalisation, anchor, scheme validation) and `openExternal` |
| `src/core/hmi/help-topic-registry.ts` | Plugin contributions — see `doc-extending-webviewer.md` |

`openCurrentHelp(viewer)` is the single entry point: the click handler and the <kbd>F1</kbd>
listener both call exactly it, so they cannot diverge and a configured base URL cannot apply to
only one of them. It is **strictly synchronous** all the way to `window.open(url, '_blank',
'noopener,noreferrer')` — an `await` in that path would let popup blockers swallow the tab.

> Not to be confused with `DOC_BASE_URL` in `tooltip/MetadataTooltipContent.tsx`. That constant
> resolves relative links out of Unity `RuntimeMetadata` (customer content on
> `doc.realvirtual.io`) and is a separate concern.

### Keyboard and visibility

<kbd>F1</kbd> is registered on the app shell, not on the button, so it keeps working in FPV
where the ActivityBar is hidden. It obeys the same `help` visibility rule as the button —
in a kiosk deployment both are gone, and the key does **not** call `preventDefault()` there, so
the browser's own F1 handling stays untouched. The same applies while the caret is in an input,
textarea or contenteditable.

Default rule: `{ hiddenIn: ['kiosk'] }`, overridable per deployment through
`ui.visibilityOverrides['help']` (see *Context Visibility Overrides*). The base URL is
configured separately via `docs.baseUrl` (see `doc-deploy.md`).

On mobile the entry appears in the "⋮" overflow menu instead of the bar. In the CONNECT embed
shell it is part of the activity-bar allowlist.

## Signal Chips & Interaction Model

`SignalBadge` (`src/core/hmi/rv-signal-badge.tsx`) is the single signal chip component used everywhere a signal appears — the hierarchy browser, the property inspector, the CONNECT panel, the signal-bind popover and the signal search overlay.

### Display variants

Three normalized variants control how much a chip shows:

| Variant    | Renders                                | Example                    |
|------------|----------------------------------------|----------------------------|
| `full`     | Name (dot notation) + type + value     | `Conveyor.Start OutBool ●` |
| `standard` | Name + value                           | `Conveyor.Start ●`         |
| `minimal`  | I/O direction letter + value           | `O ●`                      |

The global default lives in the persisted signal-display store (Settings ▸ Interfaces ▸ Signal chips). Any `SignalBadge` usage may override it with the optional `variant` prop — the prop wins over the global setting. The label itself is built by the pure `buildChipLabel(variant, parts)` helper.

**Chip width (plan-422).** Names are no longer cut to a character count. `buildChipLabelParts()` splits the label into an elidable `name` and a fixed `tail` (type + value); the chip lets the name shrink with a CSS ellipsis against the real column width while the reading keeps its size, and the whole label sits in the chip's `title`. A 24-character cap in a popover column wide enough for the full name was how "PLC_ExitConveyorRun" reached users as "PLC_ExitCon…". `SIGNAL_CHIP_NAME_MAX` is still exported for surfaces measured in characters rather than pixels — the 3D badges are not one of them, they are icon sprites and never drew the name.

### Interaction model

The chip interactions are strictly separated:

| Gesture                  | Effect |
|--------------------------|--------|
| **Hover**                | Interactive tooltip: full name, direction · type · value, address · source, originating CONNECT interface (resolved via signal membership in the CONNECT snapshot), comment, and **all** component bindings (max 8 rows + "+N more"). Every binding row is clickable and navigates to the bound component; clicking the tooltip title navigates to the signal node itself. |
| **Click**                | Force (pin) the signal — bool chips toggle, numeric chips open the force-value popover. Gated by the force confirmation. |
| **Drag** (no modifier)   | Start a signal drag to create a link. A ghost chip follows the cursor; `Esc` or releasing without a target cancels. |
| **Shift+Drag**           | The same drag, kept as an explicit gesture. |
| **Touch: long press**    | Arms the drag (500 ms). Moving before it elapses stays a scroll; a tap is a normal click. |

**Shift is no longer required (plan-422 F6).** The state machine already told a press from a drag by MOVEMENT, so a plain pointerdown arms too and the release decides: under the 4 px threshold it is the ordinary force click, past it a drag. The one thing that had to change is the trailing click — a Shift+Click has never forced and is still swallowed, while a plain press must reach the chip. That is `armSignalDrag(..., { clickOnRelease: true })`. A completed drag always suppresses the click, so a drag never forces the signal it started from.

While a drag is in progress all signal tooltips are suppressed globally.

### 3D link badges — hover card

Hovering a 3D link badge (the plug sprites shown in signal link mode) opens a card naming **which element** the plug belongs to plus one line per slot with its binding state (`SignalBadgeTooltipContent`, driven by `BadgeTooltipController`). Badges are auxiliary raycast targets owned by the node they sit on, so a hover reports that owner; the badge is recognised through the hit mesh (`badgeRootOf`), which is why this is a separate controller from `GenericTooltipController` — otherwise a badge hover would show the drive/lamp card of the object behind it. The card is suppressed during a drag, where the drop overlay already names the candidate.

### Drag & drop signal linking

The drag state machine lives in `src/core/hmi/signal-drag-store.ts` (`idle → armed → dragging → drop/cancel`); the `SignalDragPayload` carries `name`, `direction`, `plcType`, `address`, `comment`, `source`, the provider identity (`interfaceId`, and `topic` for MQTT) and a **required** `origin: 'connect' | 'internal'`, so drop targets validate without a store roundtrip. `origin` is what tells an internal model signal (which deliberately has no `interfaceId`) apart from a CONNECT signal that lost its provider. Drag sources are every signal chip and the whole signal rows of the CONNECT panel list. Drop targets register their DOM elements in `src/core/hmi/signal-drop-target.ts`; the drop is resolved centrally at pointerup with `elementFromPoint` plus a rect-union fallback per target (a slot row spanning several grid cells accepts drops across its whole band — portals and MUI popovers cannot swallow the hit). Hovering a target shows green (accepted) or red (type/direction mismatch — the drop is ignored) feedback.

Drop targets:

- **Signal slot rows** — the inline Property-Inspector rows AND the signal-bind popover rows (both `SignalSlotRow`): dropping a CONNECT signal onto a slot row creates the mapping through the same code path as the picker (type/direction validated by `slotAcceptsSignal` in `src/plugins/signal-bind/drop-accept.ts`).
- **3D scene** — dragging over a placed element with bindable slots auto-opens its signal-bind popover (debounced ~250 ms, `src/plugins/signal-bind/scene-drag-open.ts`), so the drop can land directly on a slot row. Leaving the element without dropping closes the auto-opened popover again. Requires the planner signal-linking feature (`signalBindingManager`).

## Typed Connections

Typed, directed connections link two components logically — persisted in the rv-ODT `Connections` block (`connections` edge list + `connectionTypes` signatures, `schema/v1/rv-odt.json` section 7g), so a GLB is self-describing. A connection is a named **bidirectional call**: the source invokes the target with request parameters; the target answers — usually deferred through a reply handle — with response parameters. Edges are 1:n capable (several edges may share a source or a target).

Two type categories share one storage / drag / inspector / cable mechanism:

| | Built-in (engine-semantic) | User-defined |
|---|---|---|
| Example | `StopOnExit` | `QualityCheck`, … |
| Signature | in code (`registerBuiltinConnectionType`) | data in `connectionTypes` (request/response parameter schemas) |
| Receive | `onArrival(mu)` | `onRequest(topic, params, reply)` |
| Answer | `mu.release()` | `reply(response)` (deferred, exactly once) |

**StopOnExit** builds a work station without code on the conveyor side: connect a sensor (source) to a station script (target). An MU reaching the sensor is stopped — the **transport surface decides how** via its `Accumulate` flag: on an accumulating surface the single MU is held (owner tag `heldBy: 'connection'`, the belt keeps running, following MUs accumulate); on a non-accumulating surface — or for instanced MUs (`useInstancing`), which have no per-instance hold — the surface's **drive is stopped** (note: a drive shared across several surfaces halts the whole line). The station script receives `onArrival(mu)`, processes (`self.in(ProcessTime, 'done', mu)`) and frees the MU with `mu.release()`.

Runtime pieces:

- `src/core/engine/rv-connection-registry.ts` — edge/type model, adjacency index, request/reply dispatch (re-entrancy-guarded), parameter validation.
- `src/core/engine/rv-connection-hold.ts` — the MU hold controller (single-MU hold vs. belt stop, per-drive refcount).
- `src/plugins/connection-system-plugin.ts` — loads the `Connections` extras block, applies edit-op edges on `scene-loaded`, dispatches StopOnExit from sensor `component-event`s and couples holds/reply handles to `simulation-reset`.
- `src/plugins/connection-gizmo-plugin.ts` — optional cable layer: one `link-line` gizmo per resolvable edge, colored by type, endpoints tracked per frame without geometry rebuilds. Toggleable via the Display panel's `Connections` overlay category.

Editing: the Property Inspector's **Connections** section lists in/out edges as chips (click navigates to the other end), offers typed per-edge config fields, an add form, a drag handle (drag onto another node in the 3D scene to connect) and the connection-type editor. All edits are ops (`addConnection` / `removeConnection` / `setConnectionType`) — undoable and draft-autosaved. GLBs without a `Connections` block load unchanged.

## Unified CAD Import

All geometry sources are imported through one entry point: the **Import** button (left tool toolbar, available in every workspace mode) opens the Unified Import Dialog. Its tabs come dynamically from the import provider registry (`viewer.importProviders`):

| Provider | Source | Build |
|----------|--------|-------|
| GLB File | local `.glb` file(s) | core (public) |
| STEP | local `.step`/`.stp` via occt WASM (browser-local, no upload) | private |
| Asset Manager | Unity Cloud Asset Manager (shared connections with the Library panel) | private |
| Onshape | Onshape cloud (registry entry point reserved) | private |
| AutomationML | local `.aml` **folder** (or a single `.amlx`) — CAEX topology + referenced COLLADA | private, **internal only** |

The dialog makes the target explicit ("Import as"):

- **Add to current scene** (default) — additive: the result is placed as a layout component through `viewer.importObject()`. The placement is recorded in the scene op log (undo/redo, autosave) and the imported geometry is written into the active project's `library/imports/` as a regular library asset, so it reloads like any catalog item. Without a writable project open the import still works but a warning marks it as non-persistent. The "Auto-align to floor" checkbox controls the AABB pivot/floor alignment — uncheck it for multi-part CAD assemblies that must keep their CAD origin.
- **Open as new scene** — replace: loads the result as a new model (clears the current scene), identical to opening a model from the selector.

Providers report availability reactively (`ready` / `needs-setup` / `connecting`); a provider that needs a login or credentials shows a setup hint instead of its form. Errors and partial results (e.g. 3 of 5 files converted) are listed in the dialog — nothing fails silently. See `doc-extending-webviewer.md` §21 for writing your own provider.

### AutomationML (plan-420, internal preview)

The AML tab is the one provider that picks a **folder**, not a file. An AutomationML package is a `.aml`
document plus a sibling geometry folder referenced as `./dae_lib/X.dae`, and a browser cannot resolve
that relative path from a lone `<input type="file">` — so the tab uses `webkitdirectory` and resolves
every reference against `webkitRelativePath`. A single `.amlx` (ZIP) is accepted as a convenience road
and is size/ratio/path-checked from the ZIP central directory before anything is decompressed.

What it reads today, and what it deliberately does not:

| Read | Not read (later phases) |
|------|-------------------------|
| `InstanceHierarchy` → one editable node per CAEX element | Kinematics (this format carries it inside COLLADA, not CAEX) |
| `Frame` (x/y/z/rx/ry/rz) → node transforms | Signals and PLCopen logic |
| CAEX `Attribute`s → one `AutomationMLAttributes` component per node | AML **export** |
| All referenced COLLADA geometry, complete | |

Three properties are worth knowing when reading the code:

- **The whole package becomes exactly ONE GLB.** The editor sink loops over the resolved items and
  notifies the document after each one; with more than one item, the semantics waiting to be applied
  would fire at a half-loaded model. So every COLLADA resource is composed into one transient root and
  serialized once.
- **three's `ColladaLoader` is not enough on its own** and a text pre-stage
  (`aml-collada-prepare.ts`) sits in front of it: `<tristrips>`/`<trifans>` are triangulated (84 % of
  the reference library's triangles live there and the loader drops them without an error), and
  cross-file `<instance_node url="Other.dae#id">` links are cut into placeholders and re-stitched over
  a cycle-safe file graph (the loader throws a `TypeError` on them). The parse itself cannot move into
  a Worker — `ColladaLoader` needs `DOMParser`, which Workers do not have — so it yields between files
  and shares one built subtree per repeated reference instead.
- **The Z-up→Y-up conversion happens exactly once**, on the import root, and the provider stamps
  `ZIsUpVector: false` / `ImportScaleFactor: 1` so the sink does not apply it a second time. That is
  also what makes a CAEX `Frame` directly usable: everything below the root is plain package space.

Registered from `internal-plugins.ts` only. Console entry: `await rvAml.dryRun(files)` /
`await rvAml.import(files)`. "Re-import…" is not supported for AutomationML.

### CAD metadata (`JTData`)

JT files carry more than geometry: part name, mass, source units, layer and a stable per-body
uid. The JT reader writes a curated subset of those into each node as
`extras.realvirtual.JTData`, and the viewer registers it as a read-only component so the values
show up in the property panel.

| Field | Meaning |
|-------|---------|
| `ContractVersion` | Version of the metadata contract this block was written with |
| `PartName` | Part name from the CAD system |
| `Mass` | Mass of the part — **the unit is not recorded in JT files**, so it is reported as unknown rather than guessed |
| `MassSource` | `asserted` (user-set, assembly level) or `cad` (computed, part level). These describe **different objects** and must not be summed |
| `SourceUnits` | Length unit of the source model, raw — before the mm→m conversion the reader applies |
| `Layer` | CAD layer |
| `BodyUid` | Stable per-body uid, suitable for matching a part across CAD revisions |

Three properties are worth knowing:

- **Every field is optional.** The reader omits what the source file does not provide instead of
  writing `0` or `null`, so a block carrying only `ContractVersion` and `Layer` is normal. A GLB
  with no `JTData` at all is equally normal — not every exporter fills these properties.
- **It is provenance, not user state.** `JTData` describes the imported geometry. On CAD
  re-import it is therefore *not* carried over from the previous revision: the freshly imported
  values win, while your own components (drives, sensors, …) survive as usual.
- **Read-only, and not addable by hand.** The importer writes it; the inspector shows it.

## Materials Window (Editor mode)

> **Commercial feature.** The Editor UI (`plugins/asset-editor`) is licensed, not AGPL, and
> is not part of the community edition. The *document model* it drives — `AssetDocument`, the
> op log and its executors under `src/core/editor/` — IS core and stays AGPL: the community
> build keeps it and simply has no Editor mode to author with.

Imported CAD arrives with whatever appearance the source file carried — usually a sea of flat greys. The **Materials** window (palette button in the left tool toolbar, Editor mode only) applies material presets to the selection and reports the material/texture health of the asset.

It docks on the right and shares that slot with the Quick Edit window — opening one closes the other.

**Sections**

- **Asset** — material and texture counts, plus actionable warnings: duplicate materials (distinct instances that render identically), oversized (≥2048px) and non-power-of-two textures, and transparency flags with no visual effect. Clicking a warning selects the parts it refers to. Deliberately no triangle/draw-call stats — those live in Settings → Dev Tools.
- **Presets** — a swatch library grouped into Metal, Plastic, Rubber & Glass and Paint (RAL). Click applies to every mesh under the selection. Custom presets appear in their own group.
- **Edit** — free PBR editing (base color, metalness, roughness, opacity) seeded from the primary selection, saveable as a custom preset. Custom presets persist in `localStorage` under `rv-editor-material-presets`.

**How it persists.** Each apply is a `setMaterial` op on the AssetDocument, so it is undoable and lands in the GLB on save as a real glTF material — there is no `rv_extras` override layer for appearance. Dragging a slider coalesces into a single undo step.

**Two invariants worth knowing** (`src/core/editor/rv-asset-material.ts`):

- **Clone-on-write.** The loader's dedup pass means one material instance routinely backs hundreds of parts, so applying a preset *assigns* a different instance and never mutates the attached one. Painting a subassembly cannot change parts elsewhere that happened to share its material.
- **One instance per distinct value.** Painting 400 parts "Steel" yields a single shared material, so the exported GLB does not carry 400 identical definitions. Undo re-attaches the exact original instances, preserving whatever sharing existed before.

**Editor mode only, by design.** Editor mode loads with `preserveHierarchy: true`, which skips the uber bake and nulls the `BatchTable`, so every node keeps its own real material. In batched modes the same assignment would be a silent no-op — batched source meshes render at `layers.mask = 0` and the arena keeps drawing the baked appearance. The plugin's `modes: ['editor']` gate is what keeps the window out of those modes.

## Asset Editor Op Log — Bulk Edits and Failure

> **Commercial feature.** The Editor UI (`plugins/asset-editor`) is licensed, not AGPL, and
> is not part of the community edition. The *document model* it drives — `AssetDocument`, the
> op log and its executors under `src/core/editor/` — IS core and stays AGPL: the community
> build keeps it and simply has no Editor mode to author with.

The asset editor records every edit as an `RvOp` on the `AssetDocument`
(`src/core/editor/rv-asset-document.ts`), applies it through
`AssetExecutorContext` (`rv-asset-executors.ts`) and folds multi-step actions into
one `composite` undo unit via `withTransaction`. Two properties of that machinery
are load-bearing once an edit touches hundreds of nodes at once.

**`AssetDocument` and `SceneStore` are behaviour layers, not documents**
(plan-710). Both hold one [`RvDocument`](src/core/ops/rv-document.ts) — the one
class that owns the op log, the single-flight queue, transactions, coalescing,
undo/redo, the history cap and dirty derivation — and neither carries a copy of
that machinery any more. What is genuinely theirs remains theirs: op
CONSTRUCTION, the base/workspace lifecycle, and their own save orchestration.
Three consequences worth knowing when reading either file:

- **One vocabulary.** Ops are built as `RvOp` at the source. The old parallel
  type names and the up-/downcast layer between them are deleted, so an apply no
  longer converts and reading the op log is no longer an O(n) downcast of the
  whole array.
- **A shared snapshot core.** `dirty`, `busy`, `canUndo` and `canRedo` are
  derived once, in `RvDocumentCore`, and spread into whatever shape a layer
  needs around them. `SceneSnapshot` keeps its eleven scene-specific fields (the
  materialised `RvScene`, the catalogue, the published list) — forcing one shape
  over both was an earlier draft's mistake.
- **Guards are parameters, not copies.** The scene's "no ops during a load" gate
  and the asset lineage's "no ops during a CAD base swap" gate are the same
  `canApply` callback; `hasUnpersistedWork` is another such callback
  (see doc-persistence.md §3.5c).

### One top-level op per bulk move (`reparentNodesBatch`)

`AssetExecutorContext._afterApply` runs **once per top-level op** — and each run
emits `editor-structure-changed` (which costs the hierarchy panel a full
`scene.traverse`) plus one grouped-BVH classification. So an API that emits one op
per node makes both of those scale with the node count.

- `reparentNodes(paths, target)` — one top-level op **per node**. Use it for
  interactive moves (drag & drop, a handful of nodes).
- `reparentNodesBatch(paths, target)` — the whole block resolved **before** the
  first mutation and applied as **one composite**: one structure event, one BVH
  classification, one world-matrix flush, one undo step. Use it for anything bulk
  (`groupIntoEmpty`, the PLMXML kinematics import).

Measured on a synthetic 4493-node assembly moving 434 nodes with the hierarchy
panel open: **178 ms → 21 ms**, structure events 773 → 8, forced
`updateMatrixWorld` walks 1306 → 16. 73% of the original cost was the panel
re-scanning the scene once per node.

The batch is deliberately **not** a new persisted op kind — it composes the
existing `renameNode`/`reparentNode` primitives, so undo, redo, draft replay and
the op-log schema are unchanged. Two details it owns: all paths and collision
renames are resolved up front (a later lookup can never be invalidated by an
earlier move), and `prevIndex` is recorded against the parent's children **minus
the batch's earlier members**, because the inverse restores them in reverse order
into a list that grows back one node at a time — snapshotting raw indices
scrambles sibling order on undo.

The matrix batching that goes with it is applied **only** to a composite made
purely of moves and renames (`isPureMoveComposite`): those apply a transform
resolved before the batch opened, so nothing inside reads `matrixWorld`. A
composite that also constructs components keeps the eager per-op refresh, and the
flush itself is unconditional — the editor pick backend reads `matrixWorld` raw.

### Failure contract

An op **either applies or rejects**; a transaction is **all-or-nothing**.

- `applyOp()` rejects when the executor failed, and the op is then not recorded.
- A `composite` that fails part-way rolls its already-applied primitives back
  before re-throwing (`_forwardAny`/`_inverseAny`).
- `withTransaction()` rolls back everything it applied, records nothing, and
  re-throws the original error — including failures from the `void`-returning
  mutators (`setField`, `addComponent`, …), which land in `_txnError`.
- `undo()`/`redo()` move their stacks only **after** the apply succeeded, so a
  failed undo stays retryable.
- The op queue tail never rejects, so one failed op cannot poison later ones.

The single documented exception is `CadGeometryUnavailableError`: it stays a
collected, user-recoverable condition (`takeMissingCadGeometry`) so replaying a
draft whose GLB cache was evicted still restores everything else.

### Busy state during a transaction

A transaction suppresses intermediate store notifications (868 synchronous
`useSyncExternalStore` snapshot changes for 434 moves used to abort the apply with
React's "Maximum update depth exceeded"). Because that also swallowed the `busy`
transition, the transaction publishes busy **once** when it opens and drops it on
commit or rollback. The observable sequence for a bulk edit is therefore exactly
three states: `busy` → `busy, dirty, undoable` → `idle, dirty, undoable`.

### Mesh Separator — splitting one mesh into its parts

A CAD import often arrives as a *single* mesh holding several physically separate
parts. Such a mesh is one unit for selection, material assignment, visibility and
kinematics. **Separate** cuts it apart, after which the existing per-mesh paths
apply unchanged — no special case in `setMaterial`, picking or the GLB export.

Right-click a single selected mesh → **Separate ▸**

- **Into parts…** — connected components, found by union-find over
  position-quantized vertices.
- **By material group…** — one part per `geometry.groups` entry, each carrying
  the material of its own slot. Offered only when the mesh has ≥ 2 groups.

The click opens a confirmation dialog reporting the part count; nothing is applied
until it is confirmed.

**Weld and output are separate roles.** The weld (`weldVertexIds`) quantizes the
**position only**, and exists only to build the connectivity graph; the output
geometry is rebuilt from the **original** vertex indices, so normals, UVs and hard
edges survive. Hashing all attributes instead — what `BufferGeometryUtils.mergeVertices()`
does — reports six islands for a single hard-edged cube, because each face has its
own normal at every shared corner. `weldThreshold` (default `0.0001`, an API
parameter, no UI setting) is therefore a **quantization resolution, not a distance
tolerance**: two points closer than the resolution can still land in adjacent grid
cells and stay separate.

**Where the work runs.** Weld, union-find and the attribute copy run in a Web
Worker (`rv-mesh-separator-worker.ts`) behind `RVMeshSeparatorClient`, in two
phases — `analyze` for the preview, `extract` only after confirmation. Measured on
a workstation, a main-thread run costs 63–380 ms from ~200k vertices upward, which
is exactly the range this feature targets. Request buffers are **copied, never
transferred** (a transfer would detach the live source geometry's `ArrayBuffer` and
take rendering and raycasting down with it); responses are transferred. Every
request carries a monotonic id, and an answer whose id is stale is dropped — that
is how dialog cancel, a geometry change and `dispose()` abort.

**What the op does** (`separateMesh`, `rv-asset-executors.ts`). The source mesh is
replaced by a **same-named `Group`**, so its path stays valid:

- The Group's local transform comes from the **baked `matrixWorld`**
  (`inverse(parent.matrixWorld) · source.matrixWorld`), decomposed to TRS, with
  both auto-update flags copied from the source — editor loads run
  `freezeStaticMatrices()`, after which the local TRS is not authoritative.
- `userData` is **deep-copied**, existing child nodes are moved across, and the
  components of the whole subtree are torn down (`disposeComponentsInSubtree`,
  **before** the registry unregister — afterwards nothing resolves) and rebuilt via
  `processExtras`.
- Undo parks the Group in the trash and brings the original back; redo is *not* the
  `importCad` trash short-circuit, because after an undo the original is live *with
  its children* while the Group sits in the trash.
- The op is parameter-only. `childNames` is resolved **once** at op creation and
  applied verbatim — a collision on replay is a logged no-op, never a silent
  rename, so a live run and a draft replay cannot drift apart.

**Not eligible:** instanced, skinned, morph-target and interleaved geometry (they
cannot be copied attribute by attribute), a mesh that is already a single island,
and — in island mode only — a multi-material mesh, which is routed to the group
mode instead. The reason is reported in the dialog.

**Draw calls.** Editor mode does not bake, so each part is its own draw call; the
dialog states the count. Loading the result in a batched mode does *not* merge the
parts back into one geometry: `rv-batched-render.ts` registers every unique
geometry as its own `BatchedMesh` slot and every mesh as its own instance.
(`buildMergeBatches()` in `rv-mesh-merge-batch.ts` *would* concatenate candidates
into one arena, but it has no caller in this tree — `meshMergeRegistry` is an
unwired seam.)

### Mesh Merge — collapsing a subtree back into one mesh

**Merge** is the inverse of Separate and lives in the same context menu. Where
Separate turns one mesh into a same-named `Group` of island children, Merge turns
the subtree of any node into a same-named **`Mesh`** — one mesh **per material and
per Group**. A deeply nested CAD import becomes a flat, HMI-ready object without
losing its function.

Right-click any node with children → **Merge into one mesh…**. The label is static
(the classification walks the whole subtree and must not run while the menu opens),
and the entry reads the **clicked target**, not the selection — a right-click on a
hierarchy row highlights it but does not select it. The dialog reports how many
parts become how many meshes and how many nodes are kept, and nothing is applied
until it is confirmed.

**What is merged, and what survives.** `classifySubtree()` in `rv-mesh-merge.ts`
sorts every node of the subtree into three categories, checked in this order:

| Category | Detected by | Effect |
|---|---|---|
| **Protected** | any non-passive rv_extras key, **or** a naming-convention name (`Drive-Rot-Y`, `Transport-Z`, `Sensor`, `Carrier-1`, `Snap-ZP-…`) | node **and its whole subtree** are untouched and become children of the result |
| **Anchor** | `Kinematic`, `Drive`, `CADLink`, `JTData` | the node survives, but its extras-free geometry still merges — into an output that stays **its own child** |
| **Mergeable** | a single-material `Mesh` with no active extras and no guard hit | goes into a bucket |

Boilerplate the Unity exporter stamps on nearly every node (`layer`, `tag`,
`activeSelf`, `renderer`, `rigidbody`, `colliders`) is **passive** and does not
protect anything — without that rule nothing would ever merge. `Group*` is passive
too, but for a different reason: group membership rides along on the output mesh
instead (see below). The naming-convention check uses the same parsers the library
loader uses, so a merge over a conveyor asset cannot dissolve it into a static mesh.

**Owner zones.** Nothing merges across an anchor boundary. Each anchor opens its
own zone, and the output built from its geometry stays a **child of that anchor** —
otherwise a `Drive` would stop moving its own geometry, an asset that looks correct
and is broken. The subtree root is a zone too; exactly one output carries
`role: 'root'` and *replaces* the root at its path (a root zone without geometry
still gets it, as an empty carrier), and every further root-zone output becomes its
child.

**Bucket key** = `ownerPath | sorted group names | materialKey`, deliberately
**without** an attribute signature. `materialKey` is a *semantic* fingerprint —
name, colour, metalness, roughness, map name, side, transparent, opacity — not
`material.uuid`, which three.js re-mints in every `Material` constructor and which
would therefore diverge on a plain GLB reload.

**Geometry.** Every source is baked into its owner's space with **exactly one**
`applyMatrix4()`, which already transforms `normal` **and** `tangent`; a second,
manual normal-matrix pass would transform normals twice. At a negative determinant
the triangle winding is flipped and the tangent handedness `w` inverted — the
renderer compensates mirroring per mesh via `gl.FrontFace`, and once mirrored and
unmirrored parts share one geometry that compensation is gone. The index type is
left to three.js (`setIndex()` picks `Uint32` from the actual index values).

`mergeGeometries()` returns `null` **silently** on incompatible attribute sets, so
the bucket is normalised first, along a whitelist: `normal` (via
`computeVertexNormals()`), `color` (white/opaque) and `uv`/`uv1`/`uv2` (zeros) can
be reconstructed; `tangent`, `skinIndex`, `skinWeight` and any custom attribute
**cannot**, and a mismatch there refuses the merge with a diagnostic rather than
inventing values — and never produces a second mesh for the same (material, Group)
pair. The return value is always checked.

**Where the work runs.** The bake and the merge run in a Web Worker
(`rv-mesh-merge-worker.ts`) behind `RVMeshMergeClient`; classification, traversal
and the attribute copy stay synchronous. Request buffers are tight copies made by
the `serialize*` helpers and are therefore handed over on the **transfer list** —
that detaches nothing live, because the copy is already independent. Measured on a
workstation: a main-thread merge costs ~41 ms at 200k and ~142 ms at 1M vertices,
against ~2.5 ms / ~12.4 ms of main-thread submit cost through the worker; peak live
buffer memory is 2.0× the source buffers at both sizes (the worker bakes its own
copies **in place**, so there is no third copy).

**What the op does** (`mergeMesh`, `rv-asset-executors.ts`). The whole partition —
sources, buckets, output names, owner zones and surviving nodes — is resolved
**once** at op creation (`planMergeMesh()`) and applied verbatim. That is stricter
than `separateMesh`, because bucketing depends on the material: an executor that
re-classified on replay would produce a different split as soon as a `setMaterial`
op ran in between. Every source therefore carries a replay signature
(`materialKey`, vertex and triangle count), and a divergence is reported as a
**collected, user-recoverable failure** (`takeUnappliedMerges()`), never as a
silent no-op and never as a throw — a throw would make the replay caller replace
the partially restored document with an empty one.

Undo is bit-exact: every node that changes parent is recorded with its original
parent object, sibling index, depth and local matrix, captured in one pass **before**
the first detachment, and restored shallowest-first at ascending sibling index.
Children authored under an output *after* the merge are recognised (they are not in
`generated`) and re-homed to the zone's origin owner instead of vanishing into the
trash. Output geometries carry `MERGER_GEOMETRY_MARK` so the trash flush disposes
only what the merge built — the parked originals may be shared and come back alive
on undo, and `disposeBoundsTree()` always runs before `dispose()`.

The replacement node takes the root's local and world matrix, both auto-update
flags, `visible`, `layers`, `castShadow`/`receiveShadow`, `renderOrder`,
`frustumCulled` and a **deep copy** of its `userData`; each output additionally
gets `Group`/`Group_N` extras for its resolved group names, because
`rv-group-sync.ts` derives membership exclusively from those.

**Not eligible:** fewer than two mergeable meshes, a subtree that is only carriers,
a multi-material source (split it with *Separate ▸ By material group* first), and
instanced/skinned/morph/interleaved geometry. The reason is reported in the dialog
and no op is created.

**The cost.** After a merge the parts share one bounding box, so culling is coarser
and a click hits the merged mesh instead of the individual part. That is the point
of the operation, and Separate is the way back.

## Invariant — an authoring load never mutates the GLB hierarchy (plan-727)

**Rule: a load that the asset editor performs must leave the node tree exactly as
the GLB describes it.** The editor's live tree IS the CAD hierarchy at every
moment, so save → reopen → save is a fixpoint and a later CAD re-import still
finds every node where it was authored.

The rule exists because it was broken. `applyKinematicParenting()` (Phase 8b of
`loadGLB`) re-parents kinematic group members under their `Kinematic` node —
correct for a runtime load, mirroring `Kinematic.Awake()` in Unity. It was the
only structure-mutating load phase without a gate (10b, 10c/10d and 13b all have
one). So every editor reopen restructured the live tree, the next save exported
that restructuring, and `relativePathMap()` in `rv-cadlink-reimport.ts` — which
builds its match keys by walking `children` down from the CAD root — no longer
traversed the moved nodes at all. They vanished from the re-import **silently**:
not matched, not even reported as unmatched, components and all.

### Two flags, deliberately not one

| Flag | Means | Set by |
|------|-------|--------|
| `preserveHierarchy` | skip the uber-material bake and the static/kinematic mesh merges; every node stays visible and individually pickable | asset editor, **and `RVEmbedViewer`** |
| `preserveAuthoringHierarchy` | never mutate the node hierarchy: skip kinematic re-parenting | asset editor **only** |

They must not be merged. `RVEmbedViewer` (`src/embed/rv-embed-viewer.ts`) is a
*simulating production runtime* that sets `preserveHierarchy` purely for
pickability while still requiring the re-parenting — gating Phase 8b on that flag
would leave embedded kinematic groups behind their moving axis, with no error and
no log. The Layout Planner's `processExtras()` placement calls likewise stay
ungated.

Guarded by `tests/rv-authoring-hierarchy-invariant.test.ts` (which asserts
positively that `preserveHierarchy` alone does **not** gate) and
`tests/rv-kinematic-save-reload-cycle.test.ts` (the save/reload fixpoint over a
full structure + transform signature). Any future load-time hierarchy mutation
has to respect `preserveAuthoringHierarchy` or those tests go red.

### Why members still move when nothing is re-parented

`processMeshes()` freezes a mesh with `matrixAutoUpdate = false` when no drive is
in its **physical** parent chain — and a group member carries only `Group`, so in
an authoring load the axis is not an ancestor. Frozen means three.js never
rebuilds the matrix from the quaternion a drive writes, i.e. the drive reports
running and the geometry stands still. `reclassifyKinematicGroupsDynamic()`
(Phase 8a-bis) therefore asks the semantic question — *is this mesh moved by a
drive?* rather than *does it hang under one?* — and re-marks every resolved
kinematic group's members dynamic. It runs in **all** modes (in runtime loads it
is idempotent to Pass 3 of `applyKinematicParenting`) and is monotone: it only
ever sets `matrixAutoUpdate` to `true`.

### Known limitation

Overlays whose `onSceneReady()` expects the post-re-parent shape are wrong or
empty in the editor: `RVSafetyDoor`'s outline/halo, the `RVWebError` badge size,
`RVEnergyChain` rigging and the related gizmo AABBs. This is presentation
comfort, not data loss, and is accepted for now — making those consumers
group-aware is tracked as a follow-up plan. Assets whose restructuring was
already baked in before this fix are **not** migrated; only newly saved assets
are correct.

## Renderer Support

- **WebGL** (default): Stable, all browsers
- **WebGPU**: Three.js r185 `WebGPURenderer` with WebGL2 fallback

Selection persists via URL parameter (`?renderer=webgpu`) or localStorage.

### Automatic Quality Selection

Weak devices automatically get the published **"Fast"** visual preset (Unlit render mode, no shadows, no antialias, lower DPR cap) instead of "Default" (`src/core/hmi/auto-quality.ts`):

- **Boot seed** — on a fresh install (no persisted visual settings), a standalone WebGL probe classifies the GPU tier; mobile devices and integrated/software GPUs seed "Fast", everything else "Default".
- **FPS watchdog** — after each model load (5 s grace period), `viewer.currentFps` is sampled (15 valid samples, hidden-tab samples skipped); a median below 20 fps switches to "Fast" at runtime.

Both stages show a one-time modal ("Performance mode enabled", dismissed with OK) and act **at most once per device** — the localStorage flag `rv-auto-quality-applied` guarantees a manual preset choice is never overridden afterwards. The preset can be changed anytime under **Settings → Visual → Preset**.

## Library Thumbnails

Card previews for library assets, projects and documents are rendered in the browser by
`src/core/thumbnails/` — `ThumbnailService` (queue, concurrency 1, pull-based) →
`ThumbnailRenderer` (offscreen render) → `ThumbnailCache` (Cache API). On a WebGPU viewer the
service reports unavailable and every request resolves to `null`; cards fall back to their icon.

**Output**: 512×512 transparent PNG, rendered internally at 1024² and downscaled in one halving
step. Supersampling rather than MSAA, because MSAA is resolved away by the first composer
intermediate (three.js #23300).

**Look is frozen, not live**: previews are rendered with a hard-coded snapshot of the "Default"
visual preset (`THUMBNAIL_LOOK` in `thumbnail-renderer.ts`) — GTAO ambient occlusion (intensity 1,
radius 0.1), fixed ambient/directional light values, no tone mapping, **no bloom**
(`UnrealBloomPass` clamps alpha to 1 and would fill the transparent background, three.js #14104).
Only the environment (HDRI IBL) is mirrored from the live scene. A cached picture is shared and
long-lived, so it must not depend on the render mode the viewport happened to be in. Changing the
look means changing those constants **and** bumping the cache bucket together.

**Contact shadow**: `thumbnail-contact-shadow.ts` bakes a silhouette-true soft shadow — an
orthographic camera on the floor renders the asset with a modified `MeshDepthMaterial` into an
alpha mask, blurred in two passes and mapped onto a plane placed just below `bounds.min.y`. The
plane is always a **sibling** of the asset (the camera fit uses `Box3.setFromObject`, which cannot
exclude it) and is baked **after** the fit. Assets without meshes bake an empty mask and simply get
no shadow.

**Cache invalidation** runs through the bucket name only — the key
(`projectId:providerId:sourceId:assetId[:version]`) deliberately does not include the size. The
current bucket is `rv-thumbnails-v4`; `rv-thumbnails-v3` (short-lived plan-712 previews with a
too-bright ambient fill), `rv-thumbnails-v2` (256px previews) and `rv-planner-thumbnails`
(pre-plan-372 glbUrl keys) are deleted once per browser session. Previews regenerate lazily, for
visible cards first.

Persisted thumbnail **files** are a separate store and are not touched by the bucket bump:
`library/.thumbnails/Custom/*.png` (written by `rv-asset-library-save.ts`) and the planner's
`public/` thumbnails keep their old picture until the asset is saved or regenerated.

## Deployment Configuration (settings.json)

Place a `settings.json` in `public/` (or next to `index.html` in production) to configure the viewer at deployment level. The file is fetched with cache-busting before React mounts, so settings apply immediately without flicker.

A documented example is provided in `public/settings.example.json` — copy it to `public/settings.json` and edit as needed.

### Model signature and provenance

Deploys can embed an Ed25519 provenance signature in the default scene extras:
`scenes[scene ?? 0].extras.rv_sig`. The signature covers the complete finished
GLB byte stream. The signer temporarily substitutes a fixed 88-character
standard-Base64 placeholder, so verification does not reserialize JSON or
depend on property order.

At runtime the loader verifies every GLB before `GLTFLoader.parseAsync()`.
Unsigned models keep the existing behavior. A valid signature enables model
logic immediately. An invalid signature, or a browser that cannot verify
Ed25519, still loads geometry and HMI but gates simulation ticks, component
events, behaviors, and runtime component initialization. The provenance banner
lets the user explicitly activate logic; that decision is stored per model as
`rv-sig-unlock:<modelName>`. Local files use their filename as the stable model
identity instead of their temporary `blob:` URL.

Signed models are self-contained: if `rv_sig` exists, the loader never applies
a neighboring `.kin.json` sidecar, regardless of whether verification succeeds.

Deployment signing is Node-only:

```bash
# PKCS#8 Ed25519 private key, either PEM text or Base64-encoded PEM.
# Never expose this as a VITE_ variable.
set RV_SIGN_PRIVATE_KEY=<private-key>
npm run deploy
```

Public deploys sign retained GLBs after model pruning. Private deploys sign each
plaintext project GLB before optional RVE1 encryption. When signing is enabled,
all GLBs are uploaded even if the remote file has the same size, because a new
valid signature can change bytes without changing length.

Commercial customer keys use a root-certified `rv_key` object. The customer
keeps its Ed25519 private key and receives a certificate for its raw public key:

```bash
node scripts/rv-issue-customer-key.mjs \
  --pub <44-character-padded-public-key> \
  --org "Customer Organization" \
  --out customer-cert.json

set RV_SIGN_PRIVATE_KEY=<customer-private-key>
set RV_SIGN_CUSTOMER_CERT=C:\secure\customer-cert.json
npm run deploy:private
```

The deploy fails if the customer certificate is not root-certified or its
public key does not match `RV_SIGN_PRIVATE_KEY`. Verify a generated artifact
without deploying it:

```bash
node scripts/rv-sign-glb.mjs --verify dist/models/machine.glb
```

### Published models (CONNECT `model_changed`)

A model pushed to a running CONNECT gateway (`POST /model`) reaches the viewer over the WebSocket as
`model_changed`, carrying the model name, the URL it is actually served under and a **revision**
counter. Two rules govern what happens next, and both exist because the previous behaviour — a blanket
`window.location.reload()` — violated them.

**The user's selection is never overridden. Only the contents of their selection are refreshed.**

| Situation | Behaviour |
|-----------|-----------|
| the published model is new | it appears in the model selection; nothing is disturbed |
| the published model is the one currently open | its geometry reloads in place |
| another model is open | nothing happens |
| the open model, but there is unsaved work | a hint offering the choice, never an automatic load |
| no model is open | only the catalogue is updated — an empty scene is a decision, not an invitation |

Who does what:

- `signal-transport-core.ts` forwards the announcement out of the worker instead of discarding it.
- `websocket-realtime-interface.ts` checks that the gateway is the page's own origin
  (`isSameOriginWsTarget`, scheme + host + port including implicit ones) and emits a typed event.
  It performs no action of its own — a page can hold three of these clients (InterfaceManager,
  the per-model one in `ConnectPlugin`, and the inheriting `CtrlXInterface`).
- `rv-model-update-coordinator.ts` is the single actor. It deduplicates by canonical URL **and**
  revision, discards announcements carrying an older revision, and decides per the table above.
- `rv-model-catalog.ts` owns model identity: the **canonical URL** (catalogue key, `localStorage`
  entry, scene-draft key — never rewritten) versus the **fetch URL** (`?v=<revision>`, used at the
  download and nowhere else), plus the catalogue signal that reaches both `SceneStore` and the login
  gate's picker.
- `rv-view-state.ts` captures and restores the complete view — projection, position, quaternion,
  controls target and zoom — because both `loadModel()` and `loadScene()` re-fit the camera. FPV and
  Follow are left alone; they drive the camera every frame.

A model published while the browser was closed or the socket was down is picked up on the next load
from `GET /model/manifest`, laid **additively** over the catalogue the viewer resolved for itself
(`models.json` stays authoritative where it exists). There is no polling.

### CONNECT embedded demo gate

CONNECT's `-PublicDemo` bundle injects `ui.initialContexts: ["connect-embed"]` and an empty
`defaultModel`. The viewer then starts with the CONNECT panel and a minimal CTA shell instead of
restoring a model, scene, or workspace mode. Starting the bundled demo unlocks the regular HMI.
The bundle also carries the AGPL license and an exact corresponding-source link.

In this context the **Models** panel shows exactly one row — the bundled demo. Clicking it starts
the demo, and the **×** on the active row closes it, returning to the non-persisted gate with the
panel still open. Both paths run through `connect-embed-actions.ts`, never through
`SceneStore.openBuiltin` (which would persist a draft the embed context does not want). There is
no demo chip and no close button over the viewport.

### AAS resolution contract

An AAS surface only appears when the link can actually be resolved. The resolvability is decided
once per model load — where the project-specific `assetsBasePath` is known — and written to
`node.userData._rvAasResolution`; tooltip, detail panel, inspector button, doc-mode click, sidebar
counter and "Add to Cart" all read that one marking.

| State | Meaning | UI |
|-------|---------|----|
| `resolved` | `aasx/index.json` available, id known | shown |
| `unknown-id` | index available, id not in it | **hidden** |
| `index-missing` | index not shipped (404 / SPA fallback) | **hidden** |
| `index-error` | network failure, 5xx, broken JSON | visible error |
| `pending` | not determined yet | renders nothing |

A deployment without an AASX payload (the CONNECT embed strips the whole `aasx/` folder) therefore
shows no AAS UI at all instead of a red error on every motor hover. A *broken* index keeps its
visible error on purpose — hiding it would mask a broken deployment.

Links attached at runtime (`attachDriveDatasheets`, layout-planner placements) are marked
`pending` synchronously and classified by `resolveAasSubtree()`, which is driven from the viewer's
`model-loaded` and `layout-content-added` events so it also runs in modes where `AasLinkPlugin`
is not loaded.

### Settings Priority

```
URL Params  >  settings.json  >  localStorage  >  Code DEFAULTS
```

Each settings store (`visual`, `search`, `interface`) follows this 3-layer merge:
1. **DEFAULTS** — Hardcoded in each store module
2. **localStorage** — User's persisted preferences (overrides DEFAULTS)
3. **settings.json** — Deployment config (overrides localStorage per-field via `??`)

### Example settings.json

```json
{
  "lockSettings": true,
  "hideWelcomeModal": true,
  "defaultModel": "models/customer-line.glb",
  "visual": {
    "shadows": true,
    "shadowStrength": 0.5,
    "lightIntensity": 1.0
  },
  "interface": {
    "activeType": "websocket-realtime",
    "autoConnect": true,
    "wsAddress": "192.168.1.100",
    "wsPort": 7000
  }
}
```

### Lock Mode

- **`lockSettings: true`** — Hides the Settings gear button entirely. All `save*()` functions become no-ops (lock guard). End users see only the 3D scene and HMI overlay.
- **`lockedTabs: ["interfaces", "devtools"]`** — Hides only specific tabs in the Settings dialog. The gear button remains visible for unlocked tabs.
- **`hideWelcomeModal: true`** — Suppresses the welcome/about dialog on first visit.
- **`defaultModel: "models/demo.glb"`** — Pre-selects a model on load (can be a filename or full URL).

`lockSettings` is an admin override — it only comes from `settings.json` or the `?lockSettings` URL param, never from localStorage.

### Context Visibility Overrides

Control which HMI elements are visible or hidden based on active "contexts" (e.g. `fpv`, `planner`, `maintenance`, `xr`, `kiosk`). Rules are declared per UI element with `hiddenIn` and `shownOnlyIn`:

The rules live under the `ui` key as `visibilityOverrides` (`UIContextConfig` in
`src/core/rv-app-config.ts`):

```json
{
  "ui": {
    "initialContexts": ["kiosk"],
    "visibilityOverrides": {
      "kpi-bar":      { "hiddenIn": ["fpv", "xr"] },
      "bottom-bar":   { "hiddenIn": ["fpv", "xr", "planner"] },
      "button-panel": { "hiddenIn": ["xr"] },
      "top-bar":      { "hiddenIn": ["xr"] },
      "messages":     { "hiddenIn": ["fpv", "planner"] },
      "views":        { "hiddenIn": ["fpv", "planner"] },
      "kiosk-overlay": { "shownOnlyIn": ["kiosk"] }
    }
  }
}
```

**Rule semantics:**
- `hiddenIn: ["fpv", "xr"]` — element is hidden when ANY of these contexts is active
- `shownOnlyIn: ["kiosk"]` — element is visible ONLY when ALL listed contexts are active
- No rule → always visible (default)
- Rules compose with the existing `H` key HMI toggle via AND logic

**Built-in contexts:** `fpv` (first-person view), `planner` (layout planner), `maintenance`, `xr` (VR/AR), `kiosk`

Plugins activate/deactivate contexts programmatically:

```typescript
import { activateContext, deactivateContext, setContext } from './core/hmi/ui-context-store';

activateContext('fpv');     // Hides elements with hiddenIn: ['fpv']
deactivateContext('fpv');   // Restores visibility
setContext('kiosk', true);  // Convenience toggle
```

React components subscribe via the `useUIVisible()` hook:

```typescript
import { useUIVisible } from './core/hmi/ui-context-store';

function KpiBar() {
  const visible = useUIVisible('kpi-bar', { hiddenIn: ['fpv', 'xr'] });
  if (!visible) return null;
  // ...
}
```

### URL Parameter Overrides

| Parameter | Effect |
|-----------|--------|
| `?lockSettings` | Locks settings (highest priority) |
| `?lockSettings=false` | Explicitly unlocks |
| `?model=models/demo.glb` | Load specific model |
| `?renderer=webgpu` | Use WebGPU renderer |
| `?option=<id>` | Load a **model variant** (see below) |

#### `?option=` — deep-link model variants

A model folder may declare variants of the SAME GLB in `models/<name>/model-options.ts` —
different supplier data on identical geometry, applied by that model's `applyModelOption`.
Two lists exist:

- **`modelOptions`** — variants offered as extra rows in the model selector.
- **`deepLinkOptions`** — variants reachable ONLY by URL, never listed in the UI.

`DemoRealvirtualWeb` uses the second list for its `bosch` and `sew` AAS mappings: three
near-identical rows in the model list confused more than they helped, so the variants are
deep-link-only. `?option=bosch` and `?option=sew` still work, survive a reload, and are
shareable:

```
/?option=bosch
/?scene=builtin:DemoRealvirtualWeb.glb&option=sew
```

`ModelOptionPlugin` **always** runs the model's apply callback on `onModelLoaded` — with
`optionId = null` when no option is active. A model uses that call to normalize the GLB back
to its default variant (e.g. nodes hard-wired to a non-default supplier in the export), so
switching away from an option does not leave the previous variant applied.

`option` is a **top-level** query parameter and is deliberately not folded into the
`scene=builtin:` value — the boot matcher compares that value against a filename. It is kept
across scene-URL rewrites for the base model it belongs to, and removed when switching to a
model that does not declare it (otherwise a stale `option` would keep applying).

### API (for plugins/custom code)

```typescript
import { getAppConfig, isSettingsLocked, isTabLocked } from './core/hmi/rv-app-config';

// Read config values
const config = getAppConfig();
if (config.interface?.autoConnect) { /* ... */ }

// Check lock state
if (isSettingsLocked()) { /* hide settings UI */ }
if (isTabLocked('interfaces')) { /* hide interfaces tab */ }
```

### How Stores Use Config

Each settings store internally calls `getAppConfig()` — no signature changes needed at call sites:

```typescript
// In loadVisualSettings():
const fromStorage = loadFromLocalStorage();           // Layer 1+2
const override = getAppConfig().visual;                // Layer 3
if (!override) return fromStorage;
return {
  shadows: override.shadows ?? fromStorage.shadows,    // config wins if set
  lightIntensity: override.lightIntensity ?? fromStorage.lightIntensity,
  // ...
};

// In saveVisualSettings():
if (isSettingsLocked()) return;  // Lock guard — no-op when locked
localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
```

## News

An opt-in, fail-silent feed of product announcements (`src/core/news-store.ts`,
`src/core/hmi/NewsDialog.tsx`). Two independent queues feed the same dialog: the public
WEB queue fetched directly from the portal, and the CONNECT queue proxied by a connected
gateway. The dialog joins the startup chain via `startup-modal-coordinator.ts`, so it
never collides with the welcome or auto-quality modals.

### Deployment gating

The WEB queue is fail-closed. `fetchUnseenNews()` issues a request only when
`settings.json` carries both fields:

```json
{
  "news": {
    "enabled": true,
    "apiUrl": "https://download.realvirtual.io/news/api/v1"
  }
}
```

`enabled` must be exactly `true`, and `apiUrl` must be an absolute HTTP(S) URL **without
query or fragment** — the store appends `?target=web` itself. Anything else resolves to
`null` and no request happens. Private, customer and self-hosted deployments omit the
block entirely and therefore make zero external requests.

Two further gates are evaluated before `fetch` is referenced at all:

| Gate | Effect |
|------|--------|
| Already fetched this session | At most one WEB request per page load |
| Running inside a CONNECT embed | WEB fetch suppressed — news arrive through the gateway instead, so no duplicate dialog appears |

### Contract v1

```json
{ "contract": 1, "items": [ { "id": "…", "title": "…", "body": "…", "link": null,
  "validFrom": "…", "validTo": null, "updatedAt": "…" } ] }
```

Validation is all-or-nothing: a wrong `contract` value, a malformed item, or a `link`
that is not `http:`/`https:` discards the entire response. Duplicate ids are dropped and
the list is capped at 20 items. The request aborts after 5 s (`NEWS_FETCH_TIMEOUT_MS`).
Every failure path — offline, timeout, non-2xx, structural error — yields an empty queue
with no banner and without blocking startup. Item bodies are rendered through
`SafeMarkdown`, never as raw HTML.

### Seen state

| Queue | Storage | Acknowledgement |
|-------|---------|-----------------|
| WEB | `localStorage['rv-news-seen']` | `markNewsSeen(id)` — local only |
| CONNECT | Gateway-side `news-seen.json` | `markConnectNewsSeen(id)` — drops the item locally, then `POST /news/seen`; the gateway stays the source of truth |

## Publishing

### Public Demo

The standard publish workflow deploys to `https://web.realvirtual.io/{demoName}/`:

1. **Unity:** Tools → realvirtual → Export → WebViewer Tools → Publish tab
2. Select provider (Bunny CDN), enter demo name, export scene, click Publish
3. The viewer app + GLB are uploaded to the CDN

Or via Claude: `/deploy-web`

### Private Projects

Private projects publish to **unguessable URLs** at `https://web.realvirtual.io/{code}/` where `{code}` is a 32-character hex string (128-bit entropy). Each project is fully self-contained — its own GLB models, plugins, and settings.

**Local project structure:**

```
Assets/realvirtual-WebViewer-Private~/projects/
  mauser3dhmi/                        # Project folder
    project.json                      # Metadata: name, code, settings
    index.ts                          # Project-level plugins (optional)
    models/
      CL Digital Twin V100.glb        # Customer-specific GLBs
    models/CL Digital Twin V100/
      index.ts                        # Model-specific plugins (optional)
    plugins/
      customer-hmi.ts                 # Plugin source files
```

**project.json format:**

```json
{
  "name": "Mauser 3D HMI",
  "code": "a9d6c728c2a7006e52e55c03a174efbf",
  "created": "2026-04-03",
  "lastPublished": "",
  "settings": {
    "defaultModel": "CL Digital Twin V100.glb"
  }
}
```

**Unity workflow:**

1. Open the **Private** tab in WebViewer Tools
2. Click **New Project** (or create the folder structure manually)
3. Open your customer scene, click **Export Scene** on the project card
4. Optionally write an `index.ts` for project-specific plugins
5. Click **Publish** — stages, compiles plugins, uploads to CDN
6. Share the URL: `https://web.realvirtual.io/{code}/`

Or via Claude: `/deploy-web-private`

**How it works:**

- The shared app bundle (`index.html`, `assets/`) is copied from `dist/` — no separate Vite build per project
- Project `index.ts` is compiled to `project-plugin.js` via esbuild (<1s)
- Model-specific `index.ts` compiled to `model-plugin.js` in the model's subfolder
- At runtime, the viewer loads `project-plugin.js` and `model-plugin.js` via dynamic `import()` and calls `setup(viewer)`
- Customer GLBs never touch `public/models/` — they stay in the private project folder

### Project-Specific Plugins (index.ts)

Project plugins control which plugins are active and can disable standard plugins. The viewer instance is injected — no direct imports from the app source needed.

**Project-level** (applies to all models in the project):

```ts
import type { RVViewer } from 'realvirtual-webviewer';
import { CustomerHmiPlugin } from './plugins/customer-hmi';

export default function setup(viewer: RVViewer): void {
  viewer.use(new CustomerHmiPlugin());
  viewer.disablePlugin('kpi-demo');      // Disable standard plugins
  viewer.disablePlugin('test-axes');
}
```

**Model-level** (applies only to a specific model):

```ts
import type { RVViewer } from 'realvirtual-webviewer';

export default function setup(viewer: RVViewer): void {
  viewer.disablePlugin('sensor-monitor');  // Not needed for this model
}
```

**`disablePlugin(id)` API:**

- Removes the plugin from all tick callbacks (`onFixedUpdatePre/Post`, `onRender`)
- Skips the plugin in lifecycle callbacks (`onModelLoaded`, `onModelCleared`, `onConnectionStateChanged`)
- Works on **any** plugin, core ones included — only `removePlugin()` refuses `core: true`
- `dispose()` is still called for disabled plugins (prevents memory leaks)

### CDN Structure

```
https://web.realvirtual.io/
  demo/                              # Public demo
    index.html, assets/*, models/demo.glb
  a9d6c728c2a7006e52e55c03a174efbf/  # Private project (root-level)
    index.html                       # Same app bundle
    assets/                          # Same JS/CSS
    project-plugin.js                # Compiled from project index.ts
    models/
      CL Digital Twin V100.glb       # Customer-specific
    settings.json                    # Project-specific config
```

Security is based on URL unguessability (128-bit entropy, same principle as Google Docs share links). HTTPS is enforced by Bunny CDN.

## GLB Extras Format

The GLB export stores component data in `node.extras.realvirtual`:

```json
{
  "extras": {
    "realvirtual": {
      "Drive": { "Direction": "LinearX", "TargetSpeed": 500.0, "Acceleration": 100.0 },
      "TransportSurface": { "SurfaceSpeed": 500.0, "BoxCollider": { "center": [0,0.5,0], "size": [2,0.1,0.5] } },
      "Sensor": { "BoxCollider": { "center": [0,0,0], "size": [0.1,0.2,0.5] } }
    }
  }
}
```

Enums as strings, component references as `{ type: "ComponentReference", path: "...", componentType: "..." }`.

## Documents — one content type (plan-413)

A project used to have three kinds of thing: a **model** you opened, a **scene**
you edited, a **library asset** you referenced. Since plan-397 they are the same
bytes — a GLB — so the distinction had stopped describing anything. plan-413
collapsed them into one: a **document**.

| Term | Meaning |
|---|---|
| **Document** | The one content type: a GLB with an `id`, a classification and a revision. |
| **Scene** / **Asset** | **Roles**, not types. A "scene" is a document you open, an "asset" is one you reference — the same file can be both. |
| **Level** | What a document says it *is*: **Part**, **Assembly**, **Plant** or **Scene**. Optional; a document without one shows as *Unclassified*. |
| **Tags** | Free-form labels beside the level. The tag input autocompletes from the tags already used in the project — enough governance to stop a synonym thicket, not enough to be a taxonomy. |

**The classification lives inside the GLB**, in the default scene's extras — not
in a manifest. That is the whole point: a share link is one URL, a copy between
libraries is a byte copy, an export is a download, and none of them has a
sidecar on the other end. `project.json` caches it for listing; when the two
disagree, **the file wins**. The same vocabulary drives the share dialog
(`rv_share`), so a shared assembly arrives as an assembly.

**Where you see it.** The Projects dashboard has **no tabs**. It shows **one
tree** (`ProjectTree.tsx`, model in
[`rv-project-tree.ts`](src/core/project/rv-project-tree.ts)): root 1 is the
project folder, roots 2..n are the attached catalogs — URL, GitHub or Asset
Manager — marked as such and restructurable only where they are writable. (A
folder on this machine is not a catalog kind any more: it is a project, opened
from Projects — plan-709 §2.6.) No catalog is another project, so there is no cross-project
reference problem to solve.

Inside the project root the folders `models` / `library` / `scenes` / `splats`
carry **no special meaning** any more; the folder path is simply the category,
and the tree is freely rearrangeable by drag or inline rename. What stays
reserved is machinery — `settings`, `connect`, `rag`, `thumbnails`, `.trash` —
grouped under one collapsed **System** node and not restructurable. Nothing is
moved on disk by *building* the tree; only an actual move writes.

**A move never breaks a reference.** Moving a GLB rewrites the manifest row's
`path` and nothing else — the document `id` every reference hangs off is
untouched. A **rename** is the same route: the row's name and the file name
follow, the id does not. Moving a non-GLB rewrites `docs-index.json`, and only
rows that already exist there.

**Every document is registered** (plan-717). There used to be two ways a
document came into being — scenes were *declared* (row written on create, id
minted once), library and models files were *discovered* (row and id re-derived
from the path on every scan). The second is why renaming a library asset used to
break references silently. Now a writable project registers everything: a file
dropped into `library/` from outside gets an authored row on the next scan
(explicitly, by the **adopt verb**, which logs what it did — the scan itself
still writes nothing), and from then on its identity is the row's, not its
path's. Read-only projects — bundled, HTTP, a folder whose write grant was
declined — are never adopted and keep showing transient scan-derived rows, which
is why they cannot rename or re-file anything.

**Collections are a row field**, shown in the catalog alongside the folder chips
a document's location produces (the folder is a place, the collection is a
choice). They used to live in a `library/library.json` sidecar that nothing ever
read back; that file is now ingested once and deleted. The one-time diff this
writes into an existing project folder, and what an OS-level file copy costs,
are in [`doc-persistence.md`](doc-persistence.md) §3.6b.

Classification chips (with counts) and a tag filter sit above the tree; the
detail pane carries the editor that writes a level and tags **into the GLB** and
then updates the manifest cache. A level nobody uses gets no chip, unless it is
the one currently selected. A reference that cannot be resolved is never
discarded: it renders as a labelled wireframe placeholder and gets an entry in
the **Problems** panel naming what was searched for (both the asset id and the
path).

**The tree shows the whole folder** (plan-445). It used to show four curated
listings — manifest documents, `docs-index.json` targets, `*.connect.json`,
`*.knowledge.md` — and a file in none of them was simply not there, which is why
people could not find their own drawings, scripts and notes. Now one backend
walk lists everything except viewer machinery (dot-paths, `project.json`,
`docs-index.json`, the `thumbnails/` cache), and the old distinction shows up as
**verbs** instead of as presence: a file with no reference model behind it
renders as an *inert* row — visible, selectable, no context menu, no F2, no
drag, and refused as a move/rename source by the tree rules themselves, so the
MCP write path obeys it too. `web_project_tree` is built from the same listing
call, so an agent and the screen see one tree.

**There is no *Built-in demos* root any more (plan-737).** The models a build
ships used to appear under a read-only catalog root of that name. It was removed
outright, because the demo stopped being a deploy artefact and became an ordinary
project: `public/demo-realvirtual/` in this checkout, a writable
`projects/demo-realvirtual/` in a customer workspace, and the open project itself
on the hosted demo. The root had two problems the move ends rather than
mitigates — in a customer delivery it listed the *customer's* machines under the
heading "Built-in demos", and on the demo deploy it duplicated the open project's
own rows. The demo's documents are normal project rows now, with a real path, a
real *used by*, and the verbs of a project that can actually be written to.

**Markdown has a preview and an editor.** Selecting a `*.knowledge.md` — or any
other `.md` the full view now lists — gives the detail pane *Preview | Edit*
tabs. Preview goes through the same lazy `react-markdown` chunk the node
knowledge field uses; Edit is a plain textarea (no new dependency) and is
offered only where the project is writable, saving through the ordinary
`writeDocument` seam.

**New document is a button.** The single most-used verb on the screen was a 16px
plus among three other icon buttons; it is now a contained Instrument-Blue
button in the folder header. The plus stays for anyone who learned it.

**Copy and move between sources.** A document's context menu offers *Copy to…*
and *Move to…*, listing only writable targets — a read-only project is absent
rather than greyed out. **Copy** creates a new document (new `id`, with
`copiedFrom` recording where it came from); **Move** keeps the `id` and retires
the original into the source's `.trash/`, which is what makes an existing
placement or `AssetReference` still resolve afterwards. The classification
travels because it is in the bytes. Drag-and-drop between sources is
deliberately out of scope.

**The two CONNECT bridges** (plan-446). The project browser is the one screen that shows a project
as *files*, so it carries the two verbs that lead out of the browser:

- **Show in Explorer** — in a tree row's context menu, for anything inside the open project. The
  browser cannot open a file-manager window and no web API can, so CONNECT does it:
  `POST /project/reveal` with the project-relative path (see
  `Assets/realvirtual-Connect~/doc-connect.md`, *"Show in Explorer"*). The entry
  appears only when **both** hold: the gateway advertises `revealSupported` on `/health`, **and**
  this page is local — `location.hostname` is `localhost`/`127.0.0.1`, or the gateway origin *is*
  the page origin. The second condition is not redundant: a viewer opened on a tablet through a
  forwarded port still looks like a loopback peer to CONNECT, and the window would open on the
  machine in the plant. Any refusal (403/404/409) silently retires the verb until the next
  `/health` — a convenience that fails costs its own menu entry and nothing else, so there is no
  dialog. The rule is `canRevealInExplorer` in
  [`connect-store.ts`](src/core/hmi/connect-store.ts).
- **Open in CONNECT** — on a `*.connect.json` row's detail pane, beside a **Used by** list of the
  documents whose `connectRef` names that file (0, 1 or several — the N:1 case of plan-718 made
  visible; a chip selects that document). The list is a query over the loaded manifest, never a
  stored back-reference: the manifest has one author and one direction, and a second copy of the
  fact is the one that goes stale. The verb opens `ConnectOptionsWindow` with `initialProfile` set
  to that path; the window names the profile the gateway loaded from that file and offers an
  explicit *Activate* — it never switches on open, because a profile switch restarts workers.
  **CONNECT stays the one place a configuration is written**; the browser is read-only about it by
  decision (there is deliberately no second JSON editor beside CONNECT's live working set).

Details: [`doc-persistence.md`](doc-persistence.md) §2.0-0, §3.6a, §3.6b, §3.7, §3.10.

## Document Storage — everything the user owns IS a GLB (plan-397, plan-716)

A saved scene used to be a base-GLB URL plus an operation log in localStorage.
Since plan-397 it is **a GLB file**, and GLBs may reference each other. Since
plan-716 there is no second kind of owned content at all: **one document model**,
one list (`documents[]`), one identity (`documentId`). "Scene" is a ROLE a
document plays — the one you have open — not a storage concept. (The word keeps
its ordinary meaning for the Three.js scene in the viewport.)

**Storage.** Bodies are files in the project: `scenes/<name>.glb` in a folder
project, the same path over OPFS in the implicit browser project *My Workspace*.
The `rv-scenes/*` catalogue that used to hold them is a **legacy keyspace being
read** — the eager migration converts its rows into documents on first boot and
retires the originals under `rv-scenes-retired/`, and old `?scene=scn_…` links
keep resolving through a permanent alias map. A record still carrying the op-log
shape (`schemaVersion: 2`) raises a spoken error naming the version that can
convert it, rather than dropping quietly out of the list. Every write carries a
content-hash revision, so a concurrent write is a visible conflict rather than a
silent overwrite.

**Nothing reads or writes JSON scenes any more.** `.scene.json` bodies, the two
localStorage draft slots, the op-log→GLB migrator and the manifest's three
legacy artefact arrays are gone; `documents[]` is the only artefact list a
manifest has. A project or a scene that missed the conversion window is refused
with one sentence that names the release which can still convert it — never
skipped, never half-loaded. See
[`doc-persistence.md`](doc-persistence.md) §2.0-0.

**Editing.** The op log is unchanged as the edit mechanism — apply, undo, redo,
transactions, coalescing — but it lives only in memory. A reload therefore
starts with an empty history: the ops are folded into the file. The debounced
autosave bakes the *whole* log onto the *same* base bytes each time, so repeated
saves are deterministic rather than cumulative.

**References.** A node carrying `AssetReference` does not contain its subtree —
it names another asset, which composition resolves and grafts in immediately
after the parse, before any of the loader's tree passes. The referencing file
carries an `AssetOverrides` layer; the referenced file is never modified. Trust
is per subtree: a signed root does not lend its signature to unsigned content.

**Flat export.** "Embed references" writes the composed tree with every
reference marked `embedded: true` and its origin (`assetId` + `sha256`) kept, so
the file runs standalone and still records what it was built from —
and `unflattenReferences()` takes it apart again. Ten occurrences of one
assembly cost ~1.02x a single export, because clones share geometry and the
exporter deduplicates it.

Details: [`doc-persistence.md`](doc-persistence.md) §2–§3,
[`schema/v1/specification.md`](schema/v1/specification.md) §5b and §7d.8–7d.12.

## Testing

Tests run in real Chromium via Vitest + Playwright:

```bash
npm test              # All tests, headless
npm run test:watch    # Watch mode
npm run typecheck     # Full type check (tsconfig.full.json — includes private-dependent tests)
npx tsc --noEmit      # Community type check — the public tsconfig, excludes private-dependent tests
```

Test GLB: export from the Unity demo scene to
`../realvirtual-WebViewer-Private~/projects/Development/fixtures/tests.glb`. It
and every other internal fixture are reached through `DEV_GLB`
(`tests/fixtures/glb-paths.mjs`), never by a hand-written URL, and every suite
that loads one must pair it with the skip probe - see *Testing Plugins* in
`doc-extending-webviewer.md`.

Test files live in [tests/](tests/) (Vitest, browser-mode) and [e2e/](e2e/) (Playwright). Run `ls tests/*.test.*` for the current inventory — counts move every release, so no totals are kept here.

## Debug Logging

Category-based structured logging via `rv-debug.ts`. Zero overhead in production.

```
?debug=all              # URL parameter
?debug=playback,loader  # Specific categories
```

The 15 categories enabled by `?debug=all`: `loader`, `playback`, `drive`, `transport`, `sensor`,
`logic`, `signal`, `erratic`, `grip`, `parity`, `config`, `multiuser`, `interface`, `render`,
`perf`. A 16th category, `plugins` (model plugin loading/unloading), exists but must be named
explicitly (`?debug=plugins`).

## Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| three | 0.185.1 (pinned, no `^`) | 3D rendering (WebGL + WebGPU + WebXR) |
| react + react-dom | ^19 | HMI overlay |
| @mui/material | ^7 | UI components |
| echarts | ^6.0.0 | Charts |
| vite | ^6.1.0 | Build tool + dev server |
| vitest | ^4 | Test runner |
| typescript | ^5.7 | Compiler |

## Camera Controls

- **Right mouse**: Orbit
- **Middle mouse**: Pan
- **Scroll**: Zoom
- Damping enabled (default factor 0.2, `DEFAULT_ORBIT_NAVIGATION_SETTINGS` in `rv-orbit-controls-config.ts`; user-configurable together with rotate/pan/zoom speed)
- Auto-fit to model bounding box after load

## Known Limitations

- `controllerScale` hardcoded to 1000 (mm→m)
- Materials may differ from Unity URP (PBR mapping differences)
- OnSignal spawn mode not implemented for Sources

Ported DriveBehaviours: `Drive_Simple`, `Drive_Cylinder`, `Drive_DestinationMotor`,
`Drive_Speed`, `Drive_FollowPosition`, `Drive_Gear`, `Drive_PositionSwitch` and
`Drive_ErraticPosition`. Behaviours outside that list are not ported.

## Multiuser

realvirtual WEB supports real-time multiuser sessions where multiple users see each other as avatars in the same 3D scene. Each user's camera position is shared and rendered as a colored sphere with a name label.

### Quick Start

1. Add the `MultiplayerWEB` component to any GameObject in your Unity scene
2. Press Play — the WebSocket server starts on Port 7000
3. Open realvirtual WEB, click the Multiuser button in the top bar
4. Enter the server URL (e.g., `ws://192.168.1.5:7000`) and your name
5. Click Connect — you will see other connected users as avatars

### Features

- **VR/AR Avatars**: VR users show head + controller positions
- **Roles**: Operator (can control signals and drives) vs Observer (watch only)
- **Late Join**: New users receive the complete simulation state (all signal values, drive positions, and current avatars)
- **Cursor Rays**: See where other users are pointing in the 3D scene
- **URL Join**: Share `?server=ws://host:7000&name=User` links for instant session entry
- **Rate limiting**: Max 100 messages/second per client on the Unity side; outgoing avatar updates capped at 20 Hz on the browser side
- **Auto-reconnect**: The browser client reconnects automatically after a 2 s delay

### Web-only Mode (No Unity)

For sessions without a running Unity instance, point realvirtual WEB at a standalone relay server. The relay source lives in a separate repository; realvirtual WEB ships with a default hosted relay (`wss://download.realvirtual.io/relay`) configured in [multiuser-settings-store.ts](src/core/hmi/multiuser-settings-store.ts). Switch a session into relay mode via the Multiuser settings tab or by passing `?server=wss://...&joinCode=...` on the URL.

### Microsoft Teams Integration

realvirtual WEB runs natively inside Microsoft Teams as an interactive app — no screen sharing needed. Share 3D digital twins directly in meetings, channels, and chats.

**What it does:**
- **Meeting stage sharing** — Share the 3D viewer to the meeting stage. All participants can orbit, pan, and zoom the model independently — including external guests who are not in your organization.
- **Personal tab** — Pin the viewer in your Teams sidebar for quick access.
- **Channel tab** — Add the viewer to any channel. Configure which model to display per channel via the config page.

**Setup:**

1. Build the Teams app package:
   ```bash
   cd teams-app
   powershell.exe Compress-Archive -Path manifest.json,color.png,outline.png -DestinationPath realvirtual-web-teams.zip
   ```

2. Install in Teams:
   - **Personal**: Teams → Apps → Manage your apps → Upload a custom app → select the zip
   - **Organization-wide**: Teams Admin Center → Manage apps → Upload new app

3. Share in a meeting:
   - Click **Share** in the meeting toolbar
   - Select **realvirtual WEB** from the app list
   - The 3D viewer opens on the meeting stage for all participants

**Key points:**
- Only the person sharing needs the app installed — guests see it automatically on the meeting stage
- External participants (outside your org) can interact with the shared 3D viewer
- The app loads from `https://web.realvirtual.io/demo/` — public URL, no VPN required
- Teams SDK initialization is automatic when `?teams=1` is in the URL
- The `teams-app/` directory contains `manifest.json`, `color.png` (192x192), and `outline.png` (32x32)

**Configurable tabs** allow per-channel model selection. The config page (`teams-config.html`) lets users set a custom model URL when adding the tab to a channel.

## Shared Constants

Centralized numeric constants in `rv-constants.ts` replace magic numbers across the codebase:

| Constant | Value | Purpose |
|----------|-------|---------|
| `MM_TO_METERS` | `1000` | Unity mm → Three.js meters conversion factor |
| `DRAG_THRESHOLD_PX` | `8` | Min pixel distance before pointerdown→move is treated as drag |
| `DEFAULT_DPR_CAP` | `1.5` | Device pixel ratio cap to limit GPU load on HiDPI screens |
| `lastPathSegment(path)` | — | Extracts last segment from hierarchy path (`"Root/Child/Leaf"` → `"Leaf"`) |

## Context Menus

Plugin-extensible right-click context menus on 3D objects. Plugins register menu items via `ContextMenuStore`; items are filtered by condition callbacks at open time, labels can be dynamic functions, and errors in conditions are caught and treated as `false`.

```typescript
import { contextMenuStore } from './core/hmi/context-menu-store';

// Register items from a plugin
contextMenuStore.register({
  pluginId: 'my-plugin',
  items: [
    {
      id: 'focus',
      label: 'Focus Camera',
      action: (target) => viewer.focusByPath(target.path),
      order: 10,
    },
    {
      id: 'inspect',
      label: (target) => `Inspect ${target.path.split('/').pop()}`,
      condition: (target) => target.types.includes('Drive'),
      action: (target) => openInspector(target.path),
      order: 20,
    },
  ],
});

// Unregister on plugin dispose
contextMenuStore.unregister('my-plugin');
```

The context menu opens on right-click (with drag-distance guard) and touch long-press (500ms). It renders via MUI `<Menu>` in `ContextMenuLayer.tsx`.

## Extending

For wiring drives, sensors, transports, signals and AAS links onto a GLB
without touching the engine, use **Component Behaviors** —
see **[doc-behaviors.md](doc-behaviors.md)** (one TypeScript file per GLB
in `src/behaviors/`, auto-discovered, with a naming convention
(`Drive-Lin-Y`, `Transport-X`, …) and sidecar JSON as alternative wiring
paths — no Unity marker required).

See **[doc-extending-webviewer.md](doc-extending-webviewer.md)** for:
- Plugin development (lifecycle callbacks, UI slots, events)
- React hooks reference
- UI slot system and layout
- Chart panel integration
- Testing patterns
- Existing plugins reference

Plugins can read deployment config via `getAppConfig()` from `rv-app-config.ts` to adjust behavior based on `settings.json` values. Custom tooltips can be added via `tooltipRegistry.register()` — see [Tooltip System](#tooltip-system) above.
