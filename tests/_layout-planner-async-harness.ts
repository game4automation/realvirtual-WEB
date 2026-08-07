// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Shared harness for the plan-371 async-placement tests.
 *
 * Two decisions worth knowing:
 *
 * 1. **The model cache is the REAL `ModelCache`** with a controllable
 *    `GLTFLoader.loadAsync` (precedent: `rv-layout-model-cache.test.ts`).
 *    A hand-rolled stand-in would only ever test itself.
 * 2. **Catalog URLs are `blob:` URLs.** `ModelCache.getOrLoad` hands those
 *    straight to the loader, bypassing `RVAssetBlobCache` — so the tests need
 *    no `fetch` mock and cannot leak state through the blob cache's
 *    module-level singleton.
 */

import { vi, expect } from 'vitest';
import {
  Group,
  Mesh,
  Sprite,
  LineSegments,
  BoxGeometry,
  MeshBasicMaterial,
  PerspectiveCamera,
} from 'three';
import type { BufferGeometry, Material, Object3D, Texture } from 'three';

import { LayoutPlannerPlugin } from '../src/plugins/layout-planner';
import { ModelCache } from '../src/plugins/layout-planner/model-cache';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import { REDUCED_MOTION_QUERY, type MatchMediaFn } from '../src/plugins/signal-bind/conflict-blink';
import type { GizmoHandle, GizmoOptions, GizmoOverlayManager } from '../src/core/engine/rv-gizmo-manager';
import type {
  LibraryCatalogEntry,
  PlacedComponent,
  SignalMapping,
} from '../src/plugins/layout-planner/rv-layout-store';
import type { PendingGeometryRegistry } from '../src/plugins/layout-planner/pending-geometry';

/** 1×1 transparent PNG — a thumbnail that really decodes, so the billboard
 *  Sprite (and therefore the sprite-dispose assertions) actually exist. */
export const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

export const GLB_URL = 'blob:rv-test/belt';

export const GLB_ENTRY: LibraryCatalogEntry = {
  id: 'cat:belt',
  name: 'Belt',
  category: 'conveyor',
  glbUrl: GLB_URL,
  thumbnailUrl: TINY_PNG,
  footprintMm: [1200, 400],
};

/** A virtual DES entry with an unregistered desType → wireframe placeholder. */
export const VIRTUAL_ENTRY: LibraryCatalogEntry = {
  id: 'cat:virtual',
  name: 'VirtualBox',
  category: 'des',
  glbUrl: '',
  thumbnailUrl: '',
  virtual: true,
  desType: 'UnregisteredTestType',
  gizmoSize: [500, 500, 500],
};

export const SPLAT_ENTRY: LibraryCatalogEntry = {
  id: 'cat:splat',
  name: 'SplatCloud',
  category: 'splat',
  splatUrl: 'blob:rv-test/cloud.ply',
};

// ─── Controllable ModelCache ────────────────────────────────────────────

interface Deferred {
  promise: Promise<{ scene: Group }>;
  resolve(): void;
  reject(err: unknown): void;
  settled: boolean;
}

export interface ControllableCache {
  cache: ModelCache;
  /** Make the next load(s) for `url` hang until `resolve`/`fail`. */
  stall(url: string): void;
  /** Release every stalled load for `url` with a fresh decoded Group. */
  resolve(url: string): Promise<void>;
  /** Release only the OLDEST stalled load — the "late arrival of a superseded
   *  attempt" case. */
  resolveStale(url: string): Promise<void>;
  /** Make loads for `url` reject. */
  fail(url: string, err: unknown): void;
  /** Undo a previous {@link fail}. */
  recover(url: string): void;
  isStalled(url: string): boolean;
  /** How often the loader was asked to decode `url`. */
  decodeCount(url: string): number;
  /** Whether the cached MASTER geometry for `url` was disposed (must stay false —
   *  clones share it). */
  masterGeometryDisposed(url: string): boolean;
}

export function createControllableCache(): ControllableCache {
  const stalls = new Map<string, Deferred[]>();
  const failures = new Map<string, unknown>();
  const decodes = new Map<string, number>();
  const masterGeometries = new Map<string, { geometry: BufferGeometry; disposed: boolean }>();

  function makeScene(url: string): { scene: Group } {
    const group = new Group();
    group.name = 'BeltRoot';
    const geometry = new BoxGeometry(1, 1, 1);
    const record = { geometry, disposed: false };
    const originalDispose = geometry.dispose.bind(geometry);
    geometry.dispose = () => { record.disposed = true; originalDispose(); };
    if (!masterGeometries.has(url)) masterGeometries.set(url, record);
    const mesh = new Mesh(geometry, new MeshBasicMaterial());
    mesh.name = 'BeltMesh';
    group.add(mesh);
    return { scene: group };
  }

  const loader = {
    loadAsync: vi.fn(async (url: string) => {
      decodes.set(url, (decodes.get(url) ?? 0) + 1);
      const failure = failures.get(url);
      if (failure) throw failure;

      const queue = stalls.get(url);
      if (!queue) return makeScene(url);

      let resolveFn!: () => void;
      let rejectFn!: (err: unknown) => void;
      const deferred: Deferred = {
        settled: false,
        promise: new Promise<{ scene: Group }>((res, rej) => {
          resolveFn = () => res(makeScene(url));
          rejectFn = rej;
        }),
        resolve: () => { resolveFn(); },
        reject: (err) => { rejectFn(err); },
      };
      queue.push(deferred);
      return deferred.promise;
    }),
  };

  const cache = new ModelCache(loader as never);

  async function release(url: string, all: boolean): Promise<void> {
    const queue = stalls.get(url);
    if (!queue || queue.length === 0) return;
    const targets = all ? queue.splice(0, queue.length) : queue.splice(0, 1);
    for (const deferred of targets) { deferred.settled = true; deferred.resolve(); }
    await flush();
  }

  return {
    cache,
    stall(url) { if (!stalls.has(url)) stalls.set(url, []); },
    resolve: (url) => release(url, true),
    resolveStale: (url) => release(url, false),
    fail(url, err) { failures.set(url, err); },
    recover(url) { failures.delete(url); },
    isStalled(url) { return (stalls.get(url)?.length ?? 0) > 0; },
    decodeCount(url) { return decodes.get(url) ?? 0; },
    masterGeometryDisposed(url) { return masterGeometries.get(url)?.disposed ?? false; },
  };
}

// ─── prefers-reduced-motion ─────────────────────────────────────────────

export interface FakeMedia {
  matchMedia: MatchMediaFn;
  /** Flip the preference and fire the change listeners. */
  set(matches: boolean): void;
  listenerCount(): number;
}

/**
 * An injectable `matchMedia`. A real browser cannot be told to change its OS
 * accessibility setting, so the query is faked — and it counts its own
 * listeners, because "dispose cleans up" is only meaningful if the removal is
 * observed rather than assumed. Mirrors `tests/badge-reduced-motion.test.ts`.
 */
export function makeFakeMedia(initial: boolean): FakeMedia {
  let matches = initial;
  const listeners = new Set<() => void>();
  const mql = {
    get matches() { return matches; },
    media: REDUCED_MOTION_QUERY,
    addEventListener: (_type: string, cb: () => void) => { listeners.add(cb); },
    removeEventListener: (_type: string, cb: () => void) => { listeners.delete(cb); },
    dispatchEvent: () => true,
  } as unknown as MediaQueryList;
  return {
    matchMedia: () => mql,
    set(next: boolean) {
      matches = next;
      for (const cb of [...listeners]) cb();
    },
    listenerCount: () => listeners.size,
  };
}

// ─── Gizmo manager stub ─────────────────────────────────────────────────

export interface CreatedGizmo {
  id: string;
  node: Object3D;
  options: GizmoOptions;
  updates: Partial<GizmoOptions>[];
  disposed: boolean;
  /** The stand-in root, so the caller-side scale/position stamp is observable. */
  root: Object3D;
}

export interface GizmoRecorder {
  manager: GizmoOverlayManager;
  created: CreatedGizmo[];
  /** The live (non-disposed) gizmo attached to `node`, or undefined. */
  liveFor(node: Object3D): CreatedGizmo | undefined;
}

/** Records `create()` calls instead of building real three.js overlays. The
 *  planner's pulse is the only consumer in these tests. */
export function createGizmoRecorder(): GizmoRecorder {
  const created: CreatedGizmo[] = [];
  let counter = 0;
  const manager = {
    create: (node: Object3D, options: GizmoOptions): GizmoHandle => {
      const entry: CreatedGizmo = {
        id: `gz_${++counter}`,
        node,
        options,
        updates: [],
        disposed: false,
        root: new Group(),
      };
      created.push(entry);
      return {
        id: entry.id,
        root: entry.root,
        update: (partial: Partial<GizmoOptions>) => { entry.updates.push(partial); },
        setVisible: () => {},
        dispose: () => { entry.disposed = true; },
      } as GizmoHandle;
    },
  } as unknown as GizmoOverlayManager;

  return {
    manager,
    created,
    liveFor: (node) => created.find((g) => g.node === node && !g.disposed),
  };
}

// ─── Gaussian-splat plugin stub ─────────────────────────────────────────

export interface FakeSplatPlugin {
  /** Mirrors the real plugin: builds the container AND adds it to the scene. */
  loadSplat(url: string, fileExt?: string): Promise<Group>;
  setSplatScale(group: Group, scale: [number, number, number]): void;
  setSplatCrop(group: Group, box: unknown): void;
  disposeSplat(group: Group): void;
  /** Every url `loadSplat` was asked for, in order. */
  loadedUrls: string[];
  /** Every (group, scale) pair pushed through `setSplatScale`. */
  scaleCalls: { group: Group; scale: [number, number, number] }[];
}

/**
 * Stand-in for the `gaussian-splat` plugin. The planner never inspects the
 * returned container beyond the layout markers it stamps on it itself, so a
 * plain `Group` parked in the scene is a faithful substitute — and it is the
 * ONLY way to exercise the splat branches, which otherwise bail out at
 * `resolvePlugin('gaussian-splat') === null`.
 */
export function createFakeSplatPlugin(scene: Group): FakeSplatPlugin {
  const loadedUrls: string[] = [];
  const scaleCalls: { group: Group; scale: [number, number, number] }[] = [];
  return {
    loadedUrls,
    scaleCalls,
    async loadSplat(url: string) {
      loadedUrls.push(url);
      const container = new Group();
      container.name = 'SplatContainer';
      scene.add(container);
      return container;
    },
    setSplatScale(group, scale) { scaleCalls.push({ group, scale }); },
    setSplatCrop() { /* recorded nowhere — the planner only needs it callable */ },
    disposeSplat(group) { group.parent?.remove(group); },
  };
}

// ─── Viewer mock ────────────────────────────────────────────────────────

export interface MockViewerOptions {
  /** Wire a {@link createFakeSplatPlugin} into `resolvePlugin`/`getPlugin`.
   *  Off by default so every existing test keeps the "no splat plugin"
   *  behaviour it was written against. */
  withSplatPlugin?: boolean;
}

/**
 * A viewer with the three subsystems `registerPlaced`'s FULL path actually
 * needs — a real `NodeRegistry`, `SignalStore` and `RVTransportManager` — so
 * `processExtras` runs for real and registry assertions mean something.
 */
export function createMockViewer(gizmos?: GizmoRecorder, opts?: MockViewerOptions) {
  const scene = new Group();
  scene.name = 'Scene';
  const currentModel = new Group();
  currentModel.name = 'Model';
  scene.add(currentModel);

  const splatPlugin = opts?.withSplatPlugin ? createFakeSplatPlugin(scene) : null;

  let selectedPaths: string[] = [];
  let primaryPath: string | null = null;

  const registry = new NodeRegistry();

  return {
    scene,
    currentModel,
    gizmoManager: gizmos?.manager,
    sceneFixtures: new Set<unknown>(),
    camera: new PerspectiveCamera(),
    controls: { enabled: true },
    registry,
    signalStore: new SignalStore(),
    transportManager: new RVTransportManager(),
    drives: [] as unknown[],
    rebuildGroupedBvh: vi.fn(),
    registerDeferredLogic: vi.fn(),
    applyRenderModeToSubtree: vi.fn(),
    raycastManager: {
      addExcludeFilter: vi.fn(),
      addAncestorOverride: vi.fn(),
      removeAncestorOverride: vi.fn(),
      updateTargets: vi.fn(),
      addAuxRaycastTarget: vi.fn(),
      removeAuxRaycastTarget: vi.fn(),
    },
    leftPanelManager: { open: vi.fn(), close: vi.fn() },
    markRenderDirty: vi.fn(),
    markShadowsDirty: vi.fn(),
    fitToNodes: vi.fn(),
    setSimulationPaused: vi.fn(),
    highlighter: { highlight: vi.fn(), clear: vi.fn(), setAuxEmphasis: vi.fn() },
    outlineManager: {
      available: false, hasOutlines: false,
      setStyle: vi.fn(), setOutlined: vi.fn(), clear: vi.fn(), setSize: vi.fn(),
    },
    selectionManager: {
      getSnapshot: () => ({ selectedPaths: [...selectedPaths], primaryPath }),
      clear: vi.fn(() => { selectedPaths = []; primaryPath = null; }),
      select: vi.fn((path: string) => { selectedPaths = [path]; primaryPath = path; }),
      selectPaths: vi.fn((paths: string[]) => {
        selectedPaths = [...paths];
        primaryPath = paths[0] ?? null;
      }),
    },
    renderer: { domElement: document.createElement('canvas') },
    on: vi.fn(() => vi.fn()),
    emit: vi.fn(),
    getPlugin: vi.fn((id?: string) =>
      (id === 'gaussian-splat' ? splatPlugin ?? undefined : undefined)),
    // The splat branches await this. Without the option it resolves to null,
    // which is exactly the "plugin not available" case the planner guards.
    resolvePlugin: vi.fn(async (id: string) =>
      (id === 'gaussian-splat' ? splatPlugin : null)),
    /** Test-only handle on the injected splat stub (null unless requested). */
    splatPlugin,
  };
}

export type MockViewer = ReturnType<typeof createMockViewer>;

// ─── Planner setup ──────────────────────────────────────────────────────

export interface PlannerHarness {
  plugin: LayoutPlannerPlugin;
  viewer: MockViewer;
  cache: ControllableCache;
  store: LayoutPlannerPlugin['store'];
  /** Every gizmo the planner asked for — the pending pulse is the only user. */
  gizmos: GizmoRecorder;
}

export interface PlannerHarnessOptions {
  /** Injected `prefers-reduced-motion` source (see {@link makeFakeMedia}). */
  matchMedia?: MatchMediaFn;
  /** Wire a fake `gaussian-splat` plugin so the splat branches are reachable. */
  withSplatPlugin?: boolean;
}

export function setupPlanner(opts?: PlannerHarnessOptions): PlannerHarness {
  const gizmos = createGizmoRecorder();
  const viewer = createMockViewer(gizmos, { withSplatPlugin: opts?.withSplatPlugin });
  const plugin = new LayoutPlannerPlugin({ matchMedia: opts?.matchMedia });
  plugin.onModelLoaded?.({ scene: new Group() } as never, viewer as never);

  // Swap in the controllable cache. The plugin builds its own `ModelCache`
  // around a real GLTFLoader in the constructor; every code path reads the
  // private field, so replacing it is enough.
  const cache = createControllableCache();
  (plugin as unknown as { _modelCache: ModelCache })._modelCache = cache.cache;

  // These two are persisted to localStorage, so a sibling test file could
  // otherwise leak its setting into ours. Pin them.
  plugin.store.setDropToSurface(true);
  plugin.store.setGridEnabled(false);

  return { plugin, viewer, cache, store: plugin.store, gizmos };
}

/**
 * Access the planner's private lifecycle for assertions.
 *
 * plan-376 added four members. `_catalogsLoaded` is the ONLY handle on the
 * real boot-restore path (the legacy autosave loop inside `_loadCatalogs`) —
 * awaiting it is what lets a test drive that loop instead of re-implementing
 * its body. `_buildPlacementFromRecord` / `_clonePlacement` are the two
 * consolidated routines; they do not exist before plan-376 Phase 2/3, so a
 * characterisation test written against the old code must go through the
 * public entry points instead.
 */
export function internals(plugin: LayoutPlannerPlugin) {
  return plugin as unknown as {
    _draft: { id: string; node: Object3D; positioned: boolean } | null;
    _objectMap: Map<string, Object3D>;
    _pending: PendingGeometryRegistry;
    _editPauseDepth: number;
    _dropCommitted: boolean;
    _catalogsLoaded: Promise<void>;
    _startDraft(entry: LibraryCatalogEntry): Promise<void>;
    _moveDraft(x: number, z: number): boolean;
    _commitDraft(entry: LibraryCatalogEntry, coords: [number, number] | null): Promise<string | null>;
    _cancelDraft(): void;
    _clearPlaced(): void;
    _applyElementBindings(id: string, node: Object3D, manual: readonly SignalMapping[]): void;
    _buildPlacementFromRecord(p: PlacedComponent, url?: string): Promise<Object3D | null>;
    _clonePlacement(comp: PlacedComponent): Promise<string | null>;
  };
}

/** Full drag gesture: enter → move → drop. Returns the committed placement id. */
export async function dragAndDrop(
  plugin: LayoutPlannerPlugin,
  entry: LibraryCatalogEntry,
  coords: [number, number],
): Promise<string> {
  const p = internals(plugin);
  await p._startDraft(entry);
  p._moveDraft(coords[0], coords[1]);
  const id = await p._commitDraft(entry, coords);
  expect(id).not.toBeNull();
  return id as string;
}

/** Drain the microtask queue a few times so chained `await`s settle. */
export async function flush(turns = 6): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

/** Wait until the placeholder's thumbnail Sprite has been attached. */
export async function waitForThumbnail(node: Object3D, timeoutMs = 2000): Promise<Sprite | null> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    let found: Sprite | null = null;
    node.traverse((child) => { if ((child as Sprite).isSprite) found = child as Sprite; });
    if (found) return found;
    await new Promise((r) => setTimeout(r, 10));
  }
  return null;
}

// ─── Disposal tracking ──────────────────────────────────────────────────

export interface DisposeRecord { disposed: boolean }

function watch(target: { dispose(): void } | null | undefined): DisposeRecord | null {
  if (!target) return null;
  const record: DisposeRecord = { disposed: false };
  const original = target.dispose.bind(target);
  target.dispose = () => { record.disposed = true; original(); };
  return record;
}

export interface TrackedDisposables {
  lineGeometries: DisposeRecord[];
  lineMaterials: DisposeRecord[];
  spriteMaterials: DisposeRecord[];
  spriteTextures: DisposeRecord[];
  /** The shared three.js Sprite geometry — must NEVER be disposed. */
  sharedSpriteGeometry: DisposeRecord | null;
}

/**
 * Wrap `dispose()` on everything a placeholder owns, so a later assertion can
 * tell what was actually freed. Also watches the SHARED Sprite geometry, which
 * is a three.js module singleton and must survive.
 */
export function trackDisposables(root: Object3D): TrackedDisposables {
  const tracked: TrackedDisposables = {
    lineGeometries: [],
    lineMaterials: [],
    spriteMaterials: [],
    spriteTextures: [],
    sharedSpriteGeometry: null,
  };

  root.traverse((node) => {
    if ((node as LineSegments).isLine) {
      const line = node as LineSegments;
      const geo = watch(line.geometry);
      if (geo) tracked.lineGeometries.push(geo);
      const mat = watch(line.material as Material);
      if (mat) tracked.lineMaterials.push(mat);
    }
    if ((node as Sprite).isSprite) {
      const sprite = node as Sprite;
      const mat = sprite.material;
      const matRecord = watch(mat);
      if (matRecord) tracked.spriteMaterials.push(matRecord);
      const texRecord = watch(mat.map as Texture | null);
      if (texRecord) tracked.spriteTextures.push(texRecord);
      tracked.sharedSpriteGeometry ??= watch(sprite.geometry);
    }
  });

  return tracked;
}

/** Add a raised platform so `dropToSurface` has something to land on. */
export function addElevatedSurface(viewer: MockViewer, opts: { y: number }): Mesh {
  const thickness = 0.1;
  const surface = new Mesh(new BoxGeometry(20, thickness, 20), new MeshBasicMaterial());
  surface.name = 'Platform';
  surface.position.set(0, opts.y - thickness / 2, 0);
  viewer.scene.add(surface);
  viewer.scene.updateMatrixWorld(true);
  return surface;
}

/** A sprite that belongs to somebody else entirely (a snap marker, say). */
export function addForeignSprite(viewer: MockViewer): Sprite {
  const sprite = new Sprite();
  sprite.name = 'ForeignSnapMarker';
  viewer.scene.add(sprite);
  return sprite;
}
