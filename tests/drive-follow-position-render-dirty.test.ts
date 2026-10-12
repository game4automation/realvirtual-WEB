// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * drive-follow-position-render-dirty.test.ts — a Drive whose position is set by
 * Drive_FollowPosition claims the axis (positionClaimedThisTick) and never arms
 * isRunning. The on-demand renderer must still be woken on every tick it MOVES,
 * and must stay asleep while the followed value rests.
 *
 * Runs a real RVDrive + RVDriveFollowPosition through CoreSubsystems.drives()
 * with a fake host that only counts markRenderDirty / markShadowsDirty.
 */

import { describe, it, expect } from 'vitest';
import { Object3D, Scene } from 'three';
import { RVDrive, DriveDirection } from '../src/core/engine/rv-drive';
import { RVDriveFollowPosition } from '../src/core/engine/rv-drive-follow-position';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import { CoreSubsystems, type CoreSubsystemsHost } from '../src/core/engine/rv-core-subsystems';
import type { ComponentContext } from '../src/core/engine/rv-component-registry';

const DT = 1 / 60;

function makeHost(drives: RVDrive[]) {
  const counts = { render: 0, shadows: 0 };
  const host: CoreSubsystemsHost = {
    isConnected: true,
    playback: null,
    logicEngine: null,
    ikPaths: [],
    replayRecordings: [],
    drives,
    transportManager: null,
    tankFillManager: null,
    pipeFlowManager: null,
    gizmoManager: { tick: () => false },
    lampManager: null,
    energyChainManager: null,
    collisionManager: null,
    markRenderDirty: () => { counts.render++; },
    markShadowsDirty: () => { counts.shadows++; },
  };
  return { host, counts };
}

function makeFollowDrive() {
  const store = new SignalStore();
  const registry = new NodeRegistry();
  const scene = new Scene();
  const root = new Object3D();
  root.name = 'Root';
  scene.add(root);
  const node = new Object3D();
  node.name = 'Ball';
  root.add(node);
  const path = NodeRegistry.computeNodePath(node);
  registry.registerNode(path, node);

  const drive = new RVDrive(node);
  drive.Direction = DriveDirection.LinearY;
  drive.initDrive();
  registry.register('Drive', path, drive);

  const posPath = `${path}/Signals/h`;
  store.register(posPath, posPath, 0, 'PLCOutputFloat');
  store.buildIndex();

  const ctx: ComponentContext = {
    registry, signalStore: store, scene, transportManager: new RVTransportManager(), root,
  };
  const follow = new RVDriveFollowPosition(node);
  follow.Position = posPath;
  follow.init(ctx);
  return { store, drive, posPath };
}

describe('Drive_FollowPosition keeps the on-demand renderer awake only while moving', () => {
  it('(a) a changing followed value marks render AND shadows dirty', () => {
    const { store, drive, posPath } = makeFollowDrive();
    const { host, counts } = makeHost([drive]);
    const core = new CoreSubsystems(host);

    store.setByPath(posPath, 100);
    core.drives(DT);
    expect(drive.isRunning).toBe(false);
    expect(drive.positionClaimedThisTick).toBe(true);
    expect(drive.currentPosition).toBeCloseTo(100, 6);
    expect(counts.render).toBe(1);
    expect(counts.shadows).toBe(1);

    store.setByPath(posPath, 120);
    core.drives(DT);
    expect(counts.render).toBe(2);
    expect(counts.shadows).toBe(2);
  });

  it('(b) a resting followed value does NOT mark render dirty', () => {
    const { store, drive, posPath } = makeFollowDrive();
    const { host, counts } = makeHost([drive]);
    const core = new CoreSubsystems(host);

    store.setByPath(posPath, 50);
    core.drives(DT); // moves once
    counts.render = 0;
    counts.shadows = 0;

    for (let i = 0; i < 10; i++) core.drives(DT);
    expect(drive.positionClaimedThisTick).toBe(true); // still claimed …
    expect(drive.claimedMoveThisTick).toBe(false);    // … but at rest
    expect(counts.render).toBe(0);
    expect(counts.shadows).toBe(0);
  });

  it('(b2) a claim does not latch once the drive stops running its behaviors', () => {
    const { store, drive, posPath } = makeFollowDrive();
    const { host, counts } = makeHost([drive]);
    const core = new CoreSubsystems(host);

    store.setByPath(posPath, 50);
    core.drives(DT);
    expect(drive.claimedMoveThisTick).toBe(true);

    // Multiuser follower: update() returns before the behavior pass.
    drive.isOwner = false;
    counts.render = 0;
    core.drives(DT);
    expect(drive.claimedMoveThisTick).toBe(false);
    expect(counts.render).toBe(0);
  });

  it('(c) a running drive still marks render + shadows dirty (unchanged)', () => {
    const node = new Object3D();
    node.name = 'Plain';
    const drive = new RVDrive(node);
    drive.Direction = DriveDirection.LinearX;
    drive.initDrive();
    drive.TargetSpeed = 100;
    drive.startMove(500);

    const { host, counts } = makeHost([drive]);
    new CoreSubsystems(host).drives(DT);
    expect(drive.isRunning).toBe(true);
    expect(counts.render).toBe(1);
    expect(counts.shadows).toBe(1);
  });
});
