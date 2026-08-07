# Asset Editor — kinematize & materialize CAD

The editor edits ONE GLB asset document. Everything is op-logged: every `web_editor_*` change
is undoable (`web_editor_undo`) and visible live in the Quick Edit / Materials panels.
Save writes into `<workfolder>/library/Custom/`. Editor tools error with
"Not in editor mode" until `web_editor_open` succeeds.

Core loop: **open → perceive → act → verify → save**.

## 1. Open

- `web_editor_open source=library relPath="Custom/MyAsset.glb"` — edit a library asset
- `web_editor_open source=empty` then `web_editor_import_cad` (STEP/JT, private builds) or
  `web_editor_import_glb` — start from a CAD file in the work folder
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

`web_editor_save name=...` — GLB + thumbnail into `library/Custom/` (same name overwrites).
Then `web_editor_close`, reload the asset live and jog real drives (`web_drive_jog`) as the
final smoke test.

## Signals & logic (optional)

`web_editor_add_signal` (PLCInput/Output Bool/Int/Float child nodes), `web_editor_convert_signal`,
`web_editor_toggle_signal_direction`, `web_editor_add_logic_step` (unknown type returns the palette).
