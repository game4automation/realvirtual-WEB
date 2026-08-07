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
- A work folder is configured, because the knowledge folder lives inside it.

## Steps

### 1. Confirm the starting point

`web_editor_status`. Three fields decide how you proceed:

- `active: true` — you are in editor mode. If not, stop and say so; nothing below works otherwise.
- `nodeCount` — greater than zero, or there is nothing imported to work on.
- `opCount` — **zero means a blank import; non-zero means someone has already worked on this
  document.** Do not assume you are starting from scratch. Read the knowledge folder in step 2
  before changing anything, and reconcile what you find with what is actually in the scene.

### 2. Build or ingest the knowledge base

`web_editor_workfolder_info` returns the work folder name, the asset's library-relative path when
it has one, and `knowledgeRelPath` — conventionally `knowledge/<AssetName>`.

**Resolve the absolute path once per machine.** The browser exposes no filesystem path
(`absolutePath` is always `null`), so search the machine for a directory named `workFolderName`
that contains a `library/` folder, confirm the hit with the user, and record it at the top of
`knowledge.md`. Later sessions read it from there. The work folder usually sits outside the
workspace, so your assistant may need that directory added to its allowed paths before it can read
files there.

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

3. **Get the rotation axis right.** `Direction` (`RotationX|Y|Z`) is a **local** axis of the
   kinematic node, while `web_node_shape` reports the functional axis as a **world** vector. Compare
   them using the `worldQuaternion` from `web_node_bounds`. When the functional axis does not line up
   with a cardinal local axis, rotate the axis node itself (`web_editor_transform` with `rx/ry/rz`)
   until it does, then set `Direction`. Choosing a Direction without checking this mapping is the
   single most common way to build an axis that spins about the wrong line.

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
- **A component you just added appears to be missing.** `web_component_get` and `web_component_list`
  read the running scene, not the editor document. Editor-authored components appear there only
  after the asset is saved and loaded — which this recipe does not do.
- **The machine is invisible or obscured.** Editor visibility is authored state. A cover someone hid
  stays hidden; prefer transparent over hidden.
- **The editor stays busy after a large call.** Keep `kinematize` and `reparent` batches to roughly
  eight paths.
- **`savePath` returns `saveError`.** The work folder is picked read-only, so the first write asks
  for permission; a denied prompt reports here rather than failing silently. Grant it and retry,
  and do not reference an image whose write you did not see succeed.
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
