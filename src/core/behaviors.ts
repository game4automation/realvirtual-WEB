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
 *
 * ── Payload discovery (plan-455) ────────────────────────────────────────────
 *
 * Name matching alone cannot see a component that lives INSIDE a scene: the
 * `AGV_1/2/3` of a saved layout carry a complete `rv_extras.Agv` config, are not
 * placements, and match no filename — so nothing ever bound them and nothing
 * drove. A third dispatch step therefore walks the loaded scene and binds every
 * node whose `userData.realvirtual` carries a registered material-flow type,
 * AT that node (`dispatchExtrasIn`). This is the same dual discovery the DES
 * scene binding has used since Plan 194 §2.6, now shared out of
 * `material-flow/registry.ts` so both kernels resolve identically.
 *
 * Two identities are tracked per bind, and they are NOT the same key:
 *   - **bind identity** `(node.uuid, type)` — the de-dupe. A node that matches
 *     by glob AND by payload binds exactly once per type.
 *   - **owner identity** — the nearest enclosing LayoutObject's placement key,
 *     or (no such ancestor) the scene lifecycle. This is what `disposeObject`
 *     removes by, so removing a placement also tears down the payload binds of
 *     its INNER nodes instead of leaving them ticking.
 *
 * Precedence: payload wins over the scene-root FILENAME glob for the same type
 * (`bindForRoot`'s `suppressTypes`). The filename glob exists for geometry-only
 * standalone assets; once a scene ships explicit payloads for a type, the
 * filename is a spent signal and would only add a ghost instance. Placement
 * globs are untouched.
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
// Payload discovery (plan-455). Safe direction: registry.ts reaches the glob
// matcher through `glob-match.ts` and never imports THIS module, so the eager
// behavior glob above stays out of its initialisation order.
import { extrasMaterialFlowTypes, isEngineOwnedFlowType } from './material-flow/registry';

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

  /**
   * The material-flow `type` this behavior is the continuous adapter for —
   * stamped by `defineLibraryComponent` / `toBehavior`, absent on hand-written
   * behaviors.
   *
   * The registry stores `MaterialFlowDefinition`s and holds NO reference to the
   * executable adapter built around them, so a payload hit (`rv_extras.Agv`)
   * yields a type with no way back to the thing that can bind it. Carrying the
   * type on the adapter closes that gap: `BehaviorManager.register` indexes by
   * it, and the payload dispatch binds the very same adapter the glob path would
   * have bound. Deliberately the declared TYPE, never the module filename — the
   * two are free to differ.
   */
  type?: string;

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
  /**
   * OWNER identity — the placement whose removal disposes this bind. The placed
   * LayoutObject's own key for a glob bind, the NEAREST enclosing LayoutObject's
   * key for a payload bind on an inner node, `undefined` when no placement
   * encloses it (then only `model-cleared` disposes it).
   */
  objectKey?: string;
  /** BIND identity — `${node.uuid}::${type ?? behaviorId}`. De-dupes glob and
   *  payload discovery against each other; released again on dispose. */
  bindKey: string;
  /** Scene path of the node this bind is scoped to — diagnostics only, so a
   *  payload bind on an inner node is distinguishable from a whole-scene one. */
  nodePath: string;
  /** Synthetic `Signals` container this bind materialised (if any) — its
   *  NodeRegistry entries are unregistered on dispose to avoid a registry leak. */
  signalsContainer?: Object3D;
}

/**
 * BehaviorManager — owns the registered behaviors, dispatches them on
 * model-load and disposes them on model-clear.
 */
/** A registered behavior together with the id it was registered under. */
interface BehaviorEntry { id: string; behavior: Behavior }

export class BehaviorManager {
  private behaviors: BehaviorEntry[] = [];
  /** Material-flow `type` → its adapter. The bridge from a payload key to the
   *  executable behavior; see {@link Behavior.type}. */
  private byType = new Map<string, BehaviorEntry>();
  /** Live bind identities `${uuid}::${type}` — the glob/payload de-dupe (F3). */
  private boundKeys = new Set<string>();
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
    const entry: BehaviorEntry = { id, behavior };
    this.behaviors.push(entry);
    // Index by material-flow type so a payload key resolves to this adapter.
    // Last registration wins (HMR re-evaluation replaces, never duplicates).
    if (behavior.type) this.byType.set(behavior.type, entry);
  }

  /** Total number of registered behaviors (for diagnostics / tests). */
  get count(): number { return this.behaviors.length; }

  /** Get all registered ids (for diagnostics / tests). */
  ids(): string[] { return this.behaviors.map(b => b.id); }

  /** Number of currently active (post-load, pre-clear) bind contexts. */
  get activeCount(): number { return this.active.length; }

  /**
   * Read-only snapshot of the active binds — for the layout-graph debug page
   * and for tests that need to see WHERE a behavior bound.
   *
   * `nodePath` is what makes a payload bind observable: `behaviorId` +
   * `objectKey` alone cannot tell a whole-scene bind from one on an inner node,
   * which is exactly the distinction plan-455 turns on.
   */
  getActiveBinds(): ReadonlyArray<{ behaviorId: string; objectKey: string | undefined; nodePath: string }> {
    return this.active.map(a => ({ behaviorId: a.behaviorId, objectKey: a.objectKey, nodePath: a.nodePath }));
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
      // 3. FIRST, though it is the newest step: every node carrying a
      //    registered material-flow payload binds AT that node. It runs ahead of
      //    the filename bind so the latter can stand down for types the scene
      //    has already claimed explicitly (precedence, F5).
      const payloadTypes = this.dispatchExtrasIn(root);
      // 1. Whole scene vs. the loaded GLB filename (a standalone asset GLB),
      //    minus any type already bound from a payload.
      this.bindForRoot(root, extractGlbName(getCurrentModelUrl()), undefined, payloadTypes);
      // 2. Each placed LayoutObject subtree vs. its asset name, so library
      //    items embedded in a scene get their behavior even though the
      //    scene's filename doesn't match (see dispatchPlaced). Order relative
      //    to step 3 is immaterial — the bind-identity de-dupe is commutative.
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
   *
   * `suppressTypes` (scene-root call only) lists the material-flow types this
   * scene already binds from an explicit payload — the filename glob yields for
   * those (F5). Returns the number of behaviors ACTUALLY bound: a match that the
   * bind-identity de-dupe or a bind error rejects is not counted.
   */
  private bindForRoot(
    root: Object3D,
    matchName: string,
    objectKey?: string,
    suppressTypes?: ReadonlySet<string>,
  ): number {
    if (!this.host) return 0;
    const matched: string[] = [];
    for (const entry of this.behaviors) {
      if (!matchesAny(entry.behavior.models, matchName)) continue;
      const type = entry.behavior.type;
      // F5 — this scene binds `type` from an explicit payload somewhere, so the
      // filename glob has nothing left to say about it. Logged, never silent:
      // if this ever suppresses something real, the log is the evidence.
      if (type && suppressTypes?.has(type)) {
        console.info(
          `[behaviors] '${entry.id}' NOT bound for '${matchName}': ` +
          `'${type}' is bound from rv_extras in this scene (filename glob yields to payload)`,
        );
        continue;
      }
      if (this.bindOne(root, entry, matchName, objectKey)) matched.push(entry.id);
    }
    if (matched.length > 1) {
      console.warn(`[behaviors] multiple behaviors matched '${matchName}': ${matched.join(', ')}`);
    }
    return matched.length;
  }

  /**
   * Bind ONE registered behavior at `root` — the shared core of both discovery
   * paths. The glob path arrives here after its `models[]` match; the payload
   * path arrives here with the adapter already resolved by type, since the
   * payload key IS the match and there is no name to test.
   *
   * Returns false when the bind identity is already live (de-dupe) or the bind
   * threw; true when a context joined `active[]`.
   */
  private bindOne(root: Object3D, entry: BehaviorEntry, matchLabel: string, objectKey?: string): boolean {
    if (!this.host) return false;
    const { id, behavior } = entry;
    const bindKey = `${root.uuid}::${behavior.type ?? id}`;
    if (this.boundKeys.has(bindKey)) return false;
    try {
      const accum: KinematicsSpec = {};
      const { ctx, handle } = createBindContext(root, this.host, accum);
      behavior.bind(ctx);
      const report = applyKinematicsSpec(root, accum);
      if (report.warnings.length > 0) {
        console.warn(`[behaviors] '${id}' for '${matchLabel}': ${report.warnings.length} warning(s)`);
      }
      const signalsContainer = this.registerBehaviorSignals(accum, root);
      this.boundKeys.add(bindKey);
      this.active.push({
        behaviorId: id,
        handle,
        objectKey,
        bindKey,
        nodePath: this.nodePathOf(root),
        signalsContainer: signalsContainer ?? undefined,
      });
      return true;
    } catch (e) {
      console.error(`[behaviors] '${id}' bind error for '${matchLabel}':`, e);
      return false;
    }
  }

  /** Scene path of a node — registry-resolved when available, computed otherwise. */
  private nodePathOf(node: Object3D): string {
    return this.host?.registry?.getPathForNode?.(node)
      ?? (NodeRegistry.computeNodePath(node) || node.name);
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
   * OWNER key for a bind at `node`: the nearest enclosing LayoutObject's
   * placement key (the node itself counts), or `undefined` when no placement
   * encloses it — then the scene lifecycle owns it.
   *
   * This is what keeps a payload bind on an INNER node from outliving the
   * placement it sits in: `disposeObject` matches on exactly this key.
   */
  private ownerKeyFor(node: Object3D): string | undefined {
    let cur: Object3D | null = node;
    while (cur) {
      if (this.isLayoutObjectRoot(cur)) return this.layoutKey(cur);
      cur = cur.parent;
    }
    return undefined;
  }

  /**
   * Bind every node in `subtree` that carries a registered material-flow type
   * as `rv_extras` payload, AT that node (plan-455 F1). Returns the set of types
   * that were found with a usable adapter — the scene-root filename bind stands
   * down for those (F5).
   *
   * ── Why engine-owned types step aside ───────────────────────────────────────
   *
   * `Source` and `Sink` already have ENGINE component factories: the scene
   * loader constructs a real `RVSource`/`RVSink` for every `rv_extras[type]` it
   * meets, and that component — not the behavior — is the continuous driver.
   * Their behaviors are `inert:true` for precisely that reason (see the
   * double-spawn guard in `behaviors/Source.ts`, whose contract states the
   * behavior never binds against an arbitrary inner-node payload). Binding them
   * from a payload here would put a second, badge-stamping, signal-writing
   * instance on nodes all over the shipped demo library while adding no
   * behaviour at all. So the payload dispatch covers the types the engine does
   * NOT own — the same ownership split `registerMaterialFlow` already makes when
   * it skips its schema adapter for factory-owned types. The DES kernel has no
   * such engine driver and therefore keeps binding every type (Plan 194 §2.6).
   */
  private dispatchExtrasIn(subtree: Object3D): Set<string> {
    const payloadTypes = new Set<string>();
    if (!this.host) return payloadTypes;
    subtree.traverse((node) => {
      const types = extrasMaterialFlowTypes(node);
      if (types.length === 0) return;
      for (const type of types) {
        if (isEngineOwnedFlowType(type)) continue;
        const entry = this.byType.get(type);
        if (!entry) continue;
        // Counted whether or not THIS call bound it: an already-live bind of the
        // same type at the same node is still a payload claim on that type.
        payloadTypes.add(type);
        if (this.bindOne(node, entry, type, this.ownerKeyFor(node))) {
          console.info(`[behaviors] rv_extras '${type}' → '${entry.id}' bound at "${node.name}"`);
        }
      }
    });
    return payloadTypes;
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
    // Payload-carrying nodes INSIDE the placement bind too, so an asset added
    // after load behaves like one that was present at load — and so a
    // remove/re-add cycle binds them again (they own-key to this placement).
    this.dispatchExtrasIn(root);
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
    // Release the bind identity so a re-add of the same object binds again.
    this.boundKeys.delete(a.bindKey);
  }

  /**
   * Dispose the behavior contexts OWNED by a placed object (call on removal).
   *
   * Ownership, not location: this also removes the payload binds of the
   * placement's inner nodes, which carry its key precisely so their tick
   * callbacks and signal subscriptions leave with it.
   */
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
        const bindKey = `${root.uuid}::${behavior.type ?? id}`;
        this.boundKeys.add(bindKey);
        this.active.push({ behaviorId: id, handle, bindKey, nodePath: this.nodePathOf(root) });
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
    this.boundKeys.clear();
  }

  /** For tests: clear registered behaviors. */
  clearRegistry(): void {
    this.disposeAll();
    this.behaviors.length = 0;
    this.byType.clear();
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
