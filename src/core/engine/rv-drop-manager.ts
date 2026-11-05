// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-drop-manager.ts — viewer-owned detection of UNSUPPORTED MUs (plan-2022).
 *
 * The question is not "is this part falling" — the kinematic engine has no
 * gravity, so a part the transport lets go simply stands where it is and the
 * drop distance is constantly zero. The question is "**would** it fall": is
 * there nothing holding it and nothing underneath it. That is why the feature
 * is called unsupported-part detection and not falling-part detection.
 *
 * Two stages, because a false alarm is more expensive than a missed case:
 *
 *  1. **State** (every tick, O(1) per MU, no allocation). Four conditions, all
 *     already present in the engine: nobody holds it (`heldBy`), no transport
 *     surface plausibly carries it, it seats on no `GripTarget`, it rests on no
 *     carrier MU (`loadedOn`). A grace clock bridges the handover moment in
 *     which a part belongs to neither of two belts.
 *  2. **Support ray** (event-driven, NOT per tick). One `raycastSurfaceAlong`
 *     straight down from just below the part's own AABB. ANY hit within
 *     `SupportProbeDistance` counts as support — including `blocked` hits, i.e.
 *     opaque geometry that carries no component at all, which is exactly the
 *     table / chute / shelf-plate case. Reported only when there is
 *     demonstrably nothing below.
 *
 * ## The plausibility check on condition 2 (measured, pick-and-place cell 2026-10-28)
 *
 * Asking whether a surface is ASSIGNED is not enough. On the customer model 105
 * unsupported parts carried a set `currentSurface` pointing at a conveyor
 * **445 mm lower** (part at y = 1.285, belt at y = 0.84) and would have
 * produced no report at all. So the check asks whether the assigned surface
 * could plausibly reach the part from below, with the SAME two comparisons the
 * transport itself uses to decide whether a surface may take an MU over
 * (`_pickDrivingSurface` tests (vii) and (viii)) and the same tolerance,
 * `RVTransportManager.surfaceVerticalReach`. No third number is invented: if
 * the transport would not pick that surface up for this part, the part is not
 * supported by it.
 *
 * ## The counter-check that must hold
 *
 * An MU that really falls — inside a `WebPhysicsZone`, owned by Rapier or
 * Box2D — is NEVER reported: there, falling is the wanted behaviour and
 * `WebPhysicsZone.RemoveBelowY` already cleans up. Only `owner === 'transport'`
 * without plausible support is the defect.
 *
 * Reporting goes the same way a collision does: the OutlinePass status channel
 * through the claim register (plan-2022 Phase 0) plus a latched card in the
 * messages panel. Nothing ever stops the simulation.
 */

import { Vector3 } from 'three';
import { getDropDetectionSettings } from '../drop-detection-settings-store';
import type { Object3D } from 'three';
import { NodeRegistry } from './rv-node-registry';
import { MM_TO_METERS } from './rv-constants';
import type { DropDetectionConfig, DropDetectionRegistrar, DropDetectionSignals } from './rv-drop-detection';
import { DEFAULT_DROP_DETECTION_CONFIG, toSupportMode } from './rv-drop-detection';
import type { RVMovingUnit, InstancedMovingUnit } from './rv-mu';
import type { RVTransportSurface } from './rv-transport-surface';
import type { SurfaceHit } from './rv-raycast-manager';
import type { SignalStore } from './rv-signal-store';
import { createSignalWriter, type SignalWriter } from './rv-signal-store';
import type { DropAlertView } from '../hmi/drop-alert-store';
import { publishDropAlert } from '../hmi/drop-alert-store';
import { reportProblem, clearProblem, clearProblemsOfCode } from '../hmi/problems-store';
import { debug } from './rv-debug';

// ─── Signal names ────────────────────────────────────────────────────────

export const SIGNAL_DROP_ACTIVE = 'DropActive';
export const SIGNAL_DROP_COUNT = 'DropCount';
export const SIGNAL_RESET_DROPS = 'ResetDrops';
/** Synthetic path prefix (same idea as `__collision__`). */
const SIGNAL_PATH_PREFIX = '__drop__';

/** Problem code for a second `DropDetection` in one scene. */
export const DROP_DETECTION_DUPLICATE_CODE = 'drop-detection-duplicate';

/**
 * Hard ceiling on support rays per tick. A CONSTANT, not a property: it
 * protects the frame rate, it is not a plant characteristic. A buffer without
 * belts can leave 200 parts standing free at once; without the cap they would
 * all probe in the same tick.
 */
export const MAX_PROBES_PER_TICK = 8;

/** The one module scratch for the ray result — the tick is single-threaded. */
const _hit: SurfaceHit = { point: new Vector3(), distance: 0, blocked: false, path: null };
/** Scratch ray origin / direction. */
const _origin = new Vector3();
const DOWN = new Vector3(0, -1, 0);

// ─── Hosts (narrow seams, no hard viewer dependency) ─────────────────────

/** Highlight seam — the production host drives the OutlinePass status channel. */
export interface DropHighlightHost {
  /** Show the drop outline on `roots` (replaces the previous set). */
  showDrops(roots: readonly Object3D[]): void;
  /** Remove the drop outline. */
  hideDrops(): void;
}

/** The support-ray seam. `RaycastManager` satisfies it; tests inject a fake. */
export interface DropProbeHost {
  raycastSurfaceAlong(origin: Vector3, direction: Vector3, out: SurfaceHit): boolean;
}

/** The slice of `SignalStore` this manager uses. */
export type DropSignalHost = Pick<SignalStore, 'register' | 'get' | 'set' | 'subscribe'>
  & Partial<Pick<SignalStore, 'createWriter'>>;

/** What the manager needs to know about the transport side (the manager itself
 *  satisfies it) — kept narrow so the tests need no full transport manager. */
export interface DropTransportHost {
  /** `RVTransportManager.surfaceVerticalReach` in metres. */
  readonly surfaceVerticalReach: number;
  /** `RVTransportManager.reachOf`: the reach of one surface in metres, honouring
   *  its authored `VerticalReach`. Optional so the narrow test fakes stay valid. */
  reachOf?(surface: RVTransportSurface): number;
  /** The GripTargets of the scene; their `occupiedBy` is the only direction
   *  the engine stores (there is no MU → target back reference). */
  readonly gripTargets: readonly { occupiedBy: unknown }[];
}

/** The MU shape the manager reads. Both MU classes satisfy it; the fields that
 *  only the clone MU has are optional. */
export type DropMU = (RVMovingUnit | InstancedMovingUnit) & {
  heldBy?: unknown;
  loadedOn?: unknown;
  vanishElapsed?: number;
};

// ─── Latched reports ─────────────────────────────────────────────────────

interface ActiveDrop {
  readonly view: DropAlertView;
  /** Highlight root; null for an instanced MU (its mesh is the whole pool) and
   *  for a deleted MU. */
  root: Object3D | null;
  /** Seconds since the report — drives `DeleteDelay`. */
  age: number;
  /** The MU, until it is deleted. */
  mu: DropMU | null;
}

/** Stable identity of an MU across ticks (same key space as the collision bodies). */
function muKeyOf(mu: DropMU): string {
  return `mu:${mu.id}`;
}

/**
 * How a node is NAMED in a problem entry. `computeNodePath` answers `''` for a
 * node that is not under a scene root (an authoring tree, a freshly created
 * node), and a problem whose text says `The one on "" is in effect` names
 * nothing at all — so the node's own name takes over.
 */
function labelOf(node: Object3D | null): string {
  if (node === null) return '(none)';
  return NodeRegistry.computeNodePath(node) || node.name || '(unnamed node)';
}

// ─── Manager ─────────────────────────────────────────────────────────────

export class RVDropManager implements DropDetectionRegistrar {
  // ── Registry (the authored component) ──
  /** Optional scene authority; without one the schema defaults apply (E5). */
  private _authority: Object3D | null = null;
  private _config: DropDetectionConfig = DEFAULT_DROP_DETECTION_CONFIG;
  private _signals: DropDetectionSignals = { dropActive: null, dropCount: null, resetDrops: null };
  /** Nodes that registered after the winner — one problem entry each. */
  private readonly _duplicates = new Set<Object3D>();

  // ── Hosts ──
  private _highlight: DropHighlightHost | null = null;
  private _probe: DropProbeHost | null = null;
  private _transport: DropTransportHost | null = null;
  private _writer: SignalWriter | null = null;
  private _unsubReset: (() => void) | null = null;
  private _prevReset = false;

  // ── Latched reports ──
  private readonly _active = new Map<string, ActiveDrop>();
  private readonly _activeRoots: Object3D[] = [];
  /** Source names muted for the rest of the run (the card's Ignore). Survives
   *  reset(); wiped on a model change. */
  private readonly _ignoredSources = new Set<string>();

  // ── Per-tick state ──
  /** MUs currently seated on a GripTarget — rebuilt ONCE per tick before the
   *  MU pass, O(m) per tick instead of O(n·m). A plain Set, not a WeakSet: it
   *  is cleared and refilled every tick, so it holds nothing beyond it. */
  private readonly _onGripTarget = new Set<unknown>();
  private _probesLeft = MAX_PROBES_PER_TICK;
  /** Support rays actually fired since the last `resetProbeStats()` (tests). */
  probeCount = 0;

  // ── Last written signal values (write only on change) ──
  private _lastActive: boolean | null = null;
  private _lastCount: number | null = null;
  /** The authored component's own feedback slots (plan-2022): the `__drop__`
   *  signals are the built-in names, these are the user's wiring. */
  private _feedback: ((active: boolean, count: number) => void) | null = null;

  // ─── Registration ──────────────────────────────────────────────────

  /** IMPLEMENTS DropDetectionRegistrar::register */
  register(node: Object3D, config: DropDetectionConfig, signals: DropDetectionSignals): void {
    if (this._authority !== null && this._authority !== node) {
      // First registered wins; the rest are a visible authoring problem, never
      // a silent merge of two configurations (the WebPhysicsZone rule).
      if (!this._duplicates.has(node)) {
        this._duplicates.add(node);
        reportProblem({
          id: `${DROP_DETECTION_DUPLICATE_CODE}:${labelOf(node)}`,
          severity: 'warning',
          code: DROP_DETECTION_DUPLICATE_CODE,
          title: 'A second DropDetection component is ignored',
          detail: 'Drop detection is scene-wide, so one component configures the whole scene. '
            + `The one on "${labelOf(this._authority)}" is in effect; this one is ignored. `
            + 'Remove it so the settings are not read in two places.',
          nodePath: labelOf(node),
        });
      }
      return;
    }
    this._authority = node;
    this._config = { ...config, SupportMode: toSupportMode(config.SupportMode) };
    this._signals = signals;
  }

  /** IMPLEMENTS DropDetectionRegistrar::unregister */
  unregister(node: Object3D): void {
    if (this._duplicates.delete(node)) {
      clearProblem(`${DROP_DETECTION_DUPLICATE_CODE}:${labelOf(node)}`);
      return;
    }
    if (this._authority !== node) return;
    this._authority = null;
    this._config = DEFAULT_DROP_DETECTION_CONFIG;
    this._signals = { dropActive: null, dropCount: null, resetDrops: null };
    this.reset();
  }

  /** Scene configuration, or schema defaults when no component is authored. */
  get config(): DropDetectionConfig { return this._config; }

  /** Options off always wins over the optional scene component. */
  get optionsEnabled(): boolean { return getDropDetectionSettings().enabled; }
  get hasComponent(): boolean { return this._authority !== null; }
  get isArmed(): boolean { return this.optionsEnabled && this._config.Enabled; }

  // ─── Host wiring ───────────────────────────────────────────────────

  setHighlightHost(host: DropHighlightHost | null): void { this._highlight = host; }
  setProbeHost(host: DropProbeHost | null): void { this._probe = host; }
  setTransportHost(host: DropTransportHost | null): void { this._transport = host; }

  /**
   * Attach to a model's SignalStore: register the three signals and subscribe
   * to the reset edge. Detaches a previous store first, so a model switch never
   * leaves a listener on a dead store.
   */
  attachSignals(store: DropSignalHost | null): void {
    this._unsubReset?.();
    this._unsubReset = null;
    this._writer = null;
    this._lastActive = null;
    this._lastCount = null;
    this._prevReset = false;
    if (!store) return;

    store.register(SIGNAL_DROP_ACTIVE, `${SIGNAL_PATH_PREFIX}/${SIGNAL_DROP_ACTIVE}`, false, 'PLCInputBool');
    store.register(SIGNAL_DROP_COUNT, `${SIGNAL_PATH_PREFIX}/${SIGNAL_DROP_COUNT}`, 0, 'PLCInputInt');
    store.register(SIGNAL_RESET_DROPS, `${SIGNAL_PATH_PREFIX}/${SIGNAL_RESET_DROPS}`, false, 'PLCOutputBool');

    this._writer = createSignalWriter(store, 'component:DropManager', 'component', {
      slotContext: SIGNAL_PATH_PREFIX,
    });
    this._prevReset = store.get(SIGNAL_RESET_DROPS) === true;
    this._unsubReset = store.subscribe(SIGNAL_RESET_DROPS, (v) => {
      const now = v === true;
      const rising = now && !this._prevReset;
      this._prevReset = now;
      if (rising) this.reset();
    });
    this._writeSignals();
  }

  // ─── Tick ──────────────────────────────────────────────────────────

  /**
   * Head of the tick: rebuild the GripTarget occupancy set and refill the probe
   * budget. Runs even while the feature is off (cheap, and it keeps the per-tick
   * sets from going stale when the component is switched on mid-run).
   */
  beginTick(): void {
    this._onGripTarget.clear();
    this._probesLeft = MAX_PROBES_PER_TICK;
    if (!this.isArmed) return;
    const targets = this._transport?.gripTargets;
    if (!targets) return;
    for (const t of targets) {
      if (t.occupiedBy != null) this._onGripTarget.add(t.occupiedBy);
    }
  }

  /**
   * Per-MU step, called from the transport manager's AABB pass — AFTER the
   * transport, the grips, the zone holds and the physics handovers, i.e. on the
   * FINAL state of the tick and with a fresh AABB (the support ray needs it).
   *
   * Only the four state comparisons and a timer run here. The ray is fired at
   * most every `SupportRecheckInterval` and at most {@link MAX_PROBES_PER_TICK}
   * times per tick.
   */
  evaluate(mu: DropMU, dt: number): void {
    const cfg = this._config;
    if (!this.isArmed) {
      // Keep the carriage history while switched off (E7): a part gripped and
      // released now must still be reportable once detection is switched on.
      if (mu.heldBy != null || mu.loadedOn != null || mu.currentSurface != null) mu.wasCarried = true;
      mu.unsupportedTime = 0;
      mu.supportProbeAt = undefined;
      mu.supported = undefined;
      return;
    }

    if (!this._isCandidate(mu)) {
      // Supported again — the clock goes back. The CARD stays: it latches, and
      // a part that was caught at the last moment is still a finding.
      mu.unsupportedTime = 0;
      mu.supportProbeAt = undefined;
      mu.supported = undefined;
      return;
    }

    mu.unsupportedTime = (mu.unsupportedTime ?? 0) + dt;
    if (mu.unsupportedTime < cfg.GraceTime) return;

    const key = muKeyOf(mu);
    if (this._active.has(key)) return;             // already reported, latched
    if (this._ignoredSources.has(mu.sourceName)) return;

    if (cfg.SupportMode === 'StateOnly') {
      this._report(mu);
      return;
    }

    // Stage 2 — the support ray, with cadence and a per-tick cap.
    const now = mu.unsupportedTime;
    const last = mu.supportProbeAt;
    if (last !== undefined && now - last < cfg.SupportRecheckInterval) {
      if (mu.supported === false) this._report(mu);  // last answer still stands
      return;
    }
    if (this._probesLeft <= 0) return;              // next tick
    this._probesLeft--;
    mu.supportProbeAt = now;
    mu.supported = this._hasSupportBelow(mu, cfg);
    if (!mu.supported) this._report(mu);
  }

  /** Advance the delete timers of the latched reports (once per tick). */
  endTick(dt: number): void {
    const cfg = this._config;
    if (!this.isArmed || !cfg.DeleteUnsupported || this._active.size === 0) return;
    let changed = false;
    for (const drop of this._active.values()) {
      drop.age += dt;
      if (drop.mu === null || drop.age < cfg.DeleteDelay) continue;
      // The sink path: step 7 of the transport tick disposes it and notifies
      // grips, zones and the physics provider. Never dispose from here.
      drop.mu.markedForRemoval = true;
      drop.mu = null;
      drop.root = null;
      (drop as { view: DropAlertView }).view = { ...drop.view, deleted: true, nodePath: null };
      changed = true;
    }
    if (changed) {
      this._rebuildHighlightRoots();
      this._applyHighlight();
      this._publish();
    }
  }

  // ─── Stage 1: the four state conditions ────────────────────────────

  /**
   * True while nothing supports this MU. Each `false` branch names its
   * condition so a reader can map the code onto the plan's table.
   */
  private _isCandidate(mu: DropMU): boolean {
    // F7 — an engine owns the pose: falling is the WANTED behaviour there, and
    // `WebPhysicsZone.RemoveBelowY` cleans up. The counter-check Thomas asked
    // for explicitly: an MU really falling in a physics zone is never reported.
    if (mu.owner !== 'transport') return false;
    if (mu.markedForRemoval) return false;
    // Mid end-of-line dissolve: already recognised as end of line; reporting it
    // again would make `vanishMUsAtEndOfLine` cry drop at every belt end.
    if (mu.vanishElapsed !== undefined) return false;
    // (1) nobody holds it (grip, connection, hold zone, commissioning drag)
    if (mu.heldBy != null) { mu.wasCarried = true; return false; }
    // (4) it is a passive load on a carrier MU
    if (mu.loadedOn != null) { mu.wasCarried = true; return false; }
    // (3) it seats on a GripTarget
    if (this._onGripTarget.has(mu)) { mu.wasCarried = true; return false; }
    // (2) a transport surface PLAUSIBLY carries it — not merely "is assigned"
    if (this._surfaceCarries(mu, mu.currentSurface)) { mu.wasCarried = true; return false; }
    // E7: a part nothing ever carried (a static hose, a pre-placed pallet in a
    // test scene) did not FALL — it was never supported in the first place.
    if (mu.wasCarried !== true) return false;
    return true;
  }

  /**
   * Could `surface` actually be carrying `mu` right now?
   *
   * The two comparisons are `_pickDrivingSurface`'s tests (vii) and (viii) with
   * the SAME tolerance (`reachOf`: the surface's own `VerticalReach`, else
   * `surfaceVerticalReach`): a surface entirely above the
   * part is another level, and a part whose underside is more than the reach
   * above the surface top is out of its grasp. This is the plan's pick-and-place cell
   * correction — 105 parts carried a surface 445 mm below themselves and were
   * counted as supported by the mere assignment.
   */
  private _surfaceCarries(mu: DropMU, surface: RVTransportSurface | null): boolean {
    if (surface === null) return false;
    const reach = this._transport?.reachOf?.(surface) ?? this._transport?.surfaceVerticalReach ?? 0.1;
    if (surface.aabb.min.y > mu.aabb.max.y) return false;             // (vii) another level
    if (mu.aabb.min.y > surface.aabb.max.y + reach) return false;     // (viii) out of reach
    return true;
  }

  // ─── Stage 2: the support ray ──────────────────────────────────────

  /**
   * One ray straight down from just BELOW the part's own AABB.
   *
   * The 1 mm offset is not cosmetic: MU instance meshes are registered raycast
   * targets, so a ray starting inside the part hits the part and the whole
   * feature would be silently dead (every part supported by itself).
   *
   * Any hit inside `SupportProbeDistance` counts, `blocked` hits included — a
   * housing or a shelf plate without a component IS a support. In doubt
   * everything supports: a false alarm costs more than a missed case.
   */
  private _hasSupportBelow(mu: DropMU, cfg: DropDetectionConfig): boolean {
    const probe = this._probe;
    if (probe === null) return true;   // no raycaster → never cry drop
    this.probeCount++;
    _origin.set(mu.aabb.center.x, mu.aabb.min.y - 0.001, mu.aabb.center.z);
    if (!probe.raycastSurfaceAlong(_origin, DOWN, _hit)) return false;
    return _hit.distance <= cfg.SupportProbeDistance / MM_TO_METERS;
  }

  // ─── Reporting ─────────────────────────────────────────────────────

  private _report(mu: DropMU): void {
    const key = muKeyOf(mu);
    if (this._active.has(key)) return;
    const root = mu.isInstanced ? null : (mu as RVMovingUnit).node;
    const c = mu.aabb.center;
    const view: DropAlertView = {
      muName: mu.getName(),
      muKey: key,
      nodePath: root ? NodeRegistry.computeNodePath(root) : null,
      sourceName: mu.sourceName ?? '',
      atMm: [c.x * MM_TO_METERS, mu.aabb.min.y * MM_TO_METERS, c.z * MM_TO_METERS],
      deleted: false,
      since: performance.now(),
    };
    this._active.set(key, { view, root, age: 0, mu });
    debug('transport', `DropDetection: "${view.muName}" is unsupported at `
      + `${view.atMm.map((v) => Math.round(v)).join(' / ')} mm`);
    this._rebuildHighlightRoots();
    this._applyHighlight();
    this._publish();
    this._writeSignals();
  }

  /** Re-derive the highlight roots from the CURRENT reports (the set shrinks). */
  private _rebuildHighlightRoots(): void {
    this._activeRoots.length = 0;
    for (const drop of this._active.values()) {
      if (drop.root && !this._activeRoots.includes(drop.root)) this._activeRoots.push(drop.root);
    }
  }

  private _applyHighlight(): void {
    if (this._activeRoots.length > 0) this._highlight?.showDrops(this._activeRoots);
    else this._highlight?.hideDrops();
  }

  /** Re-apply the outline — e.g. after a workspace-mode change. */
  reapplyHighlight(): void { this._applyHighlight(); }

  private _publish(): void {
    publishDropAlert(this.activeDrops);
  }

  /** IMPLEMENTS DropDetectionRegistrar::setFeedbackSink */
  setFeedbackSink(sink: ((active: boolean, count: number) => void) | null): void {
    this._feedback = sink;
    // Hand over the current state at once — the component may have been
    // constructed while reports were already standing (a live re-init).
    sink?.(this._active.size > 0, this._active.size);
  }

  private _writeSignals(): void {
    // The component's slots are independent of the `__drop__` writer: a model
    // may wire the slots without the synthetic store ever being attached.
    this._feedback?.(this._active.size > 0, this._active.size);
    if (!this._writer) return;
    const active = this._active.size > 0;
    const count = this._active.size;
    if (this._lastActive !== active) {
      this._lastActive = active;
      this._writer.set(SIGNAL_DROP_ACTIVE, active);
    }
    if (this._lastCount !== count) {
      this._lastCount = count;
      this._writer.set(SIGNAL_DROP_COUNT, count);
    }
  }

  // ─── Card actions ──────────────────────────────────────────────────

  /** Snapshot of the latched reports. */
  get activeDrops(): readonly DropAlertView[] {
    const views: DropAlertView[] = [];
    for (const drop of this._active.values()) views.push(drop.view);
    return views;
  }

  /**
   * Acknowledge ONE report (the card's OK): the reported part is removed (Thomas
   * 2026-11-04) through the sink path of `DeleteUnsupported` — step 7 of the
   * transport tick disposes it, never here. A part already gone just clears its
   * card. Unknown keys are a no-op.
   */
  acknowledge(muKey: string): void {
    const drop = this._active.get(muKey);
    if (!drop) return;
    this._active.delete(muKey);
    if (drop.mu) drop.mu.markedForRemoval = true;
    this._rebuildHighlightRoots();
    this._applyHighlight();
    this._publish();
    this._writeSignals();
  }

  /** Source names muted for this run. */
  get ignoredSources(): ReadonlySet<string> { return this._ignoredSources; }

  /**
   * Mute every part of one SOURCE for the rest of the run (the card's Ignore):
   * matching reports are dropped at once and no new one is taken. The source is
   * the type unit of a part, the analogue of the collision's role pair.
   * Survives reset(); wiped on a model change.
   */
  ignoreSource(sourceName: string): void {
    if (this._ignoredSources.has(sourceName)) return;
    this._ignoredSources.add(sourceName);
    let removed = false;
    for (const [key, drop] of this._active) {
      if (drop.view.sourceName === sourceName) {
        this._active.delete(key);
        removed = true;
      }
    }
    if (removed) {
      this._rebuildHighlightRoots();
      this._applyHighlight();
      this._publish();
      this._writeSignals();
    }
  }

  // ─── Reset / lifecycle ─────────────────────────────────────────────

  /**
   * Clear every report (cards, outline, signals). A part still unsupported is
   * re-detected on the next tick — this serves the `ResetDrops` edge and the
   * teardown paths. Never touches the simulation.
   */
  reset(): void {
    this._active.clear();
    this._activeRoots.length = 0;
    this._highlight?.hideDrops();
    publishDropAlert([]);
    this._writeSignals();
  }

  /** Model change: drop the registry and every reported state. */
  clear(): void {
    // By code, not by the ids tracked in `_duplicates`: an entry whose node label
    // changed since it was reported would otherwise survive the model change.
    clearProblemsOfCode(DROP_DETECTION_DUPLICATE_CODE);
    this._duplicates.clear();
    this._authority = null;
    this._config = DEFAULT_DROP_DETECTION_CONFIG;
    this._signals = { dropActive: null, dropCount: null, resetDrops: null };
    this._onGripTarget.clear();
    this._ignoredSources.clear();
    this._feedback = null;
    this.probeCount = 0;
    this._active.clear();
    this._activeRoots.length = 0;
    this._highlight?.hideDrops();
    publishDropAlert([]);
    // Write the signals DOWN before detaching — `attachSignals(null)` drops the
    // writer, so a later write would be a no-op and the old store would keep a
    // stale `DropActive = true` for anyone still reading it.
    this._writeSignals();
    this.attachSignals(null);
  }

  /** Viewer teardown. */
  dispose(): void {
    this.clear();
    this._highlight = null;
    this._probe = null;
    this._transport = null;
  }

  // ─── Diagnostics / artificial trigger (plan-2022 Phase 6) ──────────

  /**
   * Detach `mu` from everything that supports it, so the detection, the card
   * and the silhouette can be exercised WITHOUT waiting for a real defect.
   *
   * This is deliberately a plain method behind the `diag.unsupportPart` command
   * and not a hidden developer flag: it is listed in `web_commands`, it is
   * recordable, it names itself as a diagnostic, and it does nothing at all
   * unless somebody calls it. It changes only hold/carry state — it does not
   * fake a report, so what the user then sees is the real detector answering.
   */
  releaseSupport(mu: DropMU, liftMm = 0): { released: string[]; muKey: string } {
    const released: string[] = [];
    if (mu.heldBy != null) { released.push(`heldBy=${String(mu.heldBy)}`); (mu as RVMovingUnit).heldBy = null; }
    if (mu.currentSurface !== null) { released.push(`currentSurface=${mu.currentSurface.node.name}`); mu.currentSurface = null; }
    mu.lastSurface = null;
    for (const t of this._transport?.gripTargets ?? []) {
      if (t.occupiedBy === mu) {
        released.push('gripTarget');
        (t as { occupiedBy: unknown }).occupiedBy = null;
      }
    }
    this._onGripTarget.delete(mu);
    if (liftMm !== 0) {
      const p = mu.getPosition().clone();
      p.y += liftMm / MM_TO_METERS;
      mu.setPosition(p);
      mu.updateAABB();
      released.push(`lifted ${liftMm} mm`);
    }
    mu.wasCarried = true; // the artificial release stands for "it was carried until now"
    mu.unsupportedTime = 0;
    mu.supportProbeAt = undefined;
    mu.supported = undefined;
    return { released, muKey: muKeyOf(mu) };
  }
}
