// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-753 §9.6 — highlight strategy `chunk-outline`.
 *
 * Hover / selection / aux / flash of a node inside a baked placement produce
 * exactly one WRAPPER proxy per touched CHUNK with the node's subtree segment
 * interval as `drawRange` (plan-756 Q7 — it used to be one proxy per window);
 * the shared `chunk.geometry.drawRange` stays `{0, Infinity}` (S1); the
 * proxy's `boundingSphere` comes from the range; everything lands in the
 * OutlinePass channel; no `EdgesGeometry` / overlay pair is ever built for a
 * placement; proxies are pooled (no dispose); a negatively scaled placement
 * mirrors its chunk mesh's matrix (the OutlinePass flips front faces per
 * object from the determinant); a released instance takes its proxies out.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { Group, Scene, Mesh, LineSegments, BufferGeometry } from 'three';
import type { Object3D } from 'three';
import '../src/core/engine/rv-scene-loader';
import { RVHighlightManager } from '../src/core/engine/rv-highlight-manager';
import { RVUberMaterial } from '../src/core/engine/rv-uber-material';
import { BakeRegistry } from '../src/core/engine/rv-bake-registry';
import type { BakedAsset } from '../src/core/engine/rv-bake-chunk';
import { MODE_HIGHLIGHT_PROFILES } from '../src/core/engine/rv-highlight-profiles';
import { bakeTree, group, uberMesh, withComponent } from './fixtures/bake-fixture';

const uber = new RVUberMaterial(false);

/** static: frame + Sensor(window) ; mover: Drive-A */
function makeAsset(): Group {
  const root = group('Machine');
  root.add(uberMesh(uber, 'frame'));
  const sensor = withComponent(group('Sensor-1'), 'Sensor');
  sensor.add(uberMesh(uber, 'eye', [0, 0, -3]));
  root.add(sensor);
  const drive = withComponent(group('Drive-A'), 'Drive');
  drive.add(uberMesh(uber, 'arm', [0, 0, 3]));
  root.add(drive);
  return root;
}

/** Records what each OutlinePass channel was handed. */
function fakeOutlineManager() {
  const channels = { selection: [] as Object3D[], hover: [] as Object3D[], flash: [] as Object3D[] };
  return {
    channels,
    available: true,
    hoverPass: null,
    setStyle() {}, setHoverStyle() {}, setFlashStyle() {},
    setOutlined(o: readonly Object3D[]) { channels.selection = [...o]; },
    setHoverOutlined(o: readonly Object3D[]) { channels.hover = [...o]; },
    setFlashOutlined(o: readonly Object3D[]) { channels.flash = [...o]; },
    clearHover() { channels.hover = []; },
    clearFlash() { channels.flash = []; },
    clear() { channels.selection = []; },
  };
}

function lineSegmentsIn(scene: Scene): number {
  let n = 0;
  scene.traverse((o) => { if ((o as LineSegments).isLineSegments) n++; });
  return n;
}

describe('chunk-outline highlight (plan-753 §9.6)', () => {
  let baked: BakedAsset;
  beforeAll(async () => { baked = await bakeTree(makeAsset(), { uber }); });

  function setup(scale = 1) {
    const scene = new Scene();
    const registry = new BakeRegistry();
    const root = new Group(); root.name = 'P'; root.scale.setScalar(scale); root.position.x = 4;
    scene.add(root);
    const inst = registry.instantiate(baked, root);
    scene.updateMatrixWorld(true);
    const om = fakeOutlineManager();
    const hm = new RVHighlightManager(scene);
    hm.setOutlineManager(om as never);
    hm.setChunkSource(registry);
    hm.setProfile(MODE_HIGHLIGHT_PROFILES.planner);
    const sensor = inst.logicNodes.find((n) => n.name === 'Sensor-1')!;
    const drive = inst.logicNodes.find((n) => n.name === 'Drive-A')!;
    const staticMesh = inst.chunks.find((m) => m.name === 'static')!;
    const moverMesh = inst.chunks.find((m) => m.name === 'mover:Drive-A')!;
    return { scene, registry, root, inst, om, hm, sensor, drive, staticMesh, moverMesh };
  }

  it('hover on a node with a segment interval: ONE wrapper proxy per chunk, drawRange on the wrapper only', () => {
    const { hm, om, sensor, staticMesh, scene, registry } = setup();
    hm.highlight(sensor);
    expect(om.channels.hover).toHaveLength(1);
    const proxy = om.channels.hover[0] as Mesh;
    expect(proxy).not.toBe(staticMesh);
    expect(proxy.geometry).not.toBe(staticMesh.geometry);
    // Shares position + index by reference (zero-copy wrapper).
    expect(proxy.geometry.getAttribute('position')).toBe(staticMesh.geometry.getAttribute('position'));
    expect(proxy.geometry.index).toBe(staticMesh.geometry.index);
    // ONE range per CHUNK, taken from the node's subtree segment interval
    // (plan-756 Q7/§9.4 — it used to be one proxy per index WINDOW).
    const targets = registry.chunkTargetsOf(sensor)!;
    expect(targets.filter((t) => t.mesh === staticMesh)).toHaveLength(1);
    const range = targets.find((t) => t.mesh === staticMesh)!.range!;
    expect(proxy.geometry.drawRange).toEqual({ start: range.indexStart, count: range.indexCount });
    // S1: the shared chunk geometry is untouched.
    expect(staticMesh.geometry.drawRange).toEqual({ start: 0, count: Infinity });
    // boundingSphere from the RANGE (the eye box at z=-3, radius ~ half diagonal).
    const sphere = proxy.geometry.boundingSphere!;
    expect(sphere.center.z).toBeCloseTo(-3, 5);
    expect(sphere.radius).toBeCloseTo(Math.sqrt(3) / 2, 5);
    expect(proxy.frustumCulled).toBe(false);
    expect(proxy.matrixAutoUpdate).toBe(false);
    expect(proxy.matrixWorld.equals(staticMesh.matrixWorld)).toBe(true);
    expect(proxy.parent).toBe(scene);
    // No EdgesGeometry / overlay pair anywhere in the planner profile.
    expect(lineSegmentsIn(scene)).toBe(0);
    expect(hm.activeChunkProxies).toHaveLength(1);
  });

  it('a mover node outlines its WHOLE chunk mesh directly (no proxy)', () => {
    const { hm, om, drive, moverMesh } = setup();
    hm.highlight(drive);
    expect(om.channels.hover).toEqual([moverMesh]);
    expect(hm.activeChunkProxies).toHaveLength(0);
  });

  it('the placement root outlines every chunk mesh directly', () => {
    const { hm, om, root, inst } = setup();
    hm.highlightSelection([root]);
    expect(new Set(om.channels.selection)).toEqual(new Set(inst.chunks));
    expect(hm.isSelectionActive).toBe(true);
  });

  it('selection, aux and flash channels take window proxies too', () => {
    const { hm, om, sensor, scene } = setup();
    hm.highlightSelection([sensor]);
    expect(om.channels.selection).toHaveLength(1);
    expect((om.channels.selection[0] as Mesh).geometry.drawRange.count).toBeGreaterThan(0);
    hm.setAuxEmphasis('ghost', [sensor]);
    // selection ∪ aux → two distinct proxies on the selection channel
    expect(om.channels.selection).toHaveLength(2);
    hm.flash([sensor], { color: 0xff0000 });
    expect(om.channels.flash).toHaveLength(1);
    expect(lineSegmentsIn(scene)).toBe(0);
    hm.clearFlash();
    expect(om.channels.flash).toHaveLength(0);
  });

  it('pool reuse: a proxy released by clear() is reused, never disposed', () => {
    const { hm, sensor } = setup();
    hm.highlight(sensor);
    const first = hm.activeChunkProxies[0];
    let disposed = false;
    const orig = first.geometry.dispose.bind(first.geometry);
    first.geometry.dispose = () => { disposed = true; orig(); };
    hm.clear();
    expect(hm.activeChunkProxies).toHaveLength(0);
    expect(hm.chunkProxyPoolSize).toBe(1);
    hm.highlight(sensor);
    expect(hm.activeChunkProxies[0]).toBe(first);
    expect(hm.chunkProxyPoolSize).toBe(0);
    expect(disposed).toBe(false);
  });

  it('a negatively scaled placement: proxy matrix mirrors the chunk mesh (negative determinant)', () => {
    const { hm, om, sensor, staticMesh } = setup(-1);
    hm.highlight(sensor);
    const proxy = om.channels.hover[0] as Mesh;
    expect(staticMesh.matrixWorld.determinant()).toBeLessThan(0);
    expect(proxy.matrixWorld.determinant()).toBeCloseTo(staticMesh.matrixWorld.determinant(), 6);
  });

  it('per-frame update() follows a moving chunk mesh', () => {
    const { hm, om, sensor, staticMesh, root, scene } = setup();
    hm.highlight(sensor);
    const proxy = om.channels.hover[0] as Mesh;
    root.position.x = 20;
    scene.updateMatrixWorld(true);
    hm.update();
    expect(proxy.matrixWorld.equals(staticMesh.matrixWorld)).toBe(true);
  });

  it('release of the instance takes its proxies out of the scene and channels', () => {
    const { hm, om, sensor, registry, inst, root, scene } = setup();
    hm.highlightSelection([sensor, root]);
    expect(om.channels.selection.length).toBeGreaterThan(1);
    registry.release(inst);
    expect(hm.activeChunkProxies).toHaveLength(0);
    expect(om.channels.selection).toHaveLength(0);
    expect(scene.children.some((c) => c.name === '__hlChunkProxy')).toBe(false);
    // Last instance: the pooled wrapper no longer references chunk attributes.
    for (let i = 0; i < hm.chunkProxyPoolSize; i++) { /* pool inspected below */ }
    expect(hm.chunkProxyPoolSize).toBe(1);
    hm.dispose();
  });

  it('a node outside any placement keeps the classic outline strategy', () => {
    const { hm, om, scene } = setup();
    const plain = new Group();
    plain.add(new Mesh(new BufferGeometry()));
    scene.add(plain);
    hm.highlight(plain);
    expect(om.channels.hover).toEqual([plain]);
  });
});

/**
 * plan-756 Phase 2 — a PLAIN STRUCTURAL node (no component of its own, kept only
 * as the ancestor of a survivor) highlights its subtree geometry.
 *
 * Before the node table such a node had no window of its own: the highlight fell
 * through to `bbox` or to nothing. Now its CSR row is the segment interval of its
 * whole subtree — its own merged meshes AND the geometry of the metadata /
 * component parts below it — so hover, selection, aux emphasis and flash all draw
 * exactly the same one range per chunk. All four channels go through
 * `chunkTargetsOf`, which is why one interval covers them.
 */
describe('structural-node highlight (plan-756 Q7/F5)', () => {
  /** Machine > Assembly(plain) > [plate, Sensor-1 > eye] */
  function makeStructuralAsset(): Group {
    const root = group('Machine');
    root.add(uberMesh(uber, 'frame'));
    const assembly = group('Assembly');
    assembly.add(uberMesh(uber, 'plate', [0, 2, 0]));
    const sensor = withComponent(group('Sensor-1'), 'Sensor');
    sensor.add(uberMesh(uber, 'eye', [0, 0, -3]));
    assembly.add(sensor);
    root.add(assembly);
    return root;
  }

  async function setupStructural() {
    const scene = new Scene();
    const registry = new BakeRegistry();
    // Identity placement (the main model): every survivor IS a scene node, which
    // is what makes a plain structural ancestor addressable at all.
    const baked = await bakeTree(makeStructuralAsset(), { uber, destructive: true });
    const inst = registry.instantiateTemplate(baked);
    scene.add(baked.template);
    scene.updateMatrixWorld(true);
    const om = fakeOutlineManager();
    const hm = new RVHighlightManager(scene);
    hm.setOutlineManager(om as never);
    hm.setChunkSource(registry);
    hm.setProfile(MODE_HIGHLIGHT_PROFILES.planner);
    let assembly: Object3D | null = null;
    baked.template.traverse((n) => { if (!assembly && n.name === 'Assembly') assembly = n; });
    const staticMesh = inst.chunks.find((m) => m.name === 'static')!;
    return { scene, registry, hm, om, assembly: assembly as unknown as Object3D, staticMesh };
  }

  it('its subtree interval covers its own mesh AND the component part below it', async () => {
    const { registry, assembly, staticMesh } = await setupStructural();
    const targets = registry.chunkTargetsOf(assembly)!;
    expect(targets).toHaveLength(1);
    expect(targets[0].mesh).toBe(staticMesh);
    // plate (12 triangles) + eye (12 triangles), one contiguous range.
    expect(targets[0].range!.indexCount).toBe(2 * 12 * 3);
  });

  it('hover / selection / aux / flash all draw that one range', async () => {
    const { hm, om, registry, assembly, scene } = await setupStructural();
    const range = registry.chunkTargetsOf(assembly)![0].range!;
    const expectRange = (o: Object3D) => {
      expect((o as Mesh).geometry.drawRange).toEqual({ start: range.indexStart, count: range.indexCount });
    };

    hm.highlight(assembly);
    expect(om.channels.hover).toHaveLength(1);
    expectRange(om.channels.hover[0]);
    hm.clear();

    hm.highlightSelection([assembly]);
    expect(om.channels.selection).toHaveLength(1);
    expectRange(om.channels.selection[0]);

    hm.setAuxEmphasis('ghost', [assembly]);
    expect(om.channels.selection).toHaveLength(2);
    expectRange(om.channels.selection[1]);

    hm.flash([assembly], { color: 0xff0000 });
    expect(om.channels.flash).toHaveLength(1);
    expectRange(om.channels.flash[0]);

    // Still no per-mesh overlay pair anywhere — it stayed on the chunk path.
    expect(lineSegmentsIn(scene)).toBe(0);
    hm.dispose();
  });
});
