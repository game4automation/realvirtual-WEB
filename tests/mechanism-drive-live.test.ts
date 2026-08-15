// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * T1 of plan-411 — the runtime Drive lifecycle.
 *
 * The bug this pins down: a Drive assigned in the Quick Edit reached the running
 * mechanism only after a reload, because `constructComponentOnNode()` bailed out
 * for `Drive` (no ComponentFactory) — extras were written, no instance existed.
 * Fixing the CONSTRUCTION alone would not have been enough: the simulation ticks
 * `RVViewer.drives`, so a drive that is merely in the NodeRegistry still never
 * moves. Hence the two halves are asserted separately:
 *
 *   1. the instance exists and is registry-resolvable
 *   2. the CoreSubsystems drive stage actually moves it — no reload
 *
 * plus the symmetry (remove → undo → redo without ghost or duplicate) and the
 * three collection consumers the plan names (drive order, recorder, UI list).
 */

import { describe, expect, it, vi } from 'vitest';
import { Object3D, Scene } from 'three';
import {
  constructComponentOnNode,
  removeDriveComponentFromNode,
  type DriveLifecycleHost,
  type RuntimeNodeDeps,
} from '../src/core/engine/rv-scene-loader';
import { RVDrive } from '../src/core/engine/rv-drive';
import { CoreSubsystems, type CoreSubsystemsHost } from '../src/core/engine/rv-core-subsystems';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import { EventEmitter } from '../src/core/rv-events';
import type { ViewerEvents } from '../src/core/rv-viewer-events';

/** The lifecycle host under test, with the collection-changed announcement the
 *  real `RVViewer` makes. Keeping it tiny is the point of the seam. */
class FakeDriveHost implements DriveLifecycleHost {
  readonly drives: RVDrive[] = [];
  readonly events = new EventEmitter<ViewerEvents>();
  addDrive(drive: RVDrive): boolean {
    if (this.drives.includes(drive)) return false;
    this.drives.push(drive);
    this.events.emit('drives-changed', { drives: this.drives, added: drive, removed: null });
    return true;
  }
  removeDrive(drive: RVDrive): boolean {
    const i = this.drives.indexOf(drive);
    if (i < 0) return false;
    this.drives.splice(i, 1);
    this.events.emit('drives-changed', { drives: this.drives, added: null, removed: drive });
    return true;
  }
}

function harness() {
  const scene = new Scene();
  const root = new Object3D();
  root.name = 'Root';
  scene.add(root);
  const registry = new NodeRegistry();
  registry.registerNode('Root', root);
  const signalStore = new SignalStore();
  const transportManager = new RVTransportManager();
  transportManager.scene = scene;
  const driveHost = new FakeDriveHost();
  const events = new EventEmitter<ViewerEvents>();
  const deps: RuntimeNodeDeps = {
    registry, signalStore, scene, transportManager, driveHost, events,
  };
  return { scene, root, registry, signalStore, driveHost, events, deps };
}

/** Attach a node under Root and register it, as the editor's addNode would. */
function node(h: ReturnType<typeof harness>, name: string): Object3D {
  const n = new Object3D();
  n.name = name;
  h.root.add(n);
  n.userData.realvirtual = {};
  h.registry.registerNode(`Root/${name}`, n);
  return n;
}

/** A CoreSubsystems pipeline over nothing but the drive collection. */
function pipeline(host: DriveLifecycleHost): { core: CoreSubsystems; renderDirty: () => number } {
  let dirty = 0;
  const coreHost: CoreSubsystemsHost = {
    isConnected: false,
    playback: null,
    logicEngine: null,
    ikPaths: [],
    replayRecordings: [],
    get drives() { return host.drives; },
    transportManager: null,
    tankFillManager: null,
    pipeFlowManager: null,
    gizmoManager: { tick: () => false },
    lampManager: null,
    energyChainManager: null,
    collisionManager: null,
    markRenderDirty: () => { dirty++; },
    markShadowsDirty: () => {},
  };
  return { core: new CoreSubsystems(coreHost), renderDirty: () => dirty };
}

describe('plan-411 T1 — runtime addComponent Drive', () => {
  it('creates a registry-resolvable RVDrive instance', () => {
    const h = harness();
    const n = node(h, 'Axis');
    const inst = constructComponentOnNode(h.deps, n, 'Drive', {
      Direction: 'LinearX', TargetSpeed: 200,
    });

    expect(inst).toBeInstanceOf(RVDrive);
    expect(h.registry.getByPath<RVDrive>('Drive', 'Root/Axis')).toBe(inst);
    expect(n.userData._rvType).toBe('Drive');
  });

  it('is ticked by the sim loop without a reload — the drive actually moves', () => {
    const h = harness();
    const n = node(h, 'Axis');
    const drive = constructComponentOnNode(h.deps, n, 'Drive', {
      Direction: 'LinearX', TargetSpeed: 500, Acceleration: 10000,
    }) as RVDrive;

    expect(h.driveHost.drives).toContain(drive);

    const { core } = pipeline(h.driveHost);
    drive.jogForward = true;
    const before = drive.currentPosition;
    for (let i = 0; i < 20; i++) core.drives(1 / 60);

    expect(drive.currentPosition).toBeGreaterThan(before);
    expect(n.position.x).not.toBe(0);
  });

  it('does not add the same drive twice (redo after undo)', () => {
    const h = harness();
    const n = node(h, 'Axis');
    const drive = constructComponentOnNode(h.deps, n, 'Drive', { Direction: 'LinearY' }) as RVDrive;
    // A second addComponent on the SAME node returns the existing instance.
    const again = constructComponentOnNode(h.deps, n, 'Drive', { Direction: 'LinearY' });

    expect(again).toBe(drive);
    expect(h.driveHost.drives.filter((d) => d === drive)).toHaveLength(1);
  });

  it('leaves no ghost in the tick list on remove → undo → redo', () => {
    const h = harness();
    const n = node(h, 'Axis');
    const first = constructComponentOnNode(h.deps, n, 'Drive', { Direction: 'LinearX' }) as RVDrive;
    expect(h.driveHost.drives).toHaveLength(1);

    // remove (= undo of the add)
    expect(removeDriveComponentFromNode(h.deps, 'Root/Axis', 'Drive')).toBe(true);
    expect(h.driveHost.drives).toHaveLength(0);
    expect(h.registry.getByPath('Drive', 'Root/Axis')).toBeNull();

    // redo — a NEW instance, and exactly one
    const second = constructComponentOnNode(h.deps, n, 'Drive', { Direction: 'LinearX' }) as RVDrive;
    expect(second).not.toBe(first);
    expect(h.driveHost.drives).toEqual([second]);

    // and the ghost really is gone: ticking must not move a removed drive
    const { core } = pipeline(h.driveHost);
    first.jogForward = true;
    const ghostBefore = first.currentPosition;
    for (let i = 0; i < 10; i++) core.drives(1 / 60);
    expect(first.currentPosition).toBe(ghostBefore);
  });

  it('refuses to build a drive that could never be ticked (no lifecycle host)', () => {
    const h = harness();
    const n = node(h, 'Axis');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failed = vi.fn();
    h.events.on('component-construction-failed', failed);

    const hostless: RuntimeNodeDeps = { ...h.deps, driveHost: undefined };
    expect(constructComponentOnNode(hostless, n, 'Drive', { Direction: 'LinearX' })).toBeNull();
    expect(h.registry.getByPath('Drive', 'Root/Axis')).toBeNull();
    expect(failed).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });

  it('reports an unusable Direction as a finding instead of a broken drive', () => {
    const h = harness();
    const n = node(h, 'Axis');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failed = vi.fn();
    h.events.on('component-construction-failed', failed);

    // `Direction: null` is what an inspector reset writes — the schema default
    // must NOT paper over an EXPLICIT null, or the drive silently moves in X.
    expect(constructComponentOnNode(h.deps, n, 'Drive', { Direction: null })).toBeNull();
    expect(h.driveHost.drives).toHaveLength(0);
    expect(failed).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });
});

describe('plan-411 T1 — collection-changed consumers', () => {
  it('announces every runtime membership change exactly once', () => {
    const h = harness();
    const seen: Array<{ added: string | null; removed: string | null; size: number }> = [];
    h.driveHost.events.on('drives-changed', (e) => {
      seen.push({
        added: e.added?.node.name ?? null,
        removed: e.removed?.node.name ?? null,
        size: e.drives.length,
      });
    });

    const a = node(h, 'A');
    constructComponentOnNode(h.deps, a, 'Drive', { Direction: 'LinearX' });
    removeDriveComponentFromNode(h.deps, 'Root/A', 'Drive');

    expect(seen).toEqual([
      { added: 'A', removed: null, size: 1 },
      { added: null, removed: 'A', size: 0 },
    ]);
  });

  it('keeps the Gear/CAM tick order correct after a runtime add (drive-order)', async () => {
    const { DriveOrderPlugin } = await import('../src/plugins/drive-order-plugin');
    const h = harness();

    // Master exists from the "load"; the slave is added at runtime and lands at
    // the END of the tick list — behind its master only by accident.
    const masterNode = node(h, 'Master');
    const master = constructComponentOnNode(h.deps, masterNode, 'Drive', { Direction: 'LinearX' }) as RVDrive;

    const plugin = new DriveOrderPlugin();
    const viewerLike = {
      drives: h.driveHost.drives,
      on: (evt: 'drives-changed', cb: () => void) => h.driveHost.events.on(evt, cb),
    };
    plugin.onModelLoaded({} as never, viewerLike as never);

    const slaveNode = node(h, 'Slave');
    const slave = constructComponentOnNode(h.deps, slaveNode, 'Drive', { Direction: 'LinearX' }) as RVDrive;
    // Gear coupling, written the way the loader stores behavior extras.
    slave.BehaviorExtras = {
      Drive_Gear: { MasterDrive: { type: 'ComponentReference', path: 'Root/Master', componentType: 'realvirtual.Drive' } },
    };
    // Re-announce so the plugin re-sorts with the coupling in place (the same
    // event a `setField` on the reference triggers in the editor).
    h.driveHost.events.emit('drives-changed', { drives: h.driveHost.drives, added: null, removed: null });

    expect(h.driveHost.drives.indexOf(master)).toBeLessThan(h.driveHost.drives.indexOf(slave));

    // And the inverse order is actually REPAIRED, not accidentally already right.
    h.driveHost.drives.length = 0;
    h.driveHost.drives.push(slave, master);
    plugin.sort(viewerLike as never);
    expect(h.driveHost.drives).toEqual([master, slave]);
  });

  it('re-seeds the drive recorder on a runtime add and remove', async () => {
    const { DriveRecorderPlugin } = await import('../src/plugins/drive-recorder-plugin');
    const h = harness();
    const plugin = new DriveRecorderPlugin();
    const viewerLike = {
      drives: h.driveHost.drives,
      on: (evt: 'drives-changed', cb: () => void) => h.driveHost.events.on(evt, cb),
    };
    plugin.onModelLoaded({} as never, viewerLike as never);

    const n = node(h, 'Axis');
    const drive = constructComponentOnNode(h.deps, n, 'Drive', { Direction: 'LinearX' }) as RVDrive;
    expect(plugin.recorder.series.map((s) => s.drive)).toEqual([drive]);

    removeDriveComponentFromNode(h.deps, 'Root/Axis', 'Drive');
    expect(plugin.recorder.series).toHaveLength(0);
  });
});
