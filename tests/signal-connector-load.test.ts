// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2227 Phase 1 acceptance — a real GLB with `SignalConnector` extras:
 *
 *  - the loader instantiates the component (scene-loader import), the slots
 *    resolve to signal paths, and the connector couples the signals;
 *  - the connector node and its source/target signal nodes survive the
 *    destructive bake (bake-picking rule 5: reference-target tags);
 *  - in the asset editor a slot edit is stored as the target ADDRESS (`#<NodeId>`),
 *    a bare path string is refused (component-model rule 4), and setField,
 *    undo and redo re-check the connector (FA5).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BoxGeometry, Mesh, MeshStandardMaterial, Object3D, Scene } from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import type { RVViewer } from '../src/core/rv-viewer';
import { loadGLB, type LoadResult } from '../src/core/engine/rv-scene-loader';
import type { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { identityIdOf } from '../src/core/engine/rv-decode-identity';
import { bareStringReferenceRefusal, referenceFieldShape } from '../src/core/hmi/rv-reference-field';
import { RVSignalConnector, SIGNAL_CONNECTOR_PROBLEM_CODES } from '../src/core/engine/rv-signal-connector';
import { getCapabilities } from '../src/core/engine/rv-component-registry';
import { categoryOf } from '../src/core/engine/rv-component-category';
import { getProblems, resetProblemsForTests } from '../src/core/hmi/problems-store';
import { resetSlotAuthority } from '../src/core/engine/rv-slot-authority';
import { scratchAssetDocument } from './helpers/scratch-asset-document';
import { loadBakedGLB } from './helpers/load-baked-glb';

beforeEach(() => { resetSlotAuthority(); resetProblemsForTests(); });
afterEach(() => { resetSlotAuthority(); resetProblemsForTests(); });

function child(parent: Object3D, name: string, extras?: Record<string, unknown>): Object3D {
  const n = new Object3D();
  n.name = name;
  if (extras) n.userData.realvirtual = extras;
  parent.add(n);
  return n;
}

const ref = (path: string) => ({ type: 'ComponentReference', path });

/** Cell → Body (mesh), Signals/{RobotReady, Rob_Ready, RobotMode, Rob_Auto}, Coupler, AutoBit. */
async function fixtureBytes(): Promise<ArrayBuffer> {
  const src = new Scene();
  src.name = 'Cell';
  const body = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ color: 0x336699 }));
  body.name = 'Body';
  src.add(body);
  const signals = child(src, 'Signals');
  child(signals, 'RobotReady', { PLCOutputBool: { Name: 'RobotReady', Status: { Value: false } } });
  child(signals, 'Rob_Ready', { PLCInputBool: { Name: 'Rob_Ready', Status: { Value: false } } });
  child(signals, 'RobotMode', { PLCOutputInt: { Name: 'RobotMode', Status: { Value: 0 } } });
  child(signals, 'Rob_Auto', { PLCInputBool: { Name: 'Rob_Auto', Status: { Value: false } } });
  child(src, 'Coupler', {
    SignalConnector: { Mode: 'Copy', Enabled: true, SourceBool: ref('Signals/RobotReady'), TargetBool: ref('Signals/Rob_Ready') },
  });
  child(src, 'AutoBit', {
    SignalConnector: { Mode: 'BitFromWord', Bit: 2, Width: 'Word', SourceInt: ref('Signals/RobotMode'), TargetBool: ref('Signals/Rob_Auto') },
  });
  return (await new GLTFExporter().parseAsync(src, { binary: true })) as ArrayBuffer;
}

function connectorAt(registry: NodeRegistry, path: string): RVSignalConnector {
  const entry = registry.getComponentsAt(path)?.find(([type]) => type === 'SignalConnector');
  expect(entry, `SignalConnector at ${path}`).toBeDefined();
  return entry![1] as unknown as RVSignalConnector;
}

/** A renderer-free asset-editor viewer over a loaded tree (pattern of `editor-setfield-reference-shape`). */
function editorViewer(scene: Scene, root: Object3D, registry: NodeRegistry): RVViewer {
  return {
    scene,
    registry,
    signalStore: null,
    transportManager: null,
    get currentModelRoot() { return root; },
    drives: [],
    markRenderDirty() {},
    markShadowsDirty() {},
    emit() {},
    on() { return () => {}; },
    rebuildGroupedBvh() {},
    refitRaycastSubtrees() {},
    rebuildIKPaths() {},
    getPlugin: () => undefined,
    instancePickIndex: undefined,
    buildMeshBvhsAsync() {},
    selectionManager: { select() {} },
  } as unknown as RVViewer;
}

describe('SignalConnector — real GLB load (baked)', () => {
  let result: LoadResult;

  beforeEach(async () => {
    // The production path: the destructive bake (bake-test-path-enforced).
    result = await loadBakedGLB('signal-connector.glb', new Scene(), { data: await fixtureBytes() });
  });

  it('declares its capabilities and category', () => {
    const caps = getCapabilities('SignalConnector');
    expect(caps.authorable).toBe(true);
    expect(caps.carriesToPlacementRoot).toBe(true);
    expect(categoryOf('SignalConnector').category).toBe('signals');
  });

  it('instantiates the component and resolves the slots to signal paths', () => {
    const c = connectorAt(result.registry, 'Cell/Coupler');
    expect(c).toBeInstanceOf(RVSignalConnector);
    expect(typeof c.SourceBool).toBe('string');
    expect(typeof c.TargetBool).toBe('string');
    expect(c.isActive).toBe(true);
    expect(getProblems().filter((p) => p.code.startsWith('signal-connector-'))).toEqual([]);
  });

  it('couples the signals: Copy and BitFromWord', () => {
    const store = result.signalStore;
    store.set('RobotReady', true);
    expect(store.get('Rob_Ready')).toBe(true);
    store.set('RobotMode', 4);
    expect(store.get('Rob_Auto')).toBe(true);
    store.set('RobotMode', 3);
    expect(store.get('Rob_Auto')).toBe(false);
  });

  it('the connector and its source/target signal nodes survive the bake', () => {
    for (const path of ['Cell/Coupler', 'Cell/AutoBit', 'Cell/Signals/RobotReady', 'Cell/Signals/Rob_Ready', 'Cell/Signals/RobotMode', 'Cell/Signals/Rob_Auto']) {
      expect(result.registry.getNode(path), path).toBeTruthy();
    }
  });

  it('the writer identity is the node address', () => {
    const c = connectorAt(result.registry, 'Cell/Coupler');
    const id = identityIdOf(result.registry.getNode('Cell/Coupler')!);
    expect(id).toBeTruthy();
    expect(c.instanceAddress).toBe(`#${id}`);
  });
});

describe('SignalConnector — asset editor (addresses, refusal, re-check on edit/undo/redo)', () => {
  async function editorLoad() {
    const scene = new Scene();
    const r = await loadGLB('signal-connector-editor.glb', scene, { data: await fixtureBytes(), preserveHierarchy: true });
    return { scene, ...r };
  }

  it('all six slots are single references that refuse a bare path string', () => {
    for (const slot of ['SourceBool', 'SourceInt', 'SourceFloat', 'TargetBool', 'TargetInt', 'TargetFloat']) {
      expect(referenceFieldShape('SignalConnector', slot), slot).toBe('single');
      expect(bareStringReferenceRefusal('SignalConnector', slot, 'Signals/RobotReady'), slot).not.toBeNull();
    }
  });

  it('a slot edit is stored as #NodeId; setField, undo and redo re-check the connector', async () => {
    const { scene, root, registry, signalStore } = await editorLoad();
    const doc = scratchAssetDocument(editorViewer(scene, root, registry));
    const node = registry.getNode('Cell/Coupler')!;
    const c = connectorAt(registry, 'Cell/Coupler');
    const raw = () => (node.userData.realvirtual as Record<string, Record<string, unknown>>).SignalConnector;
    const unresolved = () => getProblems().filter((p) => p.code === SIGNAL_CONNECTOR_PROBLEM_CODES.unresolved);

    // Clear the target: the connector reports itself unresolved and stops writing.
    const before = raw().TargetBool;
    await doc.setFieldAwaited('Cell/Coupler', 'SignalConnector', 'TargetBool', null, before);
    expect(unresolved()).toHaveLength(1);
    expect(c.isActive).toBe(false);

    // Undo: the original reference is back, no problem, the connector writes.
    await doc.undo();
    expect(unresolved()).toHaveLength(0);
    expect(c.isActive).toBe(true);
    signalStore.set('RobotReady', true);
    expect(signalStore.get('Rob_Ready')).toBe(true);

    // Redo: unresolved again.
    await doc.redo();
    expect(unresolved()).toHaveLength(1);

    // Bind through the object form: stored as the target address.
    const targetId = identityIdOf(registry.getNode('Cell/Signals/Rob_Ready')!);
    await doc.setFieldAwaited('Cell/Coupler', 'SignalConnector', 'TargetBool',
      { type: 'ComponentReference', path: 'Signals/Rob_Ready', componentType: '' }, raw().TargetBool);
    expect(raw().TargetBool).toMatchObject({ type: 'ComponentReference', address: `#${targetId}` });
    expect(unresolved()).toHaveLength(0);
    expect(c.isActive).toBe(true);
    doc.dispose();
  });
});
