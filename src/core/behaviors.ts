// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Behaviors — auto-discovered, per-component scripts that wire GLB models
 * to drives, sensors, transport surfaces, snaps, signals, AAS links and
 * context-menu items in a single declarative file.
 *
 * Discovery: all `src/behaviors/*.ts` modules are eager-loaded via
 * `import.meta.glob` and their default export (a `Behavior`) is collected
 * into the registry. Adding a new component is a single new file — no
 * imports, no manual registration.
 *
 * Match: `models[]` matches against the GLB **filename** (without `.glb`)
 * for a standalone asset, OR — for a library asset placed inside a scene —
 * against the placed LayoutObject's asset name (`node.name` minus the `_N`
 * duplicate suffix). Patterns support `*` (any chars), `?` (one char), and
 * the wildcard `'*'` (applies to every loaded model).
 *
 * Lifecycle: on every `model-logic-activated` event the manager (1) invokes behaviors
 * matching the loaded GLB filename, scoped to the scene root, and (2) scans the
 * scene for placed LayoutObjects and dispatches behaviors matching each one,
 * scoped to that object's subtree. The layout planner also calls
 * `dispatchPlaced(root)` when an asset is added after load. The bind callback
 * writes into a fresh KinematicsSpec, deep-merged into `userData.realvirtual`
 * via `applyKinematicsSpec`. All hooks/subscriptions are tracked per-bind and
 * auto-disposed on `model-cleared` (or `disposeObject` on removal).
 */

import { Object3D } from 'three';
import {
  createBindContext,
  applyKinematicsSpec,
  iterateFixedUpdate,
  type RVBindContext,
  type BindContextHost,
  type BindContextHandle,
  type KinematicsSpec,
  type KinematizeReport,
} from './behavior-runtime';
import { instanceScope } from './engine/rv-instance-scope';
import { NodeRegistry } from './engine/rv-node-registry';
// Glob matcher lives in its own dependency-free module (cycle break — see the
// re-export note below). Imported here for this module's own internal use.
import { matchesAny, extractGlbName } from './glob-match';

/** Name of the synthetic, render-free container that holds materialised
 *  behavior-signal nodes under a bind root — mirrors the GLB `Signals` group. */
const SIGNALS_CONTAINER_NAME = 'Signals';

// ─── Public types ───────────────────────────────────────────────────────

export interface Behavior {
  /**
   * GLB filenames (without `.glb` extension) this behavior applies to.
   *
   * Each entry is either:
   *   - exact filename: `'ChainTransfer'`
   *   - glob pattern:   `'ChainTransfer_*'`, `'Belt_v?'`
   *   - wildcard:       `'*'` (applies to every loaded model)
   */
  models: string[];

  /** Called once per matching model load. All subscriptions are auto-disposed. */
  bind(rv: RVBindContext): void;
}

/** Identity helper for type-safe behavior authoring. */
export function defineBehavior(b: Behavior): Behavior { return b; }

// ─── Glob matcher ───────────────────────────────────────────────────────
//
// Re-exported from `glob-match.ts` (the dependency-free home) so every existing
// `import { matchesAny, compileGlob, extractGlbName } from '…/behaviors'` keeps
// working, while `registry.ts` can import the matcher WITHOUT importing this
// module (which carries the eager behavior glob → circular-init TDZ). See
// glob-match.ts for the full rationale.
export { compileGlob, matchesAny, extractGlbName } from './glob-match';

// ─── Registry ───────────────────────────────────────────────────────────

interface ActiveBind {
  behaviorId: string;
  handle: BindContextHandle;
  /** Set when bound to a placed LayoutObject subtree (its placement id) — null for whole-scene binds. */
  objectKey?: string;
  /** Synthetic `Signals` container this bind materialised (if any) — its
   *  NodeRegistry entries are unregistered on dispose to avoid a registry leak. */
  signalsContainer?: Object3D;
}

/**
 * BehaviorManager — owns the registered behaviors, dispatches them on
 * model-load and disposes them on model-clear.
 */
export class BehaviorManager {
  private behaviors: Array<{ id: string; behavior: Behavior }> = [];
  private active: ActiveBind[] = [];
  private modelLoadedOff: (() => void) | null = null;
  private modelClearedOff: (() => void) | null = null;
  private fixedUpdateRunner: ((dt: number) => void) | null = null;
  /** Host stored at attach() so dispatchPlaced() can bind objects placed after load. */
  private host: BindContextHost | null = null;
  /** Placement ids already dispatched, to keep per-object dispatch idempotent. */
  private dispatchedObjects = new Set<string>();
  /** Coalesces the signal-index rebuild + hierarchy refresh to once per batch. */
  private hierarchyRefreshScheduled = false;

  /**
   * Register a behavior with an explicit id (filename without extension,
   * provided by `registerAllBehaviors`).
   */
  register(id: string, behavior: Behavior): void {
    if (!behavior || typeof behavior.bind !== 'function' || !Array.isArray(behavior.models)) {
      console.warn(`[behaviors] '${id}' is not a valid Behavior (must have models[] + bind())`);
      return;
    }
    this.behaviors.push({ id, behavior });
  }

  /** Total number of registered behaviors (for diagnostics / tests). */
  get count(): number { return this.behaviors.length; }

  /** Get all registered ids (for diagnostics / tests). */
  ids(): string[] { return this.behaviors.map(b => b.id); }

  /** Number of currently active (post-load, pre-clear) bind contexts. */
  get activeCount(): number { return this.active.length; }

  /** Read-only snapshot of `{behaviorId, objectKey}` for active binds — for the layout-graph debug page. */
  getActiveBinds(): ReadonlyArray<{ behaviorId: string; objectKey: string | undefined }> {
    return this.active.map(a => ({ behaviorId: a.behaviorId, objectKey: a.objectKey }));
  }

  /**
   * Attach to a viewer-like host: subscribe to model-logic-activated/model-cleared
   * and forward fixed-update ticks to active bind contexts.
   *
   * Returns a dispose function that detaches all listeners.
   */
  attach(
    host: BindContextHost,
    getCurrentRoot: () => Object3D | null,
    getCurrentModelUrl: () => string | null,
  ): () => void {
    // Build a per-tick fan-out for active onFixedUpdate callbacks.
    this.host = host;
    this.fixedUpdateRunner = (dt: number) => {
      for (const a of this.active) iterateFixedUpdate(a.handle, dt);
    };

    this.modelLoadedOff = host.on('model-logic-activated', () => {
      const root = getCurrentRoot();
      if (!root) return;
      this.disposeAll();
      // 1. Whole scene vs. the loaded GLB filename (a standalone asset GLB).
      this.bindForRoot(root, extractGlbName(getCurrentModelUrl()));
      // 2. Each placed LayoutObject subtree vs. its asset name, so library
      //    items embedded in a scene get their behavior even though the
      //    scene's filename doesn't match (see dispatchPlaced).
      this.dispatchPlacedObjectsIn(root);
    });

    this.modelClearedOff = host.on('model-cleared', () => {
      this.disposeAll();
    });

    return () => {
      this.modelLoadedOff?.();
      this.modelClearedOff?.();
      this.modelLoadedOff = null;
      this.modelClearedOff = null;
      this.fixedUpdateRunner = null;
      this.disposeAll();
    };
  }

  /** Forward a fixed-update tick — call once per sim tick from the viewer. */
  tick(dt: number): void {
    this.fixedUpdateRunner?.(dt);
  }

  /**
   * Bind every behavior whose `models[]` match `matchName`, scoped to `root`.
   * Bound contexts join `active[]` (so they tick and dispose with the scene).
   * Returns the number of behaviors bound.
   */
  private bindForRoot(root: Object3D, matchName: string, objectKey?: string): number {
    if (!this.host) return 0;
    const matched: string[] = [];
    for (const { id, behavior } of this.behaviors) {
      if (!matchesAny(behavior.models, matchName)) continue;
      matched.push(id);
      try {
        const accum: KinematicsSpec = {};
        const { ctx, handle } = createBindContext(root, this.host, accum);
        behavior.bind(ctx);
        const report = applyKinematicsSpec(root, accum);
        if (report.warnings.length > 0) {
          console.warn(`[behaviors] '${id}' for '${matchName}': ${report.warnings.length} warning(s)`);
        }
        const signalsContainer = this.registerBehaviorSignals(accum, root);
        this.active.push({ behaviorId: id, handle, objectKey, signalsContainer: signalsContainer ?? undefined });
      } catch (e) {
        console.error(`[behaviors] '${id}' bind error for '${matchName}':`, e);
      }
    }
    if (matched.length > 1) {
      console.warn(`[behaviors] multiple behaviors matched '${matchName}': ${matched.join(', ')}`);
    }
    return matched.length;
  }

  /**
   * Register each behavior-declared signal in the SignalStore AND — when the host
   * registry exposes a write surface — materialise it as a synthetic hierarchy
   * node so a `self.signal()` signal is indistinguishable from an rv_extras one
   * (Plan 197 F4): same OutBool/InBool badge, same live value, same node path.
   *
   * Why this lives here: the load-time signal-construction pass reads behavior
   * signals from `userData.realvirtual.__BehaviorSignals`, but behaviors write
   * those DURING bind (after construction has already happened). So without this
   * post-bind pass, a behavior's `initialValue` never reaches the store.
   *
   * Per signal (when materialising): create a render-free `Object3D` under a
   * `Signals` container child of `root`, stamp `userData.realvirtual[sigType] =
   * { Name, Status:{ Value } }` (the shape the hierarchy scan + badge read), and
   * register node + store + registry under the node path — mirroring
   * `registerSignal()` in rv-signal-construction.ts. `store.register` preserves
   * an already-present value (PLC / saved scene / prior bind), so this is
   * non-destructive; only the path→name mapping changes (`path !== name`).
   *
   * Returns the synthetic `Signals` container (or null) so the caller can
   * unregister its NodeRegistry entries on dispose (leak fix).
   */
  private registerBehaviorSignals(accum: KinematicsSpec, root: Object3D): Object3D | null {
    const store = this.host?.signalStore;
    if (!store) { console.warn(`[behaviors] registerBehaviorSignals: no signalStore on host — ${accum.signals?.length ?? 0} behavior signal(s) DROPPED`); return null; }
    if (!accum.signals || accum.signals.length === 0) return null;
    const seedWriter = store.createWriter?.('behavior:signal-registration', 'behavior');
    const writeSeed = seedWriter?.set.bind(seedWriter) ?? store.set.bind(store);

    // Materialise hierarchy nodes only when the registry exposes the write
    // surface. Test / minimal hosts (registry: null) skip it gracefully and fall
    // back to the store-only seed.
    const reg = this.host?.registry;
    const registerNode = reg?.registerNode?.bind(reg);
    const registerComp = reg?.register?.bind(reg);
    const materialise = !!(registerNode && registerComp);

    // `sig.name` is already instance-scoped by ctx.signal (`${scope}.${name}` —
    // the dot-separated PLC SYMBOL). The scene-graph node path below stays
    // `/`-separated (the technical hierarchy address, not the symbol).
    const scope = instanceScope(root);

    // Register under the node's REAL scene path (parent chain included), not the
    // bare scope name. A placed LayoutObject lives under the model root
    // (`<modelRoot>/Turntable_2`), so a scope-only path (`Turntable_2/Signals/…`)
    // diverges from the physical `Signals` container — the hierarchy then shows
    // every signal TWICE (a phantom root branch with values + the real subtree
    // without), and the real nodes' badges read no live value. Detached roots
    // (no parent yet, e.g. tests / pre-attach binds) fall back to the root name.
    const rootPath = reg?.getPathForNode?.(root)
      ?? (NodeRegistry.computeNodePath(root) || root.name);

    // One render-free `Signals` container per root (idempotent), created lazily
    // on the first materialised signal — mirrors the GLB `Signals` group.
    let container: Object3D | null = null;
    let registered = 0; let materialised = 0;

    for (const sig of accum.signals) {
      if (registerNode && registerComp) {
        // Strip the scope back off for the readable node name + the path's leaf.
        // The symbol is dot-scoped (`${scope}.${local}`), so split on `.`; the
        // node path/name below is rebuilt `/`-separated.
        const local = scope && sig.name.startsWith(`${scope}.`) ? sig.name.slice(scope.length + 1) : sig.name;
        const seed = store.get(sig.name) ?? sig.initialValue ?? (sig.type.includes('Bool') ? false : 0);
        container ??= this.getOrCreateSignalsContainer(root);
        const path = rootPath ? `${rootPath}/${SIGNALS_CONTAINER_NAME}/${local}` : `${SIGNALS_CONTAINER_NAME}/${local}`;
        // Idempotent per container — a re-bind must not append a duplicate node.
        let node = container.children.find((n) => n.name === local) ?? null;
        if (!node) {
          node = new Object3D();
          node.name = local;
          container.add(node);
          materialised++;
        }
        // userData.realvirtual[sigType] = { Name, Status:{ Value } } — the exact
        // shape the hierarchy scan + signal badge read (parity with rv_extras).
        const ud = node.userData as { realvirtual?: Record<string, unknown> };
        (ud.realvirtual ??= {})[sig.type] = { Name: sig.name, Status: { Value: seed } };
        // Node + store + registry under the node path (mirrors registerSignal).
        registerNode(path, node);
        store.register?.(sig.name, path, seed, sig.type);
        registerComp(sig.type, path, { address: path, signalName: sig.name });
        registered++;
      } else {
        // No registry write surface — keep the store-only seed (preserve existing).
        if (sig.initialValue === undefined) continue;
        if (store.get(sig.name) !== undefined) continue;
        if (store.register) store.register(sig.name, sig.name, sig.initialValue, sig.type);
        else writeSeed(sig.name, sig.initialValue);
        registered++;
      }
    }

    // Rebuild the suffix index + refresh the hierarchy ONCE per synchronous batch
    // (a model-load dispatches every placed object in one turn — calling these
    // per bind would run a full scene.traverse N times).
    if (materialise) this.scheduleHierarchyRefresh();

    console.info(`[behaviors] registerBehaviorSignals: ${registered} registered (${materialised} hierarchy node(s)) of ${accum.signals.length} total`);
    return container;
  }

  /** Find-or-create the render-free `Signals` container under `root`.
   *
   *  Reuses ANY existing `Signals` child — whether GLB-native (no marker, created
   *  by `processExtras` from the exported asset) OR behavior-created (`_rvSignals`).
   *  Without this, a GLB that already ships a `Signals` group would get a SECOND,
   *  separate behavior container → the same signals appear twice in the hierarchy
   *  (the GLB one without live values, the behavior one with). Merging into the
   *  existing node keeps signals in ONE place under the component, with values. */
  private getOrCreateSignalsContainer(root: Object3D): Object3D {
    const existing = root.children.find((c) => c.name === SIGNALS_CONTAINER_NAME);
    if (existing) {
      // Stamp the marker so the merged node renders consistently as a signals group.
      (existing.userData as Record<string, unknown>)._rvSignals = true;
      return existing;
    }
    const container = new Object3D();
    container.name = SIGNALS_CONTAINER_NAME;
    (container.userData as Record<string, unknown>)._rvSignals = true;
    root.add(container);
    return container;
  }

  /** Coalesce the signal suffix-index rebuild + hierarchy refresh to a single
   *  microtask so a model-load that binds N placed objects refreshes once, not N
   *  times (each refresh is a full scene.traverse). Both calls null-guarded. */
  private scheduleHierarchyRefresh(): void {
    if (this.hierarchyRefreshScheduled) return;
    this.hierarchyRefreshScheduled = true;
    queueMicrotask(() => {
      this.hierarchyRefreshScheduled = false;
      this.host?.signalStore?.buildIndex?.();
      (this.host?.getPlugin?.('rv-extras-editor') as { refreshEditableNodes?(): void } | undefined)?.refreshEditableNodes?.();
    });
  }

  /** True if `node` is the ROOT of a placed LayoutObject (carries the marker). */
  private isLayoutObjectRoot(node: Object3D): boolean {
    const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
    return !!(rv && rv.LayoutObject);
  }

  /** Stable per-object key: the layout placement id, else the node uuid. */
  private layoutKey(node: Object3D): string {
    return (node.userData?._layoutId as string | undefined) ?? node.uuid;
  }

  /** Asset name to match against: the node name minus the `_N` duplicate suffix. */
  private layoutMatchName(node: Object3D): string {
    return node.name.replace(/_\d+$/, '');
  }

  /**
   * Dispatch behaviors for a single placed LayoutObject subtree — called by the
   * layout planner right after a library asset is added to a scene. Idempotent
   * per object (keyed by placement id). Bound contexts join `active[]`, so they
   * receive fixed-update ticks and are disposed on model-cleared (or via
   * {@link disposeObject} when the object is removed).
   */
  dispatchPlaced(root: Object3D): void {
    if (!this.host) {
      console.warn(`[behaviors] dispatchPlaced("${root.name}") skipped: no host attached`);
      return;
    }
    const key = this.layoutKey(root);
    if (this.dispatchedObjects.has(key)) {
      console.info(`[behaviors] dispatchPlaced("${root.name}") deduped (key=${key.slice(0, 8)})`);
      return;
    }
    this.dispatchedObjects.add(key);
    const matchName = this.layoutMatchName(root);
    const matched = this.bindForRoot(root, matchName, key);
    console.info(`[behaviors] dispatchPlaced("${root.name}" → match "${matchName}"): ${matched} behavior(s) bound`);
  }

  /** Scan a scene root for placed LayoutObjects and dispatch each (on model-loaded). */
  private dispatchPlacedObjectsIn(sceneRoot: Object3D): void {
    sceneRoot.traverse((node) => {
      if (this.isLayoutObjectRoot(node)) this.dispatchPlaced(node);
    });
  }

  /** Dispose one bind: tear down its hooks AND unregister the synthetic signal
   *  nodes from the NodeRegistry (the Object3D leaves with `root`; the registry
   *  entries would otherwise leak). */
  private disposeBind(a: ActiveBind): void {
    try { a.handle.dispose(); } catch { /* ignore */ }
    if (a.signalsContainer) this.host?.registry?.unregisterSubtree?.(a.signalsContainer);
  }

  /** Dispose the behavior contexts bound to a placed object (call on removal). */
  disposeObject(root: Object3D): void {
    const key = this.layoutKey(root);
    const remaining: ActiveBind[] = [];
    for (const a of this.active) {
      if (a.objectKey === key) this.disposeBind(a);
      else remaining.push(a);
    }
    this.active = remaining;
    this.dispatchedObjects.delete(key);
  }

  /** For tests: directly trigger the load logic without an event. */
  triggerLoad(host: BindContextHost, root: Object3D, modelName: string): KinematizeReport[] {
    this.disposeAll();
    const reports: KinematizeReport[] = [];
    for (const { id, behavior } of this.behaviors) {
      if (!matchesAny(behavior.models, modelName)) continue;
      try {
        const accum: KinematicsSpec = {};
        const { ctx, handle } = createBindContext(root, host, accum);
        behavior.bind(ctx);
        reports.push(applyKinematicsSpec(root, accum));
        this.active.push({ behaviorId: id, handle });
      } catch (e) {
        console.error(`[behaviors] '${id}' bind error for '${modelName}':`, e);
      }
    }
    return reports;
  }

  /** For tests: dispose all active binds. */
  disposeAll(): void {
    for (const a of this.active) this.disposeBind(a);
    this.active.length = 0;
    this.dispatchedObjects.clear();
  }

  /** For tests: clear registered behaviors. */
  clearRegistry(): void {
    this.disposeAll();
    this.behaviors.length = 0;
  }
}

// ─── Discovery ──────────────────────────────────────────────────────────

/**
 * Auto-discover all behavior modules in `src/behaviors/` and register them.
 *
 * Vite's `import.meta.glob` is evaluated at build time — adding a new file
 * to `src/behaviors/` is sufficient to enrol it (no manual import).
 */
export function registerAllBehaviors(manager: BehaviorManager): void {
  // Eager glob with default export — see Vite docs.
  // The path is relative to this module (src/core/behaviors.ts → ../behaviors/*.ts).
  const modules = (import.meta as unknown as {
    glob: (pattern: string, opts: { eager: true; import: string }) => Record<string, unknown>;
  }).glob('../behaviors/*.ts', { eager: true, import: 'default' });

  for (const [path, mod] of Object.entries(modules)) {
    const id = path.split('/').pop()!.replace(/\.tsx?$/i, '');
    if (mod && typeof (mod as Behavior).bind === 'function') {
      manager.register(id, mod as Behavior);
    } else {
      console.warn(`[behaviors] '${id}' does not export a default Behavior`);
    }
  }
}
