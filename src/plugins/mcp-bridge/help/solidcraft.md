# SolidCraft → realvirtual WEB: modelling CAD live into the asset editor

> Dotted names like `editor.setField(…)` / `sim.playPause` are registry commands: run them with
> `web_execute(command="<id>", args={…})` (or `web_batch`). Their old alias tools are not in tools/list.

SolidCraft is a parametric CAD app (own MCP server, tools `batch`, `execute`, `measure`, …).
`solidcraft.connect` links the document open in the editor to it; CONNECT then mirrors the
design node by node — every body becomes a mesh node under `SolidCraft_<design>`, revolute/slider
joints become Drives — and keeps it in sync, each step one undo step in the editor.

## Workflow

1. `web_editor_open` (asset editor) → `solidcraft.connect` → model in SolidCraft.
2. After a modelling stage: `solidcraft.resync` and compare its `bodyCount` with the
   body count SolidCraft reports (`inspect_design`), or count the meshes with `web_node_tree`.
   **They must be equal.** If WEB has fewer, read
   the Problems panel (`web_errors`) — a `solidcraft-identity-ambiguous` entry names the bodies it skipped.
   If it asks *"Is body X the renamed Y?"*, answer with
   `web_execute(command="solidcraft.identity.resolve", args={name:"X", uuid:"<uuid from the problem>"})` — or
   without `uuid` for a new body. Never guessed: until then X is not synced and Y keeps its WEB work.
3. Check the result in WEB (`web_node_tree`, `web_screenshot`), then `web_editor_save`.

Bodies that already carry components (Drive, TransportSurface) take geometry updates; a saved and reopened
design maps back to the same nodes on `solidcraft.connect` (after a move of the file the user is asked first:
"Design moved? Connect to <new path>"). Changes made during a test run arrive after it is stopped.
The `solidcraft-live` MCP server of the AI panel exists only when the user switched on *AI may control SolidCraft*
(Settings ▸ AI) and the Live Link is connected; it cannot save or export.

## Placement: the floor is z = 0

Model so the part stands on the floor in SolidCraft: feet / lowest point at z = 0, Z up. WEB maps
SolidCraft Z to Y unchanged, so a design built around its working height (e.g. frame at z = 0, legs
below) floats or sinks in WEB. Fix an existing design with one `solid.move {bodies:[all], translate:
[0,0,<height>]}` at the end, then check `web_node_tree includeBounds` (min Y = 0).

## Component axes on SolidCraft nodes

Every mirrored body node keeps SolidCraft's frame: **local Z is up and the unit is millimetres**
(world quaternion −90° about X, scale 0.001). Axis fields of components on these nodes are local:
a vertical rotation is Drive `RotationZ` and `TransportDirection {x:0,y:0,z:1}` — `RotationY` /
`(0,1,0)` would be a horizontal axis. Check with `web_node_bounds` (`worldQuaternion`) and by
selecting the node: a turntable/curve gizmo ring must lie flat.

The scale is handled: a `TransportSurface` (straight or `Radial`) and a collision `Sensor` on such a
node use the world bounds of their mm geometry, so an MU in the scene root is picked up and detected
like on any other conveyor (fixed 2026-10-21; before, the footprint landed far away from the mesh and
`web_query("transport.status", {})` showed `currentSurface: null`).

Known limits: a SolidCraft body used as `Source` prototype spawns instanced MUs in raw millimetre
coordinates — use a library MU (e.g. `CartonBox`) for tests. A node that got a gizmo mesh from a
naming convention (`Sensor`) and is then renamed in SolidCraft blocks the sync ("does not hold
exactly one mesh"): delete the sync root in WEB and reconnect.

## Geometry from SolidCraft, everything else in WEB (plan-654)

SolidCraft delivers **geometry only**. Components (Drive, TransportSurface, Sensor, snaps), materials and
properties are set in WEB and are **overrides that survive every update** from SolidCraft — a changed
parameter, a renamed body, a changed pattern count, reordering, a body moved to another component.

How: CONNECT gives every body a fixed UUID and keeps it in the design metadata (`io.realvirtual`, saved in
the `.solidcraft` file). A body keeps its identity by its **name**; a rename is recognised by its geometry.
Each time the mapping changes (a body added, renamed or deleted) CONNECT writes it as one visible undo step
in SolidCraft ("Change Design Properties", the design becomes unsaved) — **save the design in SolidCraft**,
otherwise the identities are only kept as long as CONNECT runs. A deleted body's WEB work stays as an orphan
(Problems panel) for 30 days in the design entry, so undo in SolidCraft brings it back with its overrides.

## Patterns and multi-body features

Pattern copies are named per copy index (`Roller (2)`, `Roller (3)` …) and each has its own identity;
a smaller count orphans the highest copies, a larger one brings them back with their WEB work.

- Pattern copies get generic names (`Body1`, `Body2`, …) — the original's name stays on the original.
- **Pattern copies do not inherit the original's appearance**: assign colours to the copies too
  (`appearance.assign {bodies:["Body1", …]}`).
- A sync of a few dozen bodies takes several seconds after the change; check again before judging.

## Materials

- A colour set in SolidCraft (`appearance.assign {bodies, color:"#rrggbb", opacity?}`) syncs to
  WEB as a `SolidCraft` material (metalness/roughness of the node's current material are kept).
  Prefer this for base colours — the CAD stays the source of the colour.
- For a finished look in WEB: `web_query("editor.materialPresets", {})` → `editor.assignMaterial` per node
  (steel, aluminium, plastics, rubber). A WEB material is an override: later CAD colour changes no longer
  touch that body (undo the WEB material to hand the colour back to SolidCraft).
- **Textured presets** (category *Textured*: Alu brushed / anodized, Galvanized, Powder coat, Plastic matte,
  Rubber / belt, Roller mantle, Roller mantle ↻) need **UVs**, and SolidCraft/CAD bodies have none.
  `editor.assignMaterial` with a textured preset generates the missing UVs of exactly the painted bodies
  (`generatedUVs` in the answer, same undo step). Explicitly: `web_execute("editor.generateUVs", {paths, mode:"auto"})`
  (mode `auto` | `cylindrical` | `planar` | `box`; existing UVs are kept unless
  `overwrite`). Rollers: `cylindrical` (u = revolutions around the roller axis, v = metres along it).
- **UVs are geometry**: a `solidcraft.resync` that changes a body's geometry replaces its UVs — run
  `editor.generateUVs` on it again (a textured preset without UVs shows as one flat colour).
- **Merge**: merging bodies of one textured material where only some have UVs fills the gaps with zeros —
  a `merge-uv-missing` problem names them; generate UVs first, then merge.

## Animated roller mantle (Roller mantle ↻)

The preset *Roller mantle ↻* (`tex-roller-mantle-spin`) makes the rollers visibly turn with the conveyor —
no Drive per roller and no extra draw call: the texture of the mantle moves. Rules:

1. Assign it to the roller mantles (UVs are generated automatically, cylindrical along the roller axis;
   each roller gets its own start phase from a hash of its node path, so they do not run in lockstep).
2. The part needs **exactly one `TransportSurface`** (straight or `Radial`) with its Drive — the rollers
   take its speed (straight: v / ρ, curve: ω·r_mid / ρ; ρ = mantle radius, measured at load).
   None or several → `roller-spin-unbound` in the Problems panel, the rollers stand.
3. Put the rollers **beside** the TransportSurface node, never below it — below it the belt scroll owns
   their texture and every roller costs a draw call (`roller-spin-under-surface`).
4. Rollers of one material that turn at different ratios (another radius on a straight conveyor, a
   cylinder among cones on a curve) are split into speed groups: one material + one draw call each
   (`roller-spin-mixed`, info). Conical curve rollers (ρ ∝ r) are one group.

## Light barriers: Raycast on its own node

A light barrier on a SolidCraft part is a `Sensor` with `UseRaycast` on its OWN node (`Lichtschranke`),
`RayCastDirection` across the conveyor and `RayCastLength` in **world millimetres** — the beam is drawn
2 mm thick and exactly as long as it detects, also under the 0.001 body scale. Raycast is the rule for
light barriers; a collision `Sensor` without a BoxCollider detects with (and shows, yellow/red) the box of
its own mesh. A node named `Sensor…` that is hidden (`visible: false` / `Hidden`) is NOT turned into a
sensor by the naming rule — hide construction bodies you do not want to detect.

## Recipe: roller conveyor curve (Interroll RM 8120 style)

Catalog → geometry (RM 8120, not driven, BF 420/620/840, angle 30/45/60/90°):

| Catalog | Geometry |
|---|---|
| r 825 | rollers start at radius 825 mm (inner edge of the clear width) |
| BF | rollers end at r = 825 + BF |
| TW = BF + 80 | side profiles 40 mm each: inner r 785–825, outer 825+BF … 865+BF |
| 6/9/12/18 rollers at 30/45/60/90° | roller pitch 5°, first roller at 2.5° (0.087 in P = 5° in rad) |
| 1700KXO, Ø50, conical PP sleeve | Ø grows with radius: 50 → ~87 mm over 610 mm (BF 620) |
| 115 / 120 | C-profile height 115; roller top line horizontal at z = 120 |
| HSG 68 (35–80) | side guide band top at 120 + 68 = 188 |

Build (Z up, curve centre at the origin, arc from +X to +Y):

1. Side profiles: C-section (3 mm wall, 10 mm lips) sketched on `XZ` (sketch y = −z),
   `solid.revolve {axis:"Z", angle:"90 deg"}`.
2. Conical roller with a **horizontal top line**: sketch on a tilted plane whose x axis is the
   roller axis. Half cone angle φ: tan φ = (r_out − r_in)/L. At angle θ:
   `x_dir = (cosφ·cosθ, cosφ·sinθ, −sinφ)`, `y_dir = (sinφ·cosθ, sinφ·sinθ, cosφ)`,
   origin = rotate_θ(r_start − r_in·sinφ, 0, z_top − r_in·cosφ).
   Profile (u,v): `(0,0),(0,r_in),(L,r_in+L·tanφ),(L,0)`, `solid.revolve {axis:"x"}`.
   Axle separately (r 5.5, reaching 8 mm into both profile webs). Check: bbox z max = 120.00,
   volume = π·L/3·(r1² + r1·r2 + r2²).
3. Guides: revolved bands 6 × 35 mm above the webs; holders = flat bars on a vertical plane through
   the Z axis (`{origin:[0,0,0], x_dir:[cosθ,sinθ,0], y_dir:[0,0,1]}`), extrude `symmetric`.
4. Cross ties under the rollers between the webs, at multiples of 5° (between two rollers).
5. Repeat rollers + axles with `solid.pattern.circular {axis:"Z", count:"n", angle:"a - 5 deg"}`
   (partial arcs include both ends → 5° spacing).
6. Driven variant (RM 8320): grooved head on each roller (r 22, first 25 mm, cone from there),
   round belts as slot rings (centres ±chord/2, widths 47/37, extruded 5 mm) on a plane through the
   roller heads, alternating on two radii so neighbouring belts do not touch; one RollerDrive per zone
   (18 rollers at 90°), one sensor + reflector at the zone end above the rollers.
7. Supports: two legs (40×40) under the profiles, cross bar, foot plates; then move everything up so
   the foot plates stand on z = 0 (roller top 750 mm for 630 mm legs).
8. Colours: profiles/guides near black `#1e1e1e`, roller sleeves light grey `#d8d8d8`, axles and
   holders zinc `#b5b8bb`, ties and stands grey `#6b6e70`.

## From the SolidCraft part to a library part in a layout

1. Make the part functional in the asset editor: Drive (conveying speed; on a curve a rotational
   drive in °/s), `TransportSurface` with `Radial: true` on the curve — its node origin MUST be the
   curve centre (the recipe above builds it there), Sensor, `Snap-ZN-<type>` / `Snap-ZP-<type>` at the
   two ends. Materials from `web_query("editor.materialPresets", {})`.
2. Save it as a document anywhere in the project, e.g. `library/Interroll/RM8320-Kurve.glb`
   (`web_editor_save`). It is a placeable PROJECT part right away: `web_query("library.catalogList", {"source":"project"})`
   lists it with its `documentId` as `catalogId` — the id `layout.place` takes. Renaming or moving
   it with `document.rename` / `document.move` through `web_execute` keeps it placeable (the id does
   not change).
3. Planner: `layout.place` the first curve, then `layout.snapAttach(targetId, catalogId)` on its free
   output snap — the project part is accepted like a catalog part. Four 90° curves close a ring; an MU
   is handed from curve to curve at the seams (the selection gizmo shows each curve's sector and its
   rotation direction). **Snap ports must lie exactly on the radial end planes through the curve centre**
   (`Snap-ZN` at (r_mid, h, 0), not 1 mm outside): a port 1 mm off leaves a 2 mm gap per seam, the four
   curve centres no longer coincide and an MU on scene-authored curves walks ~1.8 mm per lap. Placed
   library curves ease their MUs onto the mid radius (like a straight library belt onto its centre line),
   which hides small offsets but not a wrong curve centre.
   To put an MU on a curve: `layout.place(catalogId, 0,0,0, onto=<curve id>)` — it lands on the mid radius
   in the middle of the arc, turned along the tangent (`ry` overrides the yaw).
4. Parts of the standard library (CartonBox, pallets): `web_execute("library.attach", {"projectId":"prj_realvirtual_library"})`
   once per project, then they appear in `web_query("library.catalogList", {})` with `source: "library"`
   and `libraryProjectId: "prj_realvirtual_library"` (document ids like `pallethandling-cartonbox`).
