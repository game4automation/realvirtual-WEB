// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Test helpers for placing LayoutObjects in a minimal viewer fixture.
 *
 * These helpers exercise the production `addPlacedToScene` primitive so the
 * tests in this plan run against the real Three.js / NodeRegistry pipeline,
 * not a re-implementation. They avoid disk-resident GLBs by building
 * Three.js groups programmatically (see `makeMockLayoutGLB`).
 */

import { Group, Mesh, BoxGeometry, MeshBasicMaterial, Scene, Object3D } from 'three';
import { NodeRegistry } from '../../src/core/engine/rv-node-registry';
import { RvExtrasEditorPlugin } from '../../src/core/hmi/rv-extras-editor';
import { addPlacedToScene, removePlacedFromScene, type SceneMutationDeps } from '../../src/plugins/layout-planner/scene-mutations';

// ─── Mock LayoutGLB factory ─────────────────────────────────────────────

export interface MockLayoutGlbOptions {
  /** Number of mesh-only children (no rv_extras). Default 0. */
  meshes?: number;
  /** Number of children with a Drive component. Default 0. */
  drives?: number;
  /** Number of children with a Sensor component. Default 0. */
  sensors?: number;
  /** Custom children to append (full control over name / userData). */
  children?: Array<{ name: string; userData?: Record<string, unknown> }>;
  /** Root name. Default 'LayoutObject'. */
  rootName?: string;
}

/**
 * Build an in-memory Group whose hierarchy mimics a Catalog-GLB:
 * - root has `userData.realvirtual` left empty (caller sets LayoutObject)
 * - drives carry `userData.realvirtual.Drive`
 * - sensors carry `userData.realvirtual.Sensor`
 * - mesh-only children have no `userData.realvirtual`
 */
export function makeMockLayoutGLB(opts: MockLayoutGlbOptions = {}): Group {
  const root = new Group();
  root.name = opts.rootName ?? 'LayoutObject';

  const meshCount = opts.meshes ?? 0;
  for (let i = 0; i < meshCount; i++) {
    const m = new Mesh(new BoxGeometry(0.1, 0.1, 0.1), new MeshBasicMaterial());
    m.name = `Mesh${i + 1}`;
    root.add(m);
  }

  const driveCount = opts.drives ?? 0;
  for (let i = 0; i < driveCount; i++) {
    const g = new Group();
    g.name = `Drive-Lin-${String.fromCharCode(88 + i)}`; // X, Y, Z…
    g.userData.realvirtual = {
      Drive: { TargetSpeed: 100 + i, Acceleration: 500 },
    };
    root.add(g);
  }

  const sensorCount = opts.sensors ?? 0;
  for (let i = 0; i < sensorCount; i++) {
    const g = new Group();
    g.name = `Sensor${i + 1}`;
    g.userData.realvirtual = {
      Sensor: { UseRaycast: true },
    };
    root.add(g);
  }

  if (opts.children) {
    for (const def of opts.children) {
      const g = new Group();
      g.name = def.name;
      if (def.userData) g.userData = def.userData;
      root.add(g);
    }
  }

  return root;
}

// ─── Minimal "real" Viewer fixture ──────────────────────────────────────

/**
 * Minimal viewer fixture wired for layout-planner + rv-extras-editor tests.
 *
 * Contains a real Three.js Scene, a real NodeRegistry, and a real
 * RvExtrasEditorPlugin. The viewer object is shaped exactly enough to
 * satisfy `addPlacedToScene` / `removePlacedFromScene` and the bits of
 * `RVViewer` that the plugin touches in its public methods.
 */
export interface LayoutTestViewer {
  scene: Scene;
  registry: NodeRegistry;
  rvExtrasEditor: RvExtrasEditorPlugin;
  signalStore: null;
  transportManager: null;
  drives: unknown[];
  raycastManager: null;
  rebuildGroupedBvh: () => void;
  /** Viewer events the editor emits (e.g. `layout-lock-changed`) — recorded, no listeners. */
  emit: (event: string, payload?: unknown) => void;
  _emitted: { event: string; payload?: unknown }[];
  getPlugin<T = unknown>(id: string): T | undefined;
  _objectMap: Map<string, Object3D>;
  _idByObject: WeakMap<Object3D, string>;
  _layoutRoot: Group;
  _modelRoot: Group;
  _deps: SceneMutationDeps;
}

/**
 * Build a viewer fixture suitable for testing layout-planner +
 * rv-extras-editor flows. Wires up the real RvExtrasEditorPlugin so its
 * `selectNode`, `updateOverlayField`, `purgeOverlaysForSubtree` etc.
 * exercise production code.
 */
export function makeLayoutTestViewer(): LayoutTestViewer {
  const scene = new Scene();
  scene.name = 'Scene';

  const modelRoot = new Group();
  modelRoot.name = 'modelRoot';
  scene.add(modelRoot);

  const layoutRoot = new Group();
  layoutRoot.name = '_layoutRoot';
  scene.add(layoutRoot);

  const registry = new NodeRegistry();
  registry.registerNode('modelRoot', modelRoot);

  const rvExtrasEditor = new RvExtrasEditorPlugin();

  const plugins = new Map<string, unknown>([
    ['rv-extras-editor', rvExtrasEditor],
  ]);

  const objectMap = new Map<string, Object3D>();
  const idByObject = new WeakMap<Object3D, string>();

  const viewer: LayoutTestViewer = {
    scene,
    registry,
    rvExtrasEditor,
    signalStore: null,
    transportManager: null,
    drives: [],
    raycastManager: null,
    rebuildGroupedBvh: () => {},
    emit: (event: string, payload?: unknown) => { viewer._emitted.push({ event, payload }); },
    _emitted: [],
    getPlugin<T = unknown>(id: string): T | undefined {
      return plugins.get(id) as T | undefined;
    },
    _objectMap: objectMap,
    _idByObject: idByObject,
    _layoutRoot: layoutRoot,
    _modelRoot: modelRoot,
    _deps: {
      getViewer: () => viewer as never,
      objectMap,
      idByObject,
      getLayoutRoot: () => layoutRoot,
      getTransformControls: () => null,
      getModelRoot: () => modelRoot,
    },
  };

  // Wire the editor plugin to the viewer so updateOverlayField /
  // findLayoutObjectAncestor / purgeOverlaysForSubtree can resolve nodes.
  // The plugin reads `this._viewer.registry` so we cast here.
  (rvExtrasEditor as unknown as { _viewer: unknown })._viewer = viewer;

  return viewer;
}

/**
 * Place a mock LayoutObject in the viewer.
 *
 * Routes through `addPlacedToScene` (the same code path the layout-planner
 * plugin uses), then registers all descendants in the NodeRegistry via the
 * fallback branch (no signalStore/transportManager → no processExtras).
 *
 * Returns the placed root Group.
 */
export function placeLayoutObject(
  viewer: LayoutTestViewer,
  id: string,
  label: string,
  catalogId: string,
  glb?: Group,
): Group {
  const clone = glb ?? makeMockLayoutGLB({ rootName: label, drives: 1, sensors: 1, meshes: 2 });
  // Make sure clone.name matches `label` so the resolved unique name is stable
  if (!glb) clone.name = label;
  addPlacedToScene(viewer._deps, clone, id, label, catalogId);

  // The fallback registry path in addPlacedToScene only registers the root.
  // Walk descendants explicitly so tests can look up sub-paths.
  registerSubtreePaths(viewer.registry, clone);
  return clone;
}

/** Recursively register all descendants under `root` in the registry. */
export function registerSubtreePaths(registry: NodeRegistry, root: Object3D): void {
  root.traverse((n) => {
    const path = NodeRegistry.computeNodePath(n);
    if (!registry.getNode(path)) {
      registry.registerNode(path, n);
    }
  });
}

/** Convenience: tear down a placement via the same primitive the planner uses. */
export function unplaceLayoutObject(viewer: LayoutTestViewer, id: string): void {
  removePlacedFromScene(viewer._deps, id);
}
