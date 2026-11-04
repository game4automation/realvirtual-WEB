---
name: realvirtual-web-modeling
description: Use when building or changing a realvirtual WEB asset through the CONNECT MCP tools — kinematizing raw CAD, adding drives, sensors, signals and component references in the asset editor, recording the work as a macro. Covers the command interface (web_commands / web_execute / web_batch) and the traps that silently produce a wrong model.
---

# realvirtual WEB — modeling an asset

Everything here runs through the CONNECT MCP server (`web_*` tools). Start every session with
`web_status`: it says whether a viewer is connected and, if not, what to do.

## Workflow

1. **Orient:** `web_status`, then `web_describe` and `web_help("kinematize")` for a raw CAD model.
2. **Open the right document.**
   <!-- fact:new-asset-empty-first -->
   - A **new** asset: first `web_document_open("empty")`, then `web_editor_open` with `source: "new"`.
     Opening the editor on top of a loaded, baked scene pulls that scene into the new document.
   - An **existing** asset: `web_editor_open` with `source: "library"` and its `relPath`.
3. **Change the model through commands.** `web_commands` lists every command (id, `argsSchema`,
   `readOnly`, `macro`). Run one with `web_execute`, several in order with `web_batch` — the same rule,
   refusal and undo step as the editor button. Examples:
   - `web_execute("editor.createKinematic", {...})`, `web_execute("editor.assignToKinematic", {...})`
   - `web_execute("editor.addComponent", {...})`, `web_execute("editor.setField", {...})`
   - `web_execute("editor.transform", {...})`
4. <!-- fact:save-after-each-step -->
   **Save after every step** with `web_editor_save`. Nothing else writes the GLB; a crashed tab or a
   reload loses everything since the last save.
5. **Check geometry, do not guess it:** `web_check_gap` / `web_check_contact` (mesh-exact, also in a
   pose of drive positions), `web_node_shape` for the functional axis.
6. **Record it:** `web_macro_record_start` → work with `_reason` / `_source` on each command →
   `web_macro_assert` for the geometry you relied on → `web_macro_record_stop` → `web_macro_save`.

## Traps

<!-- fact:linearx-minus-x -->
- **LinearX moves along −X in the viewer.** A drive with direction `LinearX` moves along glTF −X
  (`RotationY` and `RotationZ` are negated too). Do not "fix" the sign of a working drive because a
  hand calculation with +X disagrees — measure with `web_node_bounds` before and after a jog.

<!-- fact:componentref-object-form -->
- **Component references only in object form.** A reference field takes
  `{"type": "ComponentReference", "path": "Cell/Drive"}`. A bare path string is not a reference: it is
  dropped without an error and the component (for example a LogicStep) runs without its drive.

<!-- fact:rv-extras-unity-vectors -->
- **Vectors in rv extras are Unity convention.** Fields marked as Unity coordinates are read with X
  negated. When you write such a vector by script, mirror X; when you read it back through the tools,
  you get viewer coordinates.

## When a call answers `running: true`

The tool is still executing in the browser. **Do not resend it.** Call `web_call_pending` with the
`callId` until it reports `done`, `error`, `expired` or `cancelled`.
