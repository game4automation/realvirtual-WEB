// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-492 Phase 6 — lane pitch of the synthetic line.
 *
 * With library geometry the lanes are drawn with `RollConveyor-*.glb`, which is
 * 1.12 m across. The plan-465 pitch (1.5 MU-derived belt widths = 0.6 m) is
 * narrower than that, so neighbouring lanes visibly intersected. The pitch now
 * follows the asset width for `geometry: 'library'` and stays byte-identical for
 * the primitive line — the defaults are a measurement contract.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D, Scene } from 'three';
import {
  buildSyntheticLine, DEFAULT_SYNTHETIC_LINE, laneSpacingFor, requiredAssets,
  type SyntheticLineConfig, type SyntheticLineHandle, type SyntheticLineHost,
} from '../../src/core/engine/perf/rv-synthetic-line';
import {
  EUROPALLET_ASSET, LIBRARY_CONVEYOR_WIDTH_M, MU_ASSET_PITCH_MM,
  clearSyntheticAssetCache, pieceForLength, setCachedAsset, tileSegment,
} from '../../src/core/engine/perf/rv-synthetic-assets';
import { RVTransportManager } from '../../src/core/engine/rv-transport-manager';
import { SignalStore } from '../../src/core/engine/rv-signal-store';
import type { RVDrive } from '../../src/core/engine/rv-drive';

function makeHost(): SyntheticLineHost & { drives: RVDrive[]; scene: Scene } {
  const scene = new Scene();
  const transportManager = new RVTransportManager();
  transportManager.scene = scene;
  return { scene, transportManager, signalStore: new SignalStore(), drives: [], fixedTimeStep: 1 / 60 };
}

/** Stand-in for `RollConveyor-Nm.glb`, as wide as the real asset. */
function fakeConveyorAsset(lengthM: number): Object3D {
  const root = new Group();
  const frame = new Mesh(new BoxGeometry(lengthM, 0.1, LIBRARY_CONVEYOR_WIDTH_M), new MeshStandardMaterial());
  frame.name = 'Frame';
  root.add(frame);
  return root;
}

const SMALL: Partial<SyntheticLineConfig> = {
  lanes: 3, plcs: 1, segments: 2, segmentLengthM: 5,
  sensorsPerSegment: 1, targetMUs: 20, speedMmS: 1000,
  muLengthMm: 200, muGapMm: 100, signalBinding: 'none', originX: 0, originZ: 0,
};

let handle: SyntheticLineHandle | null = null;
afterEach(() => { handle?.dispose(); handle = null; clearSyntheticAssetCache(); });

function lanePitch(root: Object3D): number {
  const lanes = root.children.filter((c) => c.name.startsWith('Lane'));
  expect(lanes.length).toBeGreaterThan(1);
  return lanes[1].children[0].position.z - lanes[0].children[0].position.z;
}

describe('laneSpacingFor', () => {
  it('keeps the plan-465 pitch for the primitive line', () => {
    expect(laneSpacingFor(DEFAULT_SYNTHETIC_LINE)).toBeCloseTo(0.6, 6);
  });

  it('spreads library lanes wider than the conveyor asset', () => {
    const pitch = laneSpacingFor({ ...DEFAULT_SYNTHETIC_LINE, geometry: 'library' });
    expect(pitch).toBeGreaterThan(LIBRARY_CONVEYOR_WIDTH_M);
  });

  it('never narrows a primitive pitch that is already wider than the asset', () => {
    const wide = { muLengthMm: 1000, geometry: 'library' as const };
    expect(laneSpacingFor(wide)).toBeCloseTo(laneSpacingFor({ ...wide, geometry: 'primitive' }), 6);
  });
});

describe('built line', () => {
  it('primitive lanes sit 0.6 m apart (unchanged contract)', () => {
    handle = buildSyntheticLine(makeHost(), { ...SMALL, geometry: 'primitive' });
    expect(lanePitch(handle.root)).toBeCloseTo(0.6, 6);
  });

  it('library lanes clear the asset width, and the topology is the same line', () => {
    for (const len of tileSegment(SMALL.segmentLengthM!)) {
      setCachedAsset(pieceForLength(len)!, fakeConveyorAsset(len));
    }
    const primitive = buildSyntheticLine(makeHost(), { ...SMALL, geometry: 'primitive' });
    const primitiveSurfaces = primitive.surfaces.length;
    const primitiveCapacity = primitive.plan.capacityMUs;
    primitive.dispose();

    handle = buildSyntheticLine(makeHost(), { ...SMALL, geometry: 'library' });
    expect(lanePitch(handle.root)).toBeGreaterThan(LIBRARY_CONVEYOR_WIDTH_M);
    expect(handle.surfaces.length).toBe(primitiveSurfaces);
    expect(handle.plan.capacityMUs).toBe(primitiveCapacity);
  });
});

describe('pallet MUs', () => {
  /** Stand-in for `EuropalletLoaded.glb`: 1.2 m long (z, so the builder turns it), 0.8 m wide, 0.32 m tall. */
  function fakePallet(): Object3D {
    const root = new Group();
    const body = new Mesh(new BoxGeometry(0.8, 0.32, 1.2), new MeshStandardMaterial());
    body.position.set(-5, 0.16, 0);   // off its own origin, like the real asset
    root.add(body);
    return root;
  }

  it('requires the pallet asset and rides it on the belt by its real height', () => {
    const cfg: Partial<SyntheticLineConfig> = {
      ...SMALL, muAsset: 'pallet', muLengthMm: MU_ASSET_PITCH_MM.pallet.lengthMm, muGapMm: MU_ASSET_PITCH_MM.pallet.gapMm,
      targetMUs: 8,
    };
    expect(requiredAssets({ ...DEFAULT_SYNTHETIC_LINE, ...cfg })).toContain(EUROPALLET_ASSET);
    setCachedAsset(EUROPALLET_ASSET, fakePallet());

    handle = buildSyntheticLine(makeHost(), cfg);
    // Belt top is at 0.05 m; a 0.32 m pallet rides with its centre 0.16 m above it,
    // not the 0.6 m the old "cube of muLengthMm" assumption would have given.
    const sourceNode = handle.root.getObjectByName('Source_L0');
    expect(sourceNode).toBeDefined();
    expect(sourceNode!.position.y).toBeCloseTo(0.05 + 0.16, 3);
    // Capacity follows the pallet pitch, not the box pitch.
    expect(handle.plan.capacityMUs).toBe(Math.floor((3 * 2 * 5 * 1000) / 1500));
  });

  it('refuses a pallet line whose asset was not preloaded', () => {
    expect(() => buildSyntheticLine(makeHost(), { ...SMALL, muAsset: 'pallet', muLengthMm: 1200, muGapMm: 300, targetMUs: 8 }))
      .toThrow(/EuropalletLoaded/);
  });
});
