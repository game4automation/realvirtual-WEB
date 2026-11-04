// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2227 Phase 2 — the SignalConnector's commands in the asset editor:
 *
 *  - `editor.addComponent` creates a SignalConnector (authorable);
 *  - `signalConnector.setMode` sets Mode AND clears the slots the Mode does not
 *    use in ONE undo step; switch + switch back + undo/redo restore the start;
 *  - `editor.setField(…, 'Mode', …)` on a SignalConnector acts like setMode;
 *  - `signalConnector.createBits` creates children Bit00… with one bit connector
 *    each in ONE undo step (R9); its macro args are fully resolved (the
 *    selection is gone), so a replay under another selection does the same;
 *  - `signalConnector.list` reads every connector;
 *  - save round trip: a connector authored by the commands is written with
 *    `#NodeId` addresses (no path) and couples again after the reload.
 *
 * PRIVATE-DEPENDENT (`editor.addComponent` / `editor.setField` live with the
 * asset editor): listed in `tests/private-dependent-tests.json`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BoxGeometry, Mesh, MeshStandardMaterial, Object3D, Scene } from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import type { RVViewer } from '../src/core/rv-viewer';
import { loadGLB } from '../src/core/engine/rv-scene-loader';
import type { NodeRegistry } from '../src/core/engine/rv-node-registry';
import type { SignalStore } from '../src/core/engine/rv-signal-store';
import { identityIdOf } from '../src/core/engine/rv-decode-identity';
import { RVSignalConnector } from '../src/core/engine/rv-signal-connector';
import { exportAssetGlb } from '../src/core/editor/rv-asset-glb-export';
import { readGlbJson } from '../src/core/engine/rv-binary-resources';
import type { AssetDocument } from '../src/core/editor/rv-asset-document';
import type { CommandContext, CommandImpl } from '../src/core/hmi/rv-command-registry';
import {
  signalConnectorCreateBitsImpl,
  signalConnectorListImpl,
  signalConnectorSetModeImpl,
  type SignalConnectorCreateBitsArgs,
} from '../src/core/hmi/signal-connector-commands';
import { getProblems, resetProblemsForTests } from '../src/core/hmi/problems-store';
import { resetSlotAuthority } from '../src/core/engine/rv-slot-authority';
import { scratchAssetDocument } from './helpers/scratch-asset-document';
import { loadBakedGLB } from './helpers/load-baked-glb';
import { impls } from '@rv-private/plugins/asset-editor/editor-commands';

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

/** Cell → Body, Signals/{RobotReady, Rob_Ready, RobotMode, StatusWord, B0..B3}, Coupler (Copy BOOL), Unpacker, Packer. */
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
  child(signals, 'StatusWord', { PLCInputInt: { Name: 'StatusWord', Status: { Value: 0 } } });
  for (let i = 0; i < 4; i++) child(signals, `B${i}`, { PLCInputBool: { Name: `B${i}`, Status: { Value: false } } });
  for (let i = 0; i < 2; i++) child(signals, `S${i}`, { PLCOutputBool: { Name: `S${i}`, Status: { Value: false } } });
  child(src, 'Coupler', {
    SignalConnector: { Mode: 'Copy', Enabled: true, SourceBool: ref('Signals/RobotReady'), TargetBool: ref('Signals/Rob_Ready') },
  });
  child(src, 'Unpacker');
  child(src, 'Packer');
  child(src, 'Fresh');
  return (await new GLTFExporter().parseAsync(src, { binary: true })) as ArrayBuffer;
}

function editorViewer(scene: Scene, root: Object3D, registry: NodeRegistry, signalStore: SignalStore): RVViewer {
  return {
    scene,
    registry,
    signalStore,
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
    selectionManager: { select() {}, clear() {} },
  } as unknown as RVViewer;
}

async function rig() {
  const scene = new Scene();
  const r = await loadGLB('signal-connector-commands.glb', scene, { data: await fixtureBytes(), preserveHierarchy: true });
  const viewer = editorViewer(scene, r.root, r.registry, r.signalStore);
  const doc = scratchAssetDocument(viewer) as AssetDocument;
  const ctx = (selection: string[] = []): CommandContext =>
    ({ doc, viewer, selection, mode: 'editor', handle: null } as unknown as CommandContext);
  const rv = (path: string): Record<string, Record<string, unknown>> =>
    (r.registry.getNode(path)!.userData.realvirtual ?? {}) as Record<string, Record<string, unknown>>;
  return { ...r, scene, viewer, doc, ctx, rv };
}

type Impl = CommandImpl<unknown, unknown>;
const run = async (impl: Impl, ctx: CommandContext, args: unknown) => {
  expect(impl.enabled(ctx, args)).toBe(true);
  return impl.run(ctx, args);
};

describe('SignalConnector commands (plan-2227 Phase 2)', () => {
  it('editor.addComponent creates a SignalConnector (authorable)', async () => {
    const t = await rig();
    await run(impls['editor.addComponent'] as unknown as Impl, t.ctx(), { path: 'Cell/Fresh', type: 'SignalConnector', propsJson: null });
    expect(t.rv('Cell/Fresh').SignalConnector).toMatchObject({ Mode: 'Copy', Enabled: true });
    t.doc.dispose();
  });

  it('setMode clears the unused slots in one undo step; switch, switch back and undo/redo restore the start', async () => {
    const t = await rig();
    const setMode = signalConnectorSetModeImpl as unknown as Impl;
    const start = JSON.stringify(t.rv('Cell/Coupler').SignalConnector);
    const ops0 = t.doc.document.opCount;

    const res = await run(setMode, t.ctx(), { path: 'Cell/Coupler', mode: 'BitFromWord' }) as { cleared: string[] };
    expect(res.cleared).toEqual(['SourceBool']);
    const after = t.rv('Cell/Coupler').SignalConnector;
    expect(after.Mode).toBe('BitFromWord');
    expect(after.SourceBool ?? null).toBeNull();
    expect(after.TargetBool).toBeTruthy();
    // No stray inactive slot → no slot-mismatch warning.
    expect(getProblems().some((p) => p.code === 'signal-connector-slot-mismatch')).toBe(false);

    await run(setMode, t.ctx(), { path: 'Cell/Coupler', mode: 'Copy' });
    expect(t.rv('Cell/Coupler').SignalConnector.Mode).toBe('Copy');
    // Two undo steps back to the exact start.
    await t.doc.undo();
    await t.doc.undo();
    expect(t.doc.document.opCount).toBe(ops0);
    expect(JSON.stringify(t.rv('Cell/Coupler').SignalConnector)).toBe(start);
    const c = t.registry.getByPath('SignalConnector', 'Cell/Coupler') as RVSignalConnector;
    expect(c.isActive).toBe(true);
    // Redo replays the first switch as one step.
    await t.doc.redo();
    expect(t.rv('Cell/Coupler').SignalConnector.Mode).toBe('BitFromWord');
    expect(t.rv('Cell/Coupler').SignalConnector.SourceBool ?? null).toBeNull();
    t.doc.dispose();
  });

  it('editor.setField on Mode runs setMode; an unknown Mode is refused', async () => {
    const t = await rig();
    const setField = impls['editor.setField'] as unknown as Impl;
    expect(setField.enabled(t.ctx(), { path: 'Cell/Coupler', componentType: 'SignalConnector', fieldName: 'Mode', valueJson: '"Bogus"' }))
      .toMatchObject({ reason: expect.stringContaining('mode must be') });
    const res = await run(setField, t.ctx(), { path: 'Cell/Coupler', componentType: 'SignalConnector', fieldName: 'Mode', valueJson: '"IntToBool"' }) as Record<string, unknown>;
    expect(res.redirectedTo).toBe('signalConnector.setMode');
    expect(t.rv('Cell/Coupler').SignalConnector.Mode).toBe('IntToBool');
    expect(t.rv('Cell/Coupler').SignalConnector.SourceBool ?? null).toBeNull();
    // One undo step restores Mode AND the slot.
    await t.doc.undo();
    expect(t.rv('Cell/Coupler').SignalConnector.Mode).toBe('Copy');
    expect(t.rv('Cell/Coupler').SignalConnector.SourceBool).toBeTruthy();
    t.doc.dispose();
  });

  it('createBits: 16 children Bit00…Bit15 in one undo step; resolved macro args replay identically under another selection', async () => {
    const t = await rig();
    const create = signalConnectorCreateBitsImpl as unknown as CommandImpl<SignalConnectorCreateBitsArgs, unknown>;
    const live: SignalConnectorCreateBitsArgs = { path: null, mode: 'BitFromWord', word: 'Cell/Signals/RobotMode', bits: '0-15' };
    const resolved = create.resolveArgs!(t.ctx(['Cell/Unpacker']), live);
    expect(resolved).toEqual({
      path: 'Cell/Unpacker', mode: 'BitFromWord', word: 'Cell/Signals/RobotMode', bits: '0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15',
      signals: Array(16).fill(''), width: 'Word', signed: true, invert: false,
    });

    const ops0 = t.doc.document.opCount;
    await run(create as unknown as Impl, t.ctx(['Cell/Unpacker']), live);
    const unpacker = t.registry.getNode('Cell/Unpacker')!;
    const names = () => unpacker.children.map((c) => c.name).filter((n) => /^Bit\d\d$/.test(n));
    expect(names()).toEqual(Array.from({ length: 16 }, (_, i) => `Bit${String(i).padStart(2, '0')}`));
    const bit5 = t.rv('Cell/Unpacker/Bit05').SignalConnector;
    expect(bit5).toMatchObject({ Mode: 'BitFromWord', Bit: 5, Width: 'Word', Enabled: true });
    expect(bit5.SourceInt).toMatchObject({ type: 'ComponentReference' });
    const snapshot = JSON.stringify(unpacker.children.map((c) => [c.name, c.userData.realvirtual]));

    // One undo step removes all 16.
    await t.doc.undo();
    expect(names()).toEqual([]);
    expect(t.doc.document.opCount).toBe(ops0);

    // Replay of the recorded (resolved) line while something else is selected.
    await run(create as unknown as Impl, t.ctx(['Cell/Packer']), resolved);
    expect(JSON.stringify(unpacker.children.map((c) => [c.name, c.userData.realvirtual]))).toBe(snapshot);
    expect(t.registry.getNode('Cell/Packer')!.children).toHaveLength(0);

    // Same bits again: refused (the children exist).
    expect(create.enabled(t.ctx(), resolved)).toMatchObject({ reason: expect.stringContaining('already has a child "Bit00"') });
    t.doc.dispose();
  });

  it('createBits BitToWord with bool sources wires one word; bad arguments are refused on the args', async () => {
    const t = await rig();
    const create = signalConnectorCreateBitsImpl as unknown as Impl;
    await run(create, t.ctx(), {
      path: 'Cell/Packer', mode: 'BitToWord', word: 'Cell/Signals/StatusWord', bits: [0, 1],
      signals: ['Cell/Signals/S0', 'Cell/Signals/S1'],
    });
    expect(t.rv('Cell/Packer/Bit01').SignalConnector).toMatchObject({
      Mode: 'BitToWord', Bit: 1, TargetInt: { type: 'ComponentReference' }, SourceBool: { type: 'ComponentReference' },
    });
    expect(create.enabled(t.ctx(), { path: 'Cell/Packer', mode: 'Copy', word: 'Cell/Signals/StatusWord', bits: '0' }))
      .toEqual({ reason: 'mode must be BitFromWord | BitToWord' });
    expect(create.enabled(t.ctx(), { path: 'Cell/Packer', mode: 'BitToWord', word: 'Cell/Signals/RobotReady', bits: '4' }))
      .toMatchObject({ reason: expect.stringContaining('needs a INT signal') });
    expect(create.enabled(t.ctx(), { path: 'Cell/Packer', mode: 'BitToWord', word: 'Cell/Signals/StatusWord', bits: '8', width: 'Byte' }))
      .toMatchObject({ reason: expect.stringContaining('outside a Byte') });
    expect(create.enabled(t.ctx(), { path: 'Cell/Packer', mode: 'BitToWord', word: 'Cell/Signals/StatusWord', bits: '4', signals: ['Cell/Signals/RobotMode'] }))
      .toMatchObject({ reason: expect.stringContaining('needs a BOOL signal') });
    t.doc.dispose();
  });

  it('signalConnector.list reads address, Mode, slots, values and problems', async () => {
    const t = await rig();
    t.signalStore.set('RobotReady', true);
    const list = await signalConnectorListImpl.run(t.ctx(), {}) as unknown as { connectors: Array<Record<string, unknown>>; count: number };
    const coupler = list.connectors.find((e) => e.path === 'Cell/Coupler')!;
    expect(coupler).toMatchObject({
      mode: 'Copy', enabled: true, active: true, problems: [],
      source: { slot: 'SourceBool', signal: 'RobotReady', value: true },
      target: { slot: 'TargetBool', signal: 'Rob_Ready', value: true },
    });
    expect(String(coupler.address)).toMatch(/^#/);
    const filtered = await signalConnectorListImpl.run(t.ctx(), { path: 'Cell/Nowhere' }) as { count: number };
    expect(filtered.count).toBe(0);
    t.doc.dispose();
  });

  it('save round trip: a connector authored by the commands is stored as #NodeId addresses and couples after the reload', async () => {
    const t = await rig();
    await run(impls['editor.addComponent'] as unknown as Impl, t.ctx(), { path: 'Cell/Fresh', type: 'SignalConnector', propsJson: null });
    await run(signalConnectorSetModeImpl as unknown as Impl, t.ctx(), { path: 'Cell/Fresh', mode: 'BitFromWord' });
    const setField = impls['editor.setField'] as unknown as Impl;
    await run(setField, t.ctx(), { path: 'Cell/Fresh', componentType: 'SignalConnector', fieldName: 'SourceInt', valueJson: '"Cell/Signals/RobotMode"' });
    await run(setField, t.ctx(), { path: 'Cell/Fresh', componentType: 'SignalConnector', fieldName: 'TargetBool', valueJson: '"Cell/Signals/B2"' });
    await run(setField, t.ctx(), { path: 'Cell/Fresh', componentType: 'SignalConnector', fieldName: 'Bit', valueJson: '2' });

    const glb = await exportAssetGlb(t.root, 'Cell');
    const json = readGlbJson(glb) as { nodes: Array<{ name?: string; extras?: { realvirtual?: Record<string, Record<string, unknown>> } }> };
    const stored = json.nodes.find((n) => n.name === 'Fresh')!.extras!.realvirtual!.SignalConnector;
    const modeId = identityIdOf(t.registry.getNode('Cell/Signals/RobotMode')!);
    const b2Id = identityIdOf(t.registry.getNode('Cell/Signals/B2')!);
    expect(stored.SourceInt).toMatchObject({ type: 'ComponentReference', address: `#${modeId}` });
    expect(stored.TargetBool).toMatchObject({ type: 'ComponentReference', address: `#${b2Id}` });
    expect(stored.SourceInt).not.toHaveProperty('path');
    expect(stored.TargetBool).not.toHaveProperty('path');
    expect(stored).toMatchObject({ Mode: 'BitFromWord', Bit: 2 });
    t.doc.dispose();

    resetProblemsForTests();
    const reloaded = await loadBakedGLB('saved.glb', new Scene(), { data: glb });
    const c = reloaded.registry.getComponentsAt('Cell/Fresh')?.find(([type]) => type === 'SignalConnector')?.[1] as RVSignalConnector | undefined;
    expect(c).toBeInstanceOf(RVSignalConnector);
    expect(c!.isActive).toBe(true);
    reloaded.signalStore.set('RobotMode', 4);
    expect(reloaded.signalStore.get('B2')).toBe(true);
    reloaded.signalStore.set('RobotMode', 3);
    expect(reloaded.signalStore.get('B2')).toBe(false);
    expect(getProblems().filter((p) => p.code.startsWith('signal-connector-'))).toEqual([]);
  });
});
