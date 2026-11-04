// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-774 § 9.2 (F1) — an instance override written by the editor's
 * `setField` / `unsetField` executor is ONE op: undo takes the override back
 * (to its previous value or its absence), redo writes it again, it survives
 * save → reopen, the badge source (`referenceOverriddenFields` /
 * `isFieldOverridden`) reads it, and the inspector's Revert clears it AND puts
 * the live value back to the asset's own value.
 *
 * Also: the outermost reference holds the patch of NESTED content
 * (`<b>#<id>`), the MCP tool `web_editor_set_field` (command `editor.setField`)
 * takes the same path, and a slider-drag burst stays one undo entry.
 *
 * Modes: `deferred` (the production editor load since plan-774 Phase 2) and
 * `graft` (the pre-Phase-2 load, forced through the compose seam installed below).
 *
 * PRIVATE-DEPENDENT (the `editor.setField` command lives with the asset
 * editor): listed in `tests/private-dependent-tests.json`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Object3D } from 'three';
import { exportAssetGlb } from '../src/core/editor/rv-asset-glb-export';
import { assetOpHeader } from '../src/core/editor/rv-asset-ops';
import { getAssetOverrides } from '../src/core/engine/rv-asset-reference';
import { readOverride } from '../src/core/ops/rv-reference-guard';
import {
  isFieldOverridden, referenceOverriddenFields, revertReferenceOverride, sceneOverlayOverriddenFields,
} from '../src/core/hmi/rv-field-override';
import { setActiveEditTarget, type EditTarget } from '../src/core/hmi/rv-edit-target';
import { RvExtrasEditorPlugin } from '../src/core/hmi/rv-extras-editor';
import type { AssetDocument } from '../src/core/editor/rv-asset-document';
import type { CommandContext } from '../src/core/hmi/rv-command-registry';
import { RV_OVERRIDE_BASE_KEY } from '../src/core/engine/rv-asset-reference';
import type { BakedAsset } from '../src/core/engine/rv-bake-chunk';
import { impls } from '@rv-private/plugins/asset-editor/editor-commands';
import {
  CELL_REF_NODE_ID, OUTER_DEEP_URL, OUTER_URL, SLIDE_NODE_ID, findByName, jsonNodes, toArrayBuffer,
} from './helpers/nested-placement-fixture';
import {
  INNER_OVERRIDE_SPEED, MACHINE_REF_NODE_ID, NESTED_DOC_URL, NESTED_INNER_OVERRIDE_DOC_URL,
  openEditorDocument, openEditorDocumentBytes,
  type EditorDocumentHarness, type EditorLoadMode,
} from './helpers/editor-document-harness';
import { takeComposeTemplateRoots } from './helpers/editor-defer-seam';

vi.mock('../src/core/engine/rv-glb-compose', async (importOriginal) =>
  (await import('./helpers/editor-defer-seam')).deferringComposeModule(importOriginal as never));

interface GlbNode { name?: string; children?: number[]; extras?: { realvirtual?: Record<string, unknown> } }

const MODES = ['graft', 'deferred'] as const satisfies readonly EditorLoadMode[];
const ADDR = `#${SLIDE_NODE_ID}`;
const NESTED_ADDR = `${CELL_REF_NODE_ID}#${SLIDE_NODE_ID}`;
const ASSET_SPEED = 200; // makeInner(): Slide Drive.TargetSpeed

const open: EditorDocumentHarness[] = [];
async function openDoc(url: string, mode: EditorLoadMode): Promise<EditorDocumentHarness> {
  const h = await openEditorDocument(url, { mode });
  open.push(h);
  return h;
}
afterEach(() => {
  setActiveEditTarget(null);
  for (const h of open.splice(0)) h.dispose();
});

/** The reference node of the open document that owns an override, by id. */
function refNode(h: EditorDocumentHarness, id: string): Object3D {
  return h.nodeById(id);
}
function overrideAt(ref: Object3D, address: string): unknown {
  return readOverride(ref, address)?.Drive?.TargetSpeed;
}
function hasOverride(ref: Object3D, address: string): boolean {
  const fields = readOverride(ref, address)?.Drive;
  return !!fields && 'TargetSpeed' in fields;
}
/** The extras value and the LIVE component value of the Slide. */
function slideValues(h: EditorDocumentHarness): { extras: unknown; live: unknown } {
  const slide = h.nodeById(SLIDE_NODE_ID);
  const extras = (slide.userData.realvirtual as { Drive?: { TargetSpeed?: unknown } } | undefined)?.Drive?.TargetSpeed;
  const drive = h.viewer.registry?.getByPath('Drive', h.pathOf(slide)) as { TargetSpeed?: unknown } | null;
  return { extras, live: drive?.TargetSpeed };
}
async function setSpeed(h: EditorDocumentHarness, value: number): Promise<void> {
  const slide = h.nodeById(SLIDE_NODE_ID);
  const prev = (slide.userData.realvirtual as { Drive: { TargetSpeed: unknown } }).Drive.TargetSpeed;
  await h.doc.setFieldAwaited(h.pathOf(slide), 'Drive', 'TargetSpeed', value, prev);
}
async function save(h: EditorDocumentHarness): Promise<ArrayBuffer> {
  return toArrayBuffer(await exportAssetGlb(h.viewer.currentModelRoot!, 'm'));
}
function savedOverride(bytes: ArrayBuffer, refId: string, address: string): unknown {
  const nodes = jsonNodes(bytes) as GlbNode[];
  const ref = nodes.find((n) => n.extras?.realvirtual?.NodeId === refId);
  expect(ref, `reference ${refId} is written`).toBeDefined();
  expect(ref!.children ?? [], 'the saved reference node is empty').toHaveLength(0);
  const ov = ref!.extras?.realvirtual?.AssetOverrides as
    { byAddress?: Record<string, { Drive?: { TargetSpeed?: unknown } }> } | undefined;
  return ov?.byAddress?.[address]?.Drive?.TargetSpeed;
}
/** The asset editor's edit target, as the private plugin installs it (no `persistsTo` → 'asset'). */
function installAssetTarget(doc: AssetDocument): void {
  const target: EditTarget = {
    available: true,
    setField: (p, c, f, v, prev) => doc.setField(p, c, f, v, prev),
    setFieldAsync: (p, c, f, v, prev) => doc.setFieldAwaited(p, c, f, v, prev),
    unsetField: (p, c, f, prev) => doc.unsetField(p, c, f, prev),
    withTransaction: (label, fn) => doc.withTransaction(label, fn),
  };
  setActiveEditTarget(target);
}
/**
 * The extras-editor plugin bound to the harness viewer (what the inspector's
 * Revert calls) — and the one `viewer.getPlugin('rv-extras-editor')` returns,
 * so the badge source (`isFieldOverridden`) reads ITS optimistic overlay.
 */
const extrasEditors = new WeakMap<object, RvExtrasEditorPlugin>();
function extrasEditor(h: EditorDocumentHarness): RvExtrasEditorPlugin {
  const known = extrasEditors.get(h.viewer);
  if (known) return known;
  const plugin = new RvExtrasEditorPlugin();
  (plugin as unknown as { _viewer: unknown })._viewer = h.viewer;
  const viewer = h.viewer as unknown as { getPlugin(id: string): unknown };
  const original = viewer.getPlugin.bind(viewer);
  viewer.getPlugin = (id: string) => (id === 'rv-extras-editor' ? plugin : original(id));
  extrasEditors.set(h.viewer, plugin);
  return plugin;
}
/** Every node under `root` (template trees) that carries a runtime override base. */
function nodesWithOverrideBase(root: Object3D): string[] {
  const hits: string[] = [];
  root.traverse((n) => { if (n.userData && RV_OVERRIDE_BASE_KEY in n.userData) hits.push(n.name); });
  return hits;
}
/** Run `fn` with `Date.now()` frozen — every op it issues gets the same `ts`, so a burst always coalesces. */
async function withFrozenClock<T>(fn: () => Promise<T>): Promise<T> {
  const frozen = Date.now();
  const spy = vi.spyOn(Date, 'now').mockReturnValue(frozen);
  try {
    return await fn();
  } finally {
    spy.mockRestore();
  }
}
/** Wait until every op queued on the document has run. */
async function settle(h: EditorDocumentHarness): Promise<void> {
  // Twice: a transaction opened by a `void` caller queues its ops after the first barrier.
  await h.doc.whenIdle();
  await new Promise((r) => setTimeout(r, 0));
  await h.doc.whenIdle();
}

describe('plan-774 9.2 — instance override undo / redo / reopen / Revert (F1)', () => {
  it.each(MODES)('set → undo removes the override; redo writes it again; one undo entry (%s)', async (mode) => {
    const h = await openDoc(OUTER_URL, mode);
    const cell = refNode(h, CELL_REF_NODE_ID);
    expect(getAssetOverrides(cell)).toBeNull();
    const ops0 = h.doc.document.opCount;

    const slidePath = h.pathOf(h.nodeById(SLIDE_NODE_ID));
    expect(isFieldOverridden(h.viewer, slidePath, 'Drive', 'TargetSpeed')).toBe(false);

    await setSpeed(h, 250);
    expect(overrideAt(cell, ADDR)).toBe(250);
    expect(slideValues(h)).toEqual({ extras: 250, live: 250 });
    expect(h.doc.document.opCount - ops0, 'the override write adds no undo entry').toBe(1);
    expect(isFieldOverridden(h.viewer, slidePath, 'Drive', 'TargetSpeed'), 'badge after set').toBe(true);

    await h.doc.undo();
    expect(hasOverride(cell, ADDR), 'undo: the address is absent again').toBe(false);
    expect(getAssetOverrides(cell), 'no empty AssetOverrides husk').toBeNull();
    expect(slideValues(h)).toEqual({ extras: ASSET_SPEED, live: ASSET_SPEED });
    expect(isFieldOverridden(h.viewer, slidePath, 'Drive', 'TargetSpeed'), 'badge after undo').toBe(false);

    await h.doc.redo();
    expect(overrideAt(cell, ADDR)).toBe(250);
    expect(slideValues(h)).toEqual({ extras: 250, live: 250 });
    expect(isFieldOverridden(h.viewer, slidePath, 'Drive', 'TargetSpeed'), 'badge after redo').toBe(true);
  });

  it.each(MODES)('inspector edit (optimistic overlay): badge lit after set, OFF after undo — the overlay entry is dropped once the op settled (%s)', async (mode) => {
    const h = await openDoc(OUTER_URL, mode);
    const cell = refNode(h, CELL_REF_NODE_ID);
    const slidePath = h.pathOf(h.nodeById(SLIDE_NODE_ID));
    installAssetTarget(h.doc);
    const plugin = extrasEditor(h);

    expect(plugin.updateOverlayField(slidePath, 'Drive', 'TargetSpeed', 250)).toBe(true);
    // Optimistic: lit before the op ran.
    expect(isFieldOverridden(h.viewer, slidePath, 'Drive', 'TargetSpeed'), 'badge right after the edit').toBe(true);
    await settle(h);
    expect(overrideAt(cell, ADDR)).toBe(250);
    expect(isFieldOverridden(h.viewer, slidePath, 'Drive', 'TargetSpeed'), 'badge after set').toBe(true);
    expect(sceneOverlayOverriddenFields(h.viewer, slidePath, 'Drive'), 'the reference record is the badge source now').toEqual([]);

    await h.doc.undo();
    expect(hasOverride(cell, ADDR)).toBe(false);
    expect(isFieldOverridden(h.viewer, slidePath, 'Drive', 'TargetSpeed'), 'badge after undo').toBe(false);
    expect(slideValues(h)).toEqual({ extras: ASSET_SPEED, live: ASSET_SPEED });
  });

  it.each(MODES)('undo restores the PREVIOUS override value, not its absence (%s)', async (mode) => {
    const h = await openDoc(OUTER_URL, mode);
    const cell = refNode(h, CELL_REF_NODE_ID);
    await setSpeed(h, 250);
    // A second edit far enough apart not to coalesce with the first.
    await new Promise((r) => setTimeout(r, 600));
    await setSpeed(h, 300);
    expect(h.doc.document.opCount).toBe(2);
    expect(overrideAt(cell, ADDR)).toBe(300);
    await h.doc.undo();
    expect(overrideAt(cell, ADDR)).toBe(250);
    expect(slideValues(h)).toEqual({ extras: 250, live: 250 });
  });

  it.each(MODES)('set → save → reopen: value + badge source; Revert clears it and restores the asset value; undo of Revert (%s)', async (mode) => {
    const h = await openDoc(OUTER_URL, mode);
    await setSpeed(h, 250);
    const bytes = await save(h);
    expect(savedOverride(bytes, CELL_REF_NODE_ID, ADDR)).toBe(250);

    const r = await openEditorDocumentBytes('p774-reopen.glb', bytes, { mode });
    open.push(r);
    const cell = refNode(r, CELL_REF_NODE_ID);
    const slidePath = r.pathOf(r.nodeById(SLIDE_NODE_ID));
    expect(slideValues(r)).toEqual({ extras: 250, live: 250 });
    expect(referenceOverriddenFields(r.viewer, slidePath, 'Drive')).toContain('TargetSpeed');
    expect(isFieldOverridden(r.viewer, slidePath, 'Drive', 'TargetSpeed'), 'badge after reopen').toBe(true);

    // The inspector's field Revert: `revertReferenceOverride` + `resetField`.
    installAssetTarget(r.doc);
    const plugin = extrasEditor(r);
    revertReferenceOverride(r.viewer, slidePath, 'Drive', 'TargetSpeed');
    expect(overrideAt(cell, ADDR), 'in the asset editor the op owns the write').toBe(250);
    plugin.resetField(slidePath, 'Drive', 'TargetSpeed');
    await settle(r);
    expect(hasOverride(cell, ADDR), 'Revert: override gone').toBe(false);
    expect(isFieldOverridden(r.viewer, slidePath, 'Drive', 'TargetSpeed'), 'badge cleared').toBe(false);
    expect(slideValues(r), 'Revert: live value back to the asset value').toEqual({ extras: ASSET_SPEED, live: ASSET_SPEED });
    expect(savedOverride(await save(r), CELL_REF_NODE_ID, ADDR)).toBeUndefined();

    // Undo of the Revert brings back the override AND the value.
    await r.doc.undo();
    expect(overrideAt(cell, ADDR)).toBe(250);
    expect(slideValues(r)).toEqual({ extras: 250, live: 250 });
  });

  it.each(MODES)('component Revert after reopen (no optimistic overlay entry) clears the override and the live value (%s)', async (mode) => {
    const h = await openDoc(OUTER_URL, mode);
    await setSpeed(h, 250);
    const r = await openEditorDocumentBytes('p774-reopen-c.glb', await save(h), { mode });
    open.push(r);
    const cell = refNode(r, CELL_REF_NODE_ID);
    const slidePath = r.pathOf(r.nodeById(SLIDE_NODE_ID));
    installAssetTarget(r.doc);
    revertReferenceOverride(r.viewer, slidePath, 'Drive');
    extrasEditor(r).resetComponent(slidePath, 'Drive');
    await settle(r);
    expect(getAssetOverrides(cell)).toBeNull();
    expect(slideValues(r)).toEqual({ extras: ASSET_SPEED, live: ASSET_SPEED });

    // Undo of the component Revert (one transaction) brings back the override AND the value.
    await r.doc.undo();
    expect(overrideAt(cell, ADDR)).toBe(250);
    expect(slideValues(r)).toEqual({ extras: 250, live: 250 });
    expect(isFieldOverridden(r.viewer, slidePath, 'Drive', 'TargetSpeed')).toBe(true);
  });

  it.each(MODES)('"Reset all" (resetNode) after reopen also reverts the instance overrides read from the file (%s)', async (mode) => {
    const h = await openDoc(OUTER_URL, mode);
    await setSpeed(h, 250);
    const r = await openEditorDocumentBytes('p774-reopen-n.glb', await save(h), { mode });
    open.push(r);
    const cell = refNode(r, CELL_REF_NODE_ID);
    const slidePath = r.pathOf(r.nodeById(SLIDE_NODE_ID));
    installAssetTarget(r.doc);
    extrasEditor(r).resetNode(slidePath);
    await settle(r);
    expect(getAssetOverrides(cell)).toBeNull();
    expect(slideValues(r)).toEqual({ extras: ASSET_SPEED, live: ASSET_SPEED });
    await r.doc.undo();
    expect(overrideAt(cell, ADDR)).toBe(250);
    expect(slideValues(r)).toEqual({ extras: 250, live: 250 });
  });

  it.each(MODES)('Revert restores an INNER-file-overridden value, not the raw asset value — in the session and after reopen (%s)', async (mode) => {
    const h = await openDoc(NESTED_INNER_OVERRIDE_DOC_URL, mode);
    const machine = refNode(h, MACHINE_REF_NODE_ID);
    expect(slideValues(h), 'fixture: the placed Machine file overrides its Slide').toEqual({ extras: INNER_OVERRIDE_SPEED, live: INNER_OVERRIDE_SPEED });
    await setSpeed(h, 250);
    expect(overrideAt(machine, NESTED_ADDR)).toBe(250);
    const bytes = await save(h);

    // In the session: the base was recorded at the first edit.
    const slidePath = h.pathOf(h.nodeById(SLIDE_NODE_ID));
    installAssetTarget(h.doc);
    extrasEditor(h).resetField(slidePath, 'Drive', 'TargetSpeed');
    await settle(h);
    expect(hasOverride(machine, NESTED_ADDR)).toBe(false);
    expect(slideValues(h), 'Revert (session): the inner-overridden value').toEqual({ extras: INNER_OVERRIDE_SPEED, live: INNER_OVERRIDE_SPEED });

    // After reopen: the base was recorded when the open file's layer was applied.
    setActiveEditTarget(null);
    const r = await openEditorDocumentBytes('p774-inner-ov-reopen.glb', bytes, { mode });
    open.push(r);
    const rMachine = refNode(r, MACHINE_REF_NODE_ID);
    expect(slideValues(r)).toEqual({ extras: 250, live: 250 });
    installAssetTarget(r.doc);
    extrasEditor(r).resetField(r.pathOf(r.nodeById(SLIDE_NODE_ID)), 'Drive', 'TargetSpeed');
    await settle(r);
    expect(hasOverride(rMachine, NESTED_ADDR)).toBe(false);
    expect(slideValues(r), 'Revert (reopen): the inner-overridden value').toEqual({ extras: INNER_OVERRIDE_SPEED, live: INNER_OVERRIDE_SPEED });
  });

  it.each(MODES)('a REPLAYED setField records the base from the live tree, not from the op\'s historic prev (%s)', async (mode) => {
    const h = await openDoc(OUTER_URL, mode);
    const cell = refNode(h, CELL_REF_NODE_ID);
    const slidePath = h.pathOf(h.nodeById(SLIDE_NODE_ID));
    const ex = h.doc.executor;
    ex.beginReplay();
    try {
      // A historic `prev` that does not match the tree the replay lands on.
      await h.doc.applyOp({ ...assetOpHeader(), kind: 'setField', nodePath: slidePath, componentType: 'Drive', fieldName: 'TargetSpeed', value: 250, prev: 999 });
    } finally {
      ex.endReplay();
    }
    expect(overrideAt(cell, ADDR)).toBe(250);
    installAssetTarget(h.doc);
    extrasEditor(h).resetField(slidePath, 'Drive', 'TargetSpeed');
    await settle(h);
    expect(hasOverride(cell, ADDR)).toBe(false);
    expect(slideValues(h), 'Revert: the asset value the replay found, not 999').toEqual({ extras: ASSET_SPEED, live: ASSET_SPEED });
  });

  it.each(MODES)('undo WITHOUT a capture: when op.prev is the recorded base no override is written back (%s)', async (mode) => {
    const h = await openDoc(OUTER_URL, mode);
    const cell = refNode(h, CELL_REF_NODE_ID);
    await setSpeed(h, 250); // base 200 recorded, capture {has:false}
    // Lose the capture (as a coalesce release or a dispose would).
    (h.doc.executor as unknown as { _overridePrev: Map<string, unknown> })._overridePrev.clear();
    await h.doc.undo();
    expect(hasOverride(cell, ADDR), 'op.prev (200) IS the base: no override, no husk').toBe(false);
    expect(getAssetOverrides(cell)).toBeNull();
    expect(slideValues(h)).toEqual({ extras: ASSET_SPEED, live: ASSET_SPEED });
  });

  it.each(MODES)('Revert of a field nothing overrides and whose base is unknown is a no-op — the live value stays (%s)', async (mode) => {
    const h = await openDoc(OUTER_URL, mode);
    const cell = refNode(h, CELL_REF_NODE_ID);
    const slidePath = h.pathOf(h.nodeById(SLIDE_NODE_ID));
    installAssetTarget(h.doc);
    extrasEditor(h).resetField(slidePath, 'Drive', 'TargetSpeed');
    await settle(h);
    expect(getAssetOverrides(cell)).toBeNull();
    expect(slideValues(h), 'live and saved state agree: the asset value stays').toEqual({ extras: ASSET_SPEED, live: ASSET_SPEED });
  });

  it.each(MODES)('reopen with an override: no template (compose cache / BakedAsset) carries the runtime override base (%s)', async (mode) => {
    const h = await openDoc(OUTER_URL, mode);
    await setSpeed(h, 250);
    const bytes = await save(h);
    takeComposeTemplateRoots(); // only the reopen's compose counts
    const r = await openEditorDocumentBytes('p774-template-clean.glb', bytes, { mode });
    open.push(r);
    // Proof the base IS recorded — on the instance.
    expect(RV_OVERRIDE_BASE_KEY in r.nodeById(SLIDE_NODE_ID).userData, 'the instance node carries the base').toBe(true);

    const composeRoots = takeComposeTemplateRoots() as Object3D[];
    const baked = [...((r.viewer.placements.modelCache as unknown as { _baked: Map<string, BakedAsset> })._baked.values())];
    if (mode === 'graft') {
      // The graft clones the Cell from the compose cache's template.
      expect(composeRoots.length, 'graft: the compose cache held the Cell template').toBeGreaterThan(0);
    } else {
      // Deferred: the Cell is a placement, instanced from the ModelCache's BakedAsset.
      expect(baked.length, 'deferred: the ModelCache baked the Cell').toBeGreaterThan(0);
    }
    for (const root of composeRoots) expect(nodesWithOverrideBase(root), 'compose template').toEqual([]);
    for (const asset of baked) expect(nodesWithOverrideBase(asset.template), 'BakedAsset template').toEqual([]);
  });

  it.each(MODES)('nested content: the OUTERMOST reference holds `<b>#<id>` (%s)', async (mode) => {
    const h = await openDoc(NESTED_DOC_URL, mode);
    const machine = refNode(h, MACHINE_REF_NODE_ID);
    await setSpeed(h, 250);
    expect(overrideAt(machine, NESTED_ADDR)).toBe(250);
    // The inner reference lives in the referenced file — never written there.
    // It is a live node in BOTH modes (graft: composed; deferred: the nested
    // placement's reference node survives the bake and is materialised).
    const inner = h.findById(CELL_REF_NODE_ID);
    expect(inner, `the inner reference node exists (${mode})`).not.toBeNull();
    expect(getAssetOverrides(inner!)?.byAddress?.[ADDR]).toBeUndefined();
    const bytes = await save(h);
    expect(savedOverride(bytes, MACHINE_REF_NODE_ID, NESTED_ADDR)).toBe(250);

    await h.doc.undo();
    expect(hasOverride(machine, NESTED_ADDR)).toBe(false);

    const r = await openEditorDocumentBytes('p774-nested-reopen.glb', bytes, { mode });
    open.push(r);
    expect(slideValues(r)).toEqual({ extras: 250, live: 250 });
  });

  it.each(MODES)('a static intermediate (OUTER_DEEP, Mount/Cell_1): `#<id>` on Cell_1 (%s)', async (mode) => {
    const h = await openDoc(OUTER_DEEP_URL, mode);
    await setSpeed(h, 250);
    expect(overrideAt(refNode(h, CELL_REF_NODE_ID), ADDR)).toBe(250);
    expect(savedOverride(await save(h), CELL_REF_NODE_ID, ADDR)).toBe(250);
  });

  it.each(MODES)('MCP web_editor_set_field (command editor.setField) writes the same override (%s)', async (mode) => {
    const h = await openDoc(OUTER_URL, mode);
    const cell = refNode(h, CELL_REF_NODE_ID);
    const path = h.pathOf(h.nodeById(SLIDE_NODE_ID));
    const run = (impls['editor.setField'] as unknown as {
      run(ctx: CommandContext, a: { path: string; componentType: string; fieldName: string; valueJson: string }): Promise<Record<string, unknown>>;
    }).run;
    const ctx = { doc: h.doc, viewer: h.viewer, selection: [] } as unknown as CommandContext;
    const res = await run(ctx, { path, componentType: 'Drive', fieldName: 'TargetSpeed', valueJson: '275' });
    expect(res.value).toBe(275);
    expect(overrideAt(cell, ADDR)).toBe(275);
    expect(h.doc.document.opCount).toBe(1);
    expect(savedOverride(await save(h), CELL_REF_NODE_ID, ADDR)).toBe(275);
    await h.doc.undo();
    expect(hasOverride(cell, ADDR)).toBe(false);
  });

  it('slider-drag burst: 60 setField ops inside a reference — one coalesced entry, like own content (graft)', async () => {
    const h = await openDoc(OUTER_URL, 'graft');
    const cell = refNode(h, CELL_REF_NODE_ID);
    const slidePath = h.pathOf(h.nodeById(SLIDE_NODE_ID));

    // Own-content reference burst: a Drive on the document's own Frame.
    const framePath = h.pathOf(findByName(h.root, 'Frame')!);
    await h.doc.applyOp({ ...assetOpHeader(), kind: 'addComponent', nodePath: framePath, componentType: 'Drive', fields: { Direction: 'LinearX', TargetSpeed: 200 } });
    await new Promise((r) => setTimeout(r, 600)); // never coalesce with the add

    // The coalesce window is anchored on the first op's `ts`; a frozen clock
    // keeps all 60 inside it however slow the machine is (no load flake).
    const burst = (path: string): Promise<{ ms: number; entries: number }> => withFrozenClock(async () => {
      const before = h.doc.document.opCount;
      const t0 = performance.now();
      for (let i = 1; i <= 60; i++) {
        const node = h.viewer.registry!.getNode(path)!;
        const prev = (node.userData.realvirtual as { Drive: { TargetSpeed: unknown } }).Drive.TargetSpeed;
        await h.doc.setFieldAwaited(path, 'Drive', 'TargetSpeed', 200 + i, prev);
      }
      return { ms: performance.now() - t0, entries: h.doc.document.opCount - before };
    });
    const own = await burst(framePath);
    await new Promise((r) => setTimeout(r, 600));
    const placed = await burst(slidePath);
    console.log(`[plan-774 burst] 60 setField: own content ${own.ms.toFixed(1)} ms / ${own.entries} entries; `
      + `inside reference ${placed.ms.toFixed(1)} ms / ${placed.entries} entries`);

    expect(own.entries, 'own content: one coalesced entry').toBe(1);
    expect(placed.entries, 'same undo-stack growth as own content').toBe(own.entries);
    expect(overrideAt(cell, ADDR)).toBe(260);
    // The coalesced entry keeps the FIRST op's capture: one undo = no override.
    await h.doc.undo();
    expect(hasOverride(cell, ADDR)).toBe(false);
    expect(slideValues(h)).toEqual({ extras: ASSET_SPEED, live: ASSET_SPEED });
    // Redo of the coalesced entry: the override is back with the LAST value.
    await h.doc.redo();
    expect(overrideAt(cell, ADDR)).toBe(260);
    expect(slideValues(h)).toEqual({ extras: 260, live: 260 });
  });
});
