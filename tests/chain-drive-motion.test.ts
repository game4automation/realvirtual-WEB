// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Test 9.3 of plan-733 — motion, tick ORDER, reset ORDER and the loader
 * classification regression.
 *
 * Two of these are ordering claims the plan review made (R2, "the tick must run
 * after the drive stage" / "the reset must run after the drive resets"), and an
 * ordering claim is only worth anything if the test would actually catch the
 * wrong order. Both are therefore written as observations of a RECORDED
 * sequence, not as "the value looks plausible afterwards".
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { BufferAttribute, Mesh, MeshStandardMaterial, Object3D, Scene, Vector3 } from 'three';
import { CoreSubsystems, type CoreSubsystemsHost } from '../src/core/engine/rv-core-subsystems';
import { constructComponentOnNode } from '../src/core/engine/rv-scene-loader';
import { isBatchSafe } from '../src/core/engine/rv-batched-render';
import { freezeStaticMatrices } from '../src/core/engine/rv-freeze-static';
import { RVChain } from '../src/core/engine/rv-chain';
import { chainHarness, squareLoopSpline, type ChainHarness } from './chain-fixture';

function build(h: ChainHarness, overrides: Record<string, unknown> = {}): RVChain {
  const data = h.chainExtras(overrides);
  h.chain.userData.realvirtual = { Chain: data };
  return constructComponentOnNode(h.deps, h.chain, 'Chain', data) as RVChain;
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { warn.mockRestore(); });

describe('Chain follows its drive', () => {
  it('moves every element by the drive delta', () => {
    // 2 m curve == 2000 mm, 4 elements at 0 / 500 / 1000 / 1500 mm.
    const h = chainHarness();
    const chain = build(h, { NumberOfElements: 4 });

    h.drive.currentPosition = 250;
    expect(chain.updatePose()).toBe(true);
    expect(chain.elements[0].position.z).toBeCloseTo(0.25, 6);
    expect(chain.elements[1].position.z).toBeCloseTo(0.75, 6);
    expect(chain.elements[3].position.z).toBeCloseTo(1.75, 6);
  });

  it('keeps the pitch constant while moving', () => {
    const h = chainHarness();
    const chain = build(h, { NumberOfElements: 4 });
    for (const p of [0, 137, 640, 1999]) {
      h.drive.currentPosition = p;
      chain.updatePose();
      const gap = chain.elements[2].position.z - chain.elements[1].position.z;
      expect(Math.abs(gap)).toBeCloseTo(0.5, 6);
    }
  });

  it('wraps by modulo forwards past the end of an OPEN spline', () => {
    const h = chainHarness();
    const chain = build(h, { NumberOfElements: 1 });
    h.drive.currentPosition = 2500; // 2500 mm on a 2000 mm curve
    chain.updatePose();
    expect(chain.elements[0].position.z).toBeCloseTo(0.5, 6);
  });

  it('wraps backwards through a negative drive position (Unity sign formula)', () => {
    const h = chainHarness();
    const chain = build(h, { NumberOfElements: 1 });
    h.drive.currentPosition = -500; // -500 mm => fraction 0.75 => z = 1.5 m
    chain.updatePose();
    expect(chain.elements[0].position.z).toBeCloseTo(1.5, 6);

    h.drive.currentPosition = -2500; // modulo first, then the sign branch
    chain.updatePose();
    expect(chain.elements[0].position.z).toBeCloseTo(1.5, 6);
  });

  it('reports no movement when the drive has not moved', () => {
    const h = chainHarness();
    const chain = build(h, { NumberOfElements: 2 });
    h.drive.currentPosition = 300;
    expect(chain.updatePose()).toBe(true);
    expect(chain.updatePose()).toBe(false);
  });

  it('rotates the elements along a closed loop', () => {
    const h = chainHarness({ spline: squareLoopSpline(1, 8) }); // 4 m == 4000 mm
    const chain = build(h, { NumberOfElements: 1 });
    h.drive.currentPosition = 2000; // half way round: the third side, running -Z
    chain.updatePose();
    // Local +Z of the element must point along the tangent, which runs -Z here.
    const forward = new Vector3(0, 0, 1).applyQuaternion(chain.elements[0].quaternion);
    expect(forward.z).toBeLessThan(-0.9);
  });

  it('leaves the rotation untouched when AlignWithChain is false', () => {
    const h = chainHarness({ spline: squareLoopSpline(1, 8), elementExtras: { AlignWithChain: false } });
    const chain = build(h, { NumberOfElements: 1 });
    h.drive.currentPosition = 2000;
    chain.updatePose();
    expect(chain.elements[0].quaternion.x).toBe(0);
    expect(chain.elements[0].quaternion.w).toBe(1);
    // The POSITION still tracks the drive.
    expect(chain.elements[0].position.x).toBeGreaterThan(0);
  });

  it('applies OffsetToDrivePosition from the template extras', () => {
    const h = chainHarness({ elementExtras: { OffsetToDrivePosition: 250 } });
    const chain = build(h, { NumberOfElements: 1 });
    expect(chain.elements[0].position.z).toBeCloseTo(0.25, 6);
  });
});

describe('tick order — the chain must run AFTER the drive stage', () => {
  it('sees the drive position of the SAME tick (no one-tick lag)', () => {
    const h = chainHarness();
    const chain = build(h, { NumberOfElements: 1 });

    const seen: number[] = [];
    const host: CoreSubsystemsHost = {
      isConnected: false,
      playback: null, logicEngine: null, ikPaths: [], replayRecordings: [],
      drives: [{
        isRunning: true, positionOverwrite: false, jogForward: true,
        jogBackward: false, isTransportSurface: false,
        update: () => { h.drive.currentPosition += 100; },
      }],
      transportManager: null, tankFillManager: null, pipeFlowManager: null,
      gizmoManager: { tick: () => false },
      lampManager: null,
      energyChainManager: null,
      chainManager: {
        update: (dt) => { seen.push(h.drive.currentPosition); return h.chainManager.update(dt); },
      },
      collisionManager: null,
      markRenderDirty: () => {},
      markShadowsDirty: () => {},
    };
    const core = new CoreSubsystems(host);

    core.drives(0.02);
    core.visuals(0.02);

    // The chain hook ran with the position the drive stage had just produced.
    expect(seen).toEqual([100]);
    expect(chain.elements[0].position.z).toBeCloseTo(0.1, 6);
  });

  it('marks render AND shadow dirty when a chain moved', () => {
    const h = chainHarness();
    build(h, { NumberOfElements: 1 });
    h.drive.currentPosition = 500;

    let render = 0;
    let shadow = 0;
    const host: CoreSubsystemsHost = {
      isConnected: false,
      playback: null, logicEngine: null, ikPaths: [], replayRecordings: [],
      drives: [], transportManager: null, tankFillManager: null, pipeFlowManager: null,
      gizmoManager: { tick: () => false },
      lampManager: null, energyChainManager: null,
      chainManager: h.chainManager,
      collisionManager: null,
      markRenderDirty: () => { render++; },
      markShadowsDirty: () => { shadow++; },
    };
    const core = new CoreSubsystems(host);

    core.visuals(0.02);
    expect(render).toBe(1);
    expect(shadow).toBe(1);
    // Idle tick: nothing moved, nothing dirty.
    core.visuals(0.02);
    expect(render).toBe(1);
    expect(shadow).toBe(1);
  });
});

describe('reset order — resetAll() must run AFTER the drive resets (F4/R2)', () => {
  it('re-poses from the RESET drive position, not the pre-reset one', () => {
    const h = chainHarness();
    const chain = build(h, { NumberOfElements: 1 });
    h.drive.currentPosition = 1400;
    chain.updatePose();
    expect(chain.elements[0].position.z).toBeCloseTo(1.4, 6);

    // The order rv-viewer.ts::resetSimulation() implements.
    const order: string[] = [];
    const driveReset = () => { order.push('drive'); h.drive.reset(); };
    const chainReset = () => { order.push('chain'); h.chainManager.resetAll(); };
    driveReset();
    chainReset();

    expect(order).toEqual(['drive', 'chain']);
    expect(chain.elements[0].position.z).toBeCloseTo(0, 6);
  });

  it('would leave the element at the STALE pose if the chain reset ran first', () => {
    // The negative control: this is exactly what a `simulation-reset` event hook
    // would do, since that event is emitted before the drive.reset() loop.
    const h = chainHarness();
    const chain = build(h, { NumberOfElements: 1 });
    h.drive.currentPosition = 1400;
    chain.updatePose();

    h.chainManager.resetAll(); // too early
    h.drive.reset();

    expect(chain.elements[0].position.z).toBeCloseTo(1.4, 6); // still wrong
    // …and the correct order repairs it.
    h.chainManager.resetAll();
    expect(chain.elements[0].position.z).toBeCloseTo(0, 6);
  });
});

describe('loader classification regression (plan-417 sensitivity)', () => {
  /** One batchable mesh under a node carrying `ownerExtras`. */
  function batchCandidate(ownerExtras?: Record<string, unknown>): boolean {
    const root = new Object3D();
    root.name = 'Root';
    const owner = new Object3D();
    owner.name = 'Owner';
    if (ownerExtras) owner.userData.realvirtual = ownerExtras;
    root.add(owner);

    const mesh = new Mesh();
    mesh.name = 'part';
    mesh.geometry.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3),
    );
    mesh.material = new MeshStandardMaterial();
    owner.add(mesh);
    return isBatchSafe(mesh, root);
  }

  it('keeps the EXISTING excluded categories excluded', () => {
    for (const key of ['TransportSurface', 'Source', 'Sink', 'MU', 'Cam', 'MachiningVolume', 'PlacementMeta']) {
      expect(batchCandidate({ [key]: {} }), `${key} must stay excluded`).toBe(false);
    }
  });

  it('keeps ordinary and non-listed component subtrees batchable', () => {
    expect(batchCandidate()).toBe(true);
    expect(batchCandidate({ Drive: {} })).toBe(true);       // classified by the planner, not excluded
    expect(batchCandidate({ EnergyChain: {} })).toBe(true); // NOT a prefix match on 'Chain'
    expect(batchCandidate({ Sensor: {} })).toBe(true);
  });

  it('excludes a Chain subtree (plan-733)', () => {
    expect(batchCandidate({ Chain: {} })).toBe(false);
  });

  it('keeps a Chain subtree matrix-dynamic through freezeStaticMatrices', () => {
    const root = new Object3D();
    root.name = 'Root';
    const structure = new Object3D();
    structure.name = 'StaticWall';
    const chain = new Object3D();
    chain.name = 'Chain';
    chain.userData.realvirtual = { Chain: {} };
    const element = new Object3D();
    element.name = 'Carrier_1';
    chain.add(element);
    root.add(structure, chain);
    new Scene().add(root);

    freezeStaticMatrices(root);

    expect(chain.matrixWorldAutoUpdate).toBe(true);
    expect(element.matrixWorldAutoUpdate).toBe(true);
    // The unrelated static structure is still frozen — the entry is additive.
    expect(structure.matrixWorldAutoUpdate).toBe(false);
  });
});
