// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Test 9.4 of plan-733 — the Unity → GLB → Web parity round trip.
 *
 * Two halves:
 *
 * 1. the wire contract exercised through the loader's own `processExtras` path
 *    against a SYNTHETIC tree carrying exactly the rv_extras a Unity export must
 *    emit. That is the half a synthetic fixture can prove: given this JSON, the
 *    viewer builds N elements and poses them here.
 *
 * 2. the half only a real export can prove — the values Unity actually writes
 *    (`componentType` of the two references, the baked sample table, the frame
 *    and the sign convention of its vectors). It loads the two REFERENCE GLBs
 *    through the full viewer.
 *
 * ## The reference rigs
 *
 * `tests/fixtures/chain-{horizontal,vertical-open}.glb` are produced by
 * `ChainReferenceGlbExport` (Unity, `Packages/io.realvirtual.professional/Editor/
 * WebViewer/ChainReferenceGlbExport.cs`) through the normative
 * `GLBManager.GetStandardExportSettings()` → `GLTFSceneExporter.SaveGLB()` chain,
 * i.e. exactly what `WebViewerToolbar.ExportSceneToWebViewer()` produces.
 *
 * Regenerate (Unity side):
 *   realvirtual DEV/Testing/Chain/Export Chain Reference GLBs
 *   (or headless `-executeMethod realvirtual.ChainReferenceGlbExport.ExportReferenceGlbsBatch`,
 *    with `RV_CHAIN_FIXTURE_DIR` pointing at this `tests/fixtures` folder)
 *
 * Both rigs are polygons with `TangentMode.Linear` knots, so every expectation
 * below is ANALYTIC — derived from the rig geometry, not copied out of a run:
 *
 *   horizontal    closed square loop, side 1 m → 4.0 m / 4000 mm, 8 elements
 *                 (500 mm pitch), `StartPosition` 250 mm, chain node at Unity
 *                 (5, 2, −3). Traversal +Z → +X → −Z → −X, seamed at the MIDDLE
 *                 of the first edge.
 *   vertical-open open 3-leg profile, leg 1 m → 3.0 m / 3000 mm, 6 elements
 *                 (500 mm pitch), `StartPosition` 250 mm, chain node at Unity
 *                 (−2, 1, 4), `chainOrientation: Vertical`.
 *
 * `StartPosition` is half a pitch on purpose: every element then sits 250 mm
 * clear of a corner, on a straight leg where the baked polyline IS the curve, so
 * the poses are analytically exact rather than corner-chord approximations.
 *
 * The X negation (Unity left-handed → glTF right-handed) is why the expected
 * positions below run into −X while the Unity rig is built in +X.
 */

import { describe, expect, it, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { Object3D, Vector3 } from 'three';
import { processExtras } from '../src/core/engine/rv-scene-loader';
import type { RVChain } from '../src/core/engine/rv-chain';
import type { RVDrive } from '../src/core/engine/rv-drive';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';
import { chainHarness, driveRef, straightSpline, transformRef } from './chain-fixture';

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { warn.mockRestore(); });

describe('Chain rv_extras through the loader placement path', () => {
  it('builds and poses a chain from the exact wire payload a Unity export writes', () => {
    const h = chainHarness();
    // Exactly the JSON the exporter must produce for the Chain node.
    h.chain.userData.realvirtual = {
      Chain: {
        ConnectedDrive: driveRef('Root/ChainDrive'),
        chainOrientation: 'Horizontal',
        NumberOfElements: 4,
        StartPosition: 0,
        CalculatedDeltaPosition: true,
        DeltaPosition: 0,
        ScaledOnFixedLength: false,
        FixedLength: 1500,
        ChainElement: transformRef('Root/Chain/Carrier'),
        NameChainElement: 'Carrier',
        Spline: straightSpline(2, 5),
      },
    };

    const result = processExtras(
      h.root, h.registry, h.signalStore, h.transportManager, h.scene,
      undefined, undefined, undefined, undefined,
      { chainManager: h.chainManager },
    );
    expect(result).toBeTruthy();

    const chain = h.registry.getByPath<RVChain>('Chain', 'Root/Chain')!;
    expect(chain).toBeTruthy();
    expect(chain.isActive).toBe(true);
    expect(chain.elements).toHaveLength(4);
    expect(chain.lengthMm).toBeCloseTo(2000, 6);

    // Pose parity: element i sits at i * (length / N) along the curve.
    h.drive.currentPosition = 0;
    chain.reset();
    expect(chain.elements.map((e) => Number(e.position.z.toFixed(6))))
      .toEqual([0, 0.5, 1, 1.5]);

    // …and every element points along the tangent.
    const forward = new Vector3(0, 0, 1).applyQuaternion(chain.elements[0].quaternion);
    expect(forward.z).toBeCloseTo(1, 6);
  });

  it('ignores a Chain payload without a Spline block instead of failing the load', () => {
    const h = chainHarness();
    h.chain.userData.realvirtual = {
      Chain: {
        ConnectedDrive: driveRef('Root/ChainDrive'),
        ChainElement: transformRef('Root/Chain/Carrier'),
        NumberOfElements: 4,
      },
    };
    expect(() => processExtras(
      h.root, h.registry, h.signalStore, h.transportManager, h.scene,
      undefined, undefined, undefined, undefined,
      { chainManager: h.chainManager },
    )).not.toThrow();
    const chain = h.registry.getByPath<RVChain>('Chain', 'Root/Chain')!;
    expect(chain.isActive).toBe(false);
    expect(chain.elements).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The real Unity exports
// ─────────────────────────────────────────────────────────────────────────────

const HORIZONTAL_GLB = '/tests/fixtures/chain-horizontal.glb';
const VERTICAL_GLB = '/tests/fixtures/chain-vertical-open.glb';

/** Rig constants, mirrored from `ChainReferenceGlbExport.cs`. */
const PITCH_MM = 500;
const START_MM = 250;
const HORIZONTAL_LENGTH_MM = 4000;
const HORIZONTAL_ELEMENTS = 8;
const VERTICAL_LENGTH_MM = 3000;
const VERTICAL_ELEMENTS = 6;

/**
 * Element poses of the horizontal rig at drive position 0, in the chain node's
 * LOCAL glTF frame — derived from the rig polygon, not recorded from a run.
 * Element i sits at arc length `250 + 500·i` mm from the seam (0, 0, 0.5).
 */
const HORIZONTAL_POSES: Array<{ pos: [number, number, number]; tangent: [number, number, number] }> = [
  { pos: [0, 0, 0.75], tangent: [0, 0, 1] },   //  250 mm — first edge, past the seam
  { pos: [-0.25, 0, 1], tangent: [-1, 0, 0] }, //  750 mm — second edge (Unity +X → glTF −X)
  { pos: [-0.75, 0, 1], tangent: [-1, 0, 0] }, // 1250 mm
  { pos: [-1, 0, 0.75], tangent: [0, 0, -1] }, // 1750 mm — third edge
  { pos: [-1, 0, 0.25], tangent: [0, 0, -1] }, // 2250 mm
  { pos: [-0.75, 0, 0], tangent: [1, 0, 0] },  // 2750 mm — fourth edge
  { pos: [-0.25, 0, 0], tangent: [1, 0, 0] },  // 3250 mm
  { pos: [0, 0, 0.25], tangent: [0, 0, 1] },   // 3750 mm — back on the first edge
];

/** The same for the open vertical rig: +Z leg, +Y leg, −Z leg (all at x = 0). */
const VERTICAL_POSES: Array<{ pos: [number, number, number]; tangent: [number, number, number] }> = [
  { pos: [0, 0, 0.25], tangent: [0, 0, 1] },   //  250 mm
  { pos: [0, 0, 0.75], tangent: [0, 0, 1] },   //  750 mm
  { pos: [0, 0.25, 1], tangent: [0, 1, 0] },   // 1250 mm — rising leg
  { pos: [0, 0.75, 1], tangent: [0, 1, 0] },   // 1750 mm
  { pos: [0, 1, 0.75], tangent: [0, 0, -1] },  // 2250 mm — return leg, tangent.z < 0
  { pos: [0, 1, 0.25], tangent: [0, 0, -1] },  // 2750 mm
];

let handle: TestViewerHandle;

beforeAll(async () => {
  handle = await createTestViewer('webgl');
}, 60_000);

afterAll(() => handle?.dispose());

/** True when a fixture is really served (an SPA fallback answers 200 text/html). */
async function assetExists(url: string): Promise<boolean> {
  try {
    const res = await fetch(url);
    return res.ok && !(res.headers.get('content-type') ?? '').includes('text/html');
  } catch {
    return false;
  }
}

/** Load a reference GLB through the full viewer and return its single chain. */
async function loadChain(url: string): Promise<{ chain: RVChain; node: Object3D; drive: RVDrive }> {
  await handle.viewer.loadModel(url);
  const registry = handle.viewer.registry!;
  let path: string | null = null;
  registry.forEachNode((p, node) => {
    if (node.name === 'Chain') path = p;
  });
  if (!path) throw new Error(`${url}: no node named "Chain" in the loaded model`);
  const chain = registry.getByPath<RVChain>('Chain', path);
  if (!chain) throw new Error(`${url}: node "${path}" carries no Chain component`);
  return { chain, node: registry.getNode(path)!, drive: chain.ConnectedDrive as RVDrive };
}

/** The raw, un-resolved `Chain` rv_extras still sitting on the node's userData. */
function rawChainExtras(node: Object3D): Record<string, any> {
  return (node.userData.realvirtual as Record<string, any>).Chain;
}

/** Advance the chain to an absolute drive position and re-pose its elements. */
function driveTo(chain: RVChain, drive: RVDrive, positionMm: number): void {
  drive.applySyncData(positionMm);
  handle.viewer.chainManager.update(0.02);
  void chain;
}

/**
 * Compare one element pose against the analytic rig value. The position
 * tolerance is 3 decimals — half a millimetre. The horizontal rig actually lands
 * within 1e-6 m; the vertical one is baked with 16 samples, where Unity's own
 * arc-length inversion costs ~0.3 mm.
 */
function expectPose(
  element: Object3D,
  expected: { pos: [number, number, number]; tangent: [number, number, number] },
  expectedUpY: number | null,
  label: string,
): void {
  expect(element.position.x, `${label} x`).toBeCloseTo(expected.pos[0], 3);
  expect(element.position.y, `${label} y`).toBeCloseTo(expected.pos[1], 3);
  expect(element.position.z, `${label} z`).toBeCloseTo(expected.pos[2], 3);

  const forward = new Vector3(0, 0, 1).applyQuaternion(element.quaternion);
  expect(forward.x, `${label} tangent x`).toBeCloseTo(expected.tangent[0], 4);
  expect(forward.y, `${label} tangent y`).toBeCloseTo(expected.tangent[1], 4);
  expect(forward.z, `${label} tangent z`).toBeCloseTo(expected.tangent[2], 4);

  if (expectedUpY !== null) {
    const up = new Vector3(0, 1, 0).applyQuaternion(element.quaternion);
    expect(up.y, `${label} up y`).toBeCloseTo(expectedUpY, 4);
  }
}

/**
 * Expected `up.y` of a vertical-rig element, or `null` where the frame is
 * degenerate and the roll is therefore undefined.
 *
 * Unity's knots carry the default rotation, so `EvaluateUpVector` returns +Y all
 * along the curve — including the RISING leg, where the tangent is +Y as well.
 * Tangent and up are parallel there, and `lookRotation` can only pick some
 * fallback basis. That is a property of the authored spline (a real bucket
 * elevator would carry knot rotations), not of the viewer, so the assertion
 * covers the legs where "up" actually means something.
 */
function verticalUpY(tangent: [number, number, number]): number | null {
  if (tangent[1] !== 0) return null;      // rising leg — degenerate frame
  return tangent[2] < 0 ? -1 : 1;         // return leg gets Unity's vertical flip
}

describe('Chain Unity GLB fixture — closed horizontal loop', () => {
  it('carries the wire contract a Unity export must emit', async (ctx) => {
    if (!await assetExists(HORIZONTAL_GLB)) {
      ctx.skip(`${HORIZONTAL_GLB} missing — run "realvirtual DEV/Testing/Chain/Export Chain Reference GLBs"`);
      return;
    }
    const { chain, node } = await loadChain(HORIZONTAL_GLB);
    const extras = rawChainExtras(node);

    // Both references are ComponentReferences, and the template one carries the
    // Transform type the resolver matches on — the generic GameObject path would
    // have written a bare string here and left the chain without a template.
    expect(extras.ChainElement.type).toBe('ComponentReference');
    expect(extras.ChainElement.componentType).toBe('UnityEngine.Transform');
    expect(extras.ConnectedDrive.type).toBe('ComponentReference');
    expect(extras.ConnectedDrive.componentType).toContain('Drive');
    expect(extras.NameChainElement).toBe('Carrier');

    // The baked table: stride, sample cap and the true arc length in METRES.
    const samples = extras.Spline.samples as number[];
    expect(samples.length % 9).toBe(0);
    const sampleCount = samples.length / 9;
    expect(sampleCount).toBeGreaterThanOrEqual(2);
    expect(sampleCount).toBeLessThanOrEqual(512);
    expect(extras.Spline.length).toBeCloseTo(HORIZONTAL_LENGTH_MM / 1000, 6);
    expect(chain.lengthMm).toBeCloseTo(HORIZONTAL_LENGTH_MM, 3);

    // The Unity-only performance/edit-mode fields must NOT be in the wire format.
    for (const dropped of [
      'UseBurstOptimization', 'SplineBakeResolution', 'DriveUpdateThreshold',
      'CreateElementeInEditMode', 'Length',
    ]) {
      expect(Object.keys(extras)).not.toContain(dropped);
    }

    // KNOWN EXPORTER LIMITATION (plan-733, Fixture-Roundtrip 9.4): this rig IS a
    // closed loop — first and last sample coincide in position AND tangent — but
    // `IsChainCurveClosed()` reads Unity's tangent at arc fraction 1.0, which is
    // zero for a closed spline, so the flag comes out false. The viewer does not
    // use the flag (the wrap is a modulo on the POSITION), which is why the loop
    // below still wraps correctly. Flip this expectation when the exporter is fixed.
    expect(extras.Spline.closed).toBe(false);
    expect(samples.slice(0, 9)).toEqual(samples.slice(-9));
  }, 60_000);

  it('bakes the samples in the CHAIN NODE\'S LOCAL frame', async (ctx) => {
    if (!await assetExists(HORIZONTAL_GLB)) { ctx.skip('fixture missing'); return; }
    const { node } = await loadChain(HORIZONTAL_GLB);
    const samples = rawChainExtras(node).Spline.samples as number[];

    // The chain node sits at Unity (5, 2, −3) → glTF (−5, 2, −3) …
    expect(node.position.x).toBeCloseTo(-5, 5);
    expect(node.position.y).toBeCloseTo(2, 5);
    expect(node.position.z).toBeCloseTo(-3, 5);
    // … and the first sample is still the seam in LOCAL coordinates. A world-space
    // bake would start at (−5, 2, −2.5) here.
    expect(samples.slice(0, 3)).toEqual([0, 0, 0.5]);
  }, 60_000);

  it('builds and poses the elements exactly where the rig geometry puts them', async (ctx) => {
    if (!await assetExists(HORIZONTAL_GLB)) { ctx.skip('fixture missing'); return; }
    const { chain, drive } = await loadChain(HORIZONTAL_GLB);

    expect(chain.isActive).toBe(true);
    expect(chain.elements).toHaveLength(HORIZONTAL_ELEMENTS);
    expect(chain.deltaPositionMm).toBeCloseTo(PITCH_MM, 6);
    expect(chain.StartPosition).toBeCloseTo(START_MM, 6);
    expect(chain.chainOrientation).toBe('Horizontal');
    expect(drive).toBeTruthy();

    driveTo(chain, drive, 0);
    HORIZONTAL_POSES.forEach((expected, i) => {
      // Horizontal orientation: the up vector is NEVER flipped, not even on the
      // two edges whose tangent runs in −Z (that flip is Vertical-only).
      expectPose(chain.elements[i], expected, 1, `horizontal element ${i}`);
    });
  }, 60_000);

  it('wraps by modulo on the loop — forwards and backwards by one pitch', async (ctx) => {
    if (!await assetExists(HORIZONTAL_GLB)) { ctx.skip('fixture missing'); return; }
    const { chain, drive } = await loadChain(HORIZONTAL_GLB);

    // One pitch forward: every element lands where its successor was, and the
    // LAST one wraps past the seam onto the first pose.
    driveTo(chain, drive, PITCH_MM);
    for (let i = 0; i < HORIZONTAL_ELEMENTS; i++) {
      const expected = HORIZONTAL_POSES[(i + 1) % HORIZONTAL_ELEMENTS];
      expectPose(chain.elements[i], expected, 1, `+1 pitch, element ${i}`);
    }

    // One pitch backwards from zero drives element 0 to −250 mm, which Unity
    // resolves through its NEGATIVE branch (`1 − |p|/L`) to 3750 mm — the pose
    // the last element had.
    driveTo(chain, drive, -PITCH_MM);
    for (let i = 0; i < HORIZONTAL_ELEMENTS; i++) {
      const expected = HORIZONTAL_POSES[(i + HORIZONTAL_ELEMENTS - 1) % HORIZONTAL_ELEMENTS];
      expectPose(chain.elements[i], expected, 1, `−1 pitch, element ${i}`);
    }

    // A full loop is the identity.
    driveTo(chain, drive, HORIZONTAL_LENGTH_MM);
    HORIZONTAL_POSES.forEach((expected, i) => {
      expectPose(chain.elements[i], expected, 1, `full loop, element ${i}`);
    });
  }, 60_000);
});

describe('Chain Unity GLB fixture — open vertical profile', () => {
  it('is exported as an open curve and poses its elements analytically', async (ctx) => {
    if (!await assetExists(VERTICAL_GLB)) {
      ctx.skip(`${VERTICAL_GLB} missing — run "realvirtual DEV/Testing/Chain/Export Chain Reference GLBs"`);
      return;
    }
    const { chain, node, drive } = await loadChain(VERTICAL_GLB);
    const extras = rawChainExtras(node);

    expect(extras.Spline.closed).toBe(false);
    expect(extras.Spline.length).toBeCloseTo(VERTICAL_LENGTH_MM / 1000, 6);
    expect(extras.chainOrientation).toBe('Vertical');
    expect(chain.chainOrientation).toBe('Vertical');
    expect(chain.elements).toHaveLength(VERTICAL_ELEMENTS);
    expect(chain.deltaPositionMm).toBeCloseTo(PITCH_MM, 6);

    // The whole profile lies in the YZ plane, so the X mirror is invisible in the
    // positions — but the node translation still proves it happened.
    expect(node.position.x).toBeCloseTo(2, 5);

    driveTo(chain, drive, 0);
    VERTICAL_POSES.forEach((expected, i) => {
      // Vertical orientation: Unity flips the up vector wherever tangent.z < 0,
      // i.e. on the return leg (elements 4 and 5).
      expectPose(chain.elements[i], expected, verticalUpY(expected.tangent), `vertical element ${i}`);
    });
  }, 60_000);

  it('wraps an OPEN spline by modulo too — Unity parity, no clamping', async (ctx) => {
    if (!await assetExists(VERTICAL_GLB)) { ctx.skip('fixture missing'); return; }
    const { chain, drive } = await loadChain(VERTICAL_GLB);

    // The decisive open-spline case: element 5 sits at 2750 mm, one pitch takes
    // it to 3250 mm — PAST the end of an open curve. Unity's `SetPosition()` has
    // no `closed` branch, so it wraps to 250 mm; a clamp would pile every element
    // up on the last sample instead.
    driveTo(chain, drive, PITCH_MM);
    for (let i = 0; i < VERTICAL_ELEMENTS; i++) {
      const expected = VERTICAL_POSES[(i + 1) % VERTICAL_ELEMENTS];
      expectPose(chain.elements[i], expected, verticalUpY(expected.tangent), `+1 pitch, element ${i}`);
    }

    // And the negative branch on the same open curve.
    driveTo(chain, drive, -PITCH_MM);
    for (let i = 0; i < VERTICAL_ELEMENTS; i++) {
      const expected = VERTICAL_POSES[(i + VERTICAL_ELEMENTS - 1) % VERTICAL_ELEMENTS];
      expectPose(chain.elements[i], expected, verticalUpY(expected.tangent), `−1 pitch, element ${i}`);
    }
  }, 60_000);
});
