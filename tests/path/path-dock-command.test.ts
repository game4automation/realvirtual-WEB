// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Object3D } from 'three';
import { makeRig, fingerprint, type Rig } from './path-network-rig';
import { createPathNetworkCommandDescriptors, ensurePathNetworkCommandsRegistered } from '../../src/plugins/path-network/path-network-commands';
import { commandRegistry, type CommandContext, type CommandImpl } from '../../src/core/hmi/rv-command-registry';
import { setActiveEditTarget } from '../../src/core/hmi/rv-edit-target';
import type { RVViewer } from '../../src/core/rv-viewer';
import { SnapPointRegistry } from '../../src/core/engine/rv-snap-point-registry';
import { scanAndRegisterSnaps } from '../../src/core/connect/snap-scanner';
import { FleetAuthoringSource } from '../../src/core/fleet/scene/fleet-authoring-source';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { getDefaultZoneRegistry } from '../../src/core/engine/rv-zone-registry';
import { getDefaultAgvFleet } from '../../src/core/engine/rv-agv-fleet';
import { snapshotNetwork } from '../../src/plugins/path-network/path-network-scene';
import { validateSceneNetwork } from '../../src/plugins/path-network/path-network-validation';
import { collectStationDockChecks, dockSignature, resolveStationDock } from '../../src/plugins/path-network/path-network-dock';
import { getProblems, resetProblemsForTests } from '../../src/core/hmi/problems-store';

interface DockResult {
  blockId: string; stubPathId: string; hostPathId: string; s: number; side: string;
  stubStraightM: number; dockPort: string; replacedBlockId?: string;
  loadOffsetMm: number; loadOffsetSource: string; envelopeSource: string; warnings?: string[];
}
const impls = new Map(createPathNetworkCommandDescriptors().map(d => [d.id, d.eagerImpl as CommandImpl<unknown, unknown>]));
let rig: Rig;
let snaps: SnapPointRegistry;
let station: Object3D;
let registryAvailable: boolean;
const viewer = () => rig.stub as unknown as RVViewer;
const source = () => FleetAuthoringSource.of(viewer());
const config = () => station.userData.realvirtual.TransferStation as Record<string, unknown>;
const context = (): CommandContext => ({ viewer: viewer(), doc: null, selection: [], mode: 'planner', handle: null });
async function run(id: string, args: Record<string, unknown>): Promise<unknown> {
  const impl = impls.get(id)!;
  const ctx = context();
  const enabled = impl.enabled(ctx, args);
  if (enabled !== true) throw new Error(enabled.reason);
  return impl.run(ctx, args);
}
const dock = (args: Record<string, unknown> = {}) => run('layout.path.dock', { station: 'Root/Station', ...args }) as Promise<DockResult>;
function addNode(name: string, components: Record<string, unknown>, parent = rig.root): Object3D {
  const node = new Object3D();
  node.name = name;
  node.userData.realvirtual = components;
  parent.add(node);
  rig.nodes.set(`Root/${name}`, node);
  source().invalidate();
  return node;
}
function port(name = 'Snap-ZB-path', owner = station): Object3D {
  const node = new Object3D();
  node.name = name;
  node.position.z = 0.5;
  owner.add(node);
  scanAndRegisterSnaps(node, snaps, owner);
  source().invalidate();
  return node;
}
function stubStart(id: string): number[] {
  const segment = snapshotNetwork(rig.stub).input.paths.find(p => p.id === id)!.segments[0];
  if (segment.kind !== 'line') throw new Error('not a stub line');
  return segment.from;
}
async function refuses(reason: string, args: Record<string, unknown> = {}): Promise<void> {
  const before = fingerprint(rig), fields = JSON.stringify(config()), head = rig.doc.historyHead(), resets = rig.stub.resets;
  await expect(dock(args)).rejects.toThrow(new RegExp(`^${reason}`));
  expect(fingerprint(rig)).toBe(before);
  expect(JSON.stringify(config())).toBe(fields);
  expect(rig.doc.historyHead()).toEqual(head);
  expect(rig.stub.resets).toBe(resets);
}

beforeEach(async () => {
  getDefaultPathNetwork().clear();
  getDefaultZoneRegistry().clear();
  getDefaultAgvFleet().clear();
  resetProblemsForTests();
  rig = makeRig();
  snaps = new SnapPointRegistry();
  registryAvailable = true;
  Object.assign(rig.stub, { getPlugin: (id: string) => id === 'snap-point'
    ? { getRegistry: () => registryAvailable ? snaps : null } : id === 'path-visualizer' ? rig.plugin : undefined });
  Object.assign(rig.stub.registry, { findNodeForUser: (path: string) => {
    const node = rig.nodes.get(path);
    return node ? { node, via: 'runtime' } : null;
  } });
  station = addNode('Station', { TransferStation: { PathId: '', DockPort: '' } });
  station.position.set(8, 0, -4);
  port();
  await run('layout.path.place', { block: 'straight', lengthM: 20, x: 0, z: 0, headingDeg: 0 });
  rig.stub.resets = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  commandRegistry.attachViewer(undefined);
  rig.plugin.dispose();
  setActiveEditTarget(null);
  getDefaultPathNetwork().clear();
  getDefaultZoneRegistry().clear();
  getDefaultAgvFleet().clear();
  resetProblemsForTests();
});

describe('plan-636 9.3 station dock command', () => {
  it('books one undo step, places H within 1 mm, writes both fields and resets once', async () => {
    const before = fingerprint(rig), count = rig.doc.historyHead().undoLen;
    const result = await dock();
    expect(result).toMatchObject({ hostPathId: 'PN_S1', s: 9.5, side: 'left', stubStraightM: 2,
      dockPort: 'Snap-ZB-path', loadOffsetMm: 0, loadOffsetSource: 'none', envelopeSource: 'none' });
    expect(result.stubPathId).toMatch(/^PN_K\d+$/);
    const start = stubStart(result.stubPathId);
    expect(Math.hypot(start[0] - 8, start[2] + 3.5)).toBeLessThanOrEqual(0.001);
    expect(config()).toMatchObject({ PathId: result.stubPathId, DockPort: result.dockPort });
    expect(rig.doc.historyHead().undoLen).toBe(count + 1);
    expect(rig.doc.ops.at(-1)).toMatchObject({ label: 'Path verb: Dock stub to station' });
    expect(rig.stub.resets).toBe(1);
    const after = fingerprint(rig);
    await rig.doc.undo();
    expect(fingerprint(rig)).toBe(before);
    expect(config()).toMatchObject({ PathId: '', DockPort: '' });
    await rig.doc.redo();
    expect(fingerprint(rig)).toBe(after);
    expect(config().PathId).toBe(result.stubPathId);
  });

  it.each([
    ['no-transfer-station', () => { delete station.userData.realvirtual.TransferStation; }],
    ['dock-snaps-unavailable', () => { registryAvailable = false; }],
    ['dock-port-missing', () => { snaps.clear(); source().invalidate(); }],
    ['dock-port-ambiguous', () => { port(); }],
    ['dock-port-unknown', () => { config().DockPort = 'Snap-QQ-path'; }],
    ['dock-no-host', () => { station.position.x = 30; }],
    ['dock-not-perpendicular', () => { station.rotation.y = Math.PI / 4; }],
    ['dock-too-close', () => { station.position.z = -1; }],
    ['host-too-short', () => { station.position.x = 0.1; }],
    ['already-docked-foreign', () => { config().PathId = 'PN_S1'; }],
    ['station-not-editable', () => { rig.scene.attach(station); }],
    ['station-not-editable', () => { Object.assign(rig.stub, { modes: { activeMode: 'viewer' } }); }],
    ['sim-locked', () => { rig.stub.runtime.state = 'running'; }],
    ['sim-locked', () => { rig.stub.simTime = 1; }],
  ] as const)('%s refuses without writes', async (reason, arrange) => {
    arrange();
    // The no-component case has no config to snapshot.
    if (reason === 'no-transfer-station') {
      const before = fingerprint(rig), head = rig.doc.historyHead();
      await expect(dock()).rejects.toThrow(/^no-transfer-station/);
      expect(fingerprint(rig)).toBe(before);
      expect(rig.doc.historyHead()).toEqual(head);
    } else await refuses(reason, { pathId: reason === 'dock-no-host' ? 'missing' : 'PN_S1' });
  });

  it('refuses duplicate port names even with a persisted selection', async () => {
    config().DockPort = 'Snap-ZB-path';
    port();
    await refuses('dock-port-ambiguous');
  });

  // `imported-path` needs a non-removable loaded host; that refusal is the op's own
  // (path-block-commands.test.ts) and reaches dock unchanged through runOps.
  it('passes the composition-owner refusal through unchanged', async () => {
    const host = rig.nodes.get('Root/PathNetwork/PN_Block_1/PN_S1')!;
    host.userData.realvirtual.Generated = { owner: 'palletYard' };
    await refuses('composition-owned');
  });

  it('refuses a curved host, missing ray host, and invalid dock parameters atomically', async () => {
    await run('layout.path.place', { block: 'curve', radiusM: 3, degrees: 90, x: 30, z: 0 });
    await refuses('dock-host-not-straight', { pathId: 'PN_C1' });
    await refuses('dock-internal-mismatch', { radiusM: 0 });
    await refuses('dock-no-host', { maxDepthM: 1 });
  });

  it('persists a selected second port; stored selection wins over the argument', async () => {
    const owner = new Object3D();
    station.add(owner);
    owner.rotation.y = -Math.PI / 2;
    const second = new Object3D();
    second.name = 'Snap-XB-path';
    second.position.x = 0.5;
    owner.add(second);
    scanAndRegisterSnaps(owner, snaps, owner);
    source().invalidate();
    await refuses('dock-port-ambiguous');
    const result = await dock({ port: 'Snap-XB-path' });
    expect(result.dockPort).toBe('Snap-XB-path');
    expect(config().DockPort).toBe('Snap-XB-path');
    expect(validateSceneNetwork(viewer()).issues.filter(i => i.code.startsWith('path-dock-'))).toEqual([]);
    expect((await dock({ port: 'does-not-exist' })).dockPort).toBe('Snap-XB-path');
    config().DockPort = 'Snap-QQ-path';
    await refuses('dock-port-unknown');
  });

  it('replaces its own block on a healed host, and undo restores the first dock', async () => {
    const first = await dock(), before = fingerprint(rig), start = stubStart(first.stubPathId);
    const second = await dock();
    expect(second.replacedBlockId).toBe(first.blockId);
    expect(second.blockId).not.toBe(first.blockId);
    expect(stubStart(second.stubPathId)).toEqual(start);
    expect(snapshotNetwork(rig.stub).input.blocks!.filter(b => b.extras.kind === 'stub')).toHaveLength(1);
    await rig.doc.undo();
    expect(fingerprint(rig)).toBe(before);
    expect(config().PathId).toBe(first.stubPathId);
    station.position.x += 0.3;
    const moved = await dock();
    expect(moved.replacedBlockId).toBe(first.blockId);
    expect(stubStart(moved.stubPathId)[0]).toBeCloseTo(start[0] + 0.3, 6);
  });

  it('a refusal after planning removal leaves the old dock and history intact', async () => {
    await dock();
    station.position.z = -1;
    await refuses('dock-too-close');
  });

  it('replaces a dangling PathId normally but refuses an existing block-free path', async () => {
    config().PathId = 'deleted-stub';
    const result = await dock();
    expect(result.replacedBlockId).toBeUndefined();
    await rig.doc.undo();
    expect(config().PathId).toBe('deleted-stub');
    addNode('ManualPath', { Path: { id: 'manual', segments: [{ kind: 'line', from: [0, 0, 8], to: [20, 0, 8] }], successors: [] } });
    config().PathId = 'manual';
    await refuses('already-docked-foreign');
  });

  it('rolls back the whole transaction when a station field write fails', async () => {
    rig.failOn.kind = 'setField';
    await refuses('commit-failed');
  });

  it('returns design offset/envelope and the short-body warning', async () => {
    addNode('Fleet', { Fleet: { DesignVehicleLengthMm: 4000, DesignVehicleWidthMm: 1000, DesignLoadOffsetMm: 500 } });
    const result = await dock();
    expect(result).toMatchObject({ loadOffsetMm: 500, loadOffsetSource: 'design', envelopeSource: 'design', stubStraightM: 1.5 });
    expect(result.warnings).toContain('stub-shorter-than-body');
    expect(stubStart(result.stubPathId)[2]).toBeCloseTo(-3, 6);
    expect(validateSceneNetwork(viewer()).issues.filter(i => i.code.startsWith('path-dock-'))).toEqual([]);
  });

  it('returns load-offset-missing for an unconfigured forklift (F10 spelling)', async () => {
    addNode('Forklift', { ForkliftProfile: {} });
    const result = await dock();
    expect(result.loadOffsetSource).toBe('none');
    expect(result.warnings).toContain('load-offset-missing');
  });

  it('returns the ambiguous load-offset warning and the design tie-breaker', async () => {
    addNode('Fleet', { Fleet: { DesignLoadOffsetMm: 500 } });
    for (const [name, offset] of [['ForkA', 0.4], ['ForkB', 0.8]] as const) {
      const forklift = addNode(name, { Agv: {}, ForkliftProfile: { ForkAnchor: { type: 'ComponentReference', path: `${name}/Anchor` } } });
      const anchor = new Object3D();
      anchor.name = 'Anchor';
      anchor.position.z = -offset;
      forklift.add(anchor);
    }
    Object.assign(rig.stub.registry, { resolve: (_ref: unknown, owner: Object3D) => ({ node: owner.children[0] }) });
    source().invalidate();
    const result = await dock();
    expect(result).toMatchObject({ loadOffsetSource: 'design', loadOffsetMm: 500 });
    expect(result.warnings).toContain('load-offset-ambiguous');
    rig.stub.emit('mode-changed', { to: 'planner' });
    rig.plugin.onRender();
    expect(getProblems().find(p => p.code === 'fleet-load-offset-ambiguous')).toMatchObject({ severity: 'warning', quiet: true });
  });

  it('accepts materialized content of an active document placement through ordinary setField ops', async () => {
    const placement = new Object3D();
    placement.name = 'Placement';
    rig.scene.add(placement);
    placement.attach(station);
    Object.assign(rig.stub, { placements: { instanceOf: (node: Object3D) => node === placement ? { root: placement, released: false } : null } });
    const result = await dock();
    expect(config().PathId).toBe(result.stubPathId);
    const transaction = rig.doc.ops.at(-1) as unknown as { ops: { kind: string; nodePath?: string; componentType?: string; fieldName?: string }[] };
    expect(transaction.ops.filter(op => op.componentType === 'TransferStation')).toMatchObject([
      { kind: 'setField', nodePath: 'Root/Station', fieldName: 'PathId' },
      { kind: 'setField', nodePath: 'Root/Station', fieldName: 'DockPort' },
    ]);
    // This rig has no bake/export layer. AssetOverrides persistence is covered by Phase 3's reload test.
  });

  it('is macro-capable and executes through commandRegistry with the same ids', async () => {
    const direct = await dock();
    await rig.doc.undo();
    ensurePathNetworkCommandsRegistered(commandRegistry);
    commandRegistry.attachViewer(viewer());
    expect(commandRegistry.get('layout.path.dock')).toMatchObject({ label: 'Dock stub to station', readOnly: false,
      macro: true, undoLabel: 'Path verb: Dock stub to station' });
    const result = await commandRegistry.execute('layout.path.dock', { station: 'Root/Station' }, { origin: 'mcp' });
    expect(result.ok).toBe(true);
    expect((result as { value: DockResult }).value).toMatchObject({ blockId: direct.blockId, stubPathId: direct.stubPathId });
  });
});

describe('station dock resolution and live validation', () => {
  it('uses the resolved SeatNode; occupied ports remain dockable', async () => {
    const seat = addNode('Seat', {});
    seat.position.set(8, 2, -5);
    config().SeatNode = { type: 'ComponentReference', path: 'Root/Seat' };
    Object.assign(rig.stub.registry, { resolve: () => ({ node: seat }) });
    source().invalidate();
    snaps.getAll()[0].occupied = true;
    const result = await dock();
    expect(stubStart(result.stubPathId)[2]).toBeCloseTo(-5, 6);
    expect(stubStart(result.stubPathId)[1]).toBe(0);
    expect(validateSceneNetwork(viewer()).issues.filter(i => i.code.startsWith('path-dock-'))).toEqual([]);
  });

  it('skips ports until placement materialization, then finds them after invalidation', () => {
    config().PathId = 'missing-stub';
    snaps.clear();
    source().invalidate();
    expect(collectStationDockChecks(viewer())).toEqual([]);
    scanAndRegisterSnaps(station, snaps, station);
    rig.stub.emit('layout-content-added', {});
    expect(collectStationDockChecks(viewer())).toHaveLength(1);
    expect(validateSceneNetwork(viewer()).issues.some(i => i.code === 'path-dock-stub-missing')).toBe(true);
  });

  it('detects position and normal changes using the cached model without a scene traversal', async () => {
    await dock();
    const first = dockSignature(viewer()), reads = source().reads;
    const traverse = vi.spyOn(rig.scene, 'traverse');
    station.position.x += 0.3;
    const moved = dockSignature(viewer());
    expect(moved).not.toBe(first);
    station.rotation.y += 0.1;
    expect(dockSignature(viewer())).not.toBe(moved);
    expect(source().reads).toBe(reads);
    expect(traverse).not.toHaveBeenCalled();
  });

  it('publishes and clears quiet dock/fleet issues, and marks pose changes dirty at the poll', async () => {
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    rig.stub.emit('mode-changed', { to: 'planner' });
    const result = await dock();
    rig.plugin.onRender();
    rig.plugin.onRender();
    station.position.x += 0.3;
    now += 600;
    rig.plugin.onRender();
    rig.plugin.onRender();
    const issue = getProblems().find(p => p.code === 'path-dock-misaligned');
    expect(issue).toMatchObject({ severity: 'warning', quiet: true });
    const stationId = collectStationDockChecks(viewer())[0].stationId;
    expect(issue!.id).toBe(`path-network:path-dock-misaligned:${stationId}`);
    expect(rig.scene.getObjectByName(`__pathMarker:path-dock-misaligned:${stationId}`)?.position.x).toBeCloseTo(stubStart(result.stubPathId)[0], 6);
    expect((await run('layout.path.validate', {}) as { issues: { code: string }[] }).issues.some(i => i.code === 'path-dock-misaligned')).toBe(true);
    station.position.x -= 0.3;
    now += 600;
    rig.plugin.onRender();
    rig.plugin.onRender();
    expect(getProblems().some(p => p.code === 'path-dock-misaligned')).toBe(false);
    const fleet = addNode('Fleet', { Fleet: { DesignVehicleLengthMm: 4000 } });
    addNode('Forklift', { ForkliftProfile: {} });
    rig.plugin.onRender();
    expect(getProblems().filter(p => p.code.startsWith('fleet-')).map(p => p.code).sort()).toEqual(['fleet-design-vehicle-incomplete', 'fleet-load-offset-missing']);
    fleet.userData.realvirtual.Fleet.DesignVehicleWidthMm = 1000;
    fleet.userData.realvirtual.Fleet.DesignLoadOffsetMm = 500;
    rig.stub.emit('component-field-changed', { componentType: 'Fleet' });
    rig.plugin.onRender();
    expect(getProblems().some(p => p.code.startsWith('fleet-'))).toBe(false);
    rig.stub.emit('mode-changed', { to: 'viewer' });
    expect(getProblems().some(p => p.id.startsWith('path-network:'))).toBe(false);
  });

  it('resolves the port normal from its position, not its N/P name', () => {
    const p = snaps.getAll()[0].object3D;
    p.name = 'Snap-ZN-path';
    snaps.clear();
    scanAndRegisterSnaps(station, snaps, station);
    source().invalidate();
    const resolved = resolveStationDock(viewer(), station);
    expect('reason' in resolved).toBe(false);
    if (!('reason' in resolved)) expect(resolved.portDir).toEqual([0, 1]);
  });
});
