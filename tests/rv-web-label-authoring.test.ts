// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-529 §9.1b / §9.3b / §9.5 — authoring a `WebLabel` through the REAL
 * document ops and the REAL viewer:
 *
 *  - editor add-component on a node → the label appears and is registered with
 *    the manager THROUGH the editor path (`_runtimeDeps` threads the manager);
 *  - `setField` / `unsetField` on Text, TextColor, PlateWidth, Offset, Url →
 *    `reapplyConfig()`; Mode Billboard → Plate → Billboard swaps the visual
 *    without leaks; undo / redo;
 *  - auto-sized plates rebuild geometry on text / FontSize change (SOL R2-6);
 *  - a main model with a label plus two placements with labels (the placement
 *    init context carries the manager — plan-757 F4); disposing one placement's
 *    subtree (the primitive the planner's removal uses) unregisters ONLY its
 *    labels;
 *  - the multi-line Text renderer is registered through the `App.tsx` import
 *    path and writes through `persistFieldOp`.
 */
import { afterAll, afterEach, beforeAll, describe, it, expect } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D, Scene, Sprite, type Material } from 'three';
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { createElement, type ComponentType } from 'react';
import appSource from '../src/core/hmi/App.tsx?raw';
import type { RVViewer } from '../src/core/rv-viewer';
import '../src/core/engine/rv-scene-loader';
import { disposeComponentsInSubtree } from '../src/core/engine/rv-scene-loader';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import { WebLabelManager } from '../src/core/engine/rv-web-label-manager';
import { RVWebLabel, WEB_LABEL_TYPE } from '../src/core/engine/rv-web-label';
import { getSchemaDefaults } from '../src/core/engine/rv-component-registry';
import { scratchAssetDocument } from './helpers/scratch-asset-document';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { ModelCache } from '../src/core/engine/rv-model-cache';
import { createPickBuildPort } from '../src/core/engine/rv-pick-build-port';
import { referenceNode } from './helpers/nested-placement-fixture';
import { fieldRendererRegistry, type FieldRendererProps } from '../src/core/hmi/rv-field-renderer-registry';
import { setActiveEditTarget, type EditTarget } from '../src/core/hmi/rv-edit-target';

// ─── Mock-viewer harness for the document ops ─────────────────────────

function makeEditorViewer() {
  const scene = new Scene();
  const model = new Group();
  model.name = 'Asset';
  scene.add(model);
  const box = new Object3D();
  box.name = 'Box';
  model.add(box);
  const registry = new NodeRegistry();
  model.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
  const webLabelManager = new WebLabelManager();
  const viewer = {
    scene,
    registry,
    signalStore: new SignalStore(),
    transportManager: new RVTransportManager(),
    webLabelManager,
    get currentModelRoot() { return model; },
    markRenderDirty() {},
    markShadowsDirty() {},
    emit() {},
    rebuildGroupedBvh() {},
  } as unknown as RVViewer;
  return { viewer, box, boxPath: NodeRegistry.computeNodePath(box), registry, webLabelManager };
}

function labelAt(registry: NodeRegistry, path: string): RVWebLabel | null {
  return registry.getByPath<RVWebLabel>(WEB_LABEL_TYPE, path) ?? null;
}

function plateSize(label: RVWebLabel): { w: number; h: number } {
  const geo = (label.visual!.object as Mesh).geometry;
  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  return { w: bb.max.x - bb.min.x, h: bb.max.y - bb.min.y };
}

describe('editor add-component + field ops (§9.1b)', () => {
  it('add-component makes the label appear and registers it through the editor path; undo removes it', async () => {
    const { viewer, box, boxPath, registry, webLabelManager } = makeEditorViewer();
    const doc = scratchAssetDocument(viewer);
    doc.addComponent(boxPath, WEB_LABEL_TYPE, { ...getSchemaDefaults(WEB_LABEL_TYPE), Text: 'Hello' });
    await doc.whenIdle();
    const label = labelAt(registry, boxPath)!;
    expect(label).toBeTruthy();
    expect(webLabelManager.has(label)).toBe(true);
    expect(label.visual!.object.parent).toBe(box);
    await doc.undo();
    expect(webLabelManager.size).toBe(0);
    expect(box.children.length).toBe(0);
    await doc.redo();
    expect(webLabelManager.size).toBe(1);
    doc.dispose();
  });

  it('setField Text / TextColor / PlateWidth / Offset / Url and unsetField reapply live', async () => {
    const { viewer, boxPath, registry } = makeEditorViewer();
    const doc = scratchAssetDocument(viewer);
    doc.addComponent(boxPath, WEB_LABEL_TYPE, { ...getSchemaDefaults(WEB_LABEL_TYPE), Mode: 'Plate', Text: 'One' });
    await doc.whenIdle();
    const label = labelAt(registry, boxPath)!;
    const w0 = plateSize(label).w;

    doc.setField(boxPath, WEB_LABEL_TYPE, 'Text', 'One two three four', 'One');
    await doc.whenIdle();
    expect(plateSize(label).w).toBeGreaterThan(w0 * 2);

    const mat = label.visual!.material as Material & { map: unknown };
    const texBefore = mat.map;
    doc.setField(boxPath, WEB_LABEL_TYPE, 'TextColor', { r: 1, g: 0, b: 0, a: 1 }, undefined);
    await doc.whenIdle();
    expect(mat.map).not.toBe(texBefore);

    doc.setField(boxPath, WEB_LABEL_TYPE, 'PlateWidth', 700, 0);
    await doc.whenIdle();
    expect(plateSize(label).w).toBeCloseTo(0.7, 6);

    doc.setField(boxPath, WEB_LABEL_TYPE, 'Offset', { x: 0, y: 250, z: 0 }, { x: 0, y: 0, z: 0 });
    await doc.whenIdle();
    expect(label.visual!.object.position.y).toBeCloseTo(0.25, 9);

    doc.setField(boxPath, WEB_LABEL_TYPE, 'Url', 'https://example.com/a', '');
    await doc.whenIdle();
    expect(label.visual!.linkUrl).toBe('https://example.com/a');

    doc.unsetField(boxPath, WEB_LABEL_TYPE, 'PlateWidth', 700);
    await doc.whenIdle();
    expect(plateSize(label).w).toBeLessThan(0.7);

    await doc.undo(); // unset PlateWidth
    expect(plateSize(label).w).toBeCloseTo(0.7, 6);
    doc.dispose();
  });

  it('Mode Billboard → Plate → Billboard swaps the visual without leaks; undo/redo', async () => {
    const { viewer, box, boxPath, registry, webLabelManager } = makeEditorViewer();
    const doc = scratchAssetDocument(viewer);
    doc.addComponent(boxPath, WEB_LABEL_TYPE, { ...getSchemaDefaults(WEB_LABEL_TYPE), Text: 'Swap' });
    await doc.whenIdle();
    const label = labelAt(registry, boxPath)!;
    const first = label.visual!;
    expect(first.object).toBeInstanceOf(Sprite);
    const disposed: string[] = [];
    first.material.addEventListener('dispose', () => disposed.push('sprite-material'));

    doc.setField(boxPath, WEB_LABEL_TYPE, 'Mode', 'Plate', 'Billboard');
    await doc.whenIdle();
    const plate = label.visual!;
    expect(plate.object).toBeInstanceOf(Mesh);
    expect(disposed).toEqual(['sprite-material']);
    expect(box.children).toEqual([plate.object]);
    (plate.object as Mesh).geometry.addEventListener('dispose', () => disposed.push('plate-geometry'));

    doc.setField(boxPath, WEB_LABEL_TYPE, 'Mode', 'Billboard', 'Plate');
    await doc.whenIdle();
    expect(label.visual!.object).toBeInstanceOf(Sprite);
    expect(disposed).toContain('plate-geometry');
    expect(box.children.length).toBe(1);
    expect(webLabelManager.size).toBe(1);

    // Two quick edits of the same field may coalesce into one undo step (the
    // document's coalescing window), so assert the INVARIANT: after undo and
    // redo the visual is whatever the document's Mode says, exactly once.
    const modeNow = () => ((box.userData.realvirtual as Record<string, Record<string, unknown>>).WebLabel.Mode);
    const expectConsistent = () => {
      expect(label.visual!.object).toBeInstanceOf(modeNow() === 'Plate' ? Mesh : Sprite);
      expect(box.children.length).toBe(1);
      expect(webLabelManager.size).toBe(1);
    };
    await doc.undo();
    expectConsistent();
    await doc.redo();
    expect(label.visual!.object).toBeInstanceOf(Sprite);
    expectConsistent();
    doc.dispose();
  });

  it('auto-sized Plate: more lines / bigger FontSize grow the geometry; mixed explicit/auto; undo restores (SOL R2-6)', async () => {
    const { viewer, boxPath, registry } = makeEditorViewer();
    const doc = scratchAssetDocument(viewer);
    doc.addComponent(boxPath, WEB_LABEL_TYPE, { ...getSchemaDefaults(WEB_LABEL_TYPE), Mode: 'Plate', Text: 'A', FontSize: 20 });
    await doc.whenIdle();
    const label = labelAt(registry, boxPath)!;
    const s0 = plateSize(label);
    doc.setField(boxPath, WEB_LABEL_TYPE, 'Text', 'A\nB\nC', 'A');
    await doc.whenIdle();
    const s1 = plateSize(label);
    expect(s1.h).toBeGreaterThan(s0.h * 2);
    doc.setField(boxPath, WEB_LABEL_TYPE, 'FontSize', 40, 20);
    await doc.whenIdle();
    const s2 = plateSize(label);
    expect(s2.h).toBeCloseTo(s1.h * 2, 3);
    // Mixed: explicit width, auto height.
    doc.setField(boxPath, WEB_LABEL_TYPE, 'PlateWidth', 900, 0);
    await doc.whenIdle();
    const s3 = plateSize(label);
    expect(s3.w).toBeCloseTo(0.9, 6);
    expect(s3.h).toBeCloseTo(s2.h, 6);
    await doc.undo(); // PlateWidth
    await doc.undo(); // FontSize
    expect(plateSize(label).h).toBeCloseTo(s1.h, 6);
    await doc.undo(); // Text
    expect(plateSize(label).h).toBeCloseTo(s0.h, 6);
    doc.dispose();
  });
});

// ─── Real viewer: main model + two placements ─────────────────────────

const CELL_URL = 'blob:rv-test/p529-labelled-cell.glb';

function labelledCell(): Group {
  const root = new Group();
  root.name = 'LabelCell';
  const body = new Mesh(new BoxGeometry(1, 0.5, 1), new MeshStandardMaterial({ color: 0x336699 }));
  body.name = 'Body';
  root.add(body);
  const tag = new Object3D();
  tag.name = 'CellTag';
  tag.position.set(0, 1, 0);
  tag.userData.realvirtual = { WebLabel: { Text: 'Cell' } };
  root.add(tag);
  return root;
}

describe('placements carry the manager (§9.1b, plan-757)', () => {
  let h: TestViewerHandle | null = null;
  afterEach(() => { h?.dispose(); h = null; });

  it('main label + two placements; disposing one placement subtree unregisters only its label', async () => {
    h = await createTestViewer('webgl');
    const loader = { loadAsync: async () => ({ scene: labelledCell() }) } as unknown as GLTFLoader;
    h.viewer.placements.setModelCache(new ModelCache(loader, {
      uber: () => h!.viewer.placementUberMaterial,
      isWebGPU: () => h!.viewer.isWebGPU,
      pickPort: () => createPickBuildPort({ createWorker: () => null }),
    }));
    h.viewer.setSimulationPaused('p529', true);
    const doc = new Group();
    doc.name = 'Layout';
    const mainTag = new Object3D();
    mainTag.name = 'MainTag';
    mainTag.userData.realvirtual = { WebLabel: { Text: 'Main', Mode: 'Plate' } };
    doc.add(mainTag);
    doc.add(referenceNode('Cell_1', 'nid-c1', CELL_URL, true, [3, 0, 0]));
    doc.add(referenceNode('Cell_2', 'nid-c2', CELL_URL, true, [6, 0, 0]));
    await h.viewer.loadModel('p529.glb', { data: await objectToGlb(doc) });
    await h.viewer.whenSceneReady();

    const mgr = h.viewer.webLabelManager;
    expect(mgr.size).toBe(3);
    const reg = h.viewer.registry!;
    const labels = reg.getAll<RVWebLabel>(WEB_LABEL_TYPE).map((e) => e.instance);
    expect(labels).toHaveLength(3);
    const byPlacement = (name: string) => labels.find((l) => {
      for (let o: Object3D | null = l.node; o; o = o.parent) if (o.name === name) return true;
      return false;
    })!;
    const l1 = byPlacement('Cell_1');
    const l2 = byPlacement('Cell_2');
    expect(l1).toBeTruthy();
    expect(l2).toBeTruthy();
    expect(l1).not.toBe(l2);

    let cell1: Object3D | null = null;
    h.viewer.currentModelRoot!.traverse((o) => { if (o.name === 'Cell_1') cell1 = o; });
    disposeComponentsInSubtree(reg, cell1 as unknown as Object3D);
    expect(mgr.size).toBe(2);
    expect(mgr.has(l1)).toBe(false);
    expect(mgr.has(l2)).toBe(true);
  }, 60_000);
});

// ─── Field renderer bootstrap (§9.5) ──────────────────────────────────

describe('multi-line Text renderer (F8)', () => {
  let Renderer: ComponentType<FieldRendererProps>;
  beforeAll(async () => {
    await import('../src/core/hmi/App');
    const found = fieldRendererRegistry.getRenderer(WEB_LABEL_TYPE, 'Text');
    if (!found) throw new Error('WebLabel.Text has no field renderer after importing App.tsx');
    Renderer = found;
  }, 180_000);
  afterEach(() => { cleanup(); setActiveEditTarget(null); });
  afterAll(() => setActiveEditTarget(null));

  it('App.tsx side-effect-imports the renderer', () => {
    expect(appSource).toContain("import './rv-web-label-text-field-renderer';");
  });

  it('renders a multi-line field and commits on blur through the active edit target', () => {
    const writes: unknown[][] = [];
    setActiveEditTarget({
      available: true,
      setField: (...args: unknown[]) => { writes.push(args); },
    } as unknown as EditTarget);
    render(createElement(Renderer, {
      value: 'Line 1', fieldName: 'Text', componentType: WEB_LABEL_TYPE, nodePath: 'Asset/Box', viewer: null, signalStore: null,
    }));
    const input = screen.getByTestId('rv-web-label-text-input') as HTMLTextAreaElement;
    expect(input.tagName).toBe('TEXTAREA');
    fireEvent.change(input, { target: { value: 'Line 1\nLine 2' } });
    expect(writes).toHaveLength(0); // not per keystroke
    fireEvent.blur(input);
    expect(writes).toEqual([['Asset/Box', WEB_LABEL_TYPE, 'Text', 'Line 1\nLine 2', 'Line 1']]);
  });
});

