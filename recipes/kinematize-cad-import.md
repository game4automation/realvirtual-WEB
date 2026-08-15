# Kinematize and materialize a CAD import

## Goal and outcome

Turn a raw CAD assembly that is already open in the asset editor into a working kinematic model:
every moving axis has a Drive that has been *seen* to move the right parts in the right direction,
the machine can be shown and hidden in sensible groups, and the materials look like real industrial
hardware instead of flat grey.

Alongside the model you build a **knowledge folder** for the asset — a durable, human-readable
record of what the machine is, which parts exist, which axes were found and what remains uncertain.
It is what makes the second session on the same machine fast instead of a repeat of the first.

## When to use

Use this recipe when a STEP, JT or GLB assembly has already been imported into the asset editor and
consists of numbered CAD nodes with no semantics. It suits a person working through the editor
panels as well as an AI assistant working through the `web_*` MCP tools; tool names are given
because the assistant path is the faster one.

## Prerequisites

- The workspace is running (`start.ps1`, Linux `./start.sh`) and realvirtual CONNECT is reachable
  at http://localhost:5100.
- **The asset editor is open and the CAD is already imported.** This recipe does not open, import
  or save anything — it starts from what is on screen and ends by handing back.
- Write access is enabled in CONNECT. Read-only tools work without it; every authoring step needs it.
- A **writable project is open**, because the knowledge folder lives inside it
  (`web_editor_project_info` → `writable: true`).

## Steps

### 1. Confirm the starting point

**Before anything else, when you are starting a NEW asset: make sure the viewport is empty.**
Not the scene — the *model*. With a model loaded, `web_editor_open(source=empty)` still reports
`base: {kind:"empty"}` and `nodeCount: 1`, but the document binds to the loaded model, and
`web_editor_import_cad` attaches the import **underneath it**. Measured on the demo model:
`nodeCount` jumped 1 → 681 and the import came back as
`DemoRealvirtualWebglb/3D-model_A_00808`. Saving there would have written the whole demo scene
plus the part. Clearing the *scene* (`web_scene_new`) does **not** fix it — the model survives.

```
web_project_open project=<slug>     # right project first: all paths are project-relative
web_model_open   model=empty        # empty MODEL — this is the step that clears the viewport
web_editor_open  source=empty
web_editor_import_cad relPath=cad/<file>.stp
web_editor_status                   # nodeCount MUST be ~the part count, not the scene size
```

The `nodeCount` check is the whole point: it is the one number that tells you whether you are
authoring your part or quietly editing somebody else's scene. With the same import, a clean
start reports `nodeCount: 53` and `rootPath: "/3D-model_A_00808"`.

Then `web_editor_status`. Three fields decide how you proceed:

- `active: true` — you are in editor mode. If not, stop and say so; nothing below works otherwise.
- `nodeCount` — greater than zero, or there is nothing imported to work on.
- `opCount` — **zero means a blank import; non-zero means someone has already worked on this
  document.** Do not assume you are starting from scratch. Read the knowledge folder in step 2
  before changing anything, and reconcile what you find with what is actually in the scene.

#### 1a. Check the import sits ON the ground, not through it

A freshly imported CAD assembly lands wherever its CAD origin happened to be, which is very often
**not** the floor. Check it before anything else, because every later judgement — which part is
the static base, how high the workspace is, whether a measured pivot height looks plausible —
is read against the ground plane.

```
web_node_bounds paths=<import root>     →  min[1] (world Y minimum, metres)
```

**The rule: with rare and deliberate exceptions, everything belongs above y = 0.** `min[1]` should
be `0` (machine standing on the floor) or positive (a machine hanging from a frame, a robot head
mounted overhead). A clearly negative `min[1]` means the model is sunk into the floor and should be
dropped onto it:

```
web_editor_to_ground path=<import root>    # rests the bounding box on Y = 0
```

`web_editor_to_ground` is the tool for this — it is the same "To Ground" the Quick Edit panel
offers, it is one undo unit, and it needs no arithmetic. Reach for `web_editor_transform` only
when the part must end up at a *specific* height rather than on the floor; note it takes flat
`px`/`py`/`pz` in metres and they are ABSOLUTE local values, not deltas, so read the current
transform first.

Genuine exceptions exist — a pit conveyor, a below-floor chip auger, a machine base plate modelled
with a recess — so this is a check with a judgement, not an automatic correction. What is never
right is leaving a whole assembly floating a metre in the air or buried to its waist because
nobody looked.

Two reasons this matters beyond tidiness:

- **Layout placement assumes it.** `web_layout_place` puts an asset down on the floor plane; an
  asset whose own origin is a metre below its base lands a metre too high in every line built
  from it, and the error is then repeated per placement.
- **It silently corrupts perception.** "The plate is at y ≈ 1.70 m" is only evidence for *head
  plate mounted overhead* if y = 0 is the floor. Against a sunk import the same number means
  nothing, and a whole part-class table can be reasoned out wrong from it.

Record the corrected ground offset in `knowledge.md` — the next session must not re-litigate it.

### 2. Build or ingest the knowledge base

`web_editor_project_info` returns which project is open, whether it is writable, the asset's
`library/`-relative path when it has one, and `knowledgeRelPath` — conventionally
`knowledge/<AssetName>`, **relative to the open project**.

**There is no absolute path, and you no longer need one.** The knowledge folder lives inside the
project, and every tool that reads or writes it takes the project-relative path directly:
`web_editor_import_glb` / `web_editor_import_cad` read, `web_render` and
`web_screenshot_annotated` write via `savePath`. `absolutePath` is always `null` and stays that
way — a browser project keeps its files in OPFS, which has no path at all.

**What changed for humans (plan-709 §2.6):** dropping a datasheet into the folder from the OS file
manager only still works for a *folder* project, where the project IS a directory on disk. For a
browser project the file has to go in through the app, and the folder is not browsable from
outside. If a session needs a human to supply source documents and the project is a browser
project, say so early and ask for them another way rather than pointing at a folder that cannot be
opened.

The folder holds:

```
knowledge.md    the spine: machine summary, assembly map, part classes, candidate axes,
                open questions, ingested sources, view index, provenance
parts.json      machine-readable catalogue, one entry per PART CLASS
views/          the few durable PNGs worth keeping
<anything>      datasheets, PDFs, photos, notes dropped in by a human — read, never written
```

#### 2a. Ingest first — every session, not only the first

Walk the **whole** knowledge folder including subfolders and compare it against the *Ingested
sources* table in `knowledge.md` (relative path, kind, size, modified, and what that source
contributed). That table is both the human index and the change detector.

- **New file** — read it and add a row.
- **Changed** (size or timestamp differs) — re-read it, update its row, and revisit any conclusion
  that cited it.
- **Unchanged** — skip it. This is what makes a warm session cheap.
- **Missing** — mark it removed and flag any conclusion that depended on it as now unsourced.
- **Not machine-readable** (`.step`, `.zip`, a vendor binary) — record a row saying it exists and
  that you could not read it, and ask what is in it if it matters. A file skipped silently is worse
  than one never seen.

Two rules that matter more than they look:

- **Never ingest your own output.** `knowledge.md`, `parts.json` and `views/` are excluded. Reading
  them back as evidence turns yesterday's guess into today's fact.
- **Human-authored content outranks your inference.** If a dropped datasheet says the stroke is
  400 mm and your geometry estimate said 380 mm, follow the datasheet and record both, plus which
  one you used and why.

Then check `nodeCount` and `opCount` in `knowledge.md`'s provenance block against the live values.
They match — trust the file and skip straight to the work. They differ — treat the contents as a
prior, not as truth, and re-verify anything you rely on.

#### 2b. Fill the gaps

Do not rename, group or kinematize until you can say what the machine *does*.

1. **One `web_scene_query` gives you almost everything.** It returns a frozen snapshot of every node
   — `path, name, depth, parentPath, components[], isMesh, meshCount, triangles, bounds, material` —
   and runs your JavaScript over it. From this single call, compute:
   - **Part classes.** Cluster on `(triangles, bounds.size rounded)`. Every copy of a roller
     collapses into one class. This *is* the deduplication, and the signature doubles as the query
     that finds a class's instances again later, so `parts.json` stores classes only.
   - **The assembly map.** Subtrees at depth 1–2 with node count, triangle budget and world bounds.
   - **A work list.** Which subtrees carry no components yet.
2. **Run the expensive tools once per class, never per instance.** `web_node_shape` on one
   representative gives the shape class (cylinder-like, beam-like, disc-like, plate-like, compact)
   and, for cylinder- and disc-like parts, the **functional axis** — the rotation/symmetry axis.
   That is your axis oracle. On a large import this is tens of calls instead of thousands.
3. **Look at it.** `web_render mode=idmask groupBy=hierarchy` returns a segmentation image plus a
   colour→path legend, so one picture tells you which subtree owns which pixels regardless of node
   names. Use `groupBy=geometry` to see repeated parts at a glance. Add
   `savePath=knowledge/<AssetName>/views/overview.png` to keep the shot.
   **Never classify a part from its bounding box alone** — a node measuring 846 × 47 × 129 mm reads
   like an extrusion and is just as likely a belt conveyor, frame and rollers included.
4. **Read the bill of materials from the node names.** Manufacturer part numbers are hard evidence.
   Motor controllers (Festo `CMMT-`, Siemens `SINAMICS`) appear once per electrical axis — count
   them, and that is how many servo axes exist. A valve terminal (`VTUX`, `CPX`, `VTUG`) means
   pneumatic actuators. Sensors, HMI panels and terminal strips are cabinet content and stay static.
   This is how you know when your axis list is *complete*: two axes found but three motor
   controllers in the cabinet means one is missing.
5. **Separate moving from static by coordinate clustering.** Within an assembly, carriage parts
   share a position — everything at z ≈ +0.2 is the slide, everything symmetric about ±0.098 is
   structure. Symmetric pairs are almost always static: feet, brackets, sensor rails.

#### 2c. Write it back

Update `knowledge.md`: machine summary with the evidence behind it, assembly map, part-class table,
**candidate axes** (member classes, functional axis, proposed direction and limits, confidence),
open questions that need process knowledge, the ingested-sources table, a view index, and a
provenance block recording `nodeCount` and `opCount` as of now.

Save only the few images worth keeping — an overview, the idmask, one per axis candidate — with
`savePath`. For every other view, record the **camera pose and the call that produces it** rather
than the picture. Poses stay correct after the model changes; images quietly do not.

### 3. Build the kinematic model

**Do not rename CAD nodes.** Their names are the link back to the CAD system and to any drawing or
BOM the customer holds. Functional naming belongs in `knowledge.md`; the scene keeps the names the
CAD gave it.

**The kinematic model is a separate structure layered on top of the CAD tree.** `web_editor_kinematize`
creates a *new* axis node carrying the `Kinematic` and `Drive` components. The CAD parts are **not
moved in the hierarchy** — they stay exactly where the import put them and merely receive a `Group`
component naming the axis they belong to. Nesting is expressed by reparenting **axis nodes** under
one another; never reparent CAD parts to achieve it.

For each axis, in this order:

1. **Choose the members** from the class catalogue, then kinematize in batches of roughly eight
   paths. Larger batches have been observed to leave the editor busy.

   ```
   web_editor_kinematize paths=<parts> groupName=AxisLeft_Z direction=LinearZ
                         speed=500 lowerLimit=-400 upperLimit=0 startPosition=0
   ```

2. **Fix the pivot.** `kinematize` centres the pivot on the group's bounding box, which is right for
   a linear axis and usually **wrong for a rotary one** — a rotation belongs on the rotation centre,
   not the centroid. Use `web_editor_pivot mode=object_center targetPath=<a symmetric part of the
   axis>` to place it precisely; `mode=group_center` re-centres to the group when that is what you
   want.

   **When no part sits on the rotation centre, MEASURE it — do not derive it.** Two derivations
   look authoritative and are routinely wrong:

   - **The PCA long axis of the moving part.** A cast arm or lever carries a heavy bearing boss at
     one end, and that mass drags the principal axis away from the true joint line. On the Delta
     upper arm this produced an 18.24° inclination against a real 14.4°, putting the pivot **43 mm**
     off. `web_node_shape` is excellent for *which axis a symmetric part turns about*, and unreliable
     for *where an asymmetric casting is hinged*.
   - **A toleranced dimension lifted off the drawing.** A `±0.02` figure reads like a bearing seat,
     but check what it actually dimensions. On the Delta the tempting `318.79 ±0.02` sits in the
     head-plate **hole-pattern list**, not on the arm axis; the real radius is 331 mm.

   The reliable method is to look down the axis and pick it:

   ```
   web_camera_set  px,py,pz = <a point ON the expected axis, backed off along it>
                   tx,ty,tz = <the expected axis point>       # view direction = the axis
   web_screenshot                                             # full canvas, so pixel→fraction is direct
   web_view_pick   x=<fraction> y=<fraction> select=false
   ```

   Viewed along the axis, the bearing face shows as a true circle. Two things confirm you hit it:
   `normal` comes back as the axis direction (e.g. `[0,0,1]`), and the **central bore reads back at a
   different depth than the ring face around it** — on the Delta the centre pick returned `z = 0.167`
   against `0.191/0.197` for the surrounding annulus, which is what identified it as the shaft
   centre rather than just another point on the flange. `web_view_pick` returns the exact world
   point; that is your pivot.

   Clear the selection first (`web_select mode=clear`) — selection highlight rings are drawn as
   circles and are very easy to mistake for the bearing geometry you are aiming at.

2b. **Get the hinge DIRECTION from a neighbouring part, not from the moving body.** Linkages
   usually have small separate joint blocks, clevises or bearing caps, and those are symmetric —
   exactly what `web_node_shape` is good at. In a parallelogram linkage the far hinge is *parallel*
   to the near one, so the elbow block hands you the arm's pivot direction for free. On the Delta
   the three elbow blocks returned `[0,0,1]`, `[0.866,0,0.5]` and `[0.866,0,-0.5]` with a Y-component
   of **exactly 0** — measured confirmation that the hinges are horizontal and tangential, which no
   amount of reasoning about the assembly would have established as firmly.

3. **Get the rotation axis right.** `Direction` (`RotationX|Y|Z`) is a **local** axis of the
   kinematic node, while `web_node_shape` reports the functional axis as a **world** vector. Compare
   them using the `worldQuaternion` from `web_node_bounds`. When the functional axis does not line up
   with a cardinal local axis, rotate the axis node itself (`web_editor_transform` with `rx/ry/rz`)
   until it does, then set `Direction`. Choosing a Direction without checking this mapping is the
   single most common way to build an axis that spins about the wrong line.

   **Rotate the axis node BEFORE it has members.** `web_editor_transform` on a node that already
   owns a group drags the geometry with it. For any axis that is not aligned to a world axis, build
   it in this order instead of using `kinematize` in one shot:

   ```
   web_editor_create_kinematic   name=AxisArm_120                 # empty axis node, no members yet
   web_editor_transform          path=/AxisArm_120  px,py,pz=<measured pivot>  ry=<so local Z = hinge>
   web_editor_add_component      path=/AxisArm_120  type=Drive  propsJson={"Direction":"RotationZ",...}
   web_editor_assign_to_kinematic groupName=AxisArm_120  paths=<parts>
   web_editor_verify_drive       kinematicPath=/AxisArm_120
   ```

   For a hinge that is horizontal and tangential at azimuth θ — the standard delta/radial-linkage
   case — the direction is `t(θ) = (−sin θ, 0, cos θ)`, which a node rotation of `ry = −θ` maps onto
   local `+Z`. Deriving all axes from one formula keeps the rotation SENSE identical across them, so
   a positive command moves every arm the same way; picking the PCA sign per part does not, because
   PCA axis signs are arbitrary.

   Note `assign_to_kinematic` adds **group membership**, it does not reparent: members keep their
   original CAD paths. Do not go looking for them under the axis node afterwards.

4. **Set the limits from geometry.** Profile length minus slider length gives the mechanical stroke;
   check where the payload sits at both ends. State that as the mechanical maximum and say plainly
   that the *functional* stroke needs process knowledge the CAD does not contain.

5. **Prove it visually. This is not optional.** `web_editor_verify_drive` selects the axis, frames
   it, drags the drive through its range while capturing poses, and returns one labelled montage.
   Read it for the four failure modes:
   - parts translating where they should rotate → wrong `Direction`
   - parts orbiting instead of spinning → wrong pivot
   - parts staying behind → missing members
   - end positions leaving the guide → wrong limits

   Never record an axis as working that you have not watched move.

What belongs in a moving group and what does not:

- **The actuator's own slider must move.** On a rodless cylinder the profile has several meshes —
  profile, inner body, sealing band, and a short carrier at the current carriage position. That
  carrier is the moving part; forgetting it makes the payload drift away from its own guide.
- **Motors, drive blocks and their mounts stay still** relative to the axis they drive.
- **Energy chains stay static.** They deform in reality; attaching one rigidly drags half the chain
  through the profile. Attach the chain's carriage driver and leave the chain alone.
- **Tooling below a lift travels with the lift**, not with the carriage.

**Nested axes need an explicit reparent of the axis node.** A lift on a portal carriage does not
travel with the portal by itself: `kinematize` removes its parts from any group they were in, and
`web_editor_assign_to_kinematic` skips kinematic axis nodes. Use
`web_editor_reparent paths=/AxisLeft_Y newParentPath=/AxisLeft_Z`, then re-verify the **parent**
axis and confirm the sub-assembly travels with it. Reparent in batches of about eight.

Record each finished axis in `knowledge.md` — members, direction, pivot, limits, and how you
verified it.

### 3b. Closed kinematic chains — mechanisms instead of axis groups

An axis group can only express TREE motion: one drive moves one rigid group through the
hierarchy. When parts constrain each other — four-bar linkages, scissor lifts, Delta
platforms — no parent chain can carry the motion, and the model becomes a **mechanism**
(`web_editor_mechanism_*`): a joint graph the solver closes every tick. A single hinge or
sliding carriage is an axis, not a mechanism.

**Build order — driven axes FIRST, as ordinary kinematic groups.** A closed chain's
driven joints are usually plain hinges against the frame (a Delta's three upper arms).
Author those with `web_editor_kinematize` like any axis: group the arm's parts, place the
pivot, set the direction, and PROVE each axis with `web_editor_verify_drive` before
touching the mechanism. Only then add the mechanism as the PASSIVE layer — the loop
joints (rods, platform) — with the verified axis nodes as the driven bodies. The drive
moves its axis group directly (exactly the Unity model: the Drive writes the driven
link's pose, the solver only closes the passive loops), the axis node doubles as the
multi-part rigid body, and every stage of the build was watched moving before the next
one leaned on it. Skipping straight to an all-mechanism model discards the incremental
proof and debugs every error class at once.

Rules that cost real time when violated (all learned on a real Delta build):

- **One joint per node — this is an export contract, not a style preference.** A node's
  rv_extras can carry several `KinematicJoint_N` keys in the editor, but only one survives
  the GLB save. Host every joint on its own node: revolutes on their bodyB link, loop
  joints on any distinct node of the involved links.
- **Anchor fields are raw wire values, not editor coordinates.** `AnchorA`/`AnchorB` go
  through the Unity X-mirror AND are interpreted in the body's LOCAL units. On CAD imports
  whose nodes carry scale 0.001, a hinge at local 318.8 mm must be authored as ±318800.
  After every anchor edit, run `web_editor_mechanism_validate path=...` and read the
  `AnchorsApart` findings — 0.x mm is authored correctly, hundreds of mm means a frame or
  scale error. `web_editor_mechanism_set_anchor` fixes both sides in one undo step.
- **Axis fields mirror differently than anchors** (position rule vs quaternion rule). An
  axis-parallel direction survives a wrong guess because the LINE stays the same; a
  diagonal axis (a Delta's ±120° arms) does not. Author, validate, and confirm the axis
  visually with a small jog before trusting it.
- **`_validate` without a path only lists; `_validate path=...` rebuilds.** After
  structural edits always validate WITH the path, or you are reading the stale topology.
- **Assign drives before the first jog** — an undriven joint reports the same error as a
  broken mechanism.
- **A failed jog can wreck the live pose, and that poisons everything after it.**
  `AnchorsApart` is measured against the CURRENT scene pose, so a distorted pose turns
  correct anchors into false findings, and the solver may not find its way back from a
  blown-apart start. The document is unaffected (saves write authored state, not live
  transforms): close the editor and reopen the asset to reset, then validate again.
- **Topology sanity check:** the mechanism list reports joints/links/loops/dof. Use the
  joint/link/loop counts — but **do NOT treat the reported dof as an acceptance criterion
  for a parallel mechanism.** The figure comes from the generic 3D Grübler/Kutzbach
  formula, which routinely flags parallel-axis machines (four-bar linkages, Delta
  parallelogram arms) as over-constrained even when they are perfectly mobile. Unity's
  `kinematic_doctor` reports **−2 dof on a working Delta** and labels it informational for
  exactly this reason. Chasing a "wrong" dof number on a Delta is a guaranteed dead end;
  the acceptance test is a converging jog, not a mobility count.

- **Every body must be its own node — including each individual rod.** In the working Unity
  reference (`DemoKinematicsSolver.unity`) not one joint references geometry directly:
  frame, the three upper arms, the platform AND each of the six rods are dedicated nodes
  with the mesh hanging underneath as a child `Visual`. Mirror that. A joint that addresses
  a raw CAD mesh is addressing a body with the import's own scale (typically 0.001) and
  rotated parent frame, while every other body sits in an identity frame — and a mechanism
  mixing the two is not homogeneous. Give a single-mesh rod its own group too: the point is
  the reference frame, not the number of meshes it contains.

**A moving body is usually MORE than one mesh — give it a kinematic group with no drive.**
This is the single most consequential modelling decision in a mechanism, and it is easy to
skip because the mechanism happily accepts a bare mesh as a body. A Delta's moving platform
is a plate *plus* three joint blocks *plus* the flange and the whole tool head; wiring the
six spherical joints to the plate alone leaves every one of those parts hanging in the air
the moment it moves. Create a kinematic axis, assign the parts, add **no Drive**, and use
that node as Body A/B. Groups say what is rigid; the mechanism says how rigid bodies
constrain each other. The same applies on the driven side — a driven axis node doubles as
the arm's rigid body and should already carry the arm *and* its elbow clevis.

**Ball joints, and why not to model both rod ends as one.** `Spherical` IS the ball joint.
Real linkage rods usually carry ball heads at BOTH ends, but modelling them that way gives
each rod a free spin about its own axis — a degree of freedom with no effect on the output
body, which the solver still has to resolve. Use `Universal` at one end. The validator
checks exactly this and reports `IdleSpinRod`.

**Read `IdleSpinRod` in context: on a partially built mechanism it lies.** A platform that
is so far connected by only two spherical joints looks to the checker exactly like a rod
held by two sphericals, and it is reported as one. It disappears by itself once the
remaining joints land (a Delta platform: six sphericals). Do **not** "fix" it by converting
a platform joint to a Universal — that breaks the kinematics to silence a false positive.

**`DriveAxisMismatch` "180.0 deg off the joint axis" is a sense error, not a geometry
error.** It appears on axes that are diagonal in world space (a Delta's ±120° arms) while
an axis lying on a world axis stays clean — the same mirror asymmetry as above. Fix it with
`ReverseDirection: true` on that axis's Drive rather than by rotating anything.

**Use the 2× signature to identify an anchor sign error.** After setting a world-side anchor
by hand, a residual `AnchorsApart` of exactly **twice one coordinate** means that
coordinate's sign is mirrored, not that the point is wrong. Worked example: a pivot at
x = 331 mm first reported `1263.14 mm` apart (= the full distance to the world origin, i.e.
the anchor had defaulted to 0,0,0); authoring `{331, 1219, 0}` changed it to exactly
`662.00 mm` = 2 × 331, and `{-331, 1219, 0}` cleared it. Read the number instead of guessing
the sign.

**A clean validation is NOT a working mechanism — jog it.** `web_editor_mechanism_validate`
can report zero kinematic findings while `web_editor_mechanism_jog` still returns
`converged: false` with a huge residual. Treat the jog's `converged` flag as the acceptance
test and the validation as a pre-check. And be sceptical of a validation that went clean
right after you edited anchors by hand: `AnchorsApart` is measured against the CURRENT scene
pose, so "clean" can also mean "the anchors now match an already-distorted pose". Reset the
pose (close and reopen the asset) before believing either result.

**Author joints only once their bodies resolve, and prefer not to delete and recreate them
mid-session.** The node-transform derivation latches per session: it SKIPS joints whose body
references were unresolved when it ran and derives them on the next build. Joints that were
deleted and re-added partway through a session are therefore the first suspects when a
mechanism validates cleanly but will not converge.

**Two authoring modes exist. Pick ONE per mechanism and never mix them on a joint.**

- *Node-transform mode*: the joint node carries the transform, the joint carries
  `FromNodeTransform: true`, and the stored `AnchorA`/`AnchorB` stay `{0,0,0}` because the
  engine derives them at load.
- *Explicit-anchor mode*: the joint node sits at identity and `AnchorA`/`AnchorB`/`AxisA` are
  authored as wire values in mm. The shipped reference fixture `public/models/mechanism-delta.glb`
  is authored this way — read it with a GLB JSON dump when in doubt about the correct shape.

Calling `web_editor_mechanism_set_anchor` on a joint that already has `FromNodeTransform: true`
puts it in BOTH modes at once, and a hand-set anchor then competes with a derived one. That is a
very easy trap to walk into, because the usual reason for reaching for `set_anchor` is an
`AnchorsApart` finding — which, measured against a distorted pose, may not have been real in the
first place. Reset the pose and re-validate BEFORE authoring an anchor by hand.

Diagnosing which mode a saved asset is actually in takes one command — the GLB is the truth, not
the editor panel:

```bash
node -e 'const b=require("fs").readFileSync("asset.glb");
  const j=JSON.parse(b.slice(20,20+b.readUInt32LE(12)).toString());
  for(const n of j.nodes) if(n.extras?.realvirtual) console.log(n.name, !!n.matrix, JSON.stringify(n.extras.realvirtual));'
```

Note the transforms of empty joint nodes are exported as a `matrix`, not as `translation` —
checking only for `translation` makes them look lost when they are not.

**Preferred authoring — dedicated joint nodes.** Instead of writing anchor/axis fields,
host each joint on its own EMPTY node placed at the joint: node position = anchor point,
local +Z = primary axis, local +X = a Universal's secondary axis
(`web_editor_create_empty` → `web_editor_transform` → `web_editor_mechanism_add_joint`
with NO anchor parameters). The engine derives all per-body values from the node's world
transform at load — no wire-frame arithmetic, no body-scale sensitivity, and the values
re-derive on every load, so the node transform stays the single source of truth. Parent
joint nodes under the asset root (identity: local = world), never under a moving link.

**EVERY body must sit in an IDENTITY-SCALE frame — this is the #1 cause of a mechanism
that validates clean and will not converge.** The node-transform derivation divides the
anchor by the body's world scale, but the topology carries only each link's
`worldPosition`/`worldRotation` — **scale is dropped**. A body under a CAD root with scale
0.001 therefore gets an anchor off by 1000×. Symptom on a Delta: arms and rods sit
correctly while the PLATFORM — the one link placed through a rod-side anchor — is flung
~1000× the rod length away, and the residual floors out instead of converging.
Fix: wrap each such part in its own root-level node (identity transform, `Kinematic`
component) and move the CAD node underneath carrying the CAD-root matrix, so its world
pose is unchanged. Point the joints at the wrappers. Because node-transform anchors are
`{0,0,0}` and re-derive at load, **no anchor arithmetic and no delete-and-recreate is
needed** — repointing `BodyA`/`BodyB` is enough *when done in the file* (see below).

**Author the loop geometry from an exact parametric model, not from picked values.**
Rounded measurements (5-decimal metres) leave rod lengths differing by ~0.015 mm and
separations by ~0.003 mm. That is the same order as `Tolerance` and it costs convergence.
Derive every joint node from closed-form symmetry instead — for a Delta:
`P(θ)=Rp·u(θ)+(0,yp,0)`, `U±(θ)=Re·u(θ)+(0,ye,0)±d·t(θ)`, `S±(θ)=Rq·u(θ)+(0,yq,0)±d·t(θ)`
with `u(θ)=(cos θ,0,sin θ)`, `t(θ)=(−sin θ,0,cos θ)`, node rotation `ry=−θ`.

**GLB round-trip contract (violations author fine and load broken):**
- Do NOT co-host a `Drive` and a `KinematicJoint` on the same node — the Drive is lost
  on save. Keep drives on their own empty nodes and wire them via
  `web_editor_mechanism_assign_drive`.
- Body A/B referencing editor-created `Kinematic` nodes **does** survive the round-trip
  (verified: 6 rod bodies + platform + 3 axis nodes, 27/27 refs resolvable after save and
  reopen). An earlier note here claimed the opposite — it was wrong.
- The save exports LIVE poses (`GLTFExporter` over the live scene). Return the mechanism
  to its home pose before `web_editor_save`, or the solved deflection is baked in. **A
  failed jog followed by a save permanently corrupts the asset**: the anchors then
  re-derive from the wrecked pose on every reopen, so nothing you change afterwards can
  help. Tell-tale: CAD siblings all have local translation `[0,0,0]` while the broken ones
  carry values in the hundreds of thousands.

**`web_editor_transform` does not reach CAD-subtree nodes in the live scene.** It returns
`ok` and raises `opCount`, but the rendered node never moves (confirmed with the mechanism
removed, and on healthy nodes). It works on editor-created root nodes. Combined with the
live-scene export, a document-only edit is silently lost. **For pose surgery or structural
rewiring on imported CAD, patch the GLB directly** — parse the JSON chunk, edit
`nodes[i].matrix` / `extras.realvirtual`, re-pad both chunks, rewrite. Deterministic,
verifiable, and far cheaper than 36 MCP calls.

**Passive mechanism links do NOT move in a merged load — they only move in the editor.**
A non-`preserveHierarchy` load (the F5 in-place test run, and every normal HMI/planner
load) splits geometry into per-`Drive` kinematic merge chunks, which move, and static
`BatchedMesh` arenas, which never do. The bucket is chosen by the **`Drive`** component —
not by `Kinematic`, not by mechanism membership. So a Delta's driven arms animate while its
rods and platform stay frozen in place, even though the same model jogs perfectly in the
asset editor (where both merges are skipped). Workaround while authoring: disable static
batching (Visual settings, or `localStorage['rv-webviewer-static-merge']='0'`, read at load
time only). This is an engine gap — the batching predates mechanisms.

**Diagnostics are only valid from a freshly reopened asset.**
- `AnchorsApart` and `residualError` are measured against the CURRENT pose, so after a
  failed jog they describe the diverged pose, not the model. A ~1 000 000 mm reading is
  usually a flung link, NOT a unit bug.
- Jogging to the value the drive already holds does not run a real solve.
- `SolverIterations` barely helps: progress happens per jog CALL, not within one solve
  (the WASM solver caps internally). If you find yourself sweeping `Damping`, the model is
  wrong — a correct mechanism converges on the shipped defaults `4 / 0.01 / 0.001`.
- `ReverseDirection` on a drive has **no effect on the solve** (bit-identical residual).
  It is a Drive direction convention only; it cannot fix `DriveAxisMismatch` geometry.
- `public/models/mechanism-delta.glb` is a 2-joint OPEN chain (Base → UpperArm → Platform).
  It demonstrates explicit-anchor syntax and nothing about closed-loop convergence — do not
  cite it as proof that a mode "works".

### 4. Add show/hide groups — only if the machine needs them

Decide first, and say which way you decided: does this machine have enclosure panels, covers or
modules a user would genuinely want to toggle? Many do not. If not, skip this step.

If it does, add a `Group` component to those nodes:

```
web_editor_add_component path=<node> type=Group propsJson={"GroupName":"TopCover"}
```

Keep it coarse — **three to eight groups**. Enclosure and covers first, because that is what a user
hides first; then base and frame; then one group per functional module someone would isolate. A
group per screw is noise: if you cannot name a reason someone would hide it, do not group it.

### 5. Assign materials

Materials come **last**, once the axes are proven — appearance work on a model whose structure is
still changing is work done twice.

CAD imports arrive with every material at `metalness: 1, roughness: 1`, which is why they look flat
and grey. Fixing this is the single biggest visual improvement available.

1. `web_editor_material_stats` — appearance groups with stable keys, sorted by mesh count.
2. `web_editor_material_presets` — the available library.
3. `web_editor_materialize` with an `assignmentsJson` array — one call, one undo step, keyed by the
   group key.

Prefer internal presets (`steel`, `brushed-alu`, `stainless`, `anodized`, `galvanized`,
`plastic-black/white/grey/blue`, `rubber`, `ral-*`) over custom PBR values, so the result stays
consistent and reusable. The CAD colour usually carries meaning — blue fittings, orange terminal
levers — so pick the preset closest in hue rather than flattening everything to grey. The
`Signal *` presets are emissive and belong on LEDs and indicators only; on an ordinary part they
glow in shadow and look wrong. For enclosure panels use `guard`, or a custom glass value at low
opacity (0.1–0.25) so the machine stays visible behind it.

### 6. Hand back

**Do not save.** The document stays dirty and the person who asked for the work decides whether it
becomes an asset. Before handing back:

1. Update `knowledge.md` with the outcome — what was built, what was verified and how, what is still
   a hypothesis — and refresh the provenance `nodeCount`/`opCount`.
2. Report concretely: name the mechanical evidence behind each decision (dimensions, positions, part
   numbers), and separate clearly what the geometry proves from what needs process knowledge.
   Travel limits, transfer positions and cycle order are frequently **not** derivable from CAD.
   Never present an assumption as a verified fact.

## Acceptance criteria

- Every axis has been through `web_editor_verify_drive` and moves the correct parts in the correct
  direction, with both end positions inside the mechanical guide.
- Nested axes travel with their parent, confirmed by verifying the **parent** axis.
- No CAD node was renamed, and no CAD part was moved in the hierarchy.
- `knowledge.md` and `parts.json` exist, the ingested-sources table covers every file in the folder,
  and the provenance block matches the live `nodeCount`/`opCount`.
- No mesh remains at the imported default appearance.
- The document is **not** saved.

## Rollback

Nothing is written to the asset on disk, so there is nothing to undo there. Inside the session,
`web_editor_undo` reverses any number of operations and `web_editor_status` reports how many are
available. Abandoning the editor without saving discards every change.

The knowledge folder is the exception: it is written directly. It is additive and safe to delete —
regenerating it costs one session of perception work.

## Common problems

- **`web_editor_assign_to_kinematic` reports `ok: true` but nothing was assigned.** It cannot fail:
  unresolvable paths, nodes already in the group, and kinematic axis nodes are all skipped silently.
  Never trust the `ok` flag — confirm with the returned `members` count or
  `web_editor_list_kinematics`.
- **A field you set has no effect.** `web_editor_set_field` does not validate field names and
  silently *creates* an unknown one, reporting success. Only use field names you have seen in the
  output of an existing component; never use it to probe for a field that might exist.
- **An axis spins about the wrong line.** The `Direction` is a local axis and the node is rotated.
  Compare `web_node_shape`'s world functional axis against `web_node_bounds`' `worldQuaternion`
  before trusting a Direction.
- **`web_editor_verify_drive` timed out, and the axis is now stuck off its home pose.** The sweep
  moves the parts through the drive-drag *preview*, not through an op — so `web_editor_undo` will
  **not** put them back, and the displaced pose is what a save would write. Only a verify run that
  reaches its `finally` restores it (`restored: true` in the result is the proof). Recover either by
  re-running `verify_drive` once the tab is in the foreground, or by undoing the axis construction
  entirely and rebuilding it; check with `web_node_bounds` on a member that a home-pose coordinate
  is back where it started.
- **`verify_drive` montages of sibling axes look inconsistent.** The tool frames each axis from its
  own fitted 3/4 view, so a symmetric axis on the far side of the machine can look like it swings
  the wrong way when it does not. Do not judge symmetry from the montage — check it numerically:
  after the sweeps, every equivalent axis must return the same pivot→joint distance and its members
  must be back at mirrored home coordinates. On the Delta the three arms agreed to 0.2 mm, which
  settled it; the montage did not.
- **A rotary axis reads as correct but the linkage it drives does not follow.** Ordinary kinematic
  groups are open chains: driving an arm moves the arm. Rods, couplers and a moving platform need
  the closed-loop layer (§3b) on top; until it exists, a jog moving only the driven body is the
  expected result, not a defect.
- **A component you just added appears to be missing.** `web_component_get` and `web_component_list`
  read the running scene, not the editor document. Editor-authored components appear there only
  after the asset is saved and loaded — which this recipe does not do.
- **The machine is invisible or obscured.** Editor visibility is authored state. A cover someone hid
  stays hidden; prefer transparent over hidden.
- **The editor stays busy after a large call.** Keep `kinematize` and `reparent` batches to roughly
  eight paths.
- **`savePath` returns `saveError`.** Almost always "no writable project is open" — check
  `web_editor_project_info`. A folder project can also report a denied File System Access prompt
  here rather than failing silently. Fix the cause and retry; never reference an image whose write
  you did not see succeed.
- **Every tool answers `Not in editor mode`.** The editor closed. Nothing in this recipe works
  outside it.

## Security and version notes

CAD assemblies and the names inside them frequently disclose suppliers, part numbers and machine
capability, and the knowledge folder concentrates exactly that into one readable document. When an
AI assistant is used, everything it reads is processed by the selected provider — share only what
that provider is permitted to process. Treat the knowledge folder as carrying the same
confidentiality as the CAD it describes.

## Further reading

- [realvirtual WEB overview](../realvirtual-web/doc-webviewer.md)
- [MCP tool reference](../realvirtual-web/webviewer.mcp.md)
- [Unity-to-WEB workflow](../realvirtual-web/doc-unity-to-web.md)
- [Troubleshoot the runtime](troubleshoot-runtime.md)
