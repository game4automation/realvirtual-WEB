// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Pick consumers outside hover/click go through the ONE pick pipeline
 * (contract-bake-picking rules 15 and 17).
 *
 * Measurement, annotation and the layout planner's direct drag used to cast
 * their own `THREE.Raycaster` over the scene / the placement roots. On a baked
 * model that hits a chunk under a hidden node (three.js ignores an ancestor's
 * `visible`), stops on a transparent chunk, and lets a placement be grabbed
 * through an opaque housing. Every case below runs on the destructive bake
 * (`bakeAndPlace`) with the real `PickBackend` behind a `RaycastManager`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BoxGeometry, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, MeshStandardMaterial, PerspectiveCamera, Scene, Vector3,
} from 'three';
import type { Intersection, Object3D } from 'three';
import '../src/core/engine/rv-scene-loader';
import { RaycastManager, writeWorldNormal } from '../src/core/engine/rv-raycast-manager';
import { EnergyChainManager } from '../src/core/engine/rv-energy-chain-manager';
import { RV_CHAIN_PROXY } from '../src/core/engine/rv-traverse-utils';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { registerComponentSchema } from '../src/core/engine/rv-component-registry';
import { RVUberMaterial } from '../src/core/engine/rv-uber-material';
import { BakeRegistry } from '../src/core/engine/rv-bake-registry';
import { PickBackend } from '../src/core/engine/rv-pick-backend';
import { MeasurementPlugin } from '../src/plugins/measurement-plugin';
import { AnnotationPlugin } from '../src/plugins/annotation-plugin';
import { CanvasInteractionManager, type CanvasInteractionDeps } from '../src/plugins/layout-planner/canvas-interaction';
import { isLockedLayoutInstance, isPlannerSelectable } from '../src/plugins/layout-planner/layout-predicates';
import { bakeAndPlace, group, uberMesh, withComponent } from './fixtures/bake-fixture';

registerComponentSchema('TestPickConsumer', {}, { pick: 'select' });
// An unowned mover: its own chunk, no pick owner — an opaque blocker in a chunk of its own.
registerComponentSchema('TestPickConsumerMover', {}, { bake: 'chunk', pick: 'none' });

const uber = new RVUberMaterial(false);
const SIZE = 200;
const C = SIZE / 2;

let canvas: HTMLCanvasElement | null = null;
const disposers: Array<() => void> = [];
afterEach(() => {
  while (disposers.length) disposers.pop()!();
  canvas?.remove(); canvas = null;
});

function makeCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = SIZE; c.height = SIZE;
  c.style.cssText = `position:fixed;left:0;top:0;width:${SIZE}px;height:${SIZE}px;`;
  document.body.appendChild(c);
  canvas = c;
  return c;
}

/**
 * Asset with a `Cover` at z = 0 (front face z = +0.5) in front of an owned
 * `Inner` at z = −3 (front face z = −2.5). Camera on +Z looking down −Z.
 */
type CoverKind = 'owned' | 'opaque-unowned' | 'glass' | 'keep' | 'revealed' | 'mover';

async function scene(opts: { cover: CoverKind }) {
  const root = group('Asset');
  const cover = opts.cover === 'owned' ? withComponent(group('Cover'), 'TestPickConsumer')
    : opts.cover === 'mover' ? withComponent(group('Cover'), 'TestPickConsumerMover') : group('Cover');
  const coverMesh = uberMesh(uber, 'coverMesh', [0, 0, 0]);
  if (opts.cover === 'glass') {
    coverMesh.material = new MeshStandardMaterial({ transparent: true, opacity: 0.4 });
    coverMesh.userData._rvUberBaked = false;
  }
  // Ownerless KEEP geometry: an authored `BakeRole: 'keep'`, or a CAD box that
  // is hidden while the bake runs (kept as a mesh) and shown afterwards.
  if (opts.cover === 'keep') coverMesh.userData.realvirtual = { BakeRole: 'keep' };
  if (opts.cover === 'revealed') coverMesh.visible = false;
  cover.add(coverMesh);
  const inner = withComponent(group('Inner'), 'TestPickConsumer');
  inner.add(uberMesh(uber, 'innerMesh', [0, 0, -3]));
  root.add(cover, inner);

  const sc = new Scene();
  const bakeRegistry = new BakeRegistry();
  const placed = await bakeAndPlace(root, bakeRegistry, {
    uber, ...(opts.cover === 'owned' ? {} : { survives: (n: Object3D) => n.name === 'Cover' }),
  });
  if (opts.cover === 'revealed') placed.template.traverse((n) => { if (n.name === 'coverMesh') n.visible = true; });
  sc.add(placed.template);
  sc.updateMatrixWorld(true);
  const registry = new NodeRegistry();
  placed.template.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
  const cam = new PerspectiveCamera(40, 1, 0.01, 1000);
  cam.position.set(0, 0, 10);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld(true);
  const el = makeCanvas();
  const rm = new RaycastManager(
    { domElement: el }, () => cam, sc, registry,
    { highlight() {}, highlightInstancedMU() {}, clear() {} } as unknown as import('../src/core/engine/rv-highlight-manager').RVHighlightManager,
    { emit() {} },
  );
  rm.addBackend(new PickBackend(bakeRegistry));
  rm.enableHoverType('TestPickConsumer', true);
  const viewer = {
    renderer: { domElement: el },
    camera: cam,
    scene: sc,
    registry,
    raycastManager: rm,
    controls: { enabled: true, target: new Vector3() },
    pointerPickBlocked: false,
    selectionManager: { getSnapshot: () => ({ selectedPaths: [] }), select() {} },
    markRenderDirty() {},
    getPlugin: () => undefined,
  };
  return { placed, registry, viewer, el, sc, cam, pathOf: (n: Object3D) => registry.getPathForNode(n)! };
}

// ── Measurement ─────────────────────────────────────────────────────────

describe('MeasurementPlugin world pick → pick pipeline', () => {
  const pick = (plugin: MeasurementPlugin, viewer: unknown) => {
    (plugin as unknown as { _viewer: unknown })._viewer = viewer;
    return (plugin as unknown as {
      _worldRaycast(e: { clientX: number; clientY: number }): { point: Vector3; normal: Vector3 | null } | null;
    })._worldRaycast({ clientX: C, clientY: C });
  };

  it('a hidden node is not measured: the point lies on the part behind it', async () => {
    const { placed, viewer } = await scene({ cover: 'owned' });
    placed.node('Cover').visible = false;
    const hit = pick(new MeasurementPlugin(), viewer);
    expect(hit, 'surface behind the hidden cover').not.toBeNull();
    expect(hit!.point.z).toBeCloseTo(-2.5, 4);
    expect(hit!.normal!.z).toBeCloseTo(1, 6);
  });

  it('a transparent chunk lets the measurement pass', async () => {
    const { viewer } = await scene({ cover: 'glass' });
    const hit = pick(new MeasurementPlugin(), viewer);
    expect(hit!.point.z).toBeCloseTo(-2.5, 4);
  });

  it('an opaque unowned housing is a measurable surface (it blocks what is behind)', async () => {
    const { viewer } = await scene({ cover: 'opaque-unowned' });
    const hit = pick(new MeasurementPlugin(), viewer);
    expect(hit!.point.z).toBeCloseTo(0.5, 4);
    expect(hit!.normal!.z).toBeCloseTo(1, 6);
  });

  it('with the planner active, a main-model part with a pick owner is measurable', async () => {
    const { viewer } = await scene({ cover: 'owned' });
    viewer.raycastManager.setAllowFilter(isPlannerSelectable);
    const hit = pick(new MeasurementPlugin(), viewer);
    expect(hit, 'the planner allow filter must not hide the main model from measurement').not.toBeNull();
    expect(hit!.point.z).toBeCloseTo(0.5, 4);
  });

  it('the isolation gate and hidden nodes still apply while the allow filter is skipped', async () => {
    const { placed, viewer } = await scene({ cover: 'owned' });
    viewer.raycastManager.setAllowFilter(isPlannerSelectable);
    placed.node('Cover').visible = false;
    expect(pick(new MeasurementPlugin(), viewer)!.point.z).toBeCloseTo(-2.5, 4);
    viewer.raycastManager.setIsolationGate(() => false);
    expect(pick(new MeasurementPlugin(), viewer)).toBeNull();
  });
});

// ── Annotation ──────────────────────────────────────────────────────────

describe('AnnotationPlugin placement pick → pick pipeline', () => {
  const place = (viewer: unknown) => {
    const plugin = new AnnotationPlugin();
    (plugin as unknown as { _viewer: unknown })._viewer = viewer;
    plugin.annotationMode = true;
    (plugin as unknown as { _handlePointerDown(e: unknown): void })._handlePointerDown(
      { button: 0, clientX: C, clientY: C, detail: 1 },
    );
    return plugin.getAnnotations();
  };

  it('a hidden node gets no pin: the pin lands on the part behind it, attached to that node', async () => {
    const { placed, viewer, pathOf } = await scene({ cover: 'owned' });
    placed.node('Cover').visible = false;
    const anns = place(viewer);
    expect(anns).toHaveLength(1);
    expect(anns[0].position[2]).toBeCloseTo(-2.5, 4);
    expect(anns[0].normal[2]).toBeCloseTo(1, 6);
    expect(anns[0].nodePath).toBe(pathOf(placed.node('Inner')));
  });

  it('a transparent chunk lets the pin pass', async () => {
    const { placed, viewer, pathOf } = await scene({ cover: 'glass' });
    const anns = place(viewer);
    expect(anns[0].position[2]).toBeCloseTo(-2.5, 4);
    expect(anns[0].nodePath).toBe(pathOf(placed.node('Inner')));
  });

  it('with the planner active, a main-model part with a pick owner can be annotated', async () => {
    const { placed, viewer, pathOf } = await scene({ cover: 'owned' });
    viewer.raycastManager.setAllowFilter(isPlannerSelectable);
    const anns = place(viewer);
    expect(anns, 'the planner allow filter must not hide the main model from annotation').toHaveLength(1);
    expect(anns[0].position[2]).toBeCloseTo(0.5, 4);
    expect(anns[0].nodePath).toBe(pathOf(placed.node('Cover')));
  });
});

// ── Layout planner direct drag ──────────────────────────────────────────

describe('Layout planner direct drag → pick pipeline', () => {
  /**
   * A main model (`Machine`, optional `Housing` at z = 0) and a placement
   * (`Placement` with an owned `Part` at z = −3), both baked into one
   * registry — the placement root carries `_layoutId` like a planner record.
   */
  async function arm(opts: { housing: 'none' | 'opaque-unowned' | 'glass'; hidePart?: boolean }) {
    const machine = group('Machine');
    if (opts.housing !== 'none') {
      const housing = group('Housing');
      const m = uberMesh(uber, 'housingMesh', [0, 0, 0]);
      if (opts.housing === 'glass') {
        m.material = new MeshStandardMaterial({ transparent: true, opacity: 0.4 });
        m.userData._rvUberBaked = false;
      }
      housing.add(m);
      machine.add(housing);
    }
    const placementTree = group('Placement');
    const part = withComponent(group('Part'), 'TestPickConsumer');
    part.add(uberMesh(uber, 'partMesh', [0, 0, -3]));
    placementTree.add(part);

    const sc = new Scene();
    const bakeRegistry = new BakeRegistry();
    const main = await bakeAndPlace(machine, bakeRegistry, { uber, survives: (n: Object3D) => n.name === 'Housing' });
    const placed = await bakeAndPlace(placementTree, bakeRegistry, { uber });
    const placement = placed.template;
    placement.userData._layoutId = 'p1';
    if (opts.hidePart) placed.node('Part').visible = false;
    sc.add(main.template, placement);
    sc.updateMatrixWorld(true);
    const registry = new NodeRegistry();
    sc.traverse((n) => { if (n !== sc) registry.registerNode(NodeRegistry.computeNodePath(n), n); });
    const cam = new PerspectiveCamera(40, 1, 0.01, 1000);
    cam.position.set(0, 0, 10);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld(true);
    const el = makeCanvas();
    const rm = new RaycastManager(
      { domElement: el }, () => cam, sc, registry,
      { highlight() {}, highlightInstancedMU() {}, clear() {} } as unknown as import('../src/core/engine/rv-highlight-manager').RVHighlightManager,
      { emit() {} },
    );
    rm.addBackend(new PickBackend(bakeRegistry));
    const viewer = {
      camera: cam,
      registry,
      raycastManager: rm,
      controls: { enabled: true },
      pointerPickBlocked: false,
      selectionManager: { getSnapshot: () => ({ selectedPaths: [] }), select() {} },
      markRenderDirty() {},
    };
    const boxStart = vi.fn();
    const deps = {
      viewer,
      store: {},
      canvas: el,
      objectMap: new Map([['p1', placement]]),
      idByObject: new WeakMap(),
      floorPlane: null,
      transformControls: null,
      modelRoot: null,
      getPlacementEntry: () => null,
      getDragEntry: () => null,
      isActive: () => true,
      boxSelect: { start: boxStart },
      bboxSnap: { isArmed: false, disarm() {} },
    } as unknown as CanvasInteractionDeps;
    const mgr = new CanvasInteractionManager(deps);
    mgr.wire();
    disposers.push(() => mgr.dispose());
    el.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: C, clientY: C, bubbles: true }));
    const candidate = (mgr as unknown as { _dragCandidate: { path: string } | null })._dragCandidate;
    return { placementPath: registry.getPathForNode(placement)!, boxStart, candidate };
  }

  it('baseline: a free placement under the cursor arms the drag', async () => {
    const { candidate, boxStart, placementPath } = await arm({ housing: 'none' });
    expect(candidate?.path).toBe(placementPath);
    expect(boxStart).not.toHaveBeenCalled();
  });

  it('a placement behind glass can still be grabbed', async () => {
    const { candidate, placementPath } = await arm({ housing: 'glass' });
    expect(candidate?.path).toBe(placementPath);
  });

  it('an opaque housing in front of the placement blocks the grab (marquee instead)', async () => {
    const { candidate, boxStart } = await arm({ housing: 'opaque-unowned' });
    expect(candidate).toBeNull();
    expect(boxStart).toHaveBeenCalledTimes(1);
  });

  it('a hidden part of a placement cannot be grabbed', async () => {
    const { candidate, boxStart } = await arm({ housing: 'none', hidePart: true });
    expect(candidate).toBeNull();
    expect(boxStart).toHaveBeenCalledTimes(1);
  });
});

// ── Codex review round: surfaces, keep geometry, locked placements, normals ──

/** Measurement + annotation answers for one scene, through the plugins. */
function surfaceOf(viewer: unknown) {
  const m = new MeasurementPlugin();
  (m as unknown as { _viewer: unknown })._viewer = viewer;
  const hit = (m as unknown as {
    _worldRaycast(e: { clientX: number; clientY: number }): { point: Vector3; normal: Vector3 | null } | null;
  })._worldRaycast({ clientX: C, clientY: C });
  const measureZ = hit ? hit.point.z : null;
  const normalZ = hit?.normal?.z ?? null;
  const a = new AnnotationPlugin();
  (a as unknown as { _viewer: unknown })._viewer = viewer;
  a.annotationMode = true;
  (a as unknown as { _handlePointerDown(e: unknown): void })._handlePointerDown({ button: 0, clientX: C, clientY: C, detail: 1 });
  return { measureZ, normalZ, pins: a.getAnnotations() };
}

describe('pick-only selection hulls are no surface (EnergyChain proxy)', () => {
  it('measurement and annotation look past an invisible chain hull; click still selects the chain', async () => {
    const s = await scene({ cover: 'owned' });
    // The chain hull: invisible by design, registered the way the chain manager does it.
    const chain = s.placed.node('Inner');
    const proxy = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial({ visible: false }));
    proxy.visible = false;
    proxy.userData[RV_CHAIN_PROXY] = true;
    proxy.position.set(0, 0, 3); // in front of everything, in empty space
    s.sc.add(proxy);
    proxy.updateMatrixWorld(true);
    const chains = new EnergyChainManager();
    chains.setRaycastHost(s.viewer.raycastManager);
    chains.registerProxy(proxy, chain);

    const r = surfaceOf(s.viewer);
    expect(r.measureZ, 'measured the cover, not the empty hull').toBeCloseTo(0.5, 4);
    expect(r.pins[0].position[2]).toBeCloseTo(0.5, 4);
    expect(r.pins[0].nodePath).toBe(s.pathOf(s.placed.node('Cover')));
    // Hover/click keep the hull: it is what makes a chain selectable.
    expect(s.viewer.raycastManager.raycastForRVNodeDetailed({ clientX: C, clientY: C })?.path).toBe(s.pathOf(chain));
  });
});

describe('ownerless keep geometry is a blocked surface', () => {
  for (const kind of ['keep', 'revealed'] as const) {
    it(`${kind}: measurement and annotation land on it (point + normal, no node), nothing behind is selected`, async () => {
      const s = await scene({ cover: kind });
      const r = surfaceOf(s.viewer);
      expect(r.measureZ, 'the visible keep box in front is the surface').toBeCloseTo(0.5, 4);
      expect(r.normalZ).toBeCloseTo(1, 6);
      expect(r.pins[0].position[2]).toBeCloseTo(0.5, 4);
      expect(r.pins[0].nodePath).toBeUndefined();
      expect(s.viewer.raycastManager.raycastForRVNodeDetailed({ clientX: C, clientY: C }), 'opaque keep occludes the part behind').toBeNull();
    });
  }

  it('a hidden keep box stays ray-transparent', async () => {
    const s = await scene({ cover: 'keep' });
    s.placed.template.traverse((n) => { if (n.name === 'coverMesh') n.visible = false; });
    expect(surfaceOf(s.viewer).measureZ).toBeCloseTo(-2.5, 4);
  });

  it('a transparent keep box lets the ray pass', async () => {
    const s = await scene({ cover: 'keep' });
    s.placed.template.traverse((n) => {
      if (n.name === 'coverMesh') (n as Mesh).material = new MeshStandardMaterial({ transparent: true, opacity: 0.4 });
    });
    expect(surfaceOf(s.viewer).measureZ).toBeCloseTo(-2.5, 4);
  });
});

describe('Layout planner direct drag: the frontmost layout hit decides', () => {
  it('a locked placement in front stops the drag (marquee), the unlocked one behind is not armed', async () => {
    const mk = (name: string, z: number) => {
      const t = group(name);
      const part = withComponent(group(name + 'Part'), 'TestPickConsumer');
      part.add(uberMesh(uber, name + 'Mesh', [0, 0, z]));
      t.add(part);
      return t;
    };
    const sc = new Scene();
    const bakeRegistry = new BakeRegistry();
    const front = await bakeAndPlace(mk('Front', 0), bakeRegistry, { uber });
    const back = await bakeAndPlace(mk('Back', -3), bakeRegistry, { uber });
    front.template.userData._layoutId = 'front';
    front.template.userData.realvirtual = { ...(front.template.userData.realvirtual ?? {}), LayoutObject: { Locked: true } };
    back.template.userData._layoutId = 'back';
    sc.add(front.template, back.template);
    sc.updateMatrixWorld(true);
    const registry = new NodeRegistry();
    sc.traverse((n) => { if (n !== sc) registry.registerNode(NodeRegistry.computeNodePath(n), n); });
    const cam = new PerspectiveCamera(40, 1, 0.01, 1000);
    cam.position.set(0, 0, 10);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld(true);
    const el = makeCanvas();
    const rm = new RaycastManager(
      { domElement: el }, () => cam, sc, registry,
      { highlight() {}, highlightInstancedMU() {}, clear() {} } as unknown as import('../src/core/engine/rv-highlight-manager').RVHighlightManager,
      { emit() {} },
    );
    rm.addBackend(new PickBackend(bakeRegistry));
    // What the planner installs while active (index.ts): allow filter + ancestor override.
    rm.setAllowFilter((n) => isPlannerSelectable(n) && !isLockedLayoutInstance(n));
    rm.addAncestorOverride((n) => {
      for (let c: Object3D | null = n; c; c = c.parent) {
        if (isPlannerSelectable(c)) return isLockedLayoutInstance(c) ? null : c;
      }
      return null;
    });
    const boxStart = vi.fn();
    const deps = {
      viewer: {
        camera: cam, registry, raycastManager: rm, controls: { enabled: true }, pointerPickBlocked: false,
        selectionManager: { getSnapshot: () => ({ selectedPaths: [] }), select() {} }, markRenderDirty() {},
      },
      store: {}, canvas: el,
      objectMap: new Map<string, Object3D>([['front', front.template], ['back', back.template]]),
      idByObject: new WeakMap(), floorPlane: null, transformControls: null, modelRoot: null,
      getPlacementEntry: () => null, getDragEntry: () => null, isActive: () => true,
      boxSelect: { start: boxStart }, bboxSnap: { isArmed: false, disarm() {} },
    } as unknown as CanvasInteractionDeps;
    const mgr = new CanvasInteractionManager(deps);
    mgr.wire();
    disposers.push(() => mgr.dispose());
    el.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: C, clientY: C, bubbles: true }));
    expect((mgr as unknown as { _dragCandidate: unknown })._dragCandidate).toBeNull();
    expect(boxStart).toHaveBeenCalledTimes(1);
  });
});

describe('writeWorldNormal: the normal matrix, per instance', () => {
  const hitOn = (object: Object3D, n: Vector3, instanceId?: number) =>
    ({ object, distance: 0, point: new Vector3(), face: { a: 0, b: 1, c: 2, normal: n, materialIndex: 0 }, instanceId } as unknown as Intersection<Object3D>);
  const out = new Vector3();

  it('a 45°-rotated instance', () => {
    const im = new InstancedMesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial(), 1);
    im.setMatrixAt(0, new Matrix4().makeRotationY(Math.PI / 4));
    im.updateMatrixWorld(true);
    writeWorldNormal(hitOn(im, new Vector3(0, 0, 1), 0), out);
    expect(out.x).toBeCloseTo(Math.SQRT1_2, 6);
    expect(out.y).toBeCloseTo(0, 6);
    expect(out.z).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('non-uniform scale (inverse-transpose, not transformDirection)', () => {
    const m = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
    m.scale.set(2, 1, 1);
    m.updateMatrixWorld(true);
    writeWorldNormal(hitOn(m, new Vector3(1, 0, 1).normalize()), out);
    expect(out.x).toBeCloseTo(1 / Math.sqrt(5), 6);
    expect(out.z).toBeCloseTo(2 / Math.sqrt(5), 6);
  });

  it('a mirrored (negative-determinant) transform keeps the outward side', () => {
    const m = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
    m.scale.set(-1, 2, 1);
    m.rotation.y = Math.PI / 3;
    m.updateMatrixWorld(true);
    // A slanted local face: normal (1, 1, 0)/√2 through the local point (0.5, 0.5, 0).
    const local = new Vector3(1, 1, 0).normalize();
    const p0 = new Vector3(0.5, 0.5, 0).applyMatrix4(m.matrixWorld);
    const centre = new Vector3(0, 0, 0).applyMatrix4(m.matrixWorld);
    // Two in-plane tangents mapped to world: the normal must be perpendicular to both.
    const t1 = new Vector3(1, -1, 0).transformDirection(m.matrixWorld);
    const t2 = new Vector3(0, 0, 1).transformDirection(m.matrixWorld);
    writeWorldNormal(hitOn(m, local), out);
    expect(out.length()).toBeCloseTo(1, 6);
    expect(out.dot(t1)).toBeCloseTo(0, 6);
    expect(out.dot(t2)).toBeCloseTo(0, 6);
    // …and it points away from the centre (outward side kept under the mirror).
    expect(out.dot(p0.sub(centre))).toBeGreaterThan(0);
  });
});

// ── Codex re-review: isolation vs. blockers, chain placements in the planner drag ──

/** True when `n` is `root` or below it. */
function inSubtree(n: Object3D, root: Object3D): boolean {
  for (let c: Object3D | null = n; c; c = c.parent) if (c === root) return true;
  return false;
}

describe('ownerless blockers outside the isolation do not block', () => {
  // An unowned chunk segment that shares ONE chunk with the target cannot be
  // passed at the resolution layer (the chunk answers its nearest hit only);
  // the rule covers a blocker in its own mesh: a keep mesh or a mover chunk.
  for (const kind of ['keep', 'mover'] as const) {
    it(`${kind}: the isolated target behind it is selected`, async () => {
      const s = await scene({ cover: kind });
      const inner = s.placed.node('Inner');
      expect(s.viewer.raycastManager.raycastForRVNodeDetailed({ clientX: C, clientY: C }), 'baseline: blocked').toBeNull();
      s.viewer.raycastManager.setIsolationGate((n) => inSubtree(n, inner));
      expect(s.viewer.raycastManager.raycastForRVNodeDetailed({ clientX: C, clientY: C })?.path).toBe(s.pathOf(inner));
    });
  }
});

describe('Layout planner direct drag: EnergyChain placements', () => {
  /** A chain placement: the hull is its only pick geometry (skinned meshes are not in the backend). */
  function chainPlacement(id: string, locked: boolean, z: number) {
    const root = group('ChainPlacement_' + id);
    root.userData._layoutId = id;
    if (locked) root.userData.realvirtual = { LayoutObject: { Locked: true } };
    const chain = withComponent(group('Chain_' + id), 'TestPickConsumer');
    const hull = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial({ visible: false }));
    hull.visible = false;
    hull.userData[RV_CHAIN_PROXY] = true;
    hull.position.set(0, 0, z);
    chain.add(hull);
    root.add(chain);
    return { root, chain, hull };
  }

  async function rig(opts: { chainLocked: boolean; withBehind: boolean }) {
    const sc = new Scene();
    const bakeRegistry = new BakeRegistry();
    const objectMap = new Map<string, Object3D>();
    const cp = chainPlacement('chain', opts.chainLocked, 0);
    sc.add(cp.root);
    objectMap.set('chain', cp.root);
    let behind: Object3D | null = null;
    if (opts.withBehind) {
      const t = group('Behind');
      const part = withComponent(group('BehindPart'), 'TestPickConsumer');
      part.add(uberMesh(uber, 'behindMesh', [0, 0, -3]));
      t.add(part);
      const placed = await bakeAndPlace(t, bakeRegistry, { uber });
      behind = placed.template;
      behind.userData._layoutId = 'behind';
      sc.add(behind);
      objectMap.set('behind', behind);
    }
    sc.updateMatrixWorld(true);
    const registry = new NodeRegistry();
    sc.traverse((n) => { if (n !== sc) registry.registerNode(NodeRegistry.computeNodePath(n), n); });
    const cam = new PerspectiveCamera(40, 1, 0.01, 1000);
    cam.position.set(0, 0, 10);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld(true);
    const el = makeCanvas();
    const rm = new RaycastManager(
      { domElement: el }, () => cam, sc, registry,
      { highlight() {}, highlightInstancedMU() {}, clear() {} } as unknown as import('../src/core/engine/rv-highlight-manager').RVHighlightManager,
      { emit() {} },
    );
    rm.addBackend(new PickBackend(bakeRegistry));
    const chains = new EnergyChainManager();
    chains.setRaycastHost(rm);
    chains.registerProxy(cp.hull, cp.chain);
    rm.setAllowFilter((n) => isPlannerSelectable(n) && !isLockedLayoutInstance(n));
    rm.addAncestorOverride((n) => {
      for (let c: Object3D | null = n; c; c = c.parent) {
        if (isPlannerSelectable(c)) return isLockedLayoutInstance(c) ? null : c;
      }
      return null;
    });
    const boxStart = vi.fn();
    const deps = {
      viewer: {
        camera: cam, registry, raycastManager: rm, controls: { enabled: true }, pointerPickBlocked: false,
        selectionManager: { getSnapshot: () => ({ selectedPaths: [] }), select() {} }, markRenderDirty() {},
      },
      store: {}, canvas: el, objectMap,
      idByObject: new WeakMap(), floorPlane: null, transformControls: null, modelRoot: null,
      getPlacementEntry: () => null, getDragEntry: () => null, isActive: () => true,
      boxSelect: { start: boxStart }, bboxSnap: { isArmed: false, disarm() {} },
    } as unknown as CanvasInteractionDeps;
    const mgr = new CanvasInteractionManager(deps);
    mgr.wire();
    disposers.push(() => mgr.dispose());
    el.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: C, clientY: C, bubbles: true }));
    const candidate = (mgr as unknown as { _dragCandidate: { path: string } | null })._dragCandidate;
    return { candidate, boxStart, chainPath: registry.getPathForNode(cp.root)! };
  }

  it('an unlocked chain placement can be grabbed by its hull', async () => {
    const { candidate, boxStart, chainPath } = await rig({ chainLocked: false, withBehind: true });
    expect(candidate?.path).toBe(chainPath);
    expect(boxStart).not.toHaveBeenCalled();
  });

  it('a locked chain placement in front stops the drag (marquee), the placement behind is not armed', async () => {
    const { candidate, boxStart } = await rig({ chainLocked: true, withBehind: true });
    expect(candidate).toBeNull();
    expect(boxStart).toHaveBeenCalledTimes(1);
  });
});

// ── Codex: keep-mesh occlusion reads the HIT FACE's material ──

describe('ownerless keep mesh with a material array: the hit face decides', () => {
  /** BoxGeometry groups: 0 +X, 1 −X, 2 +Y, 3 −Y, 4 +Z (front), 5 −Z (back). */
  function faceMaterials(frontOpaque: boolean, backOpaque: boolean) {
    const glass = () => new MeshStandardMaterial({ transparent: true, opacity: 0.4 });
    const solid = () => new MeshStandardMaterial();
    return [glass(), glass(), glass(), glass(), frontOpaque ? solid() : glass(), backOpaque ? solid() : glass()];
  }
  const withMaterials = (s: Awaited<ReturnType<typeof scene>>, mats: MeshStandardMaterial[]) =>
    s.placed.template.traverse((n) => { if (n.name === 'coverMesh') (n as Mesh).material = mats; });

  it('opaque front + transparent back: the front face blocks', async () => {
    const s = await scene({ cover: 'keep' });
    withMaterials(s, faceMaterials(true, false));
    const r = surfaceOf(s.viewer);
    expect(r.measureZ, 'stops on the opaque front face').toBeCloseTo(0.5, 4);
    expect(s.viewer.raycastManager.raycastForRVNodeDetailed({ clientX: C, clientY: C })).toBeNull();
  });

  it('transparent front + opaque back: the ray passes the front face', async () => {
    const s = await scene({ cover: 'keep' });
    withMaterials(s, faceMaterials(false, true));
    // A mesh answers its nearest face only, so the opaque back face (z = −0.5)
    // is not reachable behind the glass front; the ray goes on to the part behind.
    const r = surfaceOf(s.viewer);
    expect(r.measureZ).not.toBeCloseTo(0.5, 4);
    expect(r.measureZ).toBeCloseTo(-2.5, 4);
  });
});
