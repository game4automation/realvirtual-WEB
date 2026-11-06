# realvirtual WEB — Changelog

User-facing release notes of realvirtual WEB, newest release first. Published on
`https://realvirtual.io/doc/web/release-notes/` by `Documentation/web` (`npm run sync:release-notes`).
Maintained by `/release-web`; the contract is described in `Documentation/web/README.md`.

## Unreleased

## 6.7.1 — 2026-11-06

**New**
- DES snapshots: running robot IK paths (point-to-point, linear and waiting segments) are saved and continue exactly after loading.

**Improved**
- **MCP** – the old tool names that answered `MOVED` for one release are gone and are now unknown tools; use `web_execute` / `web_query` (`web_commands` lists the commands).

**Fixed**
- Replay recordings keep their start and status signals after a model is saved in the browser and reopened.
- Fleet: an AGV waiting behind a broken-down AGV no longer reports a wait timeout; the wait names the broken vehicle.
- AI scene access now follows the configured CONNECT address and port instead of always using port 5100.
- Animated USD export and Isaac Sim live sync no longer write sensor beams and detection boxes or the
  runtime screen of a camera display into the USD stage; showing or hiding them no longer restarts the
  live sync.
- CONNECT signals: OPC UA variables of type `Boolean` (for example from a CODESYS controller) now
  bind as Bool instead of Float, so edge-triggered logic such as a gripper release works again.
  When a controller signal is bound or mapped onto a model signal, the model signal's type and
  direction apply; **Fill addresses** offers **Retype to model** for a CONNECT signal configured
  differently.

**Internal**
- Hosted libraries: internal tooling sets up the CDN storage and pull zone for
  hosted libraries idempotently (`--dry-run` only reads), and publishes a
  library project to it. Binaries go under content-hash paths and `project.json` last; the script
  checks the project identity, never deletes and ends with a CORS and cache smoke test.

## 6.7.0 — 2026-11-05

**New**
- Record the running simulation as an animated USD file (.usdz) from the USD menu, live or
  for a set duration in deterministic mode, at 24, 30 or 60 fps with Blender compatible visibility
  (Commercial).
- PLC editor: DES-suitability check — lines that never settle in event-driven DES are marked (DES:), affected programs show "not DES-ready", and experiment batches refuse them.
- Ray-traced render mode (Commercial, Beta): with the WebGPU backend, the render-mode menu offers
  **Ray traced** for interactive lighting with bounced light, reflections, transparency and soft
  shadows that refines while the view is still.
- Projects dashboard: select several documents at once; cards show the document's open mode, and the
  detail pane shows a preview card.
- DES experiments (Commercial): blocked runs are marked in the experiment matrix, with the blockage
  findings of each run.

**Improved**
- The USD menu in the left activity bar groups USD files (export, import, apply realvirtual data),
  animation recording and Isaac Sim live sync, with a short description for each entry. Export modes
  explain what they write and why a mode is unavailable; the export dialog counts placements without geometry.
- Animated USD export and Isaac Sim live sync handle baked parts with millions of vertices
  by writing oversized parts in smaller pieces.
- A library document edited with Edit in library loads its parts from that library everywhere:
  reloads, test runs, descending into a part and the hierarchy's open link no longer pick up a
  document of the open project that shares its name. A part of a library that is still loading
  shows as loading and appears once the library is ready.
- Old placements that name a project document by its path keep working after the document is
  renamed, and are saved by the document's id from now on. Files saved now need realvirtual WEB
  6.6 or newer to open their library parts; older viewers show them as missing.
- Copy into project keeps the copy's parts and its thumbnail; saving in Edit in library refreshes
  the library card's thumbnail.
- Orphaned signal bindings are no longer moved to another node by name; rebind them manually.
- DES: LogicSteps run on simulation events instead of the render frame (a delay ends exactly at its
  time, waits react to the signal change), so a model with LogicSteps runs the same in every DES
  speed mode, can run experiment batches and can be saved and restored as a snapshot. Sequences that
  cannot run on events (a repeating sequence without any waiting step) are listed in Problems.
- DES: grippers and zones are part of the snapshot, and a blocking GripPick/GripPlace step no longer
  prevents saving one. A gripper or zone that holds a part still refuses the snapshot with its
  address. A pick, place or source-generate signal that pulses within one DES time step is listed
  in Problems (`des-zero-time-pulse`): grippers and classic sources do not run in DES mode yet.
- DES: the virtual PLC runs event-driven — a program scans when a signal it reads changes, when one of
  its timers (TON/TOF/TP) runs out or right after its own change, instead of once per render frame. A
  model with ST programs runs the same in every DES speed mode and can run experiment batches; only
  programs that are not DES-ready are refused. A program that never settles is stopped with an error
  and listed in Problems (`des-settle-overflow`).
- DES: a model with ST programs can be saved and restored as a snapshot. Program variables, function
  block states and running timers are part of it, so the run continues exactly as without the cut.
  While a program is still being deployed, saving and loading wait for it or are refused
  (`des-snapshot-plc-pending`).
- Collision detection works on the same structure as picking and loads only when a model uses it;
  collision and unsupported-part messages show in every mode, and OK on an unsupported-part message
  removes the part.
- The documents button and the AAS mode appear only in the operating views.

**Fixed**
- DES experiments: a live run on the older random-number version kept no checkpoints when the project
  saved its experiment metadata first; the checkpoints are now stored again.
- Animated USD export and Isaac Sim live sync stop with a clear message showing the estimated
  size and browser limit when the file would be too large.
- DES: RobotHandling counted each output twice; throughput and KPIs of models with RobotHandling were
  doubled. Experiment results recorded before this fix are not comparable.
- A signal binding whose stored target no longer exists stays empty and is listed in Problems
  instead of silently binding to a signal with the same name.
- FMU models: a drive or LogicStep linked to an FMU signal (for example the ball height of the
  FMU demo) moves again; the link was reported as "Reference not found" and stayed empty.
- DES: after an experiment batch the next run starts with your own end time and warm-up again,
  not with those of the last experiment run, also after a reset.
- DES: end time, warm-up and seed set right after loading or resetting a scene (`des.setEnd`,
  `des.seed.set`, clock window) wait for the load instead of being refused.
- DES experiments (Commercial): changing the end time or warm-up of the live simulation no longer
  marks experiment results as "stale: base changed"; existing results stay valid.
- DES experiments (Commercial): an open live run (for example one with autosave checkpoints) no
  longer shows its column as "stale: failed".
- Resetting the simulation now also resets the internal run state of drive behaviors (for example
  destination, start and speed commands of Drive_DestinationMotor, Drive_Speed and
  Drive_ContinousDestination), so a reset no longer keeps a previous target or command.
- A logic sequence that jumps or loops without any waiting step no longer freezes the viewer; it is
  stopped after 10,000 instant steps and reported in Problems (`logic-instant-loop`).
- DES: setting the end time, warm-up or seed during a run (`des.setEnd`, clock window) no longer
  stops checkpoint autosave and snapshots with "model changed since run start".
- DES checkpoints (Commercial): a Fast Forward over several autosave intervals keeps a checkpoint
  at every interval (up to **keep**) instead of only the first one, and the checkpoints are listed
  under the live run, also when an earlier run used the same seed.
- Saving or exporting right after unbinding a signal no longer writes the old binding into the file.
- Measuring, annotations and dragging in the planner pick the same part that hover highlights.
- STEP import: the minimal and ultra-low quality presets keep large circles round.

**Internal**
- DES experiment results recorded since 5fff25b2 in scenes where `des.setEnd` created a
  run-configuration holder show as "base changed" once; re-run them.

## 6.6.0 — 2026-11-04

**New**
- SEW MOVI-C (UDP): CONNECT offers it in the interface list (UDP with the SEW defaults), and every
  UDP card imports a SEW symbol table in the browser; a re-import replaces the signals and keeps
  the connection settings.
- DES experiment manager (Commercial): plan, run and compare experiment matrices in their own
  window; the public demo stays available for evaluation and non-commercial use.
- DES commands for AI/MCP: create, duplicate, rename and delete experiment columns, set experiment
  values, read and set the DES seed, and live checkpoints (experiment and checkpoint commands are
  part of the Commercial experiment manager).
- Signal Connector component: connects signals with conversion (copy, int/bool, bit from/to word,
  scale, invert) and checks fan-in, cycles, width and direction. It loads on demand, so models
  without it do not pay for it.
- Stereo 3D (Commercial, Beta): side-by-side stereo rendering.
- 3D display walls (Commercial, Beta): off-axis viewports with head tracking, set up and edited in
  Settings > Stereo 3D, with projector and "2 people stereo" templates.
- Flystick navigation (Commercial, Beta): the Flystick drives the existing viewer functions,
  including ray clicks and dragging parts.
- SpaceMouse navigation via WebHID, with its own settings tab.
- Libraries as projects: the realvirtual library and your own libraries are projects; edit a
  library document in place or copy it into your project, attach libraries by id, and repair an
  unavailable library from the Problems panel.
- Drop detection reports parts that fall off while being carried (switchable in Settings), and
  conveyors set supported parts down on horizontal surfaces; the vertical reach is set per
  transport surface.
- Public demo terms: evaluation and non-commercial use.

**Improved**
- Layout Planner and Guided maintenance are stable; the Beta label is gone.
- DES: stability and memory fixes — a run after Reset starts like the first run, the experiment
  window no longer re-renders on every run or poll, and invalid commands fail clearly.
- Virtual PLC (Structured Text): IEC operator precedence, EXIT/RETURN, `=>` output parameters,
  bitwise logic and shifts, initial values, VAR CONSTANT and RV_FirstScan; the supported language
  scope is documented.
- SolidCraft live link: AI control of SolidCraft is a setting (off by default), moved designs are
  confirmed before they are applied, and reconnects after save/reopen are robust.
- Settings keep one ordered tab list and reopen on the last tab.
- Smaller start bundle: drop detection no longer pulls in the full component schema.
- Documentation updated for the new features.

**Fixed**
- Switching from continuous simulation to DES resets progress tracking, so the snapshot taken
  afterwards is correct.
- 3D scene buttons react to a click on the button cap.
- Flystick: a ray drag no longer starts a second gesture, and a ray click on a chart filters by
  the element that was hit.
- Section/clipping tool releases its materials and forgets removed placements.
- Boolean variant fields accept "true"/"false".
- The development build no longer fills the browser's User Timing buffer.

**Internal**
- Tier changes (plan-2215): Stereo 3D, display walls and Flystick moved from Preview to the
  commercial tier as Beta; SpaceMouse stays in the core. The fleet control / PalletYard forklift
  logic stays open source (AGPL) — not part of the commercial cut.
- DES experiment manager cut out of the public tree into the commercial module (plan-2211, ADR-054);
  KPI definitions and the Experiments button stay in the core.
- New DES commands: `des.seed.get/set`, commercial `des.checkpoint.*`, experiment column / cell
  value commands (plan-2208b).
- SignalConnector lazy-loaded with its own release-gate guards and signal-conversion drift test
  (plan-2227); eager-source-graph ratchet re-pinned several times.
- Stress harness for `/stresstest`.
- Contracts renamed `doc-*` → `contract-*`; node-identity and bake-picking contracts split.

## 6.5.4 — 2026-11-03

**New**
- Model-Scripts run on the DES clock: in a discrete-event run they receive sink arrivals
  (`self.sink(path).on`), are carried through snapshots and continuation, and their frame hooks
  only update the display.
- PalletYard demo: ShippingMonitor script and a "Late shipments" KPI.
- Robot commands for AI/MCP: run, stop and check a robot path, move the TCP, set a target's grip
  (`ik.*` commands), plus a "robot" help topic.
- Asset library: Loading Gantry in Pallet Handling.
- AI clicks can be switched off in the toolbar; the AI then acts without simulated pointer clicks.
- Scripts of the bundled demo project run without the `?scripts` switch.
- Share shows the upload limits before you upload.
- The public demo and the commercial development workspace ask once for consent to the terms of
  use.

**Improved**
- The viewer keeps working when the browser blocks local storage (private windows, strict site
  settings).

**Fixed**
- Drill-in on a project-library placement in the asset editor works again, also after a page
  reload.
- Model content can no longer inject prototype keys.
- A deployed project reads its DES experiment archive only when it declares one (no more 404).
- DES: deterministic MU ids and correct snapshots with pending MU retirements.

**Internal**
- AxisCorrection removed from WEB IK; `perf:des --script`.

## 6.5.3 — 2026-11-02

**New**
- DES experiment manager: "+ Add KPI" defines your own KPIs. A KPI can be a component property
  (picked like "+ Add property", or a name pattern summed over matching components), a value a
  script publishes, or a predefined component metric such as utilization, breakdown or traffic-stop
  share over a name pattern (mean, sum, min or max).
- Property and script KPIs are evaluated as a counter (change over the measured time, optionally
  per hour) or as a state (time-weighted mean, maximum or end value). The kind is proposed from the
  field name and can be switched. The warm-up period is always excluded.
- Runs recorded before a KPI existed say "needs a rerun" instead of showing a value; deltas are
  coloured by each KPI's better direction.
- Experiment columns carry a description: Base and every variant can be described via the column
  menu (*Edit description…*). The text shows under the column state and does not invalidate
  recorded results.
- The asset library shows preview images.
- PalletYard demo: descriptions for every column and three new KPIs (AGV breakdown share, AGV
  traffic stops, pallets out per hour).
- Bundled with realvirtual CONNECT 1.7.0: offline licence activation for computers without internet
  access, and *Save diagnostics…* in the tray menu, which writes a ZIP for support.

**Improved**
- Public and hosted pages no longer probe a local CONNECT gateway on page load, so visitors no
  longer see the browser's local-network access prompt. The AI panel checks the gateway only once
  CONNECT is connected or when you open the panel or an AI command.
- The "+ Add KPI" property picker offers only numeric fields of the running simulation components
  and runtime counters.
- On document cards, the Bundled chip sits at the bottom-left of the preview with the same look as
  the mode chip; on small cards both labels shorten instead of overflowing.
- MCP: `editor.importCad` also imports FBX, USD and DXF files, through the same import path as the
  import dialog.

**Fixed**
- Run all started right after editing *Stop at* or *Measure after* now runs with the new values;
  before, the click could be lost and every column turned stale with "run length changed".
- *Stop at* and *Measure after* are locked while a batch or snapshot runs, instead of accepting an
  edit that was then dropped.
- A *Measure after* that is not shorter than *Stop at* is refused with a message next to the
  fields, and the run buttons say why they are blocked.
- Column descriptions, and their removal, survive a reload.
- A difference that displays as 0.0 is no longer coloured.

**Internal**
- Private test excludes regenerated (ai-prompt-no-local-probe); reference baseline updated
  (PalletYard.glb after the experiment-descriptions fix, SEWStackerCrane project added).
- Import providers declare their file extensions; `editor.importCad` resolves a file without a CAD
  provider through the import provider that claims its extension.
- Experiment manager README wording: the experiment manager is a commercial module.

## 6.5.2 — 2026-11-02

**New**
- DES experiment manager: compare model variants side by side in one table. Base and
  each variant are columns; property rows edit a variant's overrides, KPI rows show the results.
- Replications per column with mean and 95% confidence interval. The difference to Base is computed as a
  paired comparison when runs share their seeds, otherwise with Welch's test; when no comparison is
  possible, the cell says why.
- Time series per run: KPIs recorded over simulation time, shown as bars or over-time charts with a
  confidence band across replications.
- Snapshots: save the state of a running DES model and continue it later with identical results. A
  snapshot remembers its variant column. AGV fleets, scripts, conveyors, turntables and chain transfers
  are included.
- Reproducible random streams: every component and script draws from its own named stream, so the same
  seed gives the same result, also after the model is rebuilt.
- Experiments are saved with the project in writable project folders and travel with a project export.
- PalletYard experiment example in the demo: AGV breakdowns per vehicle, 2, 3 and 4 AGVs, and a variant
  without downtime.
- MCP: `experiment.*` commands let AI assistants run experiments and read results, time series, rows and
  snapshots.
- Floating panels resize from all edges and corners, with a visible corner grip.
- Thumbnails are written into the project on save; the demo documents ship with preview images.
- A library asset shows that it is loading on its first placement.
- `camera.fit` frames nodes into the area that no floating window covers.

**Improved**
- DES core is stable and part of the AGPL Community edition; the Beta label is gone. The experiment
  manager becomes a separate commercial module.
- Run all executes every column in its own variant, restores the scene afterwards and leaves Play
  usable. Models with logic steps, PLC programs or IK paths are refused with a plain-text reason.
- Archived experiment results from earlier versions are shown as "stale" once after the update; rerun
  a column to refresh it.
- The inspector shows the effective variant value; number fields keep a typed value until it is
  confirmed.
- The legacy planning window starts collapsed and is hidden in variant mode.
- Faster DES snapshot capture and time-series recording.
- A deployed PLC program is stored in the model.
- Material assignment paints meshes with material arrays.
- Agent Eye can be collapsed; the folded state is remembered.
- A lamp without an On colour lights in its lens colour.
- The hierarchy Back pill is compact and truncates long names.
- Delivered workspaces carry `NOTICE.md`, `CONTENT-LICENSE.md` and `CONTENT-MANIFEST.md` next to
  `LICENSE`.

**Fixed**
- Resetting a variant field to Base survives a reload.
- Run all no longer leaves a gap between columns in which Play could restart the batch.
- A column reads current again after a successful rerun; an unsaved variant edit is restored after a
  reload.
- Same seed, same result across PalletYard rebuilds; changing the yard size scales the fleet again.
- MU colliders are sized correctly under scaled parents; explicit static colliders no longer form
  invisible walls around MUs.
- A WebOperatorPanel configuration given as a raw object stays usable.
- An editor test run keeps the user camera.
- On document cards, the Bundled badge no longer overlaps the mode chip.
- Running an experiment batch no longer reports spurious 'variant conflicts with the model' problems.
- Signal names are reserved per document; name collisions are resolved after a rename.
- The AI window stays running until the CLI exits.

**Internal**
- DES snapshot contract v4 (participants, persistable fleet timers, behaviour state, continuation harness)
  and RNG v2 named streams (plan-2059, plan-2061).
- Experiment manager V1 phases A–J and experiment commands (plan-2013, plan-2208); performance bisect
  fixes (plan-2063).
- Register-driven customer-name guard for the public tree; bundle-budget re-pins; release staging carries
  the licence files.

## 6.5.1 — 2026-11-01

**New**
- Procedural drive sounds: a Sound component makes a drive audible as an electric motor, pneumatic cylinder
  or hydraulic axis, synthesised in the browser without audio files. A speaker button with a volume
  slider switches it on.
- The password page of encrypted links shows a "Decrypting model file..." step and the heading
  "realvirtual Digital Twin".
- A central statistics hub collects DES results, path traffic, planning key figures and component
  statistics in one window.
- Variant management: create, rename and switch model variants from the toolbar, see the differing
  fields per part, reset a field to the base, and save variants with the document.
- Blockage diagnostics for material flow and AGV fleets: deadlock and stall probes, wait edges and a
  cause chain in the Problems panel, and "Save diagnostics" for a browser log package.
- AI panel: run Claude Code or Codex from the AI entry with the current selection and screenshots,
  and keep several sessions.
- Open the asset behind a placed reference in the same tab with Back and breadcrumb, or in a new tab.
- New material-flow components with Unity parity: guided arc and line conveyors, MU variant switching
  on sensor entry, MU pushers, source destinations and direct gripping on sensor entry.
- CONNECT: offline licence activation, signal configuration written to CONNECT with addresses filled
  from the controller, and address table import.
- Robot paths export as ABB or SEW programs.
- Simulated KPI chips open a trend window of their source.

**Improved**
- DES: seeded randomness for takt sources and downtimes, a finished run continues with one click, and
  runs are reproducible under load.
- Raycast sensors behave like Unity: they hit colliders only and report entries per collider.
- Faster start: the CONNECT panel, path network editing and the planner load on demand.
- The editor keeps placed references baked and keeps instance overrides of placed content on save.
- Toolbar tools are grouped, with flyouts for related tools.
- The user interface is English throughout.

**Fixed**
- The light barriers of the standard demo detect their MUs again.
- A signal badge no longer blanks the HMI.
- Picking stays responsive when a background worker fails; the work finishes inline.

## 6.5.0 — 2026-10-23

**New**
- AI assistants work through a compact command interface: `web_commands` lists the viewer's commands,
  `web_execute` and `web_batch` run them.
- MCP macros: an assistant records its model changes with a reason per step, the macro is saved inside
  the GLB, and any later session can replay it with a report per line.
- Geometry checks for assistants: mesh-exact gap and contact between two parts, also with drives moved
  to given positions, usable as macro assertions.
- A part library reads stroke and moving sub-parts of common pneumatic and electric drives from their
  type code.
- New editor commands: clone a subtree, define a material, reorder children.
- NVIDIA SimReady assets are available as a source in the realvirtual WEB Library: search, preview and
  import them like any other library part, with attribution kept.
- SolidCraft live link: connect to SolidCraft from the activity bar and model CAD next to the viewer.
  Bodies keep stable identities across updates, joints become drives, and settings you changed in WEB
  survive the next CAD update.
- Guided maintenance: author step-by-step procedures in the asset editor, and the machine moves along
  with each step (drives, transforms, signals, transparency, spray effects, saved camera views). The
  standard demo includes a guided coolant nozzle cleaning.
- Parametric part families: define a part once with parameters (stretch, bend, duplicate, nested
  families) and set the parameters per placement in the inspector.
- Path network authoring for AGV layouts: draw path blocks and junctions, drag them from the catalog,
  live validation, and structural edits (sweep, append, split, remove).
- AGVs can drive in reverse, and congestion trace bands show where traffic piles up over time.
- USD export with all realvirtual settings preserved, USD import that reads them back, and a one-way
  USD live link to NVIDIA Isaac Sim / Kit including a downloadable Kit extension.
- DXF import for 2D floor plans as locked layout placements.
- Asset editor statistics: heaviest parts, a per-mesh heatmap and a mesh simplification core that
  reduces triangle counts without moving contact surfaces.
- Robot tools for AI assistants: rig a library robot in one call and author robot paths by pose or by
  joint angles.
- Operator panels gain analog elements, a keyboard legend, an optional compact density, and a window
  that fits its content.
- The public demo opens with a welcome window, and a hosted project can name its start document and
  mode in its project.json.

**Improved**
- References in a saved model point at the part itself, not at its name or place in the tree: renaming,
  moving or re-importing a part no longer breaks drives, signals, kinematics or settings that use it.
- Settings changed inside a placed machine are kept at any nesting depth, and the outer file's value wins.
- Moving a single part inside a placed machine is no longer saved; move the whole placement, or move the
  part in its asset. Older files that moved parts this way open with a notice, and the parts sit where
  their asset puts them.
- GLBs saved by realvirtual WEB can no longer be imported into Unity. Unity exports keep opening in
  realvirtual WEB as before.
- Faster start: the asset editor, DES and other features load only when you first need them, with a
  visible retry if a part fails to load.
- AI control is a switch of its own and no longer tied to the CONNECT channel; the HMI shows both
  separately.
- JT import reads JT 9.5 and JT 8.x files.
- Renaming or moving a part in the asset editor rewrites every reference to it, and a reference audit
  lists broken links in the Problems panel.
- The editor saves the names you typed, refuses duplicate names among siblings, and warns before a
  save would lose a reference.
- Planner, DES material flow and path network share one connection system, so a line connected in
  one place is connected everywhere.
- DES hands material over at its real set-down pose instead of jumping onto the next belt.
- The asset editor has a transform-tool toggle (Move, shortcut T) and a cleaner selection highlight.
- The library catalog search covers all library sources.
- The Problems panel stays closed after you close it until a new or changed entry appears.
- Lower memory use and quicker loading of large models; the Fast preset renders lighter.

**Fixed**
- Robot TCP and IK solving work correctly on baked models and under scaling; IK failures are reported
  instead of being silent.
- Sensor collision boxes and mechanism link masses survive model baking, so sensors and forces work
  on baked models.
- Spawned MUs keep the template's size under a scaled parent.
- Undo and redo through the trash keep the restored part's components.
- A new document asks for its name first; double-clicking a project card opens it reliably.
- Shadows come back after switching render modes on WebGPU.
- A conveyor in DES no longer drops a waiting MU when it starts.
- SolidCraft parts are sized correctly in the planner, and connecting to SolidCraft works from a page
  served by CONNECT.
- The USD live link no longer stops on textures it cannot export.
- Hosted deployments always ship their feature list and no longer probe localhost on page load.

**Internal**
- Raytraced render mode (restricted, beta): G-buffer, temporal resolve, worker-built TLAS.
- MuJoCo locomotion spike: walking robot driven by signals in a real scene.
- 2D interaction zones (Box2D) for dense material flow on conveyors (jam, buffer table, diverter, merge): in development, not active in customer builds.
- Dev toolbar replaces the dev-server banner; agent/CI dev servers never open a browser.
- Test lock: maximum run time, startup limit, GPU test group.
- References stored by node address; edition feature catalog as single source; third-party notices gate enforced in release builds.

## 6.4.3 — 2026-10-15

**Fixed**
- Customer source deliveries no longer stop at their own secret check.

## 6.4.2 — 2026-10-15

**Improved**
- The robot loading screen appears only while the viewer starts; switching scenes stays in the HMI.
- Ambient occlusion on Max Quality is sharp, and the Fast preset renders without it.
- WebGPU rendering is complete: no more grey screen, and picking works.

**Fixed**
- A part held by a gripper no longer lets the parts behind it drive into it on a conveyor.
- The Problems window remembers when you closed it for a model.
- Gizmos draw underneath the HMI panels.

## 6.4.1 — 2026-10-13

**Improved**
- A new loading screen shows a robot cell whose cycle follows the real loading progress.
- PLC programs show a read-only preview of their Structured Text in the Property
  Inspector; a click opens the program in the PLC editor.

**Fixed**
- The viewer starts with the proven startup sequence of 6.3 again; the faster
  startup that shipped with 6.4.0 is withdrawn.

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
