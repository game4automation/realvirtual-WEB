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
4. **Placed assets are baked.** A document that places other assets (references — a cell with
   a gripper, a line with stations) shows them like the planner does: baked, with only their
   component nodes addressable — there are no CAD parts under a reference. Inside a placed asset
   you can change component field values (`web_execute("editor.setField", …)` writes an instance
   override on the reference); geometry, structure, materials and mechanisms of a placed asset are
   changed by descending into it (`web_editor_descend`, back with `web_editor_back`). Right after
   `web_editor_open` check `placementsReady` (also in `web_editor_status`): while it is false the
   placed assets are still loading and paths into them do not resolve yet.
5. Once in the editor, **never leave it without the user's explicit confirmation**. Leaving
   means `web_editor_close`, `web_execute("workspace.setMode", {mode:"planner"})`, `web_document_open`, `web_project_open` or any
   navigation. Testing the current work happens inside the editor too (test session tools);
   there is no "save, close, load and try it" detour.

## Step 2 — Collect what is known about the machine and attach it to the root

Build the starting knowledge from three sources:

1. The hierarchy: `web_node_tree(depth=2, includeBounds=true)` — structure, node names, sizes.
2. The look: `web_screenshot_analyze(paths=<root path>)` — bounds and four views.
3. Documentation the user has explicitly pointed to (PDF, Excel, PowerPoint, images, videos).
   Never search for it; use only what the user named.

Write the result as short Markdown bullets with `knowledge.set(path=<root path>)`: what the
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
3. **Apply and measure.** `web_execute("editor.rotate90", {path:<root>, axis:"x", sign:1})`, then
   `web_node_bounds(<root>, focus=false)`: the size must now be tallest in Y and the parts that
   were decided to be low (cabinet, floor plate) must have the smaller Y. If `min.y` is not 0,
   `web_execute("editor.toGround", {path:<root>})`.
4. **Look once.** `web_screenshot_analyze(paths=<root>)`: the machine must stand upright on the
   grid, base at the bottom, nothing below the floor. If it does not, undo and go back to cue 1.

Then update the root note with `knowledge.set`: the rotation applied, which side is the front,
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

## Step 5b — Look it up, then model, then check

Work in this order for every actuator: **look up → model → check → save**.

1. **Look up.** `web_query("part.lookup", {name})` with the part's node name (e.g. `DFM-12-50-P-A-GF (K)`)
   answers from the shipped part library: family, size and stroke from the type number, linear or
   rotary, which name patterns mark the moving and the fixed sub-part (e.g. `(K)` / `(Z)`), and a
   reference-point hint. No match means: do not guess — read the datasheet or ask.
2. **Model** with the result, and say where a value came from: pass `_reason` and
   `_source: "parts:DFM-12-50"` with the model change (`web_execute`, `web_batch` or the bound
   `web_editor_*` tool). A stroke taken from the type number goes into the limits of Step 6.
3. **Check** what you assumed, mesh-exact: `web_check_gap(a, b, pose?)` /
   `web_check_contact(a, b, pose?, toleranceMm?)` measure the real distance in millimetres between
   two nodes, optionally with drive positions set (`{"Cell/Lift": 50}`) — the pose is restored
   afterwards and no drive state changes. Typical checks: the piston rod touches the plate at the
   end of its stroke, a part sits inside its nest without overlap, a stopper reaches the edge of the
   box. A pose needs the runtime tree (in the editor: `web_editor_test_start` first); in the editor
   tree a check measures the authored pose.
4. **Keep the check.** While recording a macro, add the check as an assertion line:
   `web_macro_assert(name, "gap", {"a": …, "b": …, "pose": {…}}, {"gapMm": {"min": 0, "max": 0.5}})`.
   Every later replay measures it again and reports a failure in the Problems panel.
5. **Save** (`web_editor_save`) — the macro with its reasons and assertions travels in the GLB.

## Step 6 — Build the axes

1. `web_execute("editor.kinematize", {paths, groupName, direction, lowerLimit, upperLimit})` creates a
   world-aligned axis node at the asset root and groups the moving parts under it.
2. **Direction convention.** Drive directions follow Unity: `LinearX` moves along three.js/world
   **−X**, `RotationY` and `RotationZ` turn the other way round; `LinearY`, `LinearZ` and
   `RotationX` are not mirrored. Decide the physical motion first, then choose the sign of the
   limits for that convention, and verify (Step 9) before relying on it.
3. **Nested axes** (a cylinder that carries a cylinder that carries a gripper): create the parent
   axis with the parent's moving parts plus the fixed parts of the child actuator (its body), create
   the child axis, then add a `Group` component to the **child axis node** with the parent's
   `GroupName` (`web_execute("editor.addComponent", {path:<child axis>, type:"Group", propsJson:'{"GroupName":"<parent>"}'})`).
   `editor.assignToKinematic` skips axis nodes and cannot do this.
4. **Pivots.** Linear axes can keep the centered pivot. For a rotary axis pass `centerPivot=false`
   and then either `web_execute("editor.pivotToObjectCenter", {path:<axis>, targetPath:<rotating part>})` or set the
   pivot directly with `web_execute("editor.transform", {path:<axis>, px, py, pz})`. Moving or rotating an axis
   node in the editor does not move its member geometry, so `web_execute("editor.transform", {path:<axis>, ry:120})` is also
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
`web_component_schema("Zone")` first, then `web_execute("editor.addComponent", {path:<axis>, type:"Zone"})` and set the box
with `editor.setField` (`Center` / `Size`, local millimetres of that node — or drag the handles).

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
   the default for new work. Check a zone in a test run: `web_query("transport.status", {})` lists every zone with
   `active`, `occupied` and the held MUs.

## Step 8 — Make the model readable

1. Materials by part meaning: assign in two passes — whole assemblies first, then detail parts
   (sensors, belts, lamps, fasteners) on top. Name patterns must ignore dots (Step 5.2).
   **Every part gets a material; nothing stays CAD grey.** When a part's meaning is unclear, guess
   from its shape, name and position and say so in your answer: frames → painted steel, extruded
   profiles → aluminium, covers and housings → plastic, robot arms → white, lamps → signal colours,
   shafts, fasteners and small machined parts → steel, feet and belts → rubber. A finished look with
   a few marked guesses beats a half-grey model.
2. Put guarding, covers and doors in one `Group` (e.g. `Housing`), glass or transparent, so it can
   be hidden for inspection and verification.

## Show the user what you are doing

The agent camera (`web_camera_*`, `web_eye`, `web_view_*`) is invisible to the user: their viewport
does not move with it. Whenever you build or move something the user should follow — an axis, a
gripper, a conveyor — **select it** with `web_select` first: the hierarchy then expands to that node
and scrolls to it, exactly as after a user's click, so the user sees in the tree what you are
working on. Then bring **their** view there: `web_execute("camera.fit", {"paths": ["<path>"],
"fill": 1.1})` frames the part large in the area no floating window covers (the AI window, panels),
keeping the current view direction; list several paths to frame an axis together with what it
carries, omit `paths` to frame the whole model. (`camera.flyTo` with `node` is a chase camera for
vehicles, not a framing.) In a tight build-up where covers or frames hide the
part, isolate it for the user too: `web_execute("view.isolate", {"paths": "<path>"})` (and end the
isolation when you move on). Then show it slowly and one thing at a time:
jog each axis from end to end at a speed a person can watch, and only then go to the next axis.
A user who asked to "see it move" must not have to search the scene for what changed.

## Step 9 — Verify

1. `web_editor_verify_drive` is quick, but its automatic view is often blocked by covers and it does
   not reliably show nested axes following their parent. Hide the housing group first.
2. The reliable check is a test session: `web_editor_test_start`, `drive.jog` to each limit,
   then `web_node_bounds` on the **axis nodes** (individual CAD parts are baked away while the test
   runs) and `web_eye` for a look. Confirm that children followed their parent (a jaw under a
   180° rotary must end up mirrored around the pivot) and that `web_logs(level="warn")` is empty.
   `web_editor_test_stop` restores the authored state.
3. Re-run the geometric checks of Step 5b at the limits: `web_check_gap` / `web_check_contact` with
   the pose of each end position (mesh-exact, in mm) settles "does it touch / does it collide"
   without eyeballing a screenshot.
4. Save with `web_editor_save` and update the root note: axes, strokes, home/work meaning, which
   assumptions are still unverified.

## Tool reference — editor domain

The complete `web_editor_*` inventory with parameters, generated from the decorators. Parameters per tool: `web_help(topic)`.

<!-- BEGIN GENERATED: tool-reference editor — do not edit; run `npm run gen:mcp-docs` -->
_12 tools in this family, generated from the @McpTool decorators — do not edit by hand._

| Tool | Access | Parameters | Summary |
|------|--------|------------|---------|
| `web_editor_back` | write | — | Leave the current descend level and return to the document above it (the inverse of web_editor_descend). |
| `web_editor_close` | write | `ifDirty` string, `name` string | Close the asset editor and return to the previous workspace. |
| `web_editor_descend` | write | `path` string **req** | Descend INTO a referenced asset at path — opens that asset as its own document one level deeper, exactly like double-clicking the reference in the hierarchy. |
| `web_editor_open` | write | `source` string **req**, `relPath` string, `ifDirty` string | Open the ASSET EDITOR with a document: source=new (creates a NEW document in the open project and opens it) or source=library with relPath naming an EXISTING document of… |
| `web_editor_parametric_define` | write | `path` string **req**, `paramsJson` string **req**, `code` string **req**, `valuesJson` string, `partsRoot` string | Define a parametric family on a node (plan-650): base parts are the children of partsRoot, paramsJson the schema, code a pure JS generate(values, parts) returning a buil… |
| `web_editor_parametric_inspect` | read | `path` string **req**, `valuesJson` string, `runGenerator` boolean | Read a parametric family without changing it: values, hashes (upToDate), parts and, unless runGenerator=false, the build plan or the generator error. |
| `web_editor_parametric_set` | write | `path` string **req**, `valuesJson` string **req** | Set values of a parametric family (partial JSON, normalized) and regenerate its variant as one undo step; deferred while the simulation runs. |
| `web_editor_save` | write | `name` string | Save the asset as GLB into the open project — its own folder when it has one, the project ROOT when it has none (plan-744: `library/Custom` is no longer a fallback). |
| `web_editor_status` | read | — | Asset editor status: document name/base/dirty, undo/redo availability + label, op count, selection and node counts, and placementsReady / placementsPending (placed refer… |
| `web_editor_test_start` | write | — | Start the editor's IN-PLACE TEST session: the authoring state is materialised through the real save path and the runtime is attached, so drives, logic and mechanisms act… |
| `web_editor_test_stop` | write | — | Stop the editor's in-place test session and put the authoring state back exactly as it was before the run. |
| `web_editor_verify_drive` | write | `kinematicPath` string **req**, `from` number, `to` number, `frames` integer, `keepView` boolean | VERIFY a drive visually before saving — performed like a user would: selects the axis (gizmo + group highlight appear), aims the AGENT camera at a fitted 3/4 view of the… |
<!-- END GENERATED: tool-reference editor -->
