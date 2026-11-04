# Building a parametric part family from a catalogue page

Single source of truth for turning a manufacturer's catalogue page into a **part family**: one
GLB that carries the base parts, a parameter schema and a small JavaScript rule part, so a
receiver can make new variants without SolidCraft, CONNECT or a viewer build. Served verbatim by
`web_help("parametric")`. Written for plan-650 Phase 6 (pilots Interroll RM 8110 straight and
RM 8120 curve); the reference rules are `examples/parametric/rm8110.js`, `rm8120.js` and
`aluprofile.js`. A rule appears here only when no tool can enforce it.

> Dotted names like `editor.createEmpty` / `layout.setParams` are registry commands: run them with
> `web_execute(command="<id>", args={…})` (or `web_batch`).

## The idea in four lines

- SolidCraft builds the **base design once**: every distinct part exactly once (profile, roller,
  guide, strip, …). After that SolidCraft is not needed any more.
- The rule part `generate(values, parts)` maps the parameters onto four operations only:
  **duplicate**, **stretch** (plane-cut shift), **bend** (straight → arc) and **set** (position,
  rotation). It also emits the simulation parts: snap ports, `Drive`, `TransportSurface`.
- The rule part runs in a sandbox as a pure function with hard budgets; the result is baked.
- Values live per placement; equal values share one baked variant.

## Step 0 — The tools must be in the session

You need the realvirtual CONNECT tools (`web_*`) and, for Step 2, the SolidCraft MCP tools
(`batch`, `execute`, `measure`, …). If either is missing, **stop and tell the user** — do not
improvise another transport. Without SolidCraft you can still do Steps 4–7 on an existing base
design.

## Step 1 — Read the catalogue page and write the numbers down

Render the page (dimension drawing **and** product photo) and extract the values before modelling.
Write them into the family's knowledge note (`web_query("editor.projectInfo", {})` → `knowledgeRelPath`) with
the page as `_source`. The pilots:

| Module | Parameters (schema) | Fixed values |
|--------|---------------------|--------------|
| RM 8110 straight (p. 14–15) | BF ∈ {420, 620, 840}, P ∈ {60, 90, 120, 150}, ML 500–4320, HSG 35–80 | roller Ø, profile section, guide section |
| RM 8120 curve (p. 16–17) | Angle ∈ {30, 45, 60, 90}°, BF ∈ {420, 620, 840}, HSG 35–80 | r_i 825 mm, P_i ≈ 72 mm, P_a ≈ 0.087 · BF + P_i |
| Aluminium profile | L 60–6000 | section 40 × 40 |

## Step 2 — The base design in SolidCraft

One design per family. Rules the rule part relies on (the example headers repeat them):

1. **Each part exactly once, named exactly** as the rule part expects (`Profile`, `Roller`,
   `Guide`, `Strip`, optional `Holder`; the curve uses `Roller420` / `Roller620` / `Roller840`).
   The bodies must be **direct children** of the sync root — no SolidCraft components around them
   here (each direct child of the parts root is one part).
2. **Axes: X = conveying direction, Y = across, Z = up, millimetres.** Feet / lowest point on
   z = 0 — the rule part keeps every height as authored and only moves parts in X/Y (guides follow
   HSG).
3. **Straight parts run along +X and start at x = 0.** Rollers run along +Y from y = 0 (a conical
   roller has its small end at y = 0). The rule part positions every part from its bounds, so the
   X/Y location in the design does not matter.
4. **Stretch contract:** a stretched part is cut by a plane in its middle. Every face that crosses
   that plane must contain the stretch axis (a prismatic profile does; a hole, a chamfer or a
   thread across the middle does not → `stretch-plane-invalid`). Keep end features in the end
   regions. Shortening stops before the nearest vertex beyond the plane, so the shortest length is
   half the base length plus the end region.
5. **Curve parts shorter than the shortest arc.** Profiles, guides and the strip of the curve are
   stretched to the arc length and then bent; the inner profile at 30° is ≈ 430 mm, so build them
   300 mm long. Straight parts of RM 8110 are 1000 mm (ML ≥ 500).
6. **The strip** is a thin plate (1–2 mm) on top of the rollers, 420 mm wide. It carries `Drive`
   and `TransportSurface` in the variant; do not name it `Transport-X/Y/Z` or `Sensor*` (those
   names trigger WEB naming conventions).
7. Colours per body (`appearance.assign`); pattern copies are not needed — the rule part duplicates.

Check with `measure` / `inspect_design` before going on. `web_help("solidcraft")` has the sync
rules (floor, axes, colours).

## Step 3 — Bring the base design into the asset editor

1. `web_editor_open(source="new")` → `solidcraft.connect` → `solidcraft.resync`.
2. The body count of the resync must equal SolidCraft's (`inspect_design`). Fewer → read
   `web_errors`.
3. `web_node_tree(depth=3, includeBounds=true)`: one node per base part directly below
   `SolidCraft_<design>`, min height 0.

## Step 4 — Define the family

1. `editor.createEmpty` a family node (e.g. `RM8110`) at the document root and `editor.reparent`
   the sync root `SolidCraft_<design>` under it. The family node is what layouts place; the sync
   root keeps its SolidCraft ids, so a later resync replaces the base parts.
2. `web_editor_parametric_define(path="RM8110", paramsJson=<PARAMS of the example>,
   code=<the whole example file>, partsRoot="SolidCraft_<design>")`. The example's `PARAMS` array
   is the schema; the file is the code (top-level constants are fine). This writes the component
   and builds the first variant under `_Generated` as one undo step.
3. A new family: copy the closest example and change only the rules. Keep to the contract below.

## Step 5 — Verify every catalogue corner

1. `web_editor_parametric_inspect(path)` — no error, `upToDate: true`, the parts list shows every
   base part with plausible `boundsMm`.
2. `web_editor_parametric_set(path, valuesJson)` through the corners (smallest/largest BF, ML, P;
   every curve angle). Each call is one undo step; an error leaves the old variant in place and
   names the cause.
3. Check the variant: `web_node_bounds` of `_Generated/Profile_L` (length = ML), roller count,
   snap positions (`Snap-XP-convroll` at x = ML, 0.1 mm), and look at it (`web_screenshot`).
   Select nothing before the screenshot.
4. Reset to the catalogue default before saving — the default variant is what loads without
   running any code.

## Step 6 — Save into the project library

`web_editor_save`. The GLB is the family: base parts, schema, rules and the baked default variant
in one file. Hand it on as that one file (share export bundles child families, plan-650 Phase 5b).

## Step 7 — Use it in a second project

1. Open another project, `layout.place` the family twice.
2. `layout.setParams` on one placement (e.g. `{"BF":620,"ML":3240,"P":120}`) — one undo step;
   equal values on two placements share one baked variant.
3. Connect modules with `web_query("layout.snapSuggest", {"targetId":"conveyor-1"})` / `layout.snapAttach` (RM 8110 → RM 8120 90° →
   RM 8110 makes a line with a 90° turn).
4. Run the simulation with a library MU (e.g. `CartonBox`) and watch it cross the modules
   (`web_query("transport.status", {})`). Parameters cannot change while the simulation runs — a change is
   applied at the next stop.

## The rule part contract

```js
var PARAMS = [{ Name, Label?, Type: 'number'|'int'|'bool'|'enum', Unit?: 'mm'|'deg'|'', Min?, Max?, Step?, Enum?, Default }];
function generate(values, parts) {         // values normalized; parts = [{ name, boundsMm: { min, max } }]
  return {
    instances: [{ part, name?, parent?, positionMm: [x,y,z], rotationDeg?: [x,y,z],
                  stretch?: [{ axis, atMm, byMm }],                   // in part-local mm, applied in order
                  bend?: { axis, radiusMm, centerSide: '+'|'-', pivot?: 'start'|'center' } }],
    nodes?: [{ name, parent?, positionMm, rotationDeg? }],                // empty nodes: Snap-*, markers
    components?: [{ node, type, fields }],                              // on instance or node names
    children?: [{ family, values, positionMm, rotationDeg? }],          // nested families (declared in Uses)
    messages?: [{ level: 'info'|'warning', text }],
  };
}
```

- **Pure:** no `Date`, no `Math.random`, no host functions, no signals. Same values → same plan.
- **Budgets:** 400 interrupt ticks, 16 MB, 5000 instances, 2000 nodes, 500 components, 2 M
  generated vertices, 16 stretches per instance. Exceeding one is a visible error, the old variant
  stays.
- **Positions** are in the frame of the parts root (SolidCraft axes, mm); the family converts
  once (−90° about X, 0.001).
- **Hierarchy with `parent`:** an instance or node may name another **explicitly named**
  instance/node (`name` is required on the target; default names `<part>_<n>` are no target) as
  its `parent`. With `parent`, `positionMm`/`rotationDeg` are **local to the parent** (like
  Three.js/Unity: parent matrix times local), without `parent` they stay in the parts-root
  frame. Plan order does not matter. Errors: `unknown-parent`, `parent-cycle`, `parent-depth`
  (more than 16 hops); the old variant stays. A mesh instance can be a parent too.
  Axis chain example (a drive moves its node, children follow):
  ```js
  nodes: [{ name: 'AxisX', positionMm: [0, 0, 2000] },
          { name: 'AxisY', parent: 'AxisX', positionMm: [0, 0, 0] },
          { name: 'AxisZ', parent: 'AxisY', positionMm: [0, 0, 0] }],
  instances: [{ part: 'Gripper', name: 'Gripper', parent: 'AxisZ', positionMm: [0, 0, -300] }],
  components: [{ node: 'AxisX', type: 'Drive', fields: { Direction: 'LinearX', UseLimits: true } }]
  ```
- **Names and node ids:** every explicitly named instance/node gets the fixed NodeId
  `<familyNodeId>:_Generated:<name>` (stable across regenerations, so overrides on it survive).
  Names must not contain `/` or `#` and must not be `_Children` (`invalid-name`); the family node
  needs a NodeId (`family-no-identity` otherwise).
- **References to generated nodes:** a component field of type ComponentReference (e.g.
  `Grip.PartToGrip`) takes the **name** of an explicitly named node (`PartToGrip: 'GripSensor'`);
  the assembly stores it as `{ type:'ComponentReference', address:'#<fam>:_Generated:GripSensor', componentType }`.
  An unknown name or any other raw string is `component-invalid`.
- **Bend:** the bend plane is `axis` plus a fixed transverse axis (x → y, y → x, z → x); stretch
  runs before bend. `pivot: 'center'` puts the arc centre at the instance origin — needed for a
  `Radial` `TransportSurface`, which turns about its node origin.
- **Components** are validated against the schema: unknown types or fields, signal slots and a
  nested `ParametricComponent` are refused. `TransportDirection` is in Unity coordinates (X
  negated): `{x:-1,y:0,z:0}` = local +X. A vertical rotation on these nodes is `RotationZ`.
- **Snaps** are `Snap-<AXIS><FLOW>-<TYPEID>` (`convroll` for roller conveyors). The outward
  direction is cardinal: the axis letter picks the axis (viewer frame: SolidCraft Y is viewer Z),
  the sign comes from the position relative to the family origin, and from the flow letter when
  that coordinate is 0. Put the input at the origin side (`XN` at x = 0).

## Known limits

- Curve angles 30/45/60°: the exit snap can only point along a cardinal axis, so snapping a
  straight module to it is approximate. 90° is exact.
- The SolidCraft design is not embedded in the family yet (`DesignResource` is open); keep the
  `.solidcraft` file next to the project to change the base parts later.
