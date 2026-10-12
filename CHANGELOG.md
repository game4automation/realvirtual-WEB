# realvirtual WEB — Changelog

User-facing release notes of realvirtual WEB, newest release first. Published on
`https://realvirtual.io/doc/web/release-notes/` by `Documentation/web` (`npm run sync:release-notes`).
Maintained by `/release-web`; the contract is described in `Documentation/web/README.md`.

## Unreleased

## 6.4.0 — 2026-10-12

**New**
- Virtual PLC (commercial): several Structured Text programs per scene, LogicStep sequences
  convert to ST and can be taken over by a program, an online view with live values and active
  branches, and the RV_SimulationMode system variable.
- Laser Welding Assembly Station demo, controlled entirely by the virtual PLC.
- Record video (commercial): raster download, still images, path-traced cinematic frames with
  look presets and motion blur, optionally with the HMI in the recording; deterministic
  frame-by-frame recording from the command line and over MCP.
- Render modes Unlit / Shaded / Toon (Wireframe in the editor), Max-Quality and Fast presets,
  and a frame rate limit (Off / 30 / 60).
- WebLabel: text in the 3D scene with hover, select and pin; WebError marks in the overlay.
- WebOperatorPanel: an operator panel stored as JSON in the GLB, with a JSON editor.
- Signals: a "Used by" cross-reference list, signal inspector and PLC binding checked against
  the gateway's address rules, a model/gateway reconcile report, model signals created from a
  CONNECT interface, and safe signal rename across model, CONNECT and ST code.
- PLC auto-map from model signals to S7 / PLCSIM interface signals with a match report.
- CONNECT edit forms for eleven more interface types, B&R PVI included.
- Hierarchy filter by component category.
- AASX files linked from the project folder.
- Encrypted share links for GLB files, and hosted project links with a password gate and
  encrypted models.
- AGVs: selectable vehicles with DES statistics and distance control (moving block).
- Commissioning: move and remove workpiece carriers; loads seat in and are placed on carriers.
- Quick Edit: Physics and BoxCollider authoring, and a Groups section under Kinematics with
  hover preview, eye/isolate, rename, dissolve and Add Group (also as MCP tools).
- Editor: wireframe view, lossless GLB weld on import, one-step mesh separate, selection stats.
- Drive_Cylinder valve modes (single- and double-acting).
- H hides and shows the HMI overlay.
- Third-party license notices in every WEB and CONNECT build.

**Improved**
- The view controls at the bottom right are one compact strip.
- STEP imports convert on CONNECT by default, with full assembly colours.
- PLC inputs start with the model's value instead of the type default.
- Writing to a live PLC asks for permission first and shows when no data arrives.
- Hosted pages connect to a local CONNECT and name the cause when that fails.
- Quick Edit: Add Kinematic and Add Group only set the Auto Assign target; the toggle alone
  switches the mode on (Escape turns it off).
- Simulation and commissioning share one engine contract: cylinder feedback on start, NC
  emergency stop, edge waits and a defined I/O state after reset.

**Fixed**
- The HMI no longer crashes on a mode switch, and sensor beams no longer multiply.
- Viewer writes reach signals that CONNECT adds while connected.
- F framing ignores hidden parts.
- AGVs hide the path line they drive over; the scanner field no longer counts as vehicle body.
- DES animations repaint without user input.
- Hosted deploys never publish CAD source files.
- A document draft never shadows a newer document file.
- Open dropdown menus stack above the HMI tiles.

**Internal**
- Agent remote-control start (viewer:agent), prompt queue for coding agents, one GLB container
  reader, one spawn/kill helper, collision MCP tools.

## 6.3.47 — 2026-09-30

**New**
- Zone component: Detect, Block and Hold zones with activation, gizmo and editor handles.
- Layout planner: every placement gets a sibling-unique name.
- Quick Edit: filter, foldout tree and resizable list for the kinematics section.
- Pre-placed MUs and collider-based passive loads; MUs are authorable in the asset editor.
- `web_component_schema` MCP tool with spec-backed authoring rules.
- The camera follows the AI agent's edits while the user is idle.
- Navigation: scale-adaptive wheel zoom, orbit and pan about the point under the
  cursor, touch gestures, zoom-to-cursor as an option; embed viewer navigation parity.
- The CONNECT panel explains what CONNECT is for whenever no gateway is connected.

**Fixed**
- Transport ignores belts on another level for surface pick and accumulation.
- A belt driven backward with DriveTo transports backward.
- Navigation feel restored after the scale fixes.

## 6.3.46 — 2026-09-28

**Fixed**
- Customer deliveries build project plugins that use the viewer core.

## 6.3.45 — 2026-09-28

**New**
- FMU co-simulation: attach an FMI 2.0 FMU to a node, run it through CONNECT after
  a trust confirmation, edit parameters and start values, restart it from a signal.
  Includes a bouncing-ball FMU demo.
- Signal units: signals carry units and bindings convert between them.
- Mechanisms: cartesian paths, a trajectory visualizer (path line, playback marker,
  waypoints) and offline drive sizing with trajectory, inertia override and
  SERVOsoft export.
- Projects dashboard: search the documents of all projects, quick-open type-ahead,
  "Open in new tab".
- Documents remember and restore their last-used mode.
- Seven more drive behaviours; every drive behaviour can be added in the editor.
- Mesh section in the property inspector with baked-geometry details.
- Nested references: referenced assets may contain references of their own.
- Delta robot kinematics model in the demo project; descriptions for all demo and
  library models.
- Build time shown in the version line.

**Improved**
- Property inspector: one value column, a ⋮ menu for component actions (Replace,
  Remove), Jog − | Stop | Jog + as one control, collapsible package details,
  English texts throughout.
- Number fields accept comma or dot as decimal separator.
- Buttons, menus, shortcuts and AI tools share one command system with consistent
  enabled state and reasons.
- Faster, more precise picking and hover on large models; groups no longer cost
  draw calls and can still be hidden and isolated.
- Asset cache verifies file versions and never keeps a missing file.
- Better performance for large layouts with many parts.

**Fixed**
- Typing "9,81" in a number field no longer stores 9.
- FMU section header follows the FMU state.
- Viewer mode shows Play, Pause, Reset and speed again.
- Paths honour the global speed override.
- Follow-position drives keep rendering while they move.
- Snap picker opens only on a click near a marker, not on a drag.
- Reset restarts logic steps.
- Picking imported CAD in the editor works again.
- A failed model preparation is shown as a load error.
- Project thumbnails refresh when a document changes.

## 6.3.44 — 2026-09-17

**Improved**
- bake() is the only render and pick pipeline: BatchedMesh arenas, face-range
  pick tables and proxy highlights are gone
- One placement primitive in the viewer core; planner placements are
  BakedAsset instances with chunk picking and chunk-outline highlight
- Scene-ready contract: placements-materialized event and whenSceneReady(),
  reopened layouts re-instantiate their placed references
- Per-pass frame stats, shared sensor visualisation geometry
- Faster and automatic /dev deploys (build cache, parallel upload, watcher)
- Projects: Add and Locate open the folder instead of suppressing themselves

## 6.3.43 — 2026-09-15

**Improved**
- TransportStopper collider and LogicStep WaitForStopped, wired through the
  LogicStep builder
- Recents as a pinnable flyout off the Projects folder
- Agent eye narrowed to three channels, its monitor panel reworked into a
  shared activity row, with the captured images in an HMI filmstrip
- Editor export fixes: driven nodes export from their home pose, and source
  template materials plus glTF provenance survive an in-place test export
- Energy chain survives sparse CAD tessellation
- Test suite green end to end: node 1547, browser 14623, 0 failures

## 6.3.42 — 2026-09-12

## 6.3.41 — 2026-09-12

## 6.3.38 — 2026-09-08

## 6.3.37 — 2026-09-07

## 6.3.36 — 2026-09-03

## 6.3.34 — 2026-09-01

**New**
- Chain component: the Unity Chain is now available in the web runtime — chain links
  follow a spline path and are moved by a Drive, with GLB round-trip verified against
  real Unity exports (including a vertical-flip parity fix in glTF space).
- Project manifests: every project now ships a real project.json; the glob-based and
  synthetic manifest fallbacks are removed, and the former "published:" identity space
  is folded into the manifest's documents[] list. Old ?scene= links hop to the right
  workspace document.

**Improved**
- README: new "Community Edition vs. Commercial" section, and the public demo's
  free-tier evaluation limits are stated explicitly.

**Fixed**
- GLB fidelity: deduplicated nodes keep their raw glTF name, and loading a model in
  the authoring editor never mutates the GLB hierarchy anymore.
- Layout Planner: layouts adopted from a GLB now behave exactly like natively planned
  scenes — the store survives a reload, snap points register, and placements render
  per object. The planner demo also works on static deployments.
- Embed bundle: React and @mui are kept out of the embed build, shrinking the bundle
  for iframe/embed use.
- Dashboard: the Libraries tree no longer collapses to zero width.
- Staging: the public demo staging keeps the authored demo manifest instead of
  overwriting it with a generated delivery manifest.

**Internal**
- This repository contains the full web runtime and editor with GLB as the import
  format. The commercial converters (STEP, JT, USD, Onshape), the PLC runtime and
  the DES module live outside this tree; src/private-stubs/ stands in for them.
- Type-check the community checkout with `npx tsc --noEmit` (not `npm run typecheck`,
  which requires the private sibling). `npm run deploy` targets realvirtual's own CDN
  and is not a build step.
- Published after passing the public-safety guard, the community precheck
  (tsc + production build + node tests on the staged public tree) and the
  documentation gates.

## 6.3.33 — 2026-09-01

## 6.3.32 — 2026-09-01

## 6.3.31 — 2026-08-28

## 6.3.30 — 2026-08-19

## 6.3.29 — 2026-08-18

## 6.3.28 — 2026-08-15

## 6.3.27 — 2026-08-15

## 6.3.26 — 2026-08-15

## 6.3.25 — 2026-08-15

## 6.3.24 — 2026-08-15

## 6.3.23 — 2026-08-15

## 6.3.22 — 2026-08-15

## 6.3.21 — 2026-08-15

## 6.3.20 — 2026-08-13

## 6.3.19 — 2026-08-12

## 6.3.18 — 2026-08-11

**Improved**
- Lazy-panel tests: the resource timeline is their only witness, and it is a
  fixed-size buffer (250 entries by default). This file's module graph had grown
  to fill it, so the lazy chunk's entry — recorded last, at the one moment that
  mattered — was dropped on arrival. The panels opened and the chunks loaded
  exactly as specified; the tests then spent their full 15 s budget waiting for
  evidence the browser had already discarded, and reported it as a timeout.
  Raised the buffer instead of the timeout: nothing was ever slow.
- Private Node suites: the browser config excludes `tests/**/*.node.test.ts` but
  the include glob also reaches into the private sibling, where the same
  convention went unexcluded — so 11 Node suites were dragged into Chromium and
  died on the first `node:crypto` import. They run, and pass, under
  `npm run test:node`.
- Regenerated `tests/private-dependent-tests.json` (+ the tsconfig exclude
  block): the two FBX tests restored earlier were never added, leaving the
  community-parity guard red.

## 6.3.17 — 2026-08-10

**Improved**
- Autosave data-loss fix (undefined topic in signal mappings) + visible autosave errors
- Inspector bind row for PLC signal nodes (aliased-selection fix)
- Signal chips use full width; hover cards on 3D link badges
- Shiftless chip drag (mouse threshold, touch long-press)
- Drag magnet occlusion check
- Demo scene: machine/robot signals moved onto their machines; 40 signals commented

## 6.3.16 — 2026-08-07
