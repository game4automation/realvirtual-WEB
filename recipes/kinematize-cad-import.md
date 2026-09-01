# Kinematize and materialize a CAD import

## Goal and outcome

Turn a raw CAD assembly in the asset editor into a working kinematic model: every moving axis has
a Drive that has been *seen* to move the right parts in the right direction, the machine can be
shown and hidden in sensible groups where that is useful, and the materials look like real
industrial hardware instead of flat grey.

## When to use

Use this recipe when a STEP, JT or GLB assembly is to be kinematized in the asset editor and
consists of numbered CAD nodes with no semantics. It suits a person working through the editor
panels as well as an AI assistant working through the `web_*` MCP tools; tool names are given
because the assistant path is the faster one.

## Prerequisites

- The workspace is running (`start.ps1`, Linux `./start.sh`) and realvirtual CONNECT is reachable
  at http://localhost:5100.
- Write access is enabled in CONNECT. Read-only tools work without it; every authoring step needs it.
- A writable project is open, and the document to work in **already exists**. Documents are
  created in the **project dashboard** and then entered — never from inside the editor.

## Two invariants

These hold through every step below:

- **Never rename a CAD node.** The CAD names are the link back to the CAD system and to any
  drawing or BOM the customer holds. Functional naming lives in your report, not in the scene.
- **The kinematic model is a separate layer on top of the CAD tree.** `web_editor_kinematize`
  creates a *new* axis node carrying the `Kinematic` and `Drive` components; the CAD parts stay
  exactly where the import put them and merely receive a `Group` membership naming their axis.
  Never move a CAD part in the hierarchy — membership is assignment, not reparenting, so do not
  go looking for members under the axis node afterwards.

## Steps

### 0. Orient, and read what the tools tell you

The MCP surface is self-describing. Two habits apply to every step below:

- **Orient with `web_describe`, not by assembling status calls.** One read-only call answers
  *where am I* (mode, open document with `nodeCount`/`opCount`/`busy`/`dirty`, selection,
  runtime), *what is blocked* (each gated tool family with the exact call that unblocks it) and
  *what next* (one recommended call). Use it at the start of the session and whenever you are
  unsure what state the session is in. It moves neither selection, panels nor camera.
- **Read the `verified` block on every writing call.** Every tool that persists state appends it:
  - `verified: { noop: true }` — the tool reported success and the probe observed **no change**.
    Treat it as a failure the tool did not notice, never as success.
  - `verified: { changed: [...] }` — for editor tools this counts op kinds, and the kinds carry
    the meaning: after a group assignment, `setField×1` alone means the group was merely *named*,
    while member ops mean parts actually joined it.
  - `verified: { ambiguous: true }` — two calls overlapped on the same scope; re-check with a
    read tool instead of assuming.

  The delta proves an op landed in the document; only `web_editor_verify_drive` proves the
  motion is *right*.

### 1. Enter the document and confirm the starting point

The document was created in the project dashboard. Enter it, then confirm with `web_describe` /
`web_editor_status` that you are in the **right** one:

- `active: true` — you are in editor mode. If not, stop and say so; nothing below works otherwise.
- `nodeCount` — must be roughly the part count of your CAD, not the size of some other scene.
  This is the one number that tells you whether you are authoring your part or quietly editing
  somebody else's document.
- `opCount` — **zero means a blank import; non-zero means someone has already worked on this
  document.** Do not assume you are starting from scratch — reconcile what exists with what you
  are about to do before changing anything.

If the CAD is not yet imported, import it and re-check `nodeCount`:

```
web_editor_import_cad relPath=cad/<file>.stp
web_editor_status                     # nodeCount ~ part count
```

### 2. Check the orientation, then put it on the ground

In this order — a tipped model makes every later ground and height judgement wrong:

1. **Look at it.** Take a screenshot and check the up-axis visually: is the machine standing the
   way it stands in reality? CAD exports arrive Z-up, sideways or upside down often enough that
   this is a real check, not a formality.
2. **Rotate if it is wrong** (`web_editor_transform` with `rx/ry/rz` on the import root) until
   the machine stands upright, and confirm with another screenshot.
3. **Then to-ground.** Check `web_node_bounds` on the import root: `min[1]` (world Y minimum)
   should be `0` (standing on the floor) or positive (hanging machines exist). A clearly negative
   `min[1]` means the model is sunk into the floor:

   ```
   web_editor_to_ground path=<import root>    # rests the bounding box on Y = 0
   ```

   Genuine exceptions exist — a pit conveyor, a below-floor chip auger — so this is a check with
   a judgement, not an automatic correction. What is never right is a machine floating a metre in
   the air or buried to its waist because nobody looked.

### 3. Understand the machine

**Do not kinematize what you cannot describe.** The goal of this step is to be able to say what
the machine does and which parts move — nothing more. No files are written.

- **Look at it.** `web_screenshot` from a few angles; `web_render mode=idmask groupBy=hierarchy`
  returns a segmentation image plus a colour→path legend, so one picture tells you which subtree
  owns which pixels regardless of node names. Never classify a part from its bounding box alone.
- **Read the structure.** One `web_scene_query` returns a snapshot of every node — path, name,
  depth, components, mesh/triangle counts, bounds, material — and runs your JavaScript over it.
  That is enough to find the major subassemblies and the repeated parts.
- **If the user has provided knowledge documents** (datasheets, drawings, notes), read them —
  human-authored content outranks anything you infer from geometry. Do not go hunting for
  documents that were not offered.

The output is a working mental model: what the machine does, which subassemblies move, and a
candidate list of axes. State it briefly before building anything.

### 4. Build the axes

For each axis:

1. **Create the axis with its member parts:**

   ```
   web_editor_kinematize paths=<parts> groupName=AxisLeft_Z direction=LinearZ
                         speed=500 lowerLimit=-400 upperLimit=0 startPosition=0
   ```

   Keep the path list small (batches of roughly eight paths) — larger batches have been observed
   to leave the editor busy — and read each call's `verified` block before sending the next:
   `noop: true`, or `changed` showing only `setField` ops, means the axis was *named* but no
   members joined it.

2. **Fix the pivot of a rotary axis.** `kinematize` centres the pivot on the group's bounding
   box, which is right for a linear axis and usually wrong for a rotary one — a rotation belongs
   on the rotation centre. Look in the scene for a **representative part that sits on the
   rotation axis** — a shaft, a flange, a bearing — and put the pivot on it:

   ```
   web_editor_pivot mode=object_center targetPath=<representative part>
   ```

3. **Set the limits from geometry.** Profile length minus slider length gives the mechanical
   stroke; check where the payload sits at both ends. State that as the mechanical maximum and
   say plainly that the *functional* stroke needs process knowledge the CAD does not contain.

4. **Prove it visually. This is not optional.** `web_editor_verify_drive` selects the axis,
   frames it, drags the drive through its range while capturing poses, and returns one labelled
   montage. Read it for the four failure modes:

   - parts translating where they should rotate → wrong `Direction`
   - parts orbiting instead of spinning → wrong pivot
   - parts staying behind → missing members
   - end positions leaving the guide → wrong limits

   Iterate — pivot, direction, membership — until the sweep is right. **Never record an axis as
   working that you have not watched move.**

### 5. Add show/hide groups — only if the machine needs them

Decide first, and say which way you decided: does this machine have enclosure panels, covers or
modules a user would genuinely want to toggle? Many do not. If not, skip this step.

If it does, add a `Group` component to those nodes:

```
web_editor_add_component path=<node> type=Group propsJson={"GroupName":"TopCover"}
```

Keep it coarse — **three to eight groups**. Enclosure and covers first, because that is what a
user hides first; then base and frame; then one group per functional module someone would
isolate. If you cannot name a reason someone would hide it, do not group it.

### 6. Assign materials

Materials come **last**, once the axes are proven — appearance work on a model whose structure is
still changing is work done twice.

CAD imports arrive with every material at `metalness: 1, roughness: 1`, which is why they look
flat and grey. Fixing this is the single biggest visual improvement available.

1. `web_editor_material_stats` — appearance groups with stable keys, sorted by mesh count.
2. `web_editor_material_presets` — the available library.
3. `web_editor_materialize` with an `assignmentsJson` array — one call, one undo step, keyed by
   the group key.

Prefer internal presets (`steel`, `brushed-alu`, `stainless`, `anodized`, `galvanized`,
`plastic-black/white/grey/blue`, `rubber`, `ral-*`) over custom PBR values. The CAD colour
usually carries meaning — blue fittings, orange terminal levers — so pick the preset closest in
hue rather than flattening everything to grey. The `Signal *` presets are emissive and belong on
LEDs and indicators only. For enclosure panels use `guard`, or a custom glass value at low
opacity (0.1–0.25) so the machine stays visible behind it.

### 7. Hand back

**Do not save.** The document stays dirty and the person who asked for the work decides whether
it becomes an asset. Report concretely: what was built, how each axis was verified, and what
still needs process knowledge — travel limits, transfer positions and cycle order are frequently
**not** derivable from CAD. Never present an assumption as a verified fact.

## Acceptance criteria

- Every axis has been through `web_editor_verify_drive` and moves the correct parts in the
  correct direction, with both end positions inside the mechanical guide.
- No CAD node was renamed, and no CAD part was moved in the hierarchy.
- No mesh remains at the imported default appearance.
- The document is **not** saved.

## Rollback

Nothing is written to the asset on disk, so there is nothing to undo there. Inside the session,
`web_editor_undo` reverses any number of operations and `web_editor_status` reports how many are
available. Abandoning the editor without saving discards every change.

## Common problems

- **You are not sure what state the session is in.** `web_describe` — one read-only call for
  mode, document, selection, what is blocked and the recommended next step.
- **`web_editor_assign_to_kinematic` reports `ok: true` but nothing was assigned.** It cannot
  fail: unresolvable paths, nodes already in the group, and kinematic axis nodes are all skipped
  silently. Never trust the `ok` flag — the result's `verified` block is the truth; cross-check
  with the returned `members` count or `web_editor_list_kinematics`.
- **A field you set has no effect.** `web_editor_set_field` does not validate field names and
  silently *creates* an unknown one, reporting success. Only use field names you have seen in the
  output of an existing component; never use it to probe for a field that might exist.
- **`web_editor_verify_drive` timed out, and the axis is now stuck off its home pose.** The sweep
  moves the parts through the drive-drag *preview*, not through an op — so `web_editor_undo` will
  **not** put them back, and the displaced pose is what a save would write. Only a verify run
  that reaches its `finally` restores it (`restored: true` in the result is the proof). Re-run
  `verify_drive` once the tab is in the foreground, or undo the axis construction entirely and
  rebuild it.
- **A component you just added appears to be missing.** `web_component_get` and
  `web_component_list` read the running scene, not the editor document. Editor-authored
  components appear there only after the asset is saved and loaded — which this recipe does not do.
- **The editor stays busy after a large call.** Keep `kinematize` batches to roughly eight paths.
- **Every tool answers `Not in editor mode`.** The editor closed. Nothing in this recipe works
  outside it.

## Security and version notes

CAD assemblies and the names inside them frequently disclose suppliers, part numbers and machine
capability. When an AI assistant is used, everything it reads is processed by the selected
provider — share only what that provider is permitted to process.

## Further reading

- [realvirtual WEB overview](../realvirtual-web/doc-webviewer.md)
- [MCP tool reference](../realvirtual-web/webviewer.mcp.md)
- [Unity-to-WEB workflow](../realvirtual-web/doc-unity-to-web.md)
- [Troubleshoot the runtime](troubleshoot-runtime.md)
