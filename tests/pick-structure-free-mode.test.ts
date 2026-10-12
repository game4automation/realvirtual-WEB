// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-757 Phase 3 commit B — the STRUCTURE-FREE pick mode of `PickBackend`.
 *
 * Commit B deletes the unbaked runtime, and with it the only rollback the
 * plan-756 pick structure had (the `rv-webviewer-static-merge` override used
 * to swap the whole backend for `InstancePickIndex`). Its replacement is a
 * mode INSIDE the backend: the segment table walked linearly — one box test
 * per segment, the same watertight triangle test inside — clusters and SAH
 * tree ignored. Two triggers:
 *  - the dev flag `rv-webviewer-pick-structure` = `0` (`rv-dev-load-flags.ts`),
 *    read once when the backend is built (per model load);
 *  - automatically for a chunk the bake published SEGMENT-ONLY because its
 *    pick build threw in the worker AND in the inline retry — that used to
 *    reject the whole bake; now that ONE chunk loses its acceleration.
 *
 * What this file proves, level by level:
 *  1. traversal: same ray → bit-identical hit (distance, triangle, segment,
 *     owner, blocked) with and without the tree, hidden segments and single-
 *     sided winding included; a segment-only structure answers the same
 *     distance/segment/owner as the full one;
 *  2. backend: occlusion (same chunk, other chunk), transparency, hidden nodes
 *     and two-instance resolution behave identically in both modes;
 *  3. flag: the localStorage value decides the mode of a freshly built backend;
 *  4. bake: a rejecting pick port yields a baked asset whose chunks are
 *     segment-only, picked correctly, counted in `pickMemoryStats`;
 *  5. the parity fixtures (a)–(i) through the real viewer: the same asset-space
 *     ray resolves to the expected node in both modes.
 */
import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from 'vitest';
import {
  Group, MeshStandardMaterial, PerspectiveCamera, Scene, Vector3,
} from 'three';
import type { Object3D } from 'three';
import '../src/core/engine/rv-scene-loader';
import { RaycastManager } from '../src/core/engine/rv-raycast-manager';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { registerComponentSchema } from '../src/core/engine/rv-component-registry';
import { RVUberMaterial } from '../src/core/engine/rv-uber-material';
import { BakeRegistry, pickMemoryStats } from '../src/core/engine/rv-bake-registry';
import { PickBackend } from '../src/core/engine/rv-pick-backend';
import { buildPickStructure, buildSegmentOnlyStructure } from '../src/core/engine/rv-pick-build';
import {
  createPickCounters, isSegmentOnly, pickStructureBytes, raycastPickNearest, raycastSurfaceNearest,
  segmentRange, type ChunkPickData, type PickHit,
} from '../src/core/engine/rv-pick-structure';
import { createPickBuildPort, type PickBuildPort } from '../src/core/engine/rv-pick-build-port';
import { PICK_STRUCTURE_LS_KEY, isPickStructureEnabled } from '../src/core/engine/rv-dev-load-flags';
import { bakeAndPlace, bakeTree, group, uberMesh, withComponent } from './fixtures/bake-fixture';
import { makePrimitiveAssembly, makeThinSheet, randomRays, type PickFixture } from './helpers/pick-geometry';
import { PARITY_FIXTURES } from './fixtures/parity-fixtures';
import {
  createParityHost, fixtureBytes, loadAsMainModel, pickAt, type ParityHost,
} from './helpers/parity-harness';

registerComponentSchema('TestPickFree', {}, { pick: 'select' });

const uber = new RVUberMaterial(false);

afterEach(() => {
  try { localStorage.removeItem(PICK_STRUCTURE_LS_KEY); } catch { /* private mode */ }
});

// ─── 1. Traversal ───────────────────────────────────────────────────────

function copyHit(hit: PickHit | null): PickHit | null {
  return hit === null ? null : { ...hit };
}

function castAll(
  data: ChunkPickData, position: Float32Array, index: Uint32Array, rays: Float64Array,
  extra: Record<string, unknown> = {},
): (PickHit | null)[] {
  const out: (PickHit | null)[] = [];
  for (let i = 0; i < rays.length / 6; i++) {
    const o = i * 6;
    out.push(copyHit(raycastPickNearest(
      data, position, index, rays[o], rays[o + 1], rays[o + 2], rays[o + 3], rays[o + 4], rays[o + 5], extra,
    )));
  }
  return out;
}

describe('structure-free traversal (plan-757 Phase 3 commit B)', () => {
  const fixtures: Array<{ fixture: PickFixture; doubleSided: boolean }> = [
    { fixture: makePrimitiveAssembly(), doubleSided: true },
    { fixture: makePrimitiveAssembly(), doubleSided: false },
    { fixture: makeThinSheet(60, 40), doubleSided: true },
  ];

  for (const { fixture, doubleSided } of fixtures) {
    it(`${fixture.label} (${doubleSided ? 'double' : 'front'}-sided): tree and linear walk agree on every ray, hits and blocks alike`, () => {
      const index = fixture.index.slice();
      const built = buildPickStructure(fixture.position, index, fixture.segments.map((s) => ({ ...s })), { doubleSided, blocks: true });
      const rays = randomRays(fixture, 1500, 4242);
      const tree = castAll(built.data, fixture.position, built.index, rays);
      const linear = castAll(built.data, fixture.position, built.index, rays, { linear: true });
      expect(linear).toEqual(tree);
      expect(tree.filter((h) => h !== null).length).toBeGreaterThan(rays.length / 6 / 4);
      // Mirrored instance (single-sided): the winding flip is honoured the same way.
      if (!doubleSided) {
        const treeFlipped = castAll(built.data, fixture.position, built.index, rays, { flipWinding: true });
        const linearFlipped = castAll(built.data, fixture.position, built.index, rays, { flipWinding: true, linear: true });
        expect(linearFlipped).toEqual(treeFlipped);
        expect(treeFlipped).not.toEqual(tree);
      }
    }, 60_000);
  }

  it('hidden segments are skipped identically, and the linear walk asks skipSegment only for entered boxes', () => {
    const fixture = makeThinSheet(60, 40);
    const index = fixture.index.slice();
    const built = buildPickStructure(fixture.position, index, fixture.segments.map((s) => ({ ...s })), { doubleSided: true, blocks: true });
    const rays = randomRays(fixture, 800, 99);
    const hidden = new Set([1]);
    const tree = castAll(built.data, fixture.position, built.index, rays, { hiddenSegments: hidden });
    const linear = castAll(built.data, fixture.position, built.index, rays, { hiddenSegments: hidden, linear: true });
    expect(linear).toEqual(tree);
    for (const h of linear) if (h) expect(h.segment).toBe(0);

    // `skipSegment` through the callback form: called at most once per segment per ray.
    let calls = 0;
    const o = 0;
    raycastPickNearest(built.data, fixture.position, built.index,
      rays[o], rays[o + 1], rays[o + 2], rays[o + 3], rays[o + 4], rays[o + 5],
      { linear: true, skipSegment: () => { calls++; return false; } });
    expect(calls).toBeLessThanOrEqual(built.data.segmentCount);
  }, 60_000);

  it('a segment-only structure answers the same distance, segment, owner and block as the full one', () => {
    const fixture = makePrimitiveAssembly();
    const full = buildPickStructure(fixture.position, fixture.index.slice(), fixture.segments.map((s) => ({ ...s })), { doubleSided: true, blocks: true });
    const plainIndex = fixture.index.slice();
    const only = buildSegmentOnlyStructure(fixture.position, plainIndex, fixture.segments.map((s) => ({ ...s })), { doubleSided: true, blocks: true });
    expect(isSegmentOnly(only)).toBe(true);
    expect(isSegmentOnly(full.data)).toBe(false);
    expect(only.segmentCount).toBe(full.data.segmentCount);
    expect(only.triangleCount).toBe(full.data.triangleCount);
    expect(only.clusterCount).toBe(0);
    expect(only.treeNodeCount).toBe(0);
    expect(pickStructureBytes(only)).toBeLessThan(pickStructureBytes(full.data));
    // The index was NOT permuted: segment boundaries and the authored order stand.
    expect(plainIndex).toEqual(fixture.index);
    for (let s = 0; s < only.segmentCount; s++) {
      expect(only.segIndexStart[s]).toBe(full.data.segIndexStart[s]);
      expect(only.segIndexCount[s]).toBe(full.data.segIndexCount[s]);
      expect(only.segNode[s]).toBe(full.data.segNode[s]);
      expect(only.segOwner[s]).toBe(full.data.segOwner[s]);
      for (let k = 0; k < 6; k++) expect(only.segBox[s * 6 + k]).toBeCloseTo(full.data.segBox[s * 6 + k], 6);
    }
    // The highlight side reads segment boxes only — it works without a tree.
    expect(segmentRange(only, 0, only.segmentCount - 1)).not.toBeNull();

    const rays = randomRays(fixture, 1500, 31337);
    const counters = createPickCounters();
    const a = castAll(full.data, fixture.position, full.index, rays);
    const b = castAll(only, fixture.position, plainIndex, rays, { counters });
    expect(counters.rays).toBe(rays.length / 6);
    expect(b.length).toBe(a.length);
    for (let i = 0; i < a.length; i++) {
      const x = a[i]; const y = b[i];
      if (x === null || y === null) { expect(y).toBe(x); continue; }
      expect(y.distance).toBeCloseTo(x.distance, 9);
      expect(y.segment).toBe(x.segment);
      expect(y.owner).toBe(x.owner);
      expect(y.node).toBe(x.node);
      expect(y.blocked).toBe(x.blocked);
    }
    // Surface queries take the same road.
    const o = 0;
    const s1 = raycastSurfaceNearest(full.data, fixture.position, full.index, rays[o], rays[o + 1], rays[o + 2], rays[o + 3], rays[o + 4], rays[o + 5]);
    const s2 = raycastSurfaceNearest(only, fixture.position, plainIndex, rays[o], rays[o + 1], rays[o + 2], rays[o + 3], rays[o + 4], rays[o + 5]);
    expect(s2 === null).toBe(s1 === null);
    if (s1 && s2) expect(s2.distance).toBeCloseTo(s1.distance, 9);
  }, 60_000);
});

// ─── 2. Backend ─────────────────────────────────────────────────────────

const RAY_ORIGIN = new Vector3(0, 0, 10);
const RAY_DIR = new Vector3(0, 0, -1);

function makeManager(registry: NodeRegistry, scene: Scene): RaycastManager {
  return new RaycastManager(
    { domElement: document.createElement('canvas') } as unknown as { readonly domElement: HTMLCanvasElement },
    () => new PerspectiveCamera(), scene, registry,
    { highlight() {}, highlightInstancedMU() {}, clear() {} } as unknown as import('../src/core/engine/rv-highlight-manager').RVHighlightManager,
    { emit() {} },
  );
}

function registerAll(registry: NodeRegistry, root: Object3D): void {
  root.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
}

/** Place a destructive bake and wire a manager with a backend of the given mode. */
async function place(
  root: Object3D,
  structure: boolean,
  opts: { survives?: (n: Object3D) => boolean; pickPort?: PickBuildPort } = {},
) {
  const scene = new Scene();
  const bakeRegistry = new BakeRegistry();
  const placed = await bakeAndPlace(root, bakeRegistry, { uber, ...opts });
  scene.add(placed.template);
  scene.updateMatrixWorld(true);
  const registry = new NodeRegistry();
  registerAll(registry, placed.template);
  const rm = makeManager(registry, scene);
  const backend = new PickBackend(bakeRegistry, null, structure);
  rm.addBackend(backend);
  rm.enableHoverType('TestPickFree', true);
  rm.enableHoverType('Drive', true);
  const hover = (origin = RAY_ORIGIN, dir = RAY_DIR): Object3D | null => {
    rm.updateFromXRController(origin, dir);
    return rm.hoveredNode;
  };
  return { scene, bakeRegistry, placed, rm, registry, backend, hover };
}

function coverAndInner(): Group {
  const root = group('Asset');
  const cover = group('Cover');
  cover.add(uberMesh(uber, 'coverMesh', [0, 0, 0]));
  const inner = withComponent(group('Inner'), 'TestPickFree');
  inner.add(uberMesh(uber, 'innerMesh', [0, 0, -3]));
  root.add(cover, inner);
  return root;
}

describe('PickBackend structure-free mode — same semantics as the tree walk', () => {
  it('an opaque unowned segment blocks a pickable part behind it in the SAME chunk', async () => {
    const { placed, backend, hover } = await place(coverAndInner(), false, { survives: (n) => n.name === 'Cover' });
    expect(backend.usesStructure).toBe(false);
    expect(placed.baked.chunks).toHaveLength(1);
    expect(hover()).toBeNull();
    placed.node('Cover').visible = false;
    expect(hover()).toBe(placed.node('Inner'));
  });

  it('an opaque unowned segment blocks a part in ANOTHER chunk', async () => {
    const root = group('Asset');
    const cover = group('Cover');
    cover.add(uberMesh(uber, 'coverMesh', [0, 0, 0]));
    const drive = withComponent(group('Drive-A'), 'Drive');
    drive.add(uberMesh(uber, 'arm', [0, 0, -3]));
    root.add(cover, drive);
    const { placed, hover } = await place(root, false, { survives: (n) => n.name === 'Cover' });
    expect(placed.baked.chunks.map((c) => c.key).sort()).toEqual(['mover:Drive-A', 'static']);
    expect(hover()).toBeNull();
    placed.node('Cover').visible = false;
    expect(hover()).toBe(placed.node('Drive-A'));
  });

  it('a transparent chunk never blocks', async () => {
    const root = group('Asset');
    const cover = group('Cover');
    const glass = uberMesh(uber, 'glass', [0, 0, 0]);
    glass.material = new MeshStandardMaterial({ transparent: true, opacity: 0.4 });
    glass.userData._rvUberBaked = false;
    cover.add(glass);
    const inner = withComponent(group('Inner'), 'TestPickFree');
    inner.add(uberMesh(uber, 'innerMesh', [0, 0, -3]));
    root.add(cover, inner);
    const { placed, hover } = await place(root, false, { survives: (n) => n.name === 'Cover' });
    expect(placed.baked.chunks.find((c) => c.key.startsWith('tex:'))!.blocks).toBe(false);
    expect(hover()).toBe(placed.node('Inner'));
  });

  it('a hidden node is skipped and the part behind it is picked', async () => {
    const root = group('Asset');
    const cover = withComponent(group('Cover'), 'TestPickFree');
    cover.add(uberMesh(uber, 'coverMesh', [0, 0, 0]));
    const inner = withComponent(group('Inner'), 'TestPickFree');
    inner.add(uberMesh(uber, 'innerMesh', [0, 0, -3]));
    root.add(cover, inner);
    const { placed, hover } = await place(root, false);
    expect(hover()).toBe(placed.node('Cover'));
    placed.node('Cover').visible = false;
    expect(hover()).toBe(placed.node('Inner'));
  });

  it('two instances of one asset: a grid of rays resolves to the same nodes in both modes', async () => {
    const makeAsset = (): Group => {
      const root = group('Machine');
      root.add(uberMesh(uber, 'frame'));
      const drive = withComponent(group('Drive-A'), 'Drive');
      drive.add(uberMesh(uber, 'arm', [0, 0, 2]));
      root.add(drive);
      const button = withComponent(uberMesh(uber, 'Button', [0, 0, -2]), 'TestPickFree');
      root.add(button);
      return root;
    };
    const baked = await bakeTree(makeAsset(), { uber });
    const setup = (structure: boolean) => {
      const scene = new Scene();
      const bakeRegistry = new BakeRegistry();
      const a = new Group(); a.name = 'A'; scene.add(a);
      const b = new Group(); b.name = 'B'; b.position.x = 10; scene.add(b);
      bakeRegistry.instantiate(baked, a);
      bakeRegistry.instantiate(baked, b);
      scene.updateMatrixWorld(true);
      const registry = new NodeRegistry();
      registerAll(registry, a);
      registerAll(registry, b);
      const rm = makeManager(registry, scene);
      rm.addBackend(new PickBackend(bakeRegistry, null, structure));
      rm.enableHoverType('Drive', true);
      rm.enableHoverType('TestPickFree', true);
      return (x: number, z: number): string | null => {
        rm.updateFromXRController(new Vector3(x, 5, z), new Vector3(0, -1, 0));
        return rm.hoveredNodePath;
      };
    };
    const tree = setup(true);
    const linear = setup(false);
    const seen = new Set<string | null>();
    for (const x of [-0.3, 0, 0.3, 9.7, 10, 10.3, 5]) {
      for (const z of [-2.2, -2, -1.8, -0.3, 0, 0.3, 1.8, 2, 2.2, 4]) {
        const expected = tree(x, z);
        expect(linear(x, z), `ray at x=${x} z=${z}`).toBe(expected);
        seen.add(expected);
      }
    }
    // The grid really covered the frame, the drive and the button of both instances.
    expect([...seen].filter((p) => p !== null).length).toBeGreaterThanOrEqual(5);
  });
});

// ─── 3. Flag ────────────────────────────────────────────────────────────

describe('rv-webviewer-pick-structure dev flag', () => {
  it('default: structure on; "0" switches a freshly built backend to the linear walk', () => {
    expect(isPickStructureEnabled()).toBe(true);
    expect(new PickBackend(new BakeRegistry()).usesStructure).toBe(true);
    localStorage.setItem(PICK_STRUCTURE_LS_KEY, '0');
    expect(isPickStructureEnabled()).toBe(false);
    expect(new PickBackend(new BakeRegistry()).usesStructure).toBe(false);
    // Any other value is "on".
    localStorage.setItem(PICK_STRUCTURE_LS_KEY, '1');
    expect(new PickBackend(new BakeRegistry()).usesStructure).toBe(true);
    // The explicit constructor argument wins over the flag (tests, embedders).
    localStorage.setItem(PICK_STRUCTURE_LS_KEY, '0');
    expect(new PickBackend(new BakeRegistry(), null, true).usesStructure).toBe(true);
  });
});

// ─── 4. Bake: a rejected pick build publishes the chunk segment-only ────

/** A pick build port whose every build rejects — the worker AND the retry failed. */
function rejectingPickPort(message: string): PickBuildPort {
  const real = createPickBuildPort({ createWorker: () => null });
  const reject = (): Promise<never> => Promise.reject(new Error(message));
  return {
    get size() { return real.size; },
    get usesWorker() { return real.usesWorker; },
    get stats() { return real.stats; },
    beginEpoch() {
      const epoch = real.beginEpoch();
      return {
        get id() { return epoch.id; },
        get stale() { return epoch.stale; },
        build: reject,
        abort: () => epoch.abort(),
      };
    },
    build: reject,
    dispose: () => real.dispose(),
  };
}

describe('a chunk whose pick build failed is published segment-only (no load error)', () => {
  it('the bake resolves, every chunk is segment-only, picking still resolves and blocks', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { placed, hover } = await place(coverAndInner(), true, {
        survives: (n) => n.name === 'Cover', pickPort: rejectingPickPort('worker exploded'),
      });
      expect(placed.baked.chunks.length).toBeGreaterThan(0);
      for (const c of placed.baked.chunks) {
        expect(isSegmentOnly(c.pick)).toBe(true);
        expect(c.pick.segmentCount).toBeGreaterThan(0);
        expect(c.pick.segOwner.length).toBe(c.pick.segmentCount);
      }
      const stats = pickMemoryStats([placed.baked]);
      expect(stats.segmentOnlyChunks).toBe(placed.baked.chunks.length);
      expect(stats.clusters).toBe(0);
      expect(stats.segments).toBeGreaterThan(0);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('worker exploded'))).toBe(true);
      // The backend is in STRUCTURE mode, yet the chunk has none — the linear
      // walk is taken automatically, occlusion included.
      expect(hover()).toBeNull();
      placed.node('Cover').visible = false;
      expect(hover()).toBe(placed.node('Inner'));
    } finally {
      warn.mockRestore();
    }
  });

  it('the node table over a segment-only chunk still gives every node its subtree interval', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const root = coverAndInner();
      const { placed } = await place(root, true, { pickPort: rejectingPickPort('boom') });
      const table = placed.baked.nodeTable;
      const inner = placed.node('Inner');
      const ordinal = table.ordinalOf.get(inner);
      expect(ordinal).toBeDefined();
      expect(table.rowStart[ordinal! + 1]).toBeGreaterThan(table.rowStart[ordinal!]);
    } finally {
      warn.mockRestore();
    }
  });
});

// ─── 5. Parity fixtures through the real viewer ─────────────────────────

describe('parity fixtures (a)–(i): the same ray resolves to the expected node in both modes', () => {
  let host: ParityHost;
  beforeAll(async () => { host = await createParityHost(); }, 60_000);
  afterAll(() => { host?.dispose(); });

  for (const fixture of PARITY_FIXTURES) {
    it(`(${fixture.id}) ${fixture.title}`, async () => {
      const bytes = await fixtureBytes(fixture.build());

      localStorage.setItem(PICK_STRUCTURE_LS_KEY, '0');
      const linear = await loadAsMainModel(host, bytes, { claims: fixture.claims });
      expect(host.viewer.getMainModelPickStats()?.pickMode).toBe('linear');
      const pickLinear = pickAt(linear, fixture.pick);
      linear.release();

      localStorage.removeItem(PICK_STRUCTURE_LS_KEY);
      const tree = await loadAsMainModel(host, bytes, { claims: fixture.claims });
      expect(host.viewer.getMainModelPickStats()?.pickMode).toBe('structure');
      const pickTree = pickAt(tree, fixture.pick);
      tree.release();

      expect(pickTree).toBe(fixture.pick.expect);
      expect(pickLinear).toBe(pickTree);
    }, 60_000);
  }
});
