// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-724 §9.2 — the two-stage Pivot-to-Circle interaction.
 *
 * ── What is actually at risk here ───────────────────────────────────────────
 * The maths is tested elsewhere. What this file pins is the STATE MACHINE, and
 * specifically its exits. Stage two dims the whole scene through the isolate
 * layer, hangs an overlay in it and leaves a region memo in module state; there
 * are five ways out (Escape back, right-click, commit, disarm, model change) and
 * every one of them has to undo all three. A missed edge does not throw — it
 * leaves the user in a dimmed viewport with a marker floating over geometry,
 * which no amount of clicking fixes.
 *
 * The claim behaviour matters for the same reason it does in the joint-overview
 * suite: claiming a MISS steals clicks from every other tool, claiming nothing
 * re-selects the geometry behind the ring on every commit. Since plan-724 the
 * rule is sharper — a corner that lies on NO circle is not claimed at all,
 * because a click there means nothing (F5).
 *
 * Two things are deliberately driven through an INJECTED query rather than the
 * real geometry: the "no circle here" state and the throttle. Both are
 * statements about the machine, and the plate fixture has no vertex that lies on
 * nothing (its outer outline is a circle too), so a real hover could not produce
 * that state at all.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  BufferAttribute, BufferGeometry, Group, Mesh, Object3D, PerspectiveCamera, Scene,
  Vector3,
} from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import type { RVViewer } from '../src/core/rv-viewer';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { scratchAssetDocument } from './helpers/scratch-asset-document';
import {
  CirclePickGizmo, type CircleGizmoTarget,
} from '@rv-private/plugins/asset-editor/circle-pick-gizmo';
import {
  cancelPivotCirclePick, getPivotCirclePickSnapshot, isPivotCirclePickActive,
  startPivotCirclePick,
} from '@rv-private/plugins/asset-editor/pivot-circle-pick';
import {
  cancelPivotPick, isPivotPickActive, startPivotPick,
} from '@rv-private/plugins/asset-editor/pivot-pick';
import {
  cancelMechanismPick, isMechanismPickActive, startMechanismPick,
} from '@rv-private/plugins/asset-editor/mechanism/mechanism-pick';
import {
  getVertexCircleMemoStats, queryVertexCircle,
  type VertexCircleHover,
} from '@rv-private/plugins/asset-editor/mechanism/mechanism-circle-vertex-query';
import { indicesOf, plateWithBores, positionsOf } from './helpers/mesh-fixtures';

const CANVAS_W = 400;
const CANVAS_H = 300;
const CENTRE_X = CANVAS_W / 2;
const CENTRE_Y = CANVAS_H / 2;
/**
 * Where stage one clicks: on the plate's MATERIAL, ~60 px off the axis.
 *
 * Not the canvas centre — that ray goes straight down the bore and through the
 * hole, hitting nothing. Which is the point of the tool: the circle you want is
 * exactly the place where there is no geometry to click.
 */
const ON_PLATE_X = CENTRE_X + 60;

const PLATE = plateWithBores({ thickness: 6, bores: [{ x: 0, y: 0, radius: 4 }] });
/** Group name the harness's Kinematic references. */
const KINEMATIC_GROUP = 'K1';
/** A point of the top face just outside the bore rim — inside the 14 px snap radius. */
const NEAR_RIM = new Vector3(4.4, 0, 3);
/** The bore's top rim: centre (0,0,3), radius 4 — what a commit must land on. */
const RIM_Z = 3;

const cleanups: (() => void)[] = [];
afterEach(() => {
  cancelPivotCirclePick();
  cancelPivotPick();
  cancelMechanismPick();
  while (cleanups.length) cleanups.pop()!();
});

// ─── Harness ────────────────────────────────────────────────────────────────

function makeCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  canvas.style.cssText = `position:fixed;left:0;top:0;width:${CANVAS_W}px;height:${CANVAS_H}px`;
  document.body.appendChild(canvas);
  cleanups.push(() => canvas.remove());
  return canvas;
}

function plateMesh(name: string): Mesh {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positionsOf(PLATE), 3));
  geometry.setIndex(Array.from(indicesOf(PLATE)));
  const mesh = new Mesh(geometry);
  mesh.name = name;
  return mesh;
}

interface Harness {
  viewer: RVViewer;
  doc: ReturnType<typeof scratchAssetDocument>;
  model: Group;
  axisNode: Object3D;
  bore: Mesh;
  camera: PerspectiveCamera;
  isolated: () => Object3D[] | null;
  /** Whether the normal hover pipeline is currently on. */
  hoverEnabled: () => boolean;
  /** Whether the installed allow filter would let a node hover. */
  hoverAllowed: (node: Object3D) => boolean;
  /** The x-ray silhouette overlays currently in the scene. */
  xrayRoots: () => Object3D[];
  /** Every `fitToNodes` call stage two made. */
  framed: () => Object3D[][];
  /** Spies for the "the normal pick visuals go quiet, then come back" pair. */
  highlightsCleared: ReturnType<typeof vi.fn>;
  selectionRefreshed: ReturnType<typeof vi.fn>;
  /** Every `highlightSelection` the teardown applied. */
  selectionHighlighted: ReturnType<typeof vi.fn>;
  /** Select the axis and give it a Kinematic on a group holding the bore. */
  selectKinematicAxis: () => void;
  /** Last mesh handed to the gated raycast stub — set to null for "empty space". */
  setHit: (path: string | null) => void;
  overlayRoots: () => Object3D[];
  /** The overlay group, or null when no gizmo exists. */
  overlay: () => Object3D | null;
  /** Canvas pixel of a world point. */
  screenOf: (world: Vector3) => { x: number; y: number };
  /** Fires the `model-cleared` event every `loadModel` emits before it parses. */
  clearModel: () => void;
  /** Left pointerdowns that were NOT claimed by the machine. */
  downstream: ReturnType<typeof makeDownstream>;
}

function makeHarness(): Harness {
  const scene = new Scene();
  const camera = new PerspectiveCamera(50, CANVAS_W / CANVAS_H, 0.1, 1000);
  // Looking down −Z at the plate, so a bore of radius 4 fills a good part of the
  // canvas and its rim vertices are comfortably resolvable in screen space.
  camera.position.set(0, 0, 40);
  camera.updateMatrixWorld(true);
  const canvas = makeCanvas();

  const model = new Group();
  model.name = 'Asset';
  const axisNode = new Object3D();
  axisNode.name = 'Axis';
  const bore = plateMesh('Bore');
  model.add(axisNode, bore);
  scene.add(model);

  const registry = new NodeRegistry();
  model.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
  model.updateMatrixWorld(true);

  let hitPath: string | null = 'Asset/Bore';
  let isolated: Object3D[] | null = null;
  // Stage two switches the normal hover/selection visuals off and frames the
  // target; the harness records both so the tests can assert the restore.
  let hoverEnabled = true;
  // The switch that actually holds: an orbit re-enables hover, it does not
  // restore an allow filter.
  let allowFilter: ((node: Object3D) => boolean) | null = null;
  const framed: Object3D[][] = [];
  const highlightsCleared = vi.fn();
  const selectionRefreshed = vi.fn();
  const selectionHighlighted = vi.fn();
  // The editor's selection, as the pick's teardown reads it back.
  let selectedPaths: string[] = [];
  const listeners = new Map<string, Set<() => void>>();

  const viewer = {
    scene, camera,
    renderer: { domElement: canvas },
    registry,
    markRenderDirty: vi.fn(),
    markShadowsDirty: vi.fn(),
    emit() {},
    on(event: string, handler: () => void) {
      const bucket = listeners.get(event) ?? new Set();
      bucket.add(handler);
      listeners.set(event, bucket);
      return () => { bucket.delete(handler); };
    },
    rebuildGroupedBvh() {},
    signalStore: null, transportManager: null,
    get currentModelRoot() { return model; },
    groups: {
      setExternalIsolated(roots: Object3D[] | null) { isolated = roots; },
      get: (name: string) => (name === KINEMATIC_GROUP ? { nodes: [bore] } : undefined),
    },
    raycastManager: {
      raycastForRVNodeDetailed() {
        return hitPath ? { path: hitPath, hitPoint: [0, 0, 3], hitNormal: [0, 0, 1] } : null;
      },
      get enabled() { return hoverEnabled; },
      setEnabled(value: boolean) { hoverEnabled = value; },
      getAllowFilter() { return allowFilter; },
      setAllowFilter(filter: ((node: Object3D) => boolean) | null) { allowFilter = filter; },
    },
    highlighter: { clearAll: highlightsCleared, highlightSelection: selectionHighlighted },
    selectionManager: {
      refreshHighlight: selectionRefreshed,
      getSnapshot: () => ({ selectedPaths: selectedPaths, primaryPath: selectedPaths[0] ?? null }),
    },
    fitToNodes(nodes: Object3D[]) { framed.push(nodes); },
  } as unknown as RVViewer;

  const doc = scratchAssetDocument(viewer);
  cleanups.push(() => doc.dispose());

  // Registered AFTER the machine arms, so silence here is the observable form of
  // a claim. Installed per test through `armDownstream()`.
  const downstream = makeDownstream();

  return {
    viewer, doc, model, axisNode, bore, camera, downstream,
    isolated: () => isolated,
    /** Put the axis under selection, carrying a Kinematic on the group. */
    selectKinematicAxis: () => {
      axisNode.userData.realvirtual = { Kinematic: { GroupName: KINEMATIC_GROUP } };
      selectedPaths = ['Asset/Axis'];
    },
    selectionHighlighted,
    hoverEnabled: () => hoverEnabled,
    hoverAllowed: (node: Object3D) => (allowFilter ? allowFilter(node) : true),
    xrayRoots: () => scene.children.filter((c) => c.name === '__rvCirclePickXRay'),
    framed: () => framed,
    highlightsCleared, selectionRefreshed,
    setHit: (path) => { hitPath = path; },
    overlayRoots: () => scene.children.filter((c) => c.name === '__rvCirclePickGizmo'),
    overlay: () => scene.children.find((c) => c.name === '__rvCirclePickGizmo') ?? null,
    screenOf: (world) => {
      const v = world.clone().project(camera);
      return { x: ((v.x + 1) / 2) * CANVAS_W, y: ((1 - v.y) / 2) * CANVAS_H };
    },
    clearModel: () => { for (const h of listeners.get('model-cleared') ?? []) h(); },
  };
}

/** A typed pointerdown spy — `vi.fn()` alone is not an `EventListener`. */
function makeDownstream() {
  return vi.fn((_e: PointerEvent) => {});
}

/** Watch for pointerdowns the machine let through — registered after arming. */
function armDownstream(h: Harness): void {
  window.addEventListener('pointerdown', h.downstream, true);
  cleanups.push(() => window.removeEventListener('pointerdown', h.downstream, true));
}

function pointer(type: 'pointerdown' | 'pointerup' | 'pointermove', x: number, y: number): void {
  window.dispatchEvent(new PointerEvent(type, {
    clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true,
  }));
}

function escape(): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
}

/** A click = down + up at the same spot, below the drag threshold. */
function click(x: number, y: number): void {
  pointer('pointerdown', x, y);
  pointer('pointerup', x, y);
}

/** Let the commit promise chain settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

/** Past the 50 ms hover throttle. */
function pastThrottle(): Promise<void> {
  return new Promise((r) => setTimeout(r, 70));
}

/** Arm and take the clicked mesh — i.e. land in `hovering`. */
function armedOnMesh(h: Harness, options: Parameters<typeof startPivotCirclePick>[3] = {}): void {
  startPivotCirclePick(h.viewer, h.doc, 'Asset/Axis', options);
  click(ON_PLATE_X, CENTRE_Y);
}

/** A counting stand-in for the geometry query. */
function countingQuery(sample: VertexCircleHover | null) {
  const spy = vi.fn(() => sample);
  return { spy, query: spy as unknown as typeof queryVertexCircle };
}

const NO_CIRCLE_SAMPLE: VertexCircleHover = {
  meshPath: 'Asset/Bore',
  vertexId: 7,
  localVertex: [10, 0, 3],
  worldVertex: [10, 0, 3],
  circle: null,
  reason: 'no-loop',
};

/** Visible children of the overlay group, by constructor name. */
function visibleRing(h: Harness): boolean {
  const root = h.overlay();
  if (!root) return false;
  // The ring is a fat line (LineSegments2) since the hairline proved unreadable.
  return root.children.some((c) => c instanceof LineSegments2 && c.visible);
}

// ─── The state machine ──────────────────────────────────────────────────────

describe('pivot-to-circle interaction', () => {
  it('finds the clicked mesh and dims the rest of the scene', () => {
    const h = makeHarness();
    expect(h.isolated()).toBeNull();
    armedOnMesh(h);

    expect(getPivotCirclePickSnapshot().stage).toBe('hovering');
    // Dimmed — and dimmed on the exact mesh that was hit, not on its group root.
    expect(h.isolated()).toEqual([h.bore]);
    expect(h.overlayRoots()).toHaveLength(1);
    // Nothing is drawn until the pointer says where it is.
    expect(h.overlay()!.visible).toBe(false);
  });

  it('walks past the invisible merged raycast proxy a Drive parents into its subtree', () => {
    const h = makeHarness();
    // What `rv-raycast-geometry` adds under every Drive: one merged, invisible
    // copy of the whole kinematic subtree. three's raycast ignores `visible`,
    // so without the guard this proxy — sitting nearer the camera here — became
    // the "target mesh", and the x-ray silhouette was then built for an entire
    // kinematic group instead of the clicked part.
    const proxy = plateMesh('__raycastBVH_Drive');
    proxy.visible = false;
    proxy.userData._rvRaycastBVH = true;
    proxy.position.z = 5;                       // in front of the real geometry
    h.bore.add(proxy);
    h.bore.updateMatrixWorld(true);

    armedOnMesh(h);

    expect(getPivotCirclePickSnapshot().stage).toBe('hovering');
    expect(h.isolated()).toEqual([h.bore]);     // the part, never the proxy
  });

  it('restores the KINEMATIC selection preview, not just the default one', () => {
    const h = makeHarness();
    h.selectKinematicAxis();
    armedOnMesh(h);
    h.selectionHighlighted.mockClear();

    escape();

    // `refreshHighlight()` alone puts back the manager's default visual, which
    // is not what was on screen: the editor's group preview lives on the
    // `selection-changed` listener and nothing emits that event here.
    expect(h.selectionRefreshed).toHaveBeenCalled();
    expect(h.selectionHighlighted).toHaveBeenCalledTimes(1);
    const [roots, options] = h.selectionHighlighted.mock.calls[0] as [Object3D[], { style: unknown }];
    expect(roots).toContain(h.axisNode);      // the selection …
    expect(roots).toContain(h.bore);          // … plus the group's members
    expect(options.style).toBeDefined();      // in the Kinematic accent
  });

  it('takes the mask-0 batch source, not the merged proxy that shadows it', () => {
    const h = makeHarness();
    // The real shape of a kinematic assembly: every mesh under a Drive is a
    // BatchedMesh SOURCE (`layers.mask = 0`, `visible = true`, geometry kept
    // valid for picking) and the merged raycast proxy sits alongside it. A
    // default raycaster tests layer 0 only, so the source is invisible to it
    // and the proxy was the only thing left to hit — which is why the x-ray
    // was being built for the whole kinematic group.
    h.bore.layers.mask = 0;
    const proxy = plateMesh('__raycastBVH_Drive');
    proxy.visible = false;
    proxy.userData._rvRaycastBVH = true;
    proxy.position.z = 5;
    h.bore.add(proxy);
    h.bore.updateMatrixWorld(true);

    armedOnMesh(h);

    expect(getPivotCirclePickSnapshot().stage).toBe('hovering');
    expect(h.isolated()).toEqual([h.bore]);
    // One part's silhouette — the thing the whole x-ray is for.
    expect(h.xrayRoots()).toHaveLength(1);
  });

  it('stage two frames the target, silences the normal hover visuals, and restores them', () => {
    const h = makeHarness();
    armedOnMesh(h);

    // The target is framed — stage two is about the corners of ONE part.
    expect(h.framed()).toEqual([[h.bore]]);
    // …and it is the only thing answering "what is under the cursor": the hover
    // pipeline is off and whatever it had drawn is cleared.
    expect(h.hoverEnabled()).toBe(false);
    expect(h.highlightsCleared).toHaveBeenCalled();
    // The allow filter is the half that survives an orbit — `controls.end`
    // re-enables hover unconditionally, so `setEnabled` alone let the highlight
    // back in as soon as the user moved the camera.
    expect(h.hoverAllowed(h.bore)).toBe(false);
    // The part stays rendered; only its silhouette is added, without depth test,
    // so the circles inside it can be aimed at.
    expect(h.xrayRoots()).toHaveLength(1);

    escape();   // back to stage one — every exit edge restores
    expect(h.hoverEnabled()).toBe(true);
    expect(h.hoverAllowed(h.bore)).toBe(true);
    expect(h.xrayRoots()).toHaveLength(0);
    expect(h.selectionRefreshed).toHaveBeenCalled();
  });

  it('hovering a bore rim shows vertex marker AND circle, and a click commits it', async () => {
    const h = makeHarness();
    armedOnMesh(h);
    const before = h.axisNode.getWorldPosition(new Vector3()).clone();

    const at = h.screenOf(NEAR_RIM);
    pointer('pointermove', at.x, at.y);

    const hovered = getPivotCirclePickSnapshot();
    expect(hovered.hasCircle).toBe(true);
    expect(hovered.hoverLabel).toMatch(/Ø 8\.0/);       // the r = 4 bore
    expect(h.overlay()!.visible).toBe(true);
    expect(visibleRing(h)).toBe(true);

    click(at.x, at.y);
    await settle();
    await h.doc.whenIdle();
    h.model.updateMatrixWorld(true);

    const after = h.axisNode.getWorldPosition(new Vector3());
    expect(after.distanceTo(before)).toBeGreaterThan(1e-6);
    expect(Math.hypot(after.x, after.y)).toBeLessThan(0.05);
    expect(after.z).toBeCloseTo(RIM_Z, 2);

    // Every exit edge cleans up, the commit included.
    expect(isPivotCirclePickActive()).toBe(false);
    expect(h.isolated()).toBeNull();
    expect(h.overlayRoots()).toHaveLength(0);
  });

  it('hovering a flat face shows only the vertex marker, and a click does nothing', async () => {
    const h = makeHarness();
    const { query } = countingQuery(NO_CIRCLE_SAMPLE);
    armedOnMesh(h, { queryVertexCircle: query });
    armDownstream(h);

    pointer('pointermove', CENTRE_X, CENTRE_Y);
    const snapshot = getPivotCirclePickSnapshot();
    expect(snapshot.hasCircle).toBe(false);
    expect(snapshot.hoverLabel).toMatch(/no circle/i);
    expect(h.overlay()!.visible).toBe(true);     // the marker IS drawn …
    expect(visibleRing(h)).toBe(false);          // … the ring is not.

    const opsBefore = h.doc.document.opCount;
    click(CENTRE_X, CENTRE_Y);
    await settle();
    await h.doc.whenIdle();

    // Nothing written, mode still armed, and the press was NOT claimed — a click
    // that means nothing must not be stolen from the rest of the app.
    expect(h.doc.document.opCount).toBe(opsBefore);
    expect(getPivotCirclePickSnapshot().stage).toBe('hovering');
    expect(h.downstream).toHaveBeenCalledTimes(1);
  });

  it('on the mesh but beyond the snap radius shows nothing at all', () => {
    const h = makeHarness();
    const { query } = countingQuery(null);
    armedOnMesh(h, { queryVertexCircle: query });

    pointer('pointermove', CENTRE_X, CENTRE_Y);
    expect(h.overlay()!.visible).toBe(false);
    expect(getPivotCirclePickSnapshot().hoverLabel).toBeNull();
    expect(getPivotCirclePickSnapshot().hasCircle).toBe(false);
  });

  it('a click with nothing drawn leaves the mode entirely', () => {
    const h = makeHarness();
    const { query } = countingQuery(null);          // the cursor is off the target
    armedOnMesh(h, { queryVertexCircle: query });
    armDownstream(h);

    pointer('pointermove', CENTRE_X, CENTRE_Y);
    expect(h.overlay()!.visible).toBe(false);

    click(CENTRE_X, CENTRE_Y);
    expect(getPivotCirclePickSnapshot().stage).toBe('idle');
    expect(isPivotCirclePickActive()).toBe(false);
    expect(h.isolated()).toBeNull();
    expect(h.overlayRoots()).toHaveLength(0);
    expect(h.xrayRoots()).toHaveLength(0);
    // Claimed, so leaving the mode cannot double as a selection change.
    expect(h.downstream).not.toHaveBeenCalled();
  });

  it('the query runs once per throttled sample, not per pointermove', async () => {
    const h = makeHarness();
    const { spy, query } = countingQuery(NO_CIRCLE_SAMPLE);
    armedOnMesh(h, { queryVertexCircle: query });

    for (let i = 0; i < 6; i++) pointer('pointermove', CENTRE_X + i, CENTRE_Y);
    // The throttle IS the CPU budget of hovering (doc-render-picking §2.4).
    expect(spy).toHaveBeenCalledTimes(1);

    await pastThrottle();
    pointer('pointermove', CENTRE_X, CENTRE_Y);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('commit recomputes world data from the CURRENT matrixWorld', async () => {
    const h = makeHarness();
    armedOnMesh(h);

    const at = h.screenOf(NEAR_RIM);
    pointer('pointermove', at.x, at.y);
    expect(getPivotCirclePickSnapshot().hasCircle).toBe(true);

    // The target moves between the hover and the click — a jog, an undo, a
    // partial re-import. Committing the hover's world snapshot would put the
    // pivot where the bore WAS, and nothing would say so.
    h.bore.position.set(10, 0, 0);
    h.model.updateMatrixWorld(true);

    click(at.x, at.y);
    await settle();
    await h.doc.whenIdle();
    h.model.updateMatrixWorld(true);

    const after = h.axisNode.getWorldPosition(new Vector3());
    expect(after.x).toBeCloseTo(10, 2);
    expect(after.y).toBeCloseTo(0, 2);
    expect(after.z).toBeCloseTo(RIM_Z, 2);
  });

  it('Escape from hovering returns to picking-target and clears isolation, overlay and memo', async () => {
    const h = makeHarness();
    armedOnMesh(h);
    const at = h.screenOf(NEAR_RIM);
    pointer('pointermove', at.x, at.y);
    expect(h.overlayRoots()).toHaveLength(1);

    escape();
    expect(getPivotCirclePickSnapshot().stage).toBe('picking-target');
    // Both halves of stage two are gone — the dim especially: a viewport the
    // user cannot undim is worse than a tool that never armed.
    expect(h.isolated()).toBeNull();
    expect(h.overlayRoots()).toHaveLength(0);
    expect(getPivotCirclePickSnapshot().hoverLabel).toBeNull();
    expect(isPivotCirclePickActive()).toBe(true);

    // …and the memo went with it: the first sample after re-entering RECOMPUTES
    // rather than answering from a cache that outlived its stage. (Past the
    // throttle first — the arm, and with it its 50 ms budget, survived Escape.)
    click(ON_PLATE_X, CENTRE_Y);
    await pastThrottle();
    const before = getVertexCircleMemoStats();
    pointer('pointermove', at.x, at.y);
    expect(getVertexCircleMemoStats().misses).toBe(before.misses + 1);
    expect(getVertexCircleMemoStats().hits).toBe(before.hits);
  });

  it('after dispose() no further hover query runs', async () => {
    const h = makeHarness();
    const { spy, query } = countingQuery(NO_CIRCLE_SAMPLE);
    armedOnMesh(h, { queryVertexCircle: query });

    pointer('pointermove', CENTRE_X, CENTRE_Y);
    expect(spy).toHaveBeenCalledTimes(1);

    cancelPivotCirclePick();
    await pastThrottle();
    pointer('pointermove', CENTRE_X + 20, CENTRE_Y);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('a model change disarms the mode even though it never reaches _deactivate()', () => {
    const h = makeHarness();
    armedOnMesh(h);
    expect(h.isolated()).toEqual([h.bore]);

    // The editor has at least six `loadModel` call sites that do not route
    // through `_deactivate()`; `model-cleared` is the one event all of them
    // share (plan-724 §2.6, review R3).
    h.clearModel();
    expect(isPivotCirclePickActive()).toBe(false);
    expect(h.isolated()).toBeNull();
    expect(h.overlayRoots()).toHaveLength(0);
  });

  it('Escape in picking-target disarms completely', () => {
    const h = makeHarness();
    startPivotCirclePick(h.viewer, h.doc, 'Asset/Axis');
    expect(isPivotCirclePickActive()).toBe(true);
    escape();
    expect(isPivotCirclePickActive()).toBe(false);
    expect(getPivotCirclePickSnapshot().stage).toBe('idle');
    expect(h.isolated()).toBeNull();
  });

  it('right-click leaves the mode from stage two in one gesture', () => {
    const h = makeHarness();
    armedOnMesh(h);
    const canvas = h.viewer.renderer!.domElement;
    canvas.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(isPivotCirclePickActive()).toBe(false);
    expect(h.isolated()).toBeNull();
    expect(h.overlayRoots()).toHaveLength(0);
  });

  it('ignores a hit on the source node itself but accepts its children', () => {
    const h = makeHarness();
    // Re-parent the bore under the axis node: the grandchild case, and the whole
    // point of the tool — an axis placed on the bore of the part it carries.
    h.axisNode.add(h.bore);
    h.model.updateMatrixWorld(true);
    (h.viewer.registry as NodeRegistry).registerNode('Asset/Axis/Bore', h.bore);

    h.setHit('Asset/Axis');   // the gated hit resolves to the source node …
    armedOnMesh(h);
    // … but the refinement finds the CHILD mesh, which is a legitimate target.
    expect(getPivotCirclePickSnapshot().stage).toBe('hovering');
    expect(h.isolated()).toEqual([h.bore]);
  });

  it('a click on empty space stays armed rather than committing nothing', () => {
    const h = makeHarness();
    h.setHit(null);
    armedOnMesh(h);
    expect(getPivotCirclePickSnapshot().stage).toBe('picking-target');
    expect(h.isolated()).toBeNull();
  });

  it('arming cancels an active pivot-pick and mechanism-pick', () => {
    const h = makeHarness();
    startPivotPick(h.viewer, h.doc, 'Asset/Axis');
    startMechanismPick(h.viewer, 'anchor', 'pick something', () => {});
    expect(isMechanismPickActive()).toBe(true);

    startPivotCirclePick(h.viewer, h.doc, 'Asset/Axis');
    // Neither may keep its window-capture listeners: two armed picks would both
    // claim the same click, and the existing tools do NOT block each other.
    expect(isPivotPickActive()).toBe(false);
    expect(isMechanismPickActive()).toBe(false);
    expect(isPivotCirclePickActive()).toBe(true);
  });

  it('cancelPivotCirclePick disposes overlay and isolation (editor exit / model change)', () => {
    const h = makeHarness();
    armedOnMesh(h);
    cancelPivotCirclePick();
    expect(isPivotCirclePickActive()).toBe(false);
    expect(h.overlayRoots()).toHaveLength(0);
    expect(h.isolated()).toBeNull();
    // Idempotent — `_deactivate()` may run after a right-click already disarmed.
    expect(() => cancelPivotCirclePick()).not.toThrow();
  });
});

// ─── The overlay in isolation ───────────────────────────────────────────────

function gizmoTarget(overrides: Partial<CircleGizmoTarget> = {}): CircleGizmoTarget {
  return {
    worldVertex: [4, 0, 3],
    circle: { worldCenter: [0, 0, 3], worldAxis: [0, 0, 1], worldRadius: 4 },
    label: 'Ø 8.0 · rim · bore',
    ...overrides,
  };
}

function gizmoWorld() {
  const scene = new Scene();
  const camera = new PerspectiveCamera(50, CANVAS_W / CANVAS_H, 0.1, 1000);
  camera.position.set(0, 0, 40);
  camera.updateMatrixWorld(true);
  const canvas = makeCanvas();
  const viewer = {
    scene, camera, renderer: { domElement: canvas }, markRenderDirty: vi.fn(),
  } as unknown as RVViewer;
  const hover = vi.fn();
  const gizmo = new CirclePickGizmo(viewer, hover);
  cleanups.push(() => gizmo.dispose());
  const root = () => scene.children.find((c) => c.name === '__rvCirclePickGizmo') ?? null;
  return { scene, camera, gizmo, hover, root };
}

describe('CirclePickGizmo', () => {
  it('draws marker, ring and arrow for a circle and reports the label', () => {
    const w = gizmoWorld();
    w.gizmo.show(gizmoTarget());
    expect(w.gizmo.visible).toBe(true);
    expect(w.gizmo.showsCircle).toBe(true);
    expect(w.hover).toHaveBeenLastCalledWith(
      expect.objectContaining({ label: 'Ø 8.0 · rim · bore' }));
    // Three fixed objects, never a pool.
    expect(w.gizmo.root.children).toHaveLength(3);
  });

  it('draws the marker alone when the corner lies on no circle', () => {
    const w = gizmoWorld();
    w.gizmo.show(gizmoTarget({ circle: null, label: 'no circle at this corner' }));
    expect(w.gizmo.visible).toBe(true);
    expect(w.gizmo.showsCircle).toBe(false);
  });

  it('hide() clears the overlay and the label', () => {
    const w = gizmoWorld();
    w.gizmo.show(gizmoTarget());
    w.gizmo.hide();
    expect(w.gizmo.visible).toBe(false);
    expect(w.hover).toHaveBeenLastCalledWith(null);
  });

  it('skips a non-finite circle rather than composing a NaN matrix', () => {
    const w = gizmoWorld();
    w.gizmo.show(gizmoTarget({
      circle: { worldCenter: [0, 0, 3], worldAxis: [0, 0, 1], worldRadius: Number.NaN },
    }));
    expect(w.gizmo.visible).toBe(true);      // the marker still stands …
    expect(w.gizmo.showsCircle).toBe(false); // … the ring does not.
  });

  it('is never a raycast target (§3.2 overlay contract)', () => {
    const w = gizmoWorld();
    w.gizmo.show(gizmoTarget());
    const hits: unknown[] = [];
    w.gizmo.root.traverse((object) => {
      object.raycast({} as never, hits as never);
      expect(object.userData._highlightOverlay).toBe(true);
    });
    expect(hits).toHaveLength(0);
  });

  it('dispose() removes the overlay root and clears the hover', () => {
    const w = gizmoWorld();
    w.gizmo.show(gizmoTarget());
    w.gizmo.dispose();
    expect(w.root()).toBeNull();
    expect(w.hover).toHaveBeenLastCalledWith(null);
    // Idempotent, and inert afterwards.
    expect(() => w.gizmo.dispose()).not.toThrow();
    w.gizmo.show(gizmoTarget());
    expect(w.root()).toBeNull();
  });
});
