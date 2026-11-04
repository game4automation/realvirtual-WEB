 — **3b:** green unchanged; the address input/output contract is pinned in `tests/mcp-path-contract.test.ts` (9.18) | — **3b:** green unchanged (binding key stays path-based in memory, D15) | — **3b:** green unchanged | — **3b:** green unchanged | — **3b:** green unchanged (in-memory mappings keep `componentPath`; stored form converted on persist) | — **3b:** (3b, besides its Phase-4 row) category 6: connection ends are stored as `{ address }` and name the same two nodes after reload | — **3b:** the draft GLB stores `componentAddress` (no `componentPath`); the read-back mapping equals the applied one, the replay still binds | — **3a done:** green unchanged; address-form signal refs are read by `readStoredRef` (`signalReferenceHit`) | — **3a done:** green unchanged — the planner skips address-form refs (rename/move needs no rewrite for them) | — **3a done:** (3a, besides its Phase-4 row) reload count: the reloaded file stores addresses, the name-space guard counts 0 references; audit 3/0 unchanged | — **3a done:** asserts `{type, componentType, address}` and that the address names the renamed signal node |# plan-769 — test migration list

Every test file that touches stored references or overrides at HEAD
(`rg -a -l "byPath|trsByNodeId|byNodeId|ComponentReference" tests`, 2026-10-21:
122 files, plan-769's own new Phase-0 files excluded), with the phase that changes
it, why, and what the change is meant to be.

Rule for every row: **behaviour stays, mechanism may go.** A test that asserts
WHICH node a reference reaches keeps that assertion through every phase; a test
that asserts HOW it got there (a stored `path` string, a rewrite step, a rate
stage, a `byPath` key, `trsByNodeId`) is rewritten to the new mechanism or
deleted with it. Record the assertion count before/after per file in the
phase's commit (plan § 5.4).

Classification is by content markers (first match wins):

| Marker in the file | Phase | Meaning |
|---|---|---|
| `trsByNodeId` | 4 | mechanism removed (F14, D11) |
| `byPath` / `byNodeId` | 4 | overrides become `byAddress` (F13) |
| ComponentReference + save / export / bake / reload | 3 | written form becomes `{address}` (F1, F17) |
| ComponentReference + rewrite / alias / fallback stage | 1 | stored refs stop using stages (F3, D15); input cases move to `findNodeForUser` |
| ComponentReference + `componentPath` / `SignalMapping` | 3 | `componentAddress` / `sourceAddress` (F15) |
| ComponentReference only | 1 | resolution through `resolveRef` (F6) |

The phase executor that touches a file re-checks its row (a marker can be
incidental); a row moved to another phase is edited here in the same commit.

<!-- 122 files; per phase {"1":65,"3":24,"4":33} -->
| Test file | Phase | Why it is affected | Intended change |
|---|---|---|---|
| `tests/_inline-slot-fixture.ts` | 1 | ComponentReference resolved at load | behaviour stays (same node); resolution goes through `resolveRef` (`resolvedVia: address` after migration) |
| `tests/_mechanism-path-rig.ts` | 1 | ComponentReference resolved at load | behaviour stays (same node); resolution goes through `resolveRef` (`resolvedVia: address` after migration) |
| `tests/apply-mappings-drop-visibility.test.ts` | 3 | ComponentReference + signal mapping (`componentPath`) | behaviour stays; `SignalMapping.componentAddress` / `sourceAddress` written, MCP output keeps `componentPath` (9.17/9.18) |
| `tests/asset-export-keeps-references.test.ts` | 4 | asserts AssetOverrides `byNodeId` | behaviour stays (the override lands on the same node); key form becomes `byAddress` (`byNodeId` read as `"#id"`, `byPath` migrated on read, 9.22) |
| `tests/badge-tooltip.test.tsx` | 1 | ComponentReference resolved at load | behaviour stays (same node); resolution goes through `resolveRef` (`resolvedVia: address` after migration) |
| `tests/bake-instantiate-whole-template.test.ts` | 1 | ComponentReference resolved through rewrite / alias / fallback stages | mechanism goes for STORED refs (no rate stage, no rewrite needed — 9.2/9.3); keep the assertion as a path-INPUT case (`findNodeForUser`, until plan-770) where it tests MCP/UI input |
| `tests/bake-lifecycle-races.test.ts` | 4 | asserts `trsByNodeId` (part move inside a placement) | mechanism goes: `trsByNodeId` removed, part move refused (`nested-transform-refused`); old files load with a problem (9.10) |
| `tests/bind-reload-lamp-draft.test.ts` | 3 | ComponentReference in a written file (save / export / bake / reload) | behaviour stays (reload binds the same node); written form becomes `{address}` — assert the target node, not the stored `path` string |
| `tests/binding-applied-pulse.test.tsx` | 3 | ComponentReference in a written file (save / export / bake / reload) | behaviour stays (reload binds the same node); written form becomes `{address}` — assert the target node, not the stored `path` string |
| `tests/bindings-overview-panel.test.tsx` | 3 | ComponentReference in a written file (save / export / bake / reload) | behaviour stays (reload binds the same node); written form becomes `{address}` — assert the target node, not the stored `path` string |
| `tests/chain-fixture.ts` | 1 | ComponentReference resolved at load | behaviour stays (same node); resolution goes through `resolveRef` (`resolvedVia: address` after migration) |
| `tests/chain-glb-fixture.test.ts` | 1 | ComponentReference resolved at load | behaviour stays (same node); resolution goes through `resolveRef` (`resolvedVia: address` after migration) |
| `tests/component-schema-rules-sync.test.ts` | 1 | ComponentReference resolved at load | behaviour stays (same node); resolution goes through `resolveRef` (`resolvedVia: address` after migration) |
| `tests/connect-embed-demo-model.node.test.ts` | 1 | ComponentReference resolved at load | behaviour stays (same node); resolution goes through `resolveRef` (`resolvedVia: address` after migration) |
| `tests/connection-mode.test.ts` | 3 | ComponentReference + signal mapping (`componentPath`) | behaviour stays; `SignalMapping.componentAddress` / `sourceAddress` written, MCP output keeps `componentPath` (9.17/9.18) |
| `tests/des/axis-ownership.test.ts` | 1 | ComponentReference resolved at load | behaviour stays (same node); resolution goes through `resolveRef` (`resolvedVia: address` after migration) |
| `tests/des/robot-handling-ik-tween.test.ts` | 1 | ComponentReference resolved at load | behaviour stays (same node); resolution goes through `resolveRef` (`resolvedVia: address` after migration) |
| `tests/descend-override-suppression.test.ts` | 4 | asserts AssetOverrides `byPath` + `byNodeId` | behaviour stays (the override lands on the same node); key form becomes `byAddress` (`byNodeId` read as `"#id"`, `byPath` migrated on read, 9.22) |
| `tests/document-stack-bar.test.tsx` | 4 | asserts AssetOverrides `byNodeId` | behaviour stays (the override lands on the same node); key form becomes `byAddress` (`byNodeId` read as `"#id"`, `byPath` migrated on read, 9.22) |
| `tests/drive-behavior-runtime-attach.test.ts` | 1 | ComponentReference resolved at load | behaviour stays (same node); resolution goes through `resolveRef` (`resolvedVia: address` after migration) |
| `tests/drive-destination-motor-autoprovision.test.ts` | 1 | ComponentReference resolved at load | behaviour stays (same node); resolution goes through `resolveRef` (`resolvedVia: address` after migration) |
| `tests/drive-follow-position-binding.test.ts` | 1 | ComponentReference resolved at load | behaviour stays (same node); resolution goes through `resolveRef` (`resolvedVia: address` after migration) |
| `tests/drive-gear.test.ts` | 1 | ComponentReference resolved at load | behaviour stays (same node); resolution goes through `resolveRef` (`resolvedVia: address` after migration) |
| `tests/drive-sew-movilink.test.ts` | 1 | ComponentReference resolved at load | behaviour stays (same node); resolution goes through `resolveRef` (`resolvedVia: address` after migration) |
| `tests/editor-save-authored-names.perf.test.ts` | 1 | ComponentReference resolved through rewrite / alias / fallback stages | mechanism goes for STORED refs (no rate stage, no rewrite needed — 9.2/9.3); keep the assertion as a path-INPUT case (`findNodeForUser`, until plan-770) where it tests MCP/UI input |
| `tests/editor-save-authored-names.test.ts` | 4 | asserts AssetOverrides `byPath` | behaviour stays (the override lands on the same node); key form becomes `byAddress` (`byNodeId` read as `"#id"`, `byPath` migrated on read, 9.22) |
| `tests/energy-chain-fixture.ts` | 1 | ComponentReference resolved at load | behaviour stays (same node); resolution goes through `resolveRef` (`resolvedVia: address` after migration) |
| `tests/energy-chain-glb-fixture.test.ts` | 1 | ComponentReference resolved at load | behaviour stays (same node); resolution goes through `resolveRef` (`resolvedVia: address` after migration) |
| `tests/field-unit-schema-ssot.test.ts` | 1 | ComponentReference resolved at load | behaviour stays (same node); resolution goes through `resolveRef` (`resolvedVia: address` after migration) |
| `tests/fixtures/drive-behavior-harness.ts` | 1 | ComponentReference resolved at load | behaviour stays (same node); resolution goes through `resolveRef` (`resolvedVia: address` after migration) — HELPER: shared fixture, fix once |
| `tests/fixtures/parity-fixtures.ts` | 1 | ComponentReference resolved at load | behaviour stays (same node); resolution goes through `resolveRef` (`resolvedVia: address` after migration) — HELPER: shared fixture, fix once |
| `tests/fleet/fleet-instance-scope.test.ts` | 3 | ComponentReference in a written file (save / export / bake / reload) | behaviour stays (reload binds the same node); written form becomes `{address}` — assert the target node, not the stored `path` string |
| `tests/fleet/fleet-scoped-id.test.ts` | 4 | asserts AssetOverrides `byPath` + `byNodeId` | behaviour stays (the override lands on the same node); key form becomes `byAddress` (`byNodeId` read as `"#id"`, `byPath` migrated on read, 9.22) |
| `tests/fmu-demo-model.build.test.ts` | 1 | ComponentReference resolved at load | behaviour stays (same node); resolution goes through `resolveRef` (`resolvedVia: address` after migration) |
| `tests/folder-backend-lazy-document-info.test.ts` | 4 | asserts AssetOverrides `byPath` | behaviour stays (the override lands on the same node); key form becomes `byAddress` (`byNodeId` read as `"#id"`, `byPath` migrated on read, 9.22) |
| `tests/glb-asset-reference.test.ts` | 4 | asserts AssetOverrides `byPath` + `byNodeId` | behaviour stays (the override lands on the same node); key form becomes `byAddress` (`byNodeId` read as `"#id"`, `byPath` migrated on read, 9.22) |
| `tests/glb-bake-roundtrip.test.ts` | 4 | asserts `trsByNodeId` (part move inside a placement) | mechanism goes: `trsByNodeId` removed, part move refused (`nested-transform-refused`); old files load with a problem (9.10) |
| `tests/glb-reference-resolve.test.ts` | 4 | asserts AssetOverrides `byPath` + `byNodeId` | behaviour stays (the override lands on the same node); key form becomes `byAddress` (`byNodeId` read as `"#id"`, `byPath` migrated on read, 9.22) |
| `tests/glb-web-diagnostics.test.ts` | 3 | ComponentReference in a written file (save / export / bake / reload) | behaviour stays (reload binds the same node); written form becomes `{address}` — assert the target node, not the stored `path` string |
| `tests/helpers/bake-survival.ts` | 1 | ComponentReference resolved at load | behaviour stays (same node); resolution goes through `resolveRef` (`resolvedVia: address` after migration) — HELPER: shared fixture, fix once |
| `tests/helpers/fmu-demo-scene.ts` | 3 | ComponentReference in a written file (save / export / bake / reload) | behaviour stays (reload binds the same node); written form becomes `{address}` — assert the target node, not the stored `path` string — HELPER: shared fixture, fix once |
| `tests/helpers/spike-610-ref-fixture.ts` | 1 | ComponentReference resolved at load | behaviour stays (same node); resolution goes through `resolveRef` (`resolvedVia: address` after migration) — HELPER: shared fixture, fix once |
| `tests/inspector-deprecated-field.test.ts` | 1 | ComponentReference resolved at load | behaviour stays (same node); resolution goes through `resolveRef` (`resolvedVia: address` after migration) |
| `tests/inspector-plc-bind-row.test.tsx` | 3 | ComponentReference + signal mapping (`componentPath`) | behaviour stays; `SignalMapping.componentAddress` / `sourceAddress` written, MCP output keeps `componentPath` (9.17/9.18) |
| `tests/inspector-reference-and-color.test.ts` | 1 | ComponentReference resolved at load | behaviour stays (same node); resolution goes through `resolveRef` (`resolvedVia: address` after migration) |
| `tests/instance-scope.test.ts` | 1 | ComponentReference resolved at load | behaviour stays (same node); resolution goes through `resolveRef` (`resolvedVia: address` after migration) |
| `tests/layout-reload-shared-bake.test.ts` | 4 | asserts `trsByNodeId` (part move inside a placement) | mechanism goes: `trsByNodeId` removed, part move refused (`nested-transform-refused`); old files load with a problem (9.10) |
| `tests/logic-root-active-only.test.ts` | 1 | ComponentReference resolved at load | behaviour stays (same node); resolution goes through `resolveRef` (`resolvedVia: address` after migration) |
| `tests/logic-signal-edge.test.ts` | 1 | ComponentReference resolved at load | behaviour stays (same node); resolution goes through `resolveRef` (`resolvedVia: address` after migration) |
| `tests/mcp-component-schema-tool.test.ts` | 1 | ComponentReference resolved at load | behaviour stays (same node); resolution goes through `resolveRef` (`resolvedVia: address` after migration) |
| `tests/mcp-document-info-tools.test.ts` | 4 | asserts AssetOverrides `byPath` | behaviour stays (the override lands on the same node); key form becomes `byAddress` (`byNodeId` read as `"#id"`, `byPath` migrated on read, 9.22) |
| `tests/mcp-knowledge-tools.test.ts` | 4 | asserts AssetOverrides `byPath` | behaviour stays (the override lands on the same node); key form becomes `byAddress` (`byNodeId` read as `"#id"`, `byPath` migrated on read, 9.22) |
| `tests/mcp-observe-tools.test.ts` | 4 | asserts AssetOverrides `byPath` | behaviour stays (the override lands on the same node); key form becomes `byAddress` (`byNodeId` read as `"#id"`, `byPath` migrated on read, 9.22) |
| `tests/mcp-selection-contract.test.ts` | 4 | asserts AssetOverrides `byPath` | behaviour stays (the override lands on the same node); key form becomes `byAddress` (`byNodeId` read as `"#id"`, `byPath` migrated on read, 9.22) |
| `tests/mcp-signal-bind-tools.test.ts` | 3 | ComponentReference in a written file (save / export / bake / reload) | behaviour stays (reload binds the same node); written form becomes `{address}` — assert the target node, not the stored `path` string |
| `tests/mechanism-authoring-ops.test.ts` | 3 | ComponentReference in a written file (save / export / bake / reload) | behaviour stays (reload binds the same node); written form becomes `{address}` — assert the target node, not the stored `path` string |
| `tests/mechanism-drive-live.test.ts` | 3 | ComponentReference in a written file (save / export / bake / reload) | behaviour stays (reload binds the same node); written form becomes `{address}` — assert the target node, not the stored `path` string |
| `tests/mechanism-glb-roundtrip.test.ts` | 3 | ComponentReference in a written file (save / export / bake / reload) | behaviour stays (reload binds the same node); written form becomes `{address}` — assert the target node, not the stored `path` string |
| `tests/mechanism-interaction.test.ts` | 3 | ComponentReference in a written file (save / export / bake / reload) | behaviour stays (reload binds the same node); written form becomes `{address}` — assert the target node, not the stored `path` string |
| `tests/mechanism-path-authoring.test.ts` | 3 | ComponentReference in a written file (save / export / bake / reload) | behaviour stays (reload binds the same node); written form becomes `{address}` — assert the target node, not the stored `path` string |
| `tests/mechanism-path.test.ts` | 1 | ComponentReference resolved at load | behaviour stays (same node); resolution goes through `resolveRef` (`resolvedVia: address` after migration) |
| `tests/node-registry-generic-ref.test.ts` | 1 | ComponentReference resolved through rewrite / alias / fallback stages | mechanism goes for STORED refs (no rate stage, no rewrite needed — 9.2/9.3); keep the assertion as a path-INPUT case (`findNodeForUser`, until plan-770) where it tests MCP/UI input |
| `tests/node-registry-generic-resolve.test.ts` | 1 | ComponentReference resolved through rewrite / alias / fallback stages | mechanism goes for STORED refs (no rate stage, no rewrite needed — 9.2/9.3); keep the assertion as a path-INPUT case (`findNodeForUser`, until plan-770) where it tests MCP/UI input |
| `tests/node-registry-prefix-alias.node.test.ts` | 1 | ComponentReference resolved through rewrite / alias / fallback stages | mechanism goes for STORED refs (no rate stage, no rewrite needed — 9.2/9.3); keep the assertion as a path-INPUT case (`findNodeForUser`, until plan-770) where it tests MCP/UI input |
| `tests/node-registry-resolve-compat.node.test.ts` | 1 | ComponentReference resolved at load | behaviour stays (same node); resolution goes through `resolveRef` (`resolvedVia: address` after migration) |
| `tests/parametric-component.node.test.ts` | 1 | ComponentReference resolved at load | behaviour stays (same node); resolution goes through `resolveRef` (`resolvedVia: address` after migration) |
| `tests/placed-asset-logic.test.ts` | 1 | ComponentReference resolved at load | behaviour stays (same node); resolution goes through `resolveRef` (`resolvedVia: address` after migration) |
| `tests/placement-content-edit-roundtrip.test.ts` | 4 | asserts `trsByNodeId` (part move inside a placement) | mechanism goes: `trsByNodeId` removed, part move refused (`nested-transform-refused`); old files load with a problem (9.10) |
| `tests/placement-instancer.test.ts` | 4 | asserts `trsByNodeId` (part move inside a placement) | mechanism goes: `trsByNodeId` removed, part move refused (`nested-transform-refused`); old files load with a problem (9.10) |
| `tests/placement-overrides-bypath.test.ts` | 4 | asserts `trsByNodeId` (part move inside a placement) | mechanism goes: `trsByNodeId` removed, part move refused (`nested-transform-refused`); old files load with a problem (9.10) |
| `tests/plan757-reference-is-placement.test.ts` | 4 | asserts AssetOverrides `byPath` + `byNodeId` | behaviour stays (the override lands on the same node); key form becomes `byAddress` (`byNodeId` read as `"#id"`, `byPath` migrated on read, 9.22) |
| `tests/plc-logicstep-to-st.test.ts` | 1 | ComponentReference resolved at load | behaviour stays (same node); resolution goes through `resolveRef` (`resolvedVia: address` after migration) |
| `tests/processindustry-plugin.test.ts` | 1 | ComponentReference resolved at load | **done 1b:** behaviour stays (same tank/pipe, assertions unchanged); the path-only registry fake speaks the stored-read API (`tests/helpers/legacy-registry-fake.ts`: every read is `legacy`, the plugin's own lookup runs) |
| `tests/reapply-resolve-refs.test.ts` | 3 | ComponentReference in a written file (save / export / bake / reload) | behaviour stays (reload binds the same node); written form becomes `{address}` — assert the target node, not the stored `path` string |
| `tests/reference-audit-demo-models.node.test.ts` | 1 | ComponentReference resolved through rewrite / alias / fallback stages | mechanism goes for STORED refs (no rate stage, no rewrite needed — 9.2/9.3); keep the assertion as a path-INPUT case (`findNodeForUser`, until plan-770) where it tests MCP/UI input |
| `tests/reference-path-asset-relative.test.ts` | 1 | ComponentReference resolved through rewrite / alias / fallback stages | mechanism goes for STORED refs (no rate stage, no rewrite needed — 9.2/9.3); keep the assertion as a path-INPUT case (`findNodeForUser`, until plan-770) where it tests MCP/UI input |
| `tests/reference-picker-row-ambiguous.test.tsx` | 1 | ComponentReference resolved through rewrite / alias / fallback stages | mechanism goes for STORED refs (no rate stage, no rewrite needed — 9.2/9.3); keep the assertion as a path-INPUT case (`findNodeForUser`, until plan-770) where it tests MCP/UI input |
| `tests/resolve-bindable-slots.test.ts` | 3 | ComponentReference + signal mapping (`componentPath`) | behaviour stays; `SignalMapping.componentAddress` / `sourceAddress` written, MCP output keeps `componentPath` (9.17/9.18) |
| `tests/ribbon-fixture.ts` | 1 | ComponentReference resolved at load | behaviour stays (same node); resolution goes through `resolveRef` (`resolvedVia: address` after migration) |
| `tests/ribbon-material-donor-bake.test.ts` | 1 | ComponentReference resolved at load | behaviour stays (same node); resolution goes through `resolveRef` (`resolvedVia: address` after migration) |
| `tests/ribbon-rollers-renderer.test.tsx` | 4 | asserts AssetOverrides `byPath` | behaviour stays (the override lands on the same node); key form becomes `byAddress` (`byNodeId` read as `"#id"`, `byPath` migrated on read, 9.22) |
| `tests/ribbon-sections.test.ts` | 3 | ComponentReference in a written file (save / export / bake / reload) | behaviour stays (reload binds the same node); written form becomes `{address}` — assert the target node, not the stored `path` string |
| `tests/ribbon-spin-mode.test.ts` | 1 | ComponentReference resolved at load | behaviour stays (same node); resolution goes through `resolveRef` (`resolvedVia: address` after migration) |
| `tests/ribbon-tension-pipeline.test.ts` | 1 | ComponentReference resolved at load | behaviour stays (same node); resolution goes through `resolveRef` (`resolvedVia: address` after migration) |
| `tests/robot-library-asset.node.test.ts` | 1 | ComponentReference resolved at load | behaviour stays (same node); resolution goes through `resolveRef` (`resolvedVia: address` after migration) |
| `tests/rv-asset-override-compat.test.ts` | 4 | asserts `trsByNodeId` (part move inside a placement) | mechanism goes: `trsByNodeId` removed, part move refused (`nested-transform-refused`); old files load with a problem (9.10) |
| `tests/rv-asset-override-trs.test.ts` | 4 | asserts `trsByNodeId` (part move inside a placement) | mechanism goes: `trsByNodeId` removed, part move refused (`nested-transform-refused`); old files load with a problem (9.10) |
| `tests/rv-asset-rename-move-references.test.ts` | 4 | asserts AssetOverrides `byPath` | behaviour stays (the override lands on the same node); key form becomes `byAddress` (`byNodeId` read as `"#id"`, `byPath` migrated on read, 9.22) |
| `tests/rv-component-registry.test.ts` | 1 | ComponentReference resolved at load | behaviour stays (same node); resolution goes through `resolveRef` (`resolvedVia: address` after migration) |
| `tests/rv-conveyor-init.test.ts` | 1 | ComponentReference resolved at load | behaviour stays (same node); resolution goes through `resolveRef` (`resolvedVia: address` after migration) |
| `tests/rv-custom-runtime-instruction.test.ts` | 1 | ComponentReference resolved at load | **done 1b:** behaviour stays (assertions unchanged); the fake registry is `legacyRegistry()` — CRI reads its targets through `storedNode` |
| `tests/rv-document-stack-recompose.test.ts` | 4 | asserts AssetOverrides `byPath` + `byNodeId` | behaviour stays (the override lands on the same node); key form becomes `byAddress` (`byNodeId` read as `"#id"`, `byPath` migrated on read, 9.22) |
| `tests/rv-glb-compose-trs-roundtrip.test.ts` | 4 | asserts `trsByNodeId` (part move inside a placement) | mechanism goes: `trsByNodeId` removed, part move refused (`nested-transform-refused`); old files load with a problem (9.10) |
| `tests/rv-glb-nodes.node.test.ts` | 3 | ComponentReference in a written file (save / export / bake / reload) | behaviour stays (reload binds the same node); written form becomes `{address}` — assert the target node, not the stored `path` string |
| `tests/rv-ik-path.test.ts` | 1 | ComponentReference resolved at load | behaviour stays (same node); resolution goes through `resolveRef` (`resolvedVia: address` after migration) |
| `tests/rv-lamp-alias.test.ts` | 1 | ComponentReference resolved at load | behaviour stays (same node); resolution goes through `resolveRef` (`resolvedVia: address` after migration) |
| `tests/rv-lamp-reapply.test.ts` | 3 | ComponentReference in a written file (save / export / bake / reload) | behaviour stays (reload binds the same node); written form becomes `{address}` — assert the target node, not the stored `path` string |
| `tests/rv-lamp-schema.test.ts` | 1 | ComponentReference resolved at load | behaviour stays (same node); resolution goes through `resolveRef` (`resolvedVia: address` after migration) |
| `tests/rv-node-knowledge-field-renderer.test.tsx` | 4 | asserts AssetOverrides `byPath` | behaviour stays (the override lands on the same node); key form becomes `byAddress` (`byNodeId` read as `"#id"`, `byPath` migrated on read, 9.22) |
| `tests/rv-node-path-aliases.test.ts` | 1 | ComponentReference resolved through rewrite / alias / fallback stages | mechanism goes for STORED refs (no rate stage, no rewrite needed — 9.2/9.3); keep the assertion as a path-INPUT case (`findNodeForUser`, until plan-770) where it tests MCP/UI input |
| `tests/rv-node-path-rewrite.node.test.ts` | 3 | ComponentReference in a written file (save / export / bake / reload) | behaviour stays (reload binds the same node); written form becomes `{address}` — assert the target node, not the stored `path` string |
| `tests/rv-node-registry-reverse-ref.test.ts` | 1 | ComponentReference resolved at load | behaviour stays (same node); resolution goes through `resolveRef` (`resolvedVia: address` after migration) |
| `tests/rv-node-registry-signal-binding.test.ts` | 1 | ComponentReference resolved at load | behaviour stays (same node); resolution goes through `resolveRef` (`resolvedVia: address` after migration) |
| `tests/rv-node-registry.test.ts` | 1 | ComponentReference resolved through rewrite / alias / fallback stages | mechanism goes for STORED refs (no rate stage, no rewrite needed — 9.2/9.3); keep the assertion as a path-INPUT case (`findNodeForUser`, until plan-770) where it tests MCP/UI input |
| `tests/rv-physics-zone.test.ts` | 4 | asserts AssetOverrides `byPath` | behaviour stays (the override lands on the same node); key form becomes `byAddress` (`byNodeId` read as `"#id"`, `byPath` migrated on read, 9.22) |
| `tests/rv-pipe.test.ts` | 1 | ComponentReference resolved at load | behaviour stays (same node); resolution goes through `resolveRef` (`resolvedVia: address` after migration) |
| `tests/rv-pump.test.ts` | 1 | ComponentReference resolved at load | behaviour stays (same node); resolution goes through `resolveRef` (`resolvedVia: address` after migration) |
| `tests/rv-reference-audit.node.test.ts` | 4 | asserts AssetOverrides `byPath` | behaviour stays (the override lands on the same node); key form becomes `byAddress` (`byNodeId` read as `"#id"`, `byPath` migrated on read, 9.22) |
| `tests/rv-reference-structural-guard.test.ts` | 4 | asserts AssetOverrides `byPath` + `byNodeId` | behaviour stays (the override lands on the same node); key form becomes `byAddress` (`byNodeId` read as `"#id"`, `byPath` migrated on read, 9.22) |
| `tests/rv-scene-glb-bake-move-in-reference.test.ts` | 4 | asserts `trsByNodeId` (part move inside a placement) | mechanism goes: `trsByNodeId` removed, part move refused (`nested-transform-refused`); old files load with a problem (9.10) |
| `tests/rv-signal-reapply.test.ts` | 1 | ComponentReference resolved at load | behaviour stays (same node); resolution goes through `resolveRef` (`resolvedVia: address` after migration) |
| `tests/rv-signal-wiring.test.ts` | 1 | ComponentReference resolved at load | behaviour stays (same node); resolution goes through `resolveRef` (`resolvedVia: address` after migration) |
| `tests/scene-button-fixture.ts` | 3 | ComponentReference in a written file (save / export / bake / reload) | behaviour stays (reload binds the same node); written form becomes `{address}` — assert the target node, not the stored `path` string |
| `tests/search-ai-context.test.ts` | 4 | asserts AssetOverrides `byPath` | behaviour stays (the override lands on the same node); key form becomes `byAddress` (`byNodeId` read as `"#id"`, `byPath` migrated on read, 9.22) |
| `tests/selection-object.test.ts` | 4 | asserts AssetOverrides `byPath` | behaviour stays (the override lands on the same node); key form becomes `byAddress` (`byNodeId` read as `"#id"`, `byPath` migrated on read, 9.22) |
| `tests/signal-reconcile-problems.test.ts` | 4 | asserts AssetOverrides `byPath` | behaviour stays (the override lands on the same node); key form becomes `byAddress` (`byNodeId` read as `"#id"`, `byPath` migrated on read, 9.22) |
| `tests/signal-rename-save-reload.test.ts` | 3 | ComponentReference in a written file (save / export / bake / reload) | behaviour stays (reload binds the same node); written form becomes `{address}` — assert the target node, not the stored `path` string |
| `tests/signal-usage-index.test.ts` | 3 | ComponentReference in a written file (save / export / bake / reload) | behaviour stays (reload binds the same node); written form becomes `{address}` — assert the target node, not the stored `path` string |
| `tests/source-unity-controls.test.ts` | 1 | ComponentReference resolved at load | behaviour stays (same node); resolution goes through `resolveRef` (`resolvedVia: address` after migration) |
| `tests/spec-tables-sync.test.ts` | 1 | ComponentReference resolved at load | behaviour stays (same node); resolution goes through `resolveRef` (`resolvedVia: address` after migration) |
| `tests/virtual-camera-community-survival.test.ts` | 1 | ComponentReference resolved at load | behaviour stays (same node); resolution goes through `resolveRef` (`resolvedVia: address` after migration) |
| `tests/zone-logic-step.test.ts` | 1 | ComponentReference resolved at load | behaviour stays (same node); resolution goes through `resolveRef` (`resolvedVia: address` after migration) |

## Phase 3a — added / touched outside the table (2026-10-22)

| Test file | What changed |
|---|---|
| `tests/save-id-only.test.ts` | NEW — 9.5 (editor export): F8 dynamic walker, idVersion, ids, `_` keys, reload without migration, Save→Save, duplicates, F9 guess, NAME field, runtime load of the saved file |
| `tests/unity-reexport-stability.test.ts` | NEW — 9.6 |
| `tests/save-atomicity-and-ensure-id.test.ts` | NEW — 9.23 ensureNodeId part (F21 = `it.todo`, Phase 3b) |
| `tests/mauser-editor-roundtrip.test.ts` | NEW — local (`VITE_RV_MAUSER_GLB`) Mauser load → editor export → reload |
| `tests/helpers/stored-ref-walker.ts` | NEW — the F8 save-side walker |
| `tests/op-id-invariant.test.ts` | 9.8 Save→Undo→Redo→Save (was `it.todo`) |
| `tests/phase1-persists-no-id.test.ts` | asset-export half flipped: the export now writes a NodeId per node |
| `tests/stored-ref-guard.node.test.ts` | 9.11 fingerprints of WebVisibility / RobotIK / Kinematic-Parent readers updated |
| `tests/collider-export-roundtrip.test.ts`, `tests/rv-node-knowledge-roundtrip.test.ts` | extras compared without the new `NodeId` key |
| `tests/bake-reference-tags.test.ts` | typing only (`ref.path` optional) |
| `tests/helpers/problem-code-classification.ts` | `node-id-duplicate-reminted`, `reference-saved-from-guess` → `clear-model` |

## Phase 3b — added / touched outside the table (2026-10-22)

| Test file | What changed |
|---|---|
| `tests/save-id-only.test.ts` | +2: 9.5 for the scene save — fast (JSON patch) and full (re-export) path: ids = load-time seeds, addresses only, `idVersion`, twin keeps id + ref, placement keeps record id |
| `tests/signal-address-persistence.test.ts` | NEW — 9.17 (`componentAddress` carrier / placement / `'.'`, `sourceAddress`, layout file + scene GLB) |
| `tests/mcp-path-contract.test.ts` | NEW — 9.18 (list → bind with path AND address; authored path input; setField path → stored address, op carries it) |
| `tests/save-atomicity-and-ensure-id.test.ts` | F21 `it.todo` → test (`reference-target-unsaved`) |
| `tests/phase1-persists-no-id.test.ts` | scene-save half flipped: the scene save writes a NodeId per node |
| `tests/editor-save-authored-names.test.ts` | setField stores the pinned node's ADDRESS (9.6 / 9.10 cases); ambiguous authored path now pinned by id; reload count of the name-space guard 0 |
| `tests/compose-missing-references.test.ts` | reference node byte-identical except the stamped `NodeId` |
| private `tests/maintenance-runtime.test.ts` | typing only (`ref.path` optional) |
| `tests/helpers/problem-code-classification.ts` | `reference-target-unsaved` → `clear-model` |

## Phase 4a — byAddress overrides, byPath/byNodeId read-migration, `trsByNodeId` removed (2026-10-22)

| Test file | What changed |
|---|---|
| `tests/no-trs-override.test.ts` | NEW — 9.10: part move inside placed content refused (`NestedTransformRefusedError`, `nested-transform-refused` problem, retired by the next save attempt), mixed save refused as a whole, guard keeps `transformNode` structural; old file with `trsByNodeId` loads (patch applied, parts unmoved, ONE `override-transforms-dropped` with the count); no writer emits `trsByNodeId`/`byNodeId` (scene bake fast path, editor export, `setAssetOverrides`) |
| `tests/bypath-to-address-migration.test.ts` | NEW — 9.22: `byNodeId` → `#id`, `byPath` → `legacyByPath`, `byAddress` wins field-wise, idempotent read, `migrateLegacyOverridePaths`; composed frame migrates in memory, save/reload keep the values; asset changed between save and load → address AND path orphans visible, the path kept |
| `tests/rv-asset-override-trs.test.ts` | DELETED — `parseTrsOverride` / `applyTrsOverride` / trs read-write are gone (F14); the surviving behaviour (old files load, nothing written) is in 9.10 |
| `tests/rv-asset-override-compat.test.ts` | DELETED — `trsByNodeId` beside `byNodeId`, `writeOverride` carrying trs, trs orphans: mechanism gone; `writeOverride` → `byAddress` is pinned in `rv-reference-structural-guard` |
| `tests/rv-glb-compose-trs-roundtrip.test.ts` | DELETED — move → save → load of a part inside a reference no longer exists (refused, 9.10) |
| `tests/rv-scene-glb-bake-move-in-reference.test.ts` | DELETED — category 5 is now own-file TRS or refusal; refusal (referenced + nested, all paths named, no partial write) is in 9.10 + `placement-content-edit-roundtrip` |
| `tests/placement-content-edit-roundtrip.test.ts` | component edit → `byAddress['#id']`; TRS edit in a placement (file + live) → `NestedTransformRefusedError`; live placement: component-only save lands as `byAddress` |
| `tests/glb-bake-roundtrip.test.ts` | override key `#<id>` under `byAddress`, no `byNodeId`; trs case flipped to the refusal |
| `tests/placement-overrides-bypath.test.ts` | old record (byNodeId + byPath + trs) via `readAssetOverridesRecord`: patches applied, Axis not moved, `droppedTransforms` 2 + problem, `migratedPaths`, orphan `address:#n-frame`; same counts as composition (−1 merged node) |
| `tests/bake-lifecycle-races.test.ts` | orphan id `address:#<id>`; trs case flipped: one bake (no `#split:`), `droppedTransforms` 1, nothing applied |
| `tests/layout-reload-shared-bake.test.ts` | (d) old `trsByNodeId` on a deferred placement: no split, one bake, `override-transforms-dropped`, record canonicalised away |
| `tests/placement-instancer.test.ts` | "overrides after the pivot" now with a legacy `byPath` component patch (no split, no trs) |
| `tests/model-cache-editor-open.test.ts` | forced-split case DELETED (`forceSplitNodeIds` / `#split:` bake gone) |
| `tests/parametric-placement.test.ts` | split+parametric assertion removed (no split bake); `parametricRequestsOf` legacy `byNodeId` case kept (still read) |
| `tests/rv-reference-structural-guard.test.ts` | `writeOverride`/`readOverride` → `byAddress['#n-inner']` |
| `tests/glb-asset-reference.test.ts` | literals `byAddress`/`legacyByPath`; orphan `{addressing:'address', key:'#…'}`; overlay resolver via `byAddress` |
| `tests/asset-export-keeps-references.test.ts`, `characterise-769-override-order`, `descend-override-suppression`, `fleet/fleet-scoped-id`, `glb-reference-resolve`, `plan757-reference-is-placement`, `rv-document-stack-recompose`, private `pallet-yard-placements` | literal form only: `byNodeId: {…}` → `byAddress: {'#…'}`, `byNodeId: {}, byPath:` → `byAddress: {}, legacyByPath:` |
| `tests/helpers/problem-code-classification.ts` | `override-transforms-dropped`, `nested-transform-refused` → `clear-model` |

## Phase 4b — nested overrides, one precedence point, no derived ids (2026-10-22)

| Test file | What changed |
|---|---|
| `tests/nested-override.test.ts` | NEW — 9.9: outer beats inner on `nid-cell#nid-slide`; ten instances apart; gated nested decode → override waits (`routedOverrideCount`), component reference into it resolves late + `reapplyConfig` once; document order / warm second load; save (`setField` on the nested Slide → `byAddress["nid-cell#nid-slide"]` on the Machine) → reload; orphan verdict at pending 0 (`missing`), 404 (`placement-missing`), cap (`placement-cap`), `clearModel` (queue emptied, nothing reported); `#<rootId>` → placement root |
| `tests/characterise-769-override-order.test.ts` | placement half flipped: the outer override is routed and wins (300), no orphan — compose and placement agree |
| `tests/plan757-reference-is-placement.test.ts` | the `nested-reference` orphan case flipped: a `byPath` into the nested reference is routed and applied |
| `tests/placement-content-edit-roundtrip.test.ts` | `locate()` carries `address`; 4b describe flipped: nested node → outermost placement, `<cellRef>#<slide>`, component edit saved + reloaded; nested move still refused (owner = the outer placement) |
| `tests/bypath-to-address-migration.test.ts` | 9.22 save case now the FIXED behaviour: a migrated `byPath` is written as `byAddress` (live migration memo), no runtime key in the file |
| `tests/glb-reference-resolve.test.ts` | ids learned through `identityIdOf` (compose derives no NodeIds any more, F12); orphan key `#…` |
| `tests/resolve-ref-scope.test.ts` | "WITH sha256" case: no derived id, the decode seed (UUIDv5) is the identity, `getNodeId` null |

## Rest items — 9.15, 9.20 browser, `LogicStep_Enable.Target` (2026-10-22)

| Test file | What changed |
|---|---|
| `tests/perf/node-id-perf.test.ts` | NEW — 9.15: decode with vs without the identity step, interleaved (order alternating), 2 warm-up pairs, median of 7; CI fixture LaserWeldingAssemblyStation, Mauser behind `VITE_RV_MAUSER_GLB`, heap delta behind `VITE_RV_PERF_HEAP`. The ≤ +10 % NFR is NOT met (measured +22–25 % / Mauser +32.6 %): both cases are `it.fails` at the plan value, not loosened |
| `tests/browser/decode-path-parity.browser.test.ts` | NEW — 9.20 browser variant: DemoRealvirtualWeb.glb (257 nodes, 164 path references) → `findNodeForUser` (runtime + authored path) → scene save (every reference = the address the load migrated it to, `idVersion: 1`) → reload (no migration, every id kept, every address resolves to its id, audit + inventory identical) |
| `tests/logicstep-enable-target-address.test.ts` | NEW — `LogicStep_Enable.Target` (and the `_1` key) is a PATH_FIELDS position, written as `{ address }` by the scene save and the editor export, read by `storedNode` from both forms |
| `tests/characterise-769-reference-walker.node.test.ts`, `tests/rv-node-path-rewrite.node.test.ts`, `tests/rv-maintenance-bake-targets.test.ts`, `tests/stored-ref-guard.node.test.ts` | the field tables gain `LogicStep_Enable.Target` (PATH_FIELDS + its `pathString` / `chunk` bake row); the logic-engine reader fingerprint reads the raw value |
| `tests/fixtures/reference-baseline.json` | regenerated deliberately: 0 new reference positions (no shipped GLB carries a `LogicStep_Enable`), per-customer counts unchanged; only `seedMs` timings differ (faster SHA-1) |
| `tests/fmu-demo-model.build.test.ts` | red since Phase 3 (export writes `NodeId`, a runtime-signal reference is kept as `unresolvedPath`): ids ignored as non-recipe content, the kept path compared as the path the pre-769 shipped file stores |
