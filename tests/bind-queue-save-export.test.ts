// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Group, Object3D, Scene } from 'three';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import type { RVViewer } from '../src/core/rv-viewer';
import { enqueueBind, writeQueued } from '../src/core/hmi/rv-bind-queue';
import { setActiveEditTarget, type EditTarget } from '../src/core/hmi/rv-edit-target';
import { createSignalBindingPersistence } from '../src/plugins/signal-bind/signal-binding-persistence';
import { downloadAssetGlb } from '../src/core/editor/rv-asset-library-save';
import { exportAssetGlb } from '../src/core/editor/rv-asset-glb-export';
import { saveDocument, forgetSavedRevisions } from '../src/core/editor/rv-save-document';
import { editorDocumentView } from '@rv-private/plugins/asset-editor/editor-document-view';
import { scratchAssetDocument } from './helpers/scratch-asset-document';

vi.mock('../src/core/project/project-store', () => ({
  getProjectStore: () => ({ getBackend: () => backend, getProject: () => ({ id: 'settled-project', documents: [] }) }),
}));

const writes: Uint8Array[] = [];
const backend = {
  kind: 'browser', id: 'settled-backend', writable: true, isActive: true,
  async readDocument() { return null; },
  async listDocuments() { return []; },
  async writeDocument(_ref: unknown, bytes: Uint8Array) { writes.push(bytes); return { revision: 'saved' }; },
};

function rig() {
  const scene = new Scene();
  const root = new Group();
  root.name = 'Asset';
  scene.add(root);
  const node = new Object3D();
  node.name = 'Carrier';
  node.userData.realvirtual = { SignalLinks: { Mappings: [
    { componentPath: '.', slot: 'Enable', signal: 'test.enable', direction: 'plcOutput' },
  ] } };
  root.add(node);
  const registry = new NodeRegistry();
  root.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
  const viewer = {
    scene, currentModelRoot: root, registry, signalStore: null, transportManager: null,
    emit() {}, on: () => () => {}, getPlugin: () => undefined,
    markRenderDirty() {}, markShadowsDirty() {}, rebuildGroupedBvh() {}, refitRaycastSubtrees() {},
  } as unknown as RVViewer;
  const doc = scratchAssetDocument(viewer, 'Settled');
  const et: EditTarget = {
    available: true, documentKey: doc,
    setField: (...args) => doc.setField(...args),
    setFieldAsync: (...args) => doc.setFieldAwaited(...args),
    unsetField: (...args) => doc.unsetField(...args),
    withTransaction: (label, fn) => doc.withTransaction(label, fn),
  };
  setActiveEditTarget(et);
  const persistence = createSignalBindingPersistence(viewer, {
    kind: 'node', node, nodePath: NodeRegistry.computeNodePath(node), label: node.name,
  });
  const unbind = () => enqueueBind(et, async () => {
    // The inspector's queued mapping write, delayed before the first document op.
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    await writeQueued(persistence, et, []);
  });
  return { viewer, doc, unbind };
}

function mappingsIn(bytes: ArrayBuffer | Uint8Array): unknown[] {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const length = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(data.subarray(20, 20 + length)));
  const carrier = json.nodes.find((n: { name?: string }) => n.name === 'Carrier');
  expect(carrier).toBeDefined();
  return carrier.extras?.realvirtual?.SignalLinks?.Mappings ?? [];
}

beforeEach(() => { writes.length = 0; forgetSavedRevisions(); });
afterEach(() => { setActiveEditTarget(null); vi.restoreAllMocks(); });

describe('Unbind immediately followed by save or export (LOP 241)', () => {
  it('saves a previously clean asset with the mapping removed', async () => {
    const r = rig();
    try {
      expect(mappingsIn(await exportAssetGlb(r.viewer.currentModelRoot!, 'Before'))).toHaveLength(1);
      expect(r.doc.dirty).toBe(false);
      const unbind = r.unbind();
      const result = await saveDocument(r.viewer, r.doc);
      await unbind;
      expect(result.kind).toBe('saved');
      expect(writes).toHaveLength(1);
      expect(mappingsIn(writes[0])).toEqual([]);
      expect(r.doc.dirty).toBe(false);
    } finally { r.doc.dispose(); }
  });

  it('exports shared asset bytes with the mapping removed', async () => {
    const r = rig();
    try {
      expect(mappingsIn(await exportAssetGlb(r.viewer.currentModelRoot!, 'Before'))).toHaveLength(1);
      const unbind = r.unbind();
      const bytes = await editorDocumentView(r).actions.share!.getBytes({} as never);
      await unbind;
      expect(mappingsIn(bytes)).toEqual([]);
    } finally { r.doc.dispose(); }
  });

  it('downloads GLB bytes with the mapping removed', async () => {
    const r = rig();
    expect(mappingsIn(await exportAssetGlb(r.viewer.currentModelRoot!, 'Before'))).toHaveLength(1);
    let blob: Blob | undefined;
    vi.spyOn(URL, 'createObjectURL').mockImplementation((value) => { blob = value as Blob; return 'blob:test'; });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    try {
      const unbind = r.unbind();
      expect(await downloadAssetGlb(r.viewer, r.doc, 'Settled')).toBe(true);
      await unbind;
      expect(blob).toBeDefined();
      expect(mappingsIn(await blob!.arrayBuffer())).toEqual([]);
    } finally { r.doc.dispose(); }
  });
});
