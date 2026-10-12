# Preparing a model from raw CAD in the asset editor

Single source of truth for turning a raw CAD import into a prepared asset with the `web_*`
MCP tools. Served verbatim by `web_help("kinematize")` (alias `editor`). Written step by step
from a hands-on session, 2026-09-11; Steps 5–9 added from a pneumatic assembly-station session,
2026-09-28. A rule appears here only when no tool can enforce it.

## Step 0 — The `web_*` tools must be in the session

The guide is executed only through the realvirtual CONNECT MCP tools (`web_*`). If they are
not present in the session, **stop and tell the user**: CONNECT was not reachable when the
session started, and a failed MCP server is not retried within a session. The user reconnects
the server (or starts CONNECT first and opens a new session). Do not improvise another
transport to the same endpoint.

## Step 1 — Be in the editor with a loaded document, and stay there

Every step in this guide runs inside the asset editor.

1. Call `web_describe`. The answer must say `mode: "editor"` and carry a `document` with a
   `nodeCount` greater than 1. Both conditions are needed: the editor with an empty document
   is still "in the editor" but has nothing to prepare.
2. If it does not, **stop and tell the user**, and quote the `next` field of the answer: it
   names the recovery for that exact state. Do not open the editor yourself and do not load
   anything; the user chooses the document.
3. If the `web_*` tools are listed but every call answers *"Unable to connect"*, CONNECT itself
   has died — a large CAD import is the usual cause. Tell the user. After CONNECT is restarted
   the viewer tab reconnects with its document intact and the tools re-register on their own;
   call `web_describe` again in the same session. This differs from Step 0, where the tools
   were never there.
4. Once in the editor, **never leave it without the user's explicit confirmation**. Leaving
   means `web_editor_close`, `web_mode_set`, `web_document_open`, `web_project_open` or any
   navigation. Testing the current work happens inside the editor too (test session tools);
   there is no "save, close, load and try it" detour.

## Step 2 — Collect what is known about the machine and attach it to the root

Build the starting knowledge from three sources:

1. The hierarchy: `web_node_tree(depth=2, includeBounds=true)` — structure, node names, sizes.
2. The look: `web_screenshot_analyze(paths=<root path>)` — bounds and four views.
3. Documentation the user has explicitly pointed to (PDF, Excel, PowerPoint, images, videos).
   Never search for it; use only what the user named.

Write the result as short Markdown bullets with `web_knowledge_set(path=<root path>)`: what the
machine is, its main parts by name and location, what moves (if known), and what is still unknown.
Set `confidence` honestly — facts from documentation and measurements are "observed", conclusions
from names and pictures are "inferred".

## Step 3 — Turn the correct axis up and place it on the ground

Decide from the knowledge of Step 2, without new screenshots. Three cues, in this order:

1. **Which axis is vertical.** Part names ("…_high", "L=…"), the direction of profile posts and
   guide rails, the normals of thin plates (mounting plates and doors are vertical), hinge pairs
   (a door hinge axis is vertical).
2. **Which end is down.** Parts rest on plates, they do not hang under them: the side of a plate
   that carries parts, with empty space beyond them, is its top. Profile posts end on the floor
   plate. A plinth (outer shell reaching past the inner floor plate) is at the bottom. Control
   cabinet below, process above.
3. **Apply and measure.** `web_editor_rotate90(path=<root>, axis=…, sign=…)`, then
   `web_node_bounds(<root>, focus=false)`: the size must now be tallest in Y and the parts that
   were decided to be low (cabinet, floor plate) must have the smaller Y. If `min.y` is not 0,
   `web_editor_to_ground(<root>)`.
4. **Look once.** `web_screenshot_analyze(paths=<root>)`: the machine must stand upright on the
   grid, base at the bottom, nothing below the floor. If it does not, undo and go back to cue 1.

Then update the root note with `web_knowledge_set`: the rotation applied, which side is the front,
and the parts by their new Y positions.

## Step 4 — Put the agent camera on the whole machine

`web_camera_view(preset="iso", target=<root>)`. This frames the entire machine from an elevated
3/4 angle and moves only the agent camera; the user's viewport stays where it is. Every later
render, sweep and annotated screenshot starts from this pose, and `web_camera_orbit` moves on
from it when a part needs another angle.

Check with `web_eye(channels="beauty,edges")`: the machine fills the frame, nothing is cut off.

## Step 5 — Read the whole structure and find what moves

1. **Get every node.** `web_node_tree` cuts large trees off by a node budget without saying so.
   For a complete list ask again from a sub-root with a larger `depth` and check that the number
   of nodes you hold matches `nodeCount` from `web_editor_status`. Work from that full list, not
   from a first overview.
2. **Names of copies differ.** CAD copies of a sub-assembly often lose the dots of the original
   (`HINGE.60_1` → `HINGE60_1_1`, `DOOR.PC.PLATE_1` → `DOORPCPLATE_1_1`). Match names with dots
   removed, or the second instance of every assembly is silently missed.
3. **Use the control documentation.** PLC tag lists (functional groups, `…_HomePos`/`…_WorkPos`
   outputs, `…_InHome`/`…_InWork` inputs, comments like "open"/"lower") define the axis list and
   the meaning of each end position better than the CAD does. Map every actuator tag to a CAD part
   by position and type, and write the mapping into the root note (`confidence: "inferred"`).
4. **Pneumatic actuators.** The part number carries the stroke (SMC `MXQ16A-100` = 100 mm,
   `MY1B40-400` = 400 mm rodless). On slide tables the table and its end stopper move; the body and
   the stroke adjuster on the body stay. Guided rodless cylinders can be mounted either way — check
   which part the load (plate, bracket) is attached to, and how far the moving part can still travel
   before it hits the end of the guide: that decides the direction.
5. **Two-finger vs. angular grippers.** Parallel grippers move their jaws linearly; angular grippers
   (e.g. SMC MHY2) swing them around a pin at the finger root — that is a rotary axis per jaw.

## Step 6 — Build the axes

1. `web_editor_kinematize(paths, groupName, direction, lowerLimit, upperLimit)` creates a
   world-aligned axis node at the asset root and groups the moving parts under it.
2. **Direction convention.** Drive directions follow Unity: `LinearX` moves along three.js/world
   **−X**, `RotationY` and `RotationZ` turn the other way round; `LinearY`, `LinearZ` and
   `RotationX` are not mirrored. Decide the physical motion first, then choose the sign of the
   limits for that convention, and verify (Step 9) before relying on it.
3. **Nested axes** (a cylinder that carries a cylinder that carries a gripper): create the parent
   axis with the parent's moving parts plus the fixed parts of the child actuator (its body), create
   the child axis, then add a `Group` component to the **child axis node** with the parent's
   `GroupName` (`web_editor_add_component(path=<child axis>, type="Group", propsJson={"GroupName":"<parent>"})`).
   `web_editor_assign_to_kinematic` skips axis nodes and cannot do this.
4. **Pivots.** Linear axes can keep the centered pivot. For a rotary axis pass `centerPivot=false`
   and then either `web_editor_pivot(mode="object_center", targetPath=<rotating part>)` or set the
   pivot directly with `web_editor_transform(path=<axis>, px, py, pz)`. Moving or rotating an axis
   node in the editor does not move its member geometry, so `web_editor_transform(ry=±120)` is also
   how a jaw of a three-jaw gripper gets its radial direction as local X.
5. **Pneumatic behaviour.** Add `Drive_Cylinder` to the axis node (it needs the `Drive` on the same
   node): `MinPos` = home position, `MaxPos` = work position (negative strokes are allowed). If the
   PLC has only a work output (typical for stoppers and gates), set `OneBitCylinder: true`. Signals
   are wired later; the cylinder works without them.
6. **Multi-finger grippers** are one actuator: put `Drive_Cylinder` on one master jaw and a
   `Drive_Gear` on every other jaw with `MasterDrive` pointing at the master's `Drive` and
   `GearFactor` ±1 (−1 for the opposite jaw of a two-finger gripper).

## Step 7 — Conveyors

1. A belt with two strands is **one** transport surface: create an empty node, reparent both strand
   meshes under it, and put `Drive` and `TransportSurface` on that node. The surface bounds are the
   mesh bounds of the node's subtree.
2. Always put the conveyor's own `Drive` on the transport-surface node (or set `DriveReference`).
   Otherwise the surface looks up the nearest parent `Drive` — on a lift that is the lift axis, which
   then becomes the belt drive and stops lifting.
3. `TransportDirection` is given in Unity-local coordinates of the surface node. Read the node's
   world rotation (`web_node_bounds` → `worldQuaternion`) before choosing its sign.

## Step 7b — Stoppers, singulators, clamps, lifts and grippers as a `Zone`

What a device does to the PART is one `Zone` on the node that moves (plan-521); read
`web_component_schema("Zone")` first, then `web_editor_add_component(type="Zone")` and set the box
with `web_editor_set_field` (`Center` / `Size`, local millimetres of that node — or drag the handles).

1. **Stopper / gate:** `Block: true` (plus `Detect: true` if the logic waits for a part) on the stopper
   plate's axis node. With `Activation: "Always"` the box blocks wherever the axis puts it — lowering
   the plate releases the part. With `Activation: "Axis"`, `ActivationDrive` = the plate's drive and
   `AxisFrom`/`AxisTo` = the blocking position, it blocks only while the plate STANDS there.
2. **Singulator:** `Block` + `Detect`, then a `LogicStep_WaitForZone` (`WaitForOccupied: true`) in the
   sequence instead of a sensor.
3. **Clamp / index lift / simple gripper:** `Hold: true` on the moving node, `Activation: "Axis"` with the
   closed (clamp) or raised (lift) position as window. The contained parts are taken when the axis
   arrives and stands, and let go the moment it moves again: back onto a belt below them, else onto
   a free GripTarget within `GripTargetSearchRadius`, else in place.
4. Keep `Sensor`, `TransportStopper` and `Grip` where they already work — they are unchanged; a Zone is
   the default for new work. Check a zone in a test run: `web_transport_status` lists every zone with
   `active`, `occupied` and the held MUs.

## Step 8 — Make the model readable

1. Materials by part meaning: assign in two passes — whole assemblies first, then detail parts
   (sensors, belts, lamps, fasteners) on top. Name patterns must ignore dots (Step 5.2).
2. Put guarding, covers and doors in one `Group` (e.g. `Housing`), glass or transparent, so it can
   be hidden for inspection and verification.

## Step 9 — Verify

1. `web_editor_verify_drive` is quick, but its automatic view is often blocked by covers and it does
   not reliably show nested axes following their parent. Hide the housing group first.
2. The reliable check is a test session: `web_editor_test_start`, `web_drive_jog` to each limit,
   then `web_node_bounds` on the **axis nodes** (individual CAD parts are baked away while the test
   runs) and `web_eye` for a look. Confirm that children followed their parent (a jaw under a
   180° rotary must end up mirrored around the pivot) and that `web_logs(level="warn")` is empty.
   `web_editor_test_stop` restores the authored state.
3. Save with `web_editor_save` and update the root note: axes, strokes, home/work meaning, which
   assumptions are still unverified.

## Tool reference — editor domain

The complete `web_editor_*` inventory with parameters, generated from the decorators. Parameters per tool: `web_help(topic)`.

<!-- BEGIN GENERATED: tool-reference editor — do not edit; run `npm run gen:mcp-docs` -->
_78 tools in this family, generated from the @McpTool decorators — do not edit by hand._

| Tool | Access | Parameters | Summary |
|------|--------|------------|---------|
| `web_editor_add_component` | write | `path` string **req**, `type` string **req**, `propsJson` string | Add a component to a node (Quick Edit "Components" section): Drive, Kinematic, Sensor, TransportSurface, Source, Sink, Grip, BoxCollider, WebPhysicsZone, drive behaviors… |
| `web_editor_add_logic_step` | write | `path` string **req**, `stepType` string **req** | Add a LogicStep to a node (Quick Edit "Logic Steps"). |
| `web_editor_add_signal` | write | `parentPath` string **req**, `sigType` string **req**, `name` string | Create a PLC signal node as a child (Quick Edit "Signals"). |
| `web_editor_assign_material` | write | `paths` string, `presetId` string, `color` string, `metalness` number, `roughness` number, `opacity` number | Assign a material to nodes (undoable, like the Materials panel): presetId (from web_editor_material_presets) OR free PBR values (color hex + metalness/roughness/opacity). |
| `web_editor_assign_to_kinematic` | write | `paths` string **req**, `groupName` string **req** | Assign nodes to a kinematic's group (they will move with the axis). |
| `web_editor_back` | write | — | Leave the current descend level and return to the document above it (the inverse of web_editor_descend). |
| `web_editor_close` | write | `ifDirty` string, `name` string | Close the asset editor and return to the previous workspace. |
| `web_editor_convert_signal` | write | `path` string **req**, `target` string **req** | Convert a signal node to another datatype (Bool \| Int \| Float), keeping direction and value. |
| `web_editor_create_empty` | write | `parentPath` string, `name` string | Create an empty node (under parentPath, or at the asset root when omitted). |
| `web_editor_create_kinematic` | write | `name` string | Create a new kinematic axis: an empty top-level node with a Kinematic component linked to a fresh group (Quick Edit "Add Kinematic"). |
| `web_editor_delete` | write | `paths` string **req** | Delete nodes (descendants of other given paths are pruned automatically; one undo unit). |
| `web_editor_descend` | write | `path` string **req** | Descend INTO a referenced asset at path — opens that asset as its own document one level deeper, exactly like double-clicking the reference in the hierarchy. |
| `web_editor_group_assign` | write | `name` string **req**, `paths` string | Add nodes to a PLAIN group (Quick Edit Groups): stamps a Group component, never creates a kinematic axis. |
| `web_editor_group_dissolve` | write | `name` string **req** | Dissolve a group: removes its Group component from every member and clears GroupName on every owning Kinematic; geometry and other groups stay. |
| `web_editor_group_remove` | write | `name` string **req**, `paths` string | Remove nodes from one group: strips every matching Group component of each node, other groups stay; non-members are skipped. |
| `web_editor_group_rename` | write | `name` string **req**, `newName` string **req** | Rename a group on every member Group component AND every owning Kinematic, one undo unit. |
| `web_editor_import_cad` | write | `relPath` string **req**, `quality` string | Import a CAD file (STEP/JT) from the OPEN PROJECT into the open asset — converts via the CAD provider (private build), then attaches as an undoable importCad op. |
| `web_editor_import_glb` | write | `relPath` string **req** | Import a GLB file from the OPEN PROJECT into the open asset (undoable importCad op). |
| `web_editor_kinematize` | write | `paths` string **req**, `groupName` string **req**, `direction` string, `speed` number, `lowerLimit` number, `upperLimit` number, `startPosition` number, `centerPivot` boolean | KINEMATIZE in one undo step: group the given parts under a (new or existing) kinematic axis, add a Drive on the axis, set its direction/speed/limits, and center the pivo… |
| `web_editor_list_kinematics` | read | — | List all kinematics in the asset: axis path, group name, member count, and the Drive on the axis (direction/speed/limits) when present. |
| `web_editor_material_presets` | read | — | List the material presets (built-in industrial library + user presets): id, name, category, color, metalness, roughness, opacity. |
| `web_editor_material_stats` | read | — | Material overview of the asset: counts, warnings, and the APPEARANCE GROUPS (meshes bucketed by identical current material) with a stable key, current PBR value, mesh co… |
| `web_editor_materialize` | write | `assignmentsJson` string | MATERIALIZE: call with no assignments to get the appearance groups (same as web_editor_material_stats), then call again with assignmentsJson = [{"key"\|"samplePath": ...,… |
| `web_editor_mechanism_add_body` | write | `path` string **req**, `densityPreset` string | Add a MechanismBody to a link so the force analysis has a mass for it — without one the inverse dynamics reports "a link without mass" and every drive figure stays empty. |
| `web_editor_mechanism_add_joint` | write | `path` string **req**, `jointType` string **req**, `bodyBPath` string **req**, `bodyAPath` string, `anchorAJson` string, `anchorBJson` string, `axisAJson` string | Add a KinematicJoint to a mechanism. jointType = Revolute\|Prismatic\|Spherical\|Universal. |
| `web_editor_mechanism_add_target` | write | `path` string **req**, `interpolation` string, `speedToTarget` number, `waitForSeconds` number, `mechanismPath` string | Make a node a MechanismTarget: a path waypoint whose node WORLD POSITION is the target (move the node to move it). |
| `web_editor_mechanism_assign_drive` | write | `path` string **req**, `componentType` string **req**, `drivePath` string | Assign the Drive that actively controls a joint, or clear it. |
| `web_editor_mechanism_create` | write | `path` string **req** | Add a rigid-body MECHANISM (KinematicMechanism) to a node — the container that solves a joint graph with loop closure and free bodies. |
| `web_editor_mechanism_fix` | write | `path` string **req**, `code` string **req** | Apply the auto-fix of a FIXABLE finding on a joint and persist it as an ordinary field composite, so it undoes like a manual edit. |
| `web_editor_mechanism_forces` | read | `mechanismPath` string **req**, `channelId` string, `series` boolean | Read the DRIVE SIZING figures of a mechanism: per channel the current value plus peak, time-weighted RMS and holding force with their unit, and per joint the world react… |
| `web_editor_mechanism_inspect` | read | `path` string, `include` string | Read a rigid-body MECHANISM in full: joints (type, bodies, drive, current value, limits, world origin and axis, joggable), links with their mass properties (hasBody, mas… |
| `web_editor_mechanism_jog` | write | `path` string **req**, `value` number **req**, `componentType` string | Jog one driven joint to an absolute value (degrees for Revolute, millimetres for Prismatic) and run ONE solve, reporting the REAL convergence and residual. |
| `web_editor_mechanism_path_add_waypoint` | write | `path` string **req**, `waypointPath` string **req**, `index` integer | Insert a MechanismTarget into a mechanism path waypoint list, at index or appended. |
| `web_editor_mechanism_path_create` | write | `path` string **req**, `mechanismPath` string **req**, `targetLinkPath` string **req**, `waypointPaths` string, `loopPath` boolean, `linearSpeed` number, `linearAcceleration` number | Create a MechanismPath: the mechanism it drives, the TargetLink whose origin follows the path (a Delta: the platform) and optional ordered waypoints. |
| `web_editor_mechanism_path_inspect` | read | `path` string | Read mechanism paths: waypoints (interpolation, dwell, world mm) and runtime status incl. |
| `web_editor_mechanism_path_move_waypoint` | write | `path` string **req**, `from` integer **req**, `to` integer **req** | Move one waypoint of a mechanism path from index from to index to. |
| `web_editor_mechanism_path_remove_waypoint` | write | `path` string **req**, `index` integer **req** | Remove the waypoint at index from a mechanism path list; the node stays. |
| `web_editor_mechanism_set_anchor` | write | `path` string **req**, `componentType` string **req**, `anchorAJson` string, `anchorBJson` string | Set a joint's anchor point(s), in millimetres, in the respective body local frame. |
| `web_editor_mechanism_set_anchor_snap` | write | `path` string **req**, `componentType` string **req**, `side` string **req**, `candidateId` string, `assignBody` boolean, `pickJson` string | Set a joint anchor from a snap candidate listed by web_editor_mechanism_snap_list — the geometrically exact alternative to typing millimetres into web_editor_mechanism_s… |
| `web_editor_mechanism_set_axis` | write | `path` string **req**, `componentType` string **req**, `candidateId` string, `axisWorldJson` string, `secondaryAxisWorldJson` string, `snapToPrincipal` boolean | Set a joint's axis (AxisA, body-A-local) either from a snap candidate — a bore's normal IS its axis, so candidateId is the accurate route — or from an explicit world vec… |
| `web_editor_mechanism_set_limits` | write | `path` string **req**, `componentType` string **req**, `useLimits` boolean **req**, `lower` number, `upper` number | Set or clear a joint's motion limits — the travel a jog or a drive may use. |
| `web_editor_mechanism_set_mass` | write | `path` string **req**, `densityPreset` string, `densityKgM3` number, `massKg` string, `comJson` string | Set how heavy a link is — density preset, custom density, a pinned mass and a pinned centre of mass — in ONE composite and one undo step, because they are one decision. |
| `web_editor_mechanism_snap_list` | read | `x` number **req**, `y` number **req**, `maxCandidates` integer | List the SNAP CANDIDATES under a canvas point (x,y as 0..1 fractions) so an anchor or a joint axis can be set on real geometry instead of guessed millimetres: bore axes,… |
| `web_editor_mechanism_statics` | write | `mechanismPath` string **req** | Solve the HOLDING forces of a mechanism in its current pose (velocity and acceleration zero) and file them as each channel's holding figure — "what does it take to just… |
| `web_editor_mechanism_trajectory_export` | read | `path` string **req** | Export the last sizing run of a MechanismTrajectory as SERVOsoft axis texts (Tab, decimal comma, CRLF), one per driven axis; refuses a stale, incomplete or failed run. |
| `web_editor_mechanism_trajectory_import` | write | `path` string **req**, `csv` string, `relPath` string, `mechanismPath` string, `targetLinkPath` string, `name` string | Import a sampled TCP path CSV (time;X;Y;Z in mm) into a MechanismTrajectory for drive sizing; creates the trajectory when mechanismPath and targetLinkPath are given. |
| `web_editor_mechanism_trajectory_inspect` | read | `path` string, `maxPoints` integer | Read MechanismTrajectories: configuration, findings, last sizing run and, for one path, the run series downsampled to at most maxPoints. |
| `web_editor_mechanism_trajectory_run` | write | `path` string **req** | Run the offline drive sizing of a MechanismTrajectory: inverse solve, forward solve and inverse dynamics per sample in its own raster; returns peak and RMS torque per ax… |
| `web_editor_mechanism_validate` | read | `path` string | Validate a rigid-body mechanism: structured findings (MissingBodyB, SameBodyAAndB, UnresolvedBody, AnchorsApart, MissingSecondaryAxis, IdleSpinRod, NegativeDof, DriveAxi… |
| `web_editor_open` | write | `source` string **req**, `relPath` string, `ifDirty` string | Open the ASSET EDITOR with a document: source=new (creates a NEW document in the open project and opens it) or source=library with relPath naming an EXISTING document of… |
| `web_editor_pivot` | write | `path` string **req**, `mode` string **req**, `targetPath` string | Move a node's PIVOT without moving geometry (children compensated, one undo unit). |
| `web_editor_project_files` | read | `dir` string, `glob` string | List the files the OPEN PROJECT owns, project-relative (path, name, sizeBytes, modified, folder, documentId). |
| `web_editor_project_info` | read | — | Locate the KNOWLEDGE FOLDER for the open asset inside the OPEN PROJECT — the durable home for notes, a part catalogue and saved views across sessions. |
| `web_editor_redo` | write | `count` integer | Redo the last N undone editor operations (default 1). |
| `web_editor_remove_component` | write | `path` string **req**, `componentType` string **req** | Remove a component from a node by its concrete key (e.g. "Drive" or "Drive_1" — see web_component_get_all). |
| `web_editor_rename` | write | `path` string **req**, `name` string **req** | Rename a node (undoable). |
| `web_editor_reparent` | write | `paths` string **req**, `newParentPath` string | Move nodes under a new parent, preserving world poses (undoable). |
| `web_editor_rotate90` | write | `path` string **req**, `axis` string **req**, `sign` integer | Rotate a node ±90° around a LOCAL axis (Quick Edit rotate buttons). |
| `web_editor_save` | write | `name` string | Save the asset as GLB into the open project — its own folder when it has one, the project ROOT when it has none (plan-744: `library/Custom` is no longer a fallback). |
| `web_editor_separate` | write | `paths` string, `mode` string | SEPARATE meshes into child parts (undoable, same op as the context menu "Separate ▸"): islands = connected loose parts, groups = one part per material group. |
| `web_editor_set_field` | write | `path` string **req**, `componentType` string **req**, `fieldName` string **req**, `valueJson` string **req** | Set one field of a component on a node (undoable, live in the panels). |
| `web_editor_set_visible` | write | `paths` string **req**, `visible` boolean **req** | Show or hide nodes (authored visibility — saved with the asset, undoable). |
| `web_editor_shortcut` | write | `keys` string **req**, `arg` string | Run an editor keyboard shortcut on the CURRENT selection, exactly as a user would: "S>I" select identical, "S>M" same material, "S>V" invert, "K" + arg=name assign to ki… |
| `web_editor_signal_rename` | write | `path` string **req**, `newName` string **req**, `dryRun` boolean, `confirmWireChange` boolean | Rename a PLC signal with every reference (model, overlay, planner, historian, CONNECT). |
| `web_editor_signal_rename_recheck` | write | `journalId` string **req** | Ask CONNECT again for a signal rename with an unknown outcome (Problems "Re-check"). |
| `web_editor_signal_rename_repair` | write | `journalId` string **req** | Retry what a failed signal rename could not restore (Problems "Repair"). |
| `web_editor_signal_set_binding` | write | `name` string **req**, `interfaceId` string **req**, `topic` string, `protocolAddress` string, `dataType` string, `remove` boolean | Set, change or remove the PLC binding of a MODEL signal on ONE CONNECT interface (MQTT: in one topic). |
| `web_editor_signal_set_field` | write | `path` string **req**, `field` string **req**, `value` string | Edit ONE field of a PLC signal node: Comment, OriginDataType (BOOL/INT/DINT/REAL/…) or Type (a full wire type, e.g. PLCInputFloat). |
| `web_editor_signals_create_from_interface` | write | `interfaceId` string **req**, `parentPath` string, `names` string | Create model signals for an interface's plc-only signals (see web_signal_reconcile). |
| `web_editor_status` | read | — | Asset editor status: document name/base/dirty, undo/redo availability + label, op count, selection and node counts. |
| `web_editor_test_start` | write | — | Start the editor's IN-PLACE TEST session: the authoring state is materialised through the real save path and the runtime is attached, so drives, logic and mechanisms act… |
| `web_editor_test_stop` | write | — | Stop the editor's in-place test session and put the authoring state back exactly as it was before the run. |
| `web_editor_to_ground` | write | `path` string **req** | Drop a node so its bounding box rests on the ground (Y = 0). |
| `web_editor_toggle_signal_direction` | write | `path` string **req** | Flip a signal node between PLC input and output (value preserved). |
| `web_editor_transform` | write | `path` string **req**, `px` number, `py` number, `pz` number, `rx` number, `ry` number, `rz` number, `sx` number, `sy` number, `sz` number | Set a node's LOCAL transform (partial): position in meters (px/py/pz), rotation in degrees XYZ Euler (rx/ry/rz), scale (sx/sy/sz). |
| `web_editor_undo` | write | `count` integer | Undo the last N editor operations (default 1). |
| `web_editor_verify_drive` | write | `kinematicPath` string **req**, `from` number, `to` number, `frames` integer, `keepView` boolean | VERIFY a drive visually before saving — performed like a user would: selects the axis (gizmo + group highlight appear), aims the AGENT camera at a fitted 3/4 view of the… |
| `web_editor_zero_position` | write | `paths` string **req** | Zero the LOCAL position of the given nodes (Quick Edit "Zero Local"). |
<!-- END GENERATED: tool-reference editor -->
