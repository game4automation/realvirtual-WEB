# Asset Editor — kinematize & materialize CAD

The editor edits ONE GLB asset document. Everything is op-logged: every `web_editor_*` change
is undoable (`web_editor_undo`) and visible live in the Quick Edit / Materials panels.
Save writes into the OPEN PROJECT's `library/Custom/`. Every path these tools take or report is
project-relative — there is no work folder and no absolute path (`web_editor_project_info` shows
which project is open and whether it is writable). Editor tools error with "Not in editor mode"
until `web_editor_open` succeeds.

Three properties of the op log that change what you can assume:

- **One vocabulary, one document class.** Asset edits and scene edits are the same `RvOp` over
  the same document machinery, so undo/redo, dirty state and coalescing behave identically in
  both. A tool that does several things (`_kinematize`, `_materialize`, `_mechanism_create`)
  records ONE `composite` op — so `web_editor_undo 1` takes the whole action back, not a
  fragment of it. Do not issue N undos for an N-part action.
- **Ops during a base swap are DROPPED.** While a CAD re-import replaces the document's base, an
  edit is rejected outright: not applied, not recorded, no error op in the log. If you edit
  around an import, re-issue afterwards and check with `web_editor_*` reads rather than assuming.
- **Saving is compare-and-swap from the moment the asset was opened.** If something else wrote
  the file after your `web_editor_open`, `web_editor_save` reports a CONFLICT and keeps the
  other bytes rather than overwriting them. Treat that as "re-open and redo", never as a
  transient error to retry.

Core loop: **open → perceive → act → verify → save**.

## 1. Open

- `web_editor_open source=library relPath="Custom/MyAsset.glb"` — edit a library asset
- `web_editor_open source=new` then `web_editor_import_cad` (STEP/JT, private builds) or
  `web_editor_import_glb relPath="library/imports/part.glb"` — start from a file already in the
  project (import it through the app first; a browser project has no folder on disk)
- Already-open dirty document: pass `ifDirty=save` (with a name) or `ifDirty=discard`

## 2. Perceive

- `web_node_tree` / `web_node_find` — structure and paths
- `web_camera_focus` + `web_screenshot_annotated` (numbers=true) — see and label candidate parts
- `web_node_bounds` — exact centers/sizes for pivot and axis decisions
- `web_select_similar kind=identical seedPath=<one roller>` — all copies of a repeated part
- `web_editor_shortcut` — the human keyboard vocabulary on the current selection:
  `"S>I"` identical, `"S>M"` same material, `"S>V"` invert, `"K"` + arg=name assign to kinematic,
  `"H"`/`"Shift+H"` hide/show, `"Delete"`, `"Ctrl+Z"`/`"Ctrl+Y"`, `"Escape"`.
  Example combo: shortcut `"S>I"` → `web_editor_assign_material presetId=steel` (paths omitted = selection)
- `web_view_isolate` — de-clutter before screenshots of buried parts; empty paths to exit
- `web_view_pick` / `web_view_gaze` — identify what is at a screen position (3D point + normal)

## 3. Kinematize

- `web_editor_kinematize paths=... groupName=... direction=RotationY|LinearX|... speed=... [limits]`
  — one undo step: groups the parts under a kinematic axis, adds the Drive, centers the pivot.
- Direction is in the asset's local frame; `Rotation*` in degrees, `Linear*` in mm.
- Fine-tune: `web_editor_pivot mode=object_center targetPath=<hinge part>` places the rotation
  axis on a specific part; `web_editor_set_field` adjusts Drive fields; `web_editor_assign_to_kinematic`
  adds forgotten parts; `web_editor_list_kinematics` shows the inventory.
- Manual route (when the compound doesn't fit): `web_editor_create_kinematic` →
  `web_editor_assign_to_kinematic` → `web_editor_add_component type=Drive` → pivot tools.

### Putting a rotation axis exactly on a bore

`object_center` puts the pivot at a part's centroid, which is right for a whole roller and wrong
for a hinge: a hinge rotates about its BORE, and the bore is rarely the centroid of anything.
Bisecting `web_view_pick` rays along a bore's edge until the numbers stop moving is the expensive
way to find it.

`web_editor_mechanism_snap_list x=<0..1> y=<0..1>` is what puts a number on the bore: it returns
the snap candidates under a canvas point, and a `circle-center` or `cylinder-axis` candidate
carries the bore's centre as its position and the bore's AXIS as its normal — fitted from the
tessellation, not guessed. Two ways to use it:

- **Rigid-body mechanism:** feed the `candidateId` straight into
  `web_editor_mechanism_set_anchor_snap` / `web_editor_mechanism_set_axis`. Nothing is retyped,
  so nothing is rounded.
- **Axis group:** read `worldPosition` / `worldNormal` off the recommended candidate and use them
  to VERIFY where `web_editor_pivot mode=object_center targetPath=<hinge part>` landed. When the
  centroid and the bore genuinely differ (an eccentric or L-shaped part), place the axis on a
  sub-part whose centroid IS the bore, or set the pivot in the UI (below).

Recipe: `web_editor_create_kinematic` → `web_editor_assign_to_kinematic` →
`web_camera_focus` on the part carrying the hinge so the bore is visible →
`web_editor_mechanism_snap_list` at the bore's canvas position → place the pivot →
`web_editor_verify_drive`.

Two things worth knowing. The candidates are CURSOR- and VISIBILITY-bound: a bore hidden behind
the part, or off screen, yields nothing until the camera moves — move it and call again. And the
ids belong to the LAST listing only; list again after any change rather than reusing an id, which
is refused with the ids that are live rather than committing something plausible.

In the UI the same job is one gesture: **Kinematics ▸ Transform ▸ Pivot to Circle**, then click
the part and hover its edges — the nearest corner lights up, and when that corner sits on a circle
the circle and its axis are drawn. Clicking commits.

## 3b. Mechanisms (rigid-body) — a DIFFERENT system

Do not confuse the two. Section 3 builds an AXIS GROUP: one drive moves one group of
parts, and the hierarchy carries the motion. A **mechanism** solves a joint GRAPH —
closed loops, and links that no parent chain can reach. Use it when parts constrain
each other: four-bar linkages, scissor lifts, Delta platforms. A single hinge or a
sliding carriage is an axis, not a mechanism.

- `web_editor_mechanism_create path=<container>` — add the solver container.
- `web_editor_mechanism_add_joint path=<node> jointType=Revolute|Prismatic|Spherical|Universal
  bodyBPath=<link> [bodyAPath=<link>] [anchorAJson] [anchorBJson] [axisAJson]`
  — **OMIT `bodyAPath` to anchor against WORLD/static space.** That absence IS the
  world anchor; there is no "world" placeholder path to pass. Anchors are in
  millimetres in the respective body's local frame; they should COINCIDE in world
  space (a gap raises the `AnchorsApart` finding, which is auto-fixable).
- `web_editor_mechanism_assign_drive path=<joint> componentType=KinematicJoint
  [drivePath=<node with a Drive>]` — omit `drivePath` to make the joint passive again.
  Only driven joints are boundary conditions; every other DOF is solved.
- `web_editor_mechanism_set_anchor` — correct anchors by number; both writes are one undo step.
- `web_editor_mechanism_validate [path=...]` — structured findings + topology metrics
  (joints, links, independent loops, DOF). TRANSIENT: no ops, no undo entries.
- `web_editor_mechanism_jog path=<joint> value=<deg|mm>` — move one driven joint and
  read back the REAL convergence and residual. Also transient.

### The full cycle: read → anchor → weigh → drive → run → size

**1. Read** — `web_editor_mechanism_inspect [path=...] [include=joints,links,findings]`
returns what the panel shows: every joint (type, bodies, drive, current value, limits,
world origin and axis), every link with its mass properties (`hasBody`, `massKg`,
`massSource`, `massWarning`), the findings and the convergence. Do this FIRST on an
imported mechanism and again after every edit — `_validate` alone gives you counters
and findings, not the rows.

**2. Anchor on real geometry, never by guessing millimetres.** Aim the camera first
(`web_camera_focus`, `web_view_pick` to confirm what is under a point), then:

- `web_editor_mechanism_snap_list x=<0..1> y=<0..1> [maxCandidates]` — the snap
  candidates at that canvas point: bore axes, circle centres, edge/face centres,
  vertices. Each has an id (`snap0`…), a world position and a world normal; exactly one
  is `recommended` (what a click would take). **Ids are valid until the next call.**
- `web_editor_mechanism_set_anchor_snap path=<joint> componentType=KinematicJoint
  side=A|B candidateId=snap0 [assignBody=false]` — writes the anchor in the body-local
  frame and assigns the picked part as that side's body, in one undo step.
- `web_editor_mechanism_set_axis path=<joint> componentType=... candidateId=snap0`
  — a bore candidate's normal IS the bore axis, which is what a revolute joint wants.
  Alternatively `axisWorldJson={"x":..,"y":..,"z":..}`, plus `snapToPrincipal=true` to
  magnet a nearly-aligned direction onto world X/Y/Z, and `secondaryAxisWorldJson` for
  a Universal joint.

**3. Weigh** — without masses the force analysis reports "a link without mass" and every
figure stays empty.

- `web_editor_mechanism_add_body path=<link> [densityPreset=steel|stainless|aluminum|pa|pom|custom]`
- `web_editor_mechanism_set_mass path=<link> [densityPreset] [densityKgM3] [massKg] [comJson]`
  — one composite. `massKg="null"` / `comJson="null"` DROP an override and return to the
  value computed from the geometry.
- `web_editor_mechanism_set_limits path=<joint> componentType=... useLimits=true lower=.. upper=..`
  — the travel a jog or a drive may use (degrees for Revolute, mm for Prismatic).
- Check with `_inspect`: every moving link should show `hasBody: true` and `massKg > 0`.

**4. Drive & fix** — `web_editor_mechanism_assign_drive`, then `_inspect` until no
`Error` findings remain. `web_editor_mechanism_fix path=<joint> code=<Finding>` applies
the auto-fix of any finding with `fixable: true`, as an ordinary undoable composite.

**5. Run** — `web_editor_test_start` materialises the authoring state and attaches the
runtime, so drives, logic and the mechanism actually run; it also arms the force
recording. Move the machine (`web_drive_jog`, `web_editor_mechanism_jog`), then
`web_editor_test_stop`, which restores the authoring state exactly and KEEPS the
recorded buffers. `web_editor_status` reports the session state under `testSession`.

**6. Size the drive** — `web_editor_mechanism_forces mechanismPath=<mech>` gives per
channel: current value, `peak`, time-weighted `rms`, `holding` and `sampleCount`, with
units, plus each joint's world reaction force and torque. The sizing rule is threefold:
the motor's CONTINUOUS rating must exceed the RMS (that figure is thermal), its PEAK
rating must exceed the peak, and the holding force is a separate question —
`web_editor_mechanism_statics mechanismPath=<mech>` solves it in the current pose and
fills `holding`. For a duty cycle add `channelId=<id> series=true`; the series is
downsampled to at most 200 points, keeping the extremes.

Workflow: create → add joints → anchor → weigh → assign drives → `_inspect` until clean
→ `_test_start` / jog / `_test_stop` → `_forces`. Only `Revolute` and `Prismatic` can be tree edges and
carry limits; `Spherical`/`Universal` are always loop constraints. A rod held by two
Spherical joints has a free spin DOF (`IdleSpinRod`) — make one end Universal.

Joint hosting: a node MAY carry several KinematicJoint components, but prefer ONE
joint per node (put each joint on its bodyB link's node) — then every joint has an
unambiguous path. When several joints share a node, address one via `componentType`
(`web_editor_mechanism_jog path=<node> componentType=KinematicJoint_2 ...`).

Links and kinematic groups: a link (bodyA/bodyB) is a node, and the link moves its
whole SUBTREE. To make several loose CAD parts one rigid link, make the link a
kinematic axis node (`web_editor_create_kinematic` + `web_editor_assign_to_kinematic`)
— its group members ride along, because group parenting gathers them under the axis
node. Axis groups define the rigid bodies; the mechanism solves the constraints
between them.

## 4. Verify (before saving!)

`web_editor_verify_drive kinematicPath=...` performs the test like a user: selects the axis
(gizmo + group highlight), frames a fitted 3/4 view, smoothly drags the drive through its range
in the viewport while capturing N poses, springs back, and returns one labelled montage; the
pose is restored exactly. Range: the Drive's limits when `UseLimits`, else ±180° (rotary) /
±500 mm (linear) around home; override with `from`/`to`. Wrong axis → parts translate instead of rotate;
wrong pivot → orbit instead of spin; missing members → parts stay behind. Fix, re-verify. Everything
is undoable, so iterate freely.

## 5. Materialize

- `web_editor_materialize` (no args) — appearance groups (meshes bucketed by identical material)
- `web_editor_material_presets` — the industrial preset library (steel, RAL paints, rubber, glass …)
- `web_editor_materialize assignmentsJson=[{"key":..., "presetId":"steel"}, ...]` — one undo step
- Single selections: `web_editor_assign_material` (presetId or free PBR color/metalness/roughness)

## 6. Save

`web_editor_save name=...` — GLB + thumbnail into the project's `library/Custom/` (same name
overwrites).
Then `web_editor_close`, reload the asset live and jog real drives (`web_drive_jog`) as the
final smoke test.

## Signals & logic (optional)

`web_editor_add_signal` (PLCInput/Output Bool/Int/Float child nodes), `web_editor_convert_signal`,
`web_editor_toggle_signal_direction`, `web_editor_add_logic_step` (unknown type returns the palette).

## Tool reference

<!-- BEGIN GENERATED: tool-reference editor — do not edit; run `npm run gen:mcp-docs` -->
_58 tools in this family, generated from the @McpTool decorators — do not edit by hand._

| Tool | Access | Parameters | Summary |
|------|--------|------------|---------|
| `web_editor_add_component` | write | `path` string **req**, `type` string **req**, `propsJson` string | Add a component to a node (Quick Edit "Components" section): Drive, Kinematic, Sensor, TransportSurface, Source, Sink, Grip, drive behaviors, signals, LogicSteps… Starts… |
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
| `web_editor_import_cad` | write | `relPath` string **req**, `quality` string | Import a CAD file (STEP/JT) from the OPEN PROJECT into the open asset — converts via the CAD provider (private build), then attaches as an undoable importCad op. |
| `web_editor_import_glb` | write | `relPath` string **req** | Import a GLB file from the OPEN PROJECT into the open asset (undoable importCad op). |
| `web_editor_kinematize` | write | `paths` string **req**, `groupName` string **req**, `direction` string, `speed` number, `lowerLimit` number, `upperLimit` number, `startPosition` number, `centerPivot` boolean | KINEMATIZE in one undo step: group the given parts under a (new or existing) kinematic axis, add a Drive on the axis, set its direction/speed/limits, and center the pivo… |
| `web_editor_list_kinematics` | read | — | List all kinematics in the asset: axis path, group name, member count, and the Drive on the axis (direction/speed/limits) when present. |
| `web_editor_material_presets` | read | — | List the material presets (built-in industrial library + user presets): id, name, category, color, metalness, roughness, opacity. |
| `web_editor_material_stats` | read | — | Material overview of the asset: counts, warnings, and the APPEARANCE GROUPS (meshes bucketed by identical current material) with a stable key, current PBR value, mesh co… |
| `web_editor_materialize` | write | `assignmentsJson` string | MATERIALIZE: call with no assignments to get the appearance groups (same as web_editor_material_stats), then call again with assignmentsJson = [{"key"\|"samplePath": ...,… |
| `web_editor_mechanism_add_body` | write | `path` string **req**, `densityPreset` string | Add a MechanismBody to a link so the force analysis has a mass for it — without one the inverse dynamics reports "a link without mass" and every drive figure stays empty. |
| `web_editor_mechanism_add_joint` | write | `path` string **req**, `jointType` string **req**, `bodyBPath` string **req**, `bodyAPath` string, `anchorAJson` string, `anchorBJson` string, `axisAJson` string | Add a KinematicJoint to a mechanism. jointType = Revolute\|Prismatic\|Spherical\|Universal. |
| `web_editor_mechanism_assign_drive` | write | `path` string **req**, `componentType` string **req**, `drivePath` string | Assign the Drive that actively controls a joint, or clear it. |
| `web_editor_mechanism_create` | write | `path` string **req** | Add a rigid-body MECHANISM (KinematicMechanism) to a node — the container that solves a joint graph with loop closure and free bodies. |
| `web_editor_mechanism_fix` | write | `path` string **req**, `code` string **req** | Apply the auto-fix of a FIXABLE finding on a joint and persist it as an ordinary field composite, so it undoes like a manual edit. |
| `web_editor_mechanism_forces` | read | `mechanismPath` string **req**, `channelId` string, `series` boolean | Read the DRIVE SIZING figures of a mechanism: per channel the current value plus peak, time-weighted RMS and holding force with their unit, and per joint the world react… |
| `web_editor_mechanism_inspect` | read | `path` string, `include` string | Read a rigid-body MECHANISM in full: joints (type, bodies, drive, current value, limits, world origin and axis, joggable), links with their mass properties (hasBody, mas… |
| `web_editor_mechanism_jog` | write | `path` string **req**, `value` number **req**, `componentType` string | Jog one driven joint to an absolute value (degrees for Revolute, millimetres for Prismatic) and run ONE solve, reporting the REAL convergence and residual. |
| `web_editor_mechanism_set_anchor` | write | `path` string **req**, `componentType` string **req**, `anchorAJson` string, `anchorBJson` string | Set a joint's anchor point(s), in millimetres, in the respective body local frame. |
| `web_editor_mechanism_set_anchor_snap` | write | `path` string **req**, `componentType` string **req**, `side` string **req**, `candidateId` string **req**, `assignBody` boolean | Set a joint anchor from a snap candidate listed by web_editor_mechanism_snap_list — the geometrically exact alternative to typing millimetres into web_editor_mechanism_s… |
| `web_editor_mechanism_set_axis` | write | `path` string **req**, `componentType` string **req**, `candidateId` string, `axisWorldJson` string, `secondaryAxisWorldJson` string, `snapToPrincipal` boolean | Set a joint's axis (AxisA, body-A-local) either from a snap candidate — a bore's normal IS its axis, so candidateId is the accurate route — or from an explicit world vec… |
| `web_editor_mechanism_set_limits` | write | `path` string **req**, `componentType` string **req**, `useLimits` boolean **req**, `lower` number, `upper` number | Set or clear a joint's motion limits — the travel a jog or a drive may use. |
| `web_editor_mechanism_set_mass` | write | `path` string **req**, `densityPreset` string, `densityKgM3` number, `massKg` string, `comJson` string | Set how heavy a link is — density preset, custom density, a pinned mass and a pinned centre of mass — in ONE composite and one undo step, because they are one decision. |
| `web_editor_mechanism_snap_list` | read | `x` number **req**, `y` number **req**, `maxCandidates` integer | List the SNAP CANDIDATES under a canvas point (x,y as 0..1 fractions) so an anchor or a joint axis can be set on real geometry instead of guessed millimetres: bore axes,… |
| `web_editor_mechanism_statics` | write | `mechanismPath` string **req** | Solve the HOLDING forces of a mechanism in its current pose (velocity and acceleration zero) and file them as each channel's holding figure — "what does it take to just… |
| `web_editor_mechanism_validate` | read | `path` string | Validate a rigid-body mechanism: structured findings (MissingBodyB, SameBodyAAndB, UnresolvedBody, AnchorsApart, MissingSecondaryAxis, IdleSpinRod, NegativeDof, DriveAxi… |
| `web_editor_open` | write | `source` string **req**, `relPath` string, `ifDirty` string | Open the ASSET EDITOR with a document: source=new (creates a NEW document in the open project and opens it) or source=library with relPath (e.g. "Custom/MyAsset.glb", re… |
| `web_editor_pivot` | write | `path` string **req**, `mode` string **req**, `targetPath` string | Move a node's PIVOT without moving geometry (children compensated, one undo unit). |
| `web_editor_project_files` | read | `dir` string, `glob` string | List the files the OPEN PROJECT owns, project-relative (path, name, sizeBytes, modified, folder, documentId). |
| `web_editor_project_info` | read | — | Locate the KNOWLEDGE FOLDER for the open asset inside the OPEN PROJECT — the durable home for notes, a part catalogue and saved views across sessions. |
| `web_editor_redo` | write | `count` integer | Redo the last N undone editor operations (default 1). |
| `web_editor_remove_component` | write | `path` string **req**, `componentType` string **req** | Remove a component from a node by its concrete key (e.g. "Drive" or "Drive_1" — see web_component_get_all). |
| `web_editor_rename` | write | `path` string **req**, `name` string **req** | Rename a node (undoable). |
| `web_editor_reparent` | write | `paths` string **req**, `newParentPath` string | Move nodes under a new parent, preserving world poses (undoable). |
| `web_editor_rotate90` | write | `path` string **req**, `axis` string **req**, `sign` integer | Rotate a node ±90° around a LOCAL axis (Quick Edit rotate buttons). |
| `web_editor_save` | write | `name` string | Save the asset as GLB into <workfolder>/library/Custom/. |
| `web_editor_separate` | write | `paths` string, `mode` string | SEPARATE meshes into child parts (undoable, same op as the context menu "Separate ▸"): islands = connected loose parts, groups = one part per material group. |
| `web_editor_set_field` | write | `path` string **req**, `componentType` string **req**, `fieldName` string **req**, `valueJson` string **req** | Set one field of a component on a node (undoable, live in the panels). |
| `web_editor_set_visible` | write | `paths` string **req**, `visible` boolean **req** | Show or hide nodes (authored visibility — saved with the asset, undoable). |
| `web_editor_shortcut` | write | `keys` string **req**, `arg` string | Run an editor keyboard shortcut on the CURRENT selection, exactly as a user would: "S>I" select identical, "S>M" same material, "S>V" invert, "K" + arg=name assign to ki… |
| `web_editor_status` | read | — | Asset editor status: document name/base/dirty, undo/redo availability + label, op count, selection and node counts. |
| `web_editor_test_start` | write | — | Start the editor's IN-PLACE TEST session: the authoring state is materialised through the real save path and the runtime is attached, so drives, logic and mechanisms act… |
| `web_editor_test_stop` | write | — | Stop the editor's in-place test session and put the authoring state back exactly as it was before the run. |
| `web_editor_to_ground` | write | `path` string **req** | Drop a node so its bounding box rests on the ground (Y = 0). |
| `web_editor_toggle_signal_direction` | write | `path` string **req** | Flip a signal node between PLC input and output (value preserved). |
| `web_editor_transform` | write | `path` string **req**, `px` number, `py` number, `pz` number, `rx` number, `ry` number, `rz` number, `sx` number, `sy` number, `sz` number | Set a node's LOCAL transform (partial): position in meters (px/py/pz), rotation in degrees XYZ Euler (rx/ry/rz), scale (sx/sy/sz). |
| `web_editor_undo` | write | `count` integer | Undo the last N editor operations (default 1). |
| `web_editor_verify_drive` | write | `kinematicPath` string **req**, `from` number, `to` number, `frames` integer, `keepView` boolean | VERIFY a drive visually before saving — performed like a user would: selects the axis (gizmo + group highlight appear), frames a fitted 3/4 view, then smoothly drags the… |
| `web_editor_zero_position` | write | `paths` string **req** | Zero the LOCAL position of the given nodes (Quick Edit "Zero Local"). |
<!-- END GENERATED: tool-reference editor -->
