// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import type { Object3D, OrthographicCamera, PerspectiveCamera } from 'three';
import type { GizmoHandle, GizmoOverlayManager } from '../../core/engine/rv-gizmo-manager';
import type {
  SignalBindingManager,
  ElementBindingState,
} from '../../core/engine/rv-signal-binding-manager';
import type { RVViewer } from '../../core/rv-viewer';
import { findSignalBindTarget, signalBindTargetId } from './signal-bind-target';
import { openSignalBindPopover } from './signal-bind-store';
import {
  getSignalLinkModeSnapshot,
  subscribeSignalLinkMode,
} from './signal-link-mode-store';
import { getSignalDragPhase, subscribeSignalDrag } from '../../core/hmi/signal-drag-store';
import {
  enumerateAllBindableTargets,
  type BindableTarget,
  type BindableTargetViewerLike,
} from './bindable-targets';
import { BINDING_STATE_LABEL } from '../../core/hmi/signal-vocabulary';
import { makePortMarkerTexture, type PortMarkerVariant } from './port-marker-texture';
import { applyScreenSpaceScale } from '../../core/engine/rv-screen-space-scale';
import {
  conflictBadgeAppearance,
  createReducedMotionWatcher,
  type MatchMediaFn,
  type ReducedMotionWatcher,
} from './conflict-blink';

/** Constant on-screen badge size, matched to the drop-target idle marker. */
const BADGE_MARKER_PX = 28;
/** Pre-first-frame fallback; overwritten by the screen-space scale each render. */
const BADGE_WORLD_SIZE_M = 0.12;

export const SIGNAL_BADGE_STATE_COLOR: Record<ElementBindingState, number> = {
  unbound: 0x9e9e9e,
  live: 0x22cc44,
  pending: 0x4fc3f7,
  disconnected: 0xff9800,
  conflict: 0xff3333,
};

/**
 * Sprite label per element state. An alias, not a second definition — the same
 * record backs the popover header (plan-341 Phase 6), so the badge and the
 * popover it opens can never word the same element differently.
 */
export const SIGNAL_BADGE_STATE_LABEL: Record<ElementBindingState, string> = BINDING_STATE_LABEL;

export interface BadgePlannerLike {
  store: {
    subscribe: (listener: () => void) => () => void;
    getSnapshot: () => { placed: ReadonlyArray<{ id: string }> };
  };
  getPlacedRootById: (id: string) => Object3D | null;
  findPlacedAncestor: (node: Object3D) => { id: string; root: Object3D } | null;
}

export interface BadgeViewerLike extends BindableTargetViewerLike {
  gizmoManager: GizmoOverlayManager;
  signalBindingManager: SignalBindingManager | null;
  on: {
    (event: 'object-clicked', cb: (event: { node: Object3D }) => void): () => void;
    /** Model lifecycle — see the rebuild subscription in the constructor. */
    (event: 'model-loaded' | 'model-logic-activated', cb: () => void): () => void;
  };
  markRenderDirty: () => void;
  /** Optional so headless harnesses can drive the controller without a renderer;
   *  when absent, badges keep their fixed world size instead of screen scaling. */
  camera?: PerspectiveCamera | OrthographicCamera;
  renderer?: { domElement: HTMLCanvasElement };
}

interface BadgeEntry {
  handle: GizmoHandle;
  state: ElementBindingState;
  target: BindableTarget;
  /**
   * Sprite texture the gizmo was BUILT with. `handle.update()` cannot swap a
   * sprite texture (see `_updateEntry` — it only touches colour/opacity/blink),
   * so a variant change is the one case that forces a rebuild.
   */
  variant: PortMarkerVariant;
}

/** Optional injection points; production passes nothing. */
export interface SignalBadgeControllerOptions {
  /** Overrides `window.matchMedia` so reduced motion is testable. */
  matchMedia?: MatchMediaFn;
}

export class SignalBadgeController {
  private readonly viewer: BadgeViewerLike;
  private readonly planner: BadgePlannerLike | null;
  private readonly badges = new Map<string, BadgeEntry>();
  private active = false;
  private lastSignature = '';
  private modeUnsub: (() => void) | null = null;
  private dragUnsub: (() => void) | null = null;
  private plannerUnsub: (() => void) | null = null;
  private modelUnsub: (() => void)[] = [];
  private clickUnsub: (() => void) | null = null;
  private previousStateListener: ((id: string) => void) | null = null;
  private readonly reducedMotion: ReducedMotionWatcher;

  constructor(
    viewer: BadgeViewerLike,
    planner: BadgePlannerLike | null = null,
    options: SignalBadgeControllerOptions = {},
  ) {
    this.viewer = viewer;
    this.planner = planner;
    // A runtime flip of the OS setting has to take effect immediately — the
    // whole point of the preference is that the user does not reload to escape
    // motion. Only conflict badges carry motion, so only they are rebuilt.
    this.reducedMotion = createReducedMotionWatcher(
      () => this.applyMotionPreference(),
      options.matchMedia,
    );
    this.modeUnsub = subscribeSignalLinkMode(() => this.syncMode());
    // Subscribe to the DRAG PHASE directly, not to the link mode's `active`
    // (plan-341 F17 / Nachcheck-2 finding 8): with the link mode explicitly on,
    // `active` stays constantly true across drag start and end, so
    // `publishIfChanged()` notifies nobody and this controller would never
    // learn that a drag is running.
    this.dragUnsub = subscribeSignalDrag(() => this.syncMode());
    this.plannerUnsub = planner?.store.subscribe(() => {
      if (this.active) this.rebuild(false);
    }) ?? null;
    // Rebuild once the model is actually there. Without this, a link mode
    // restored from localStorage activates the controller during startup, the
    // single `setActive(true)` rebuild runs against a half-built scene, and
    // nothing ever revisits it: the planner store is the only other trigger,
    // and `onStateChanged` only refreshes badges that already exist. Robot
    // axes were the visible casualty — their slots need the live component
    // instances, which bind on `model-logic-activated`, so A1…A6 and the
    // gripper stayed badge-less until the user toggled the mode by hand.
    // Both events are taken: geometry-only models never fire the logic one.
    this.modelUnsub = [
      viewer.on?.('model-loaded', () => { if (this.active) this.rebuild(true); }),
      viewer.on?.('model-logic-activated', () => { if (this.active) this.rebuild(true); }),
    ].filter(Boolean) as (() => void)[];

    const manager = viewer.signalBindingManager;
    if (manager) {
      this.previousStateListener = manager.onStateChanged;
      manager.onStateChanged = (id: string) => {
        this.previousStateListener?.(id);
        if (this.active) this.refreshBadge(id);
      };
    }
    this.syncMode();
  }

  /** Keep every badge at a constant on-screen size, like the drop-target markers. */
  onRender(): void {
    if (!this.active || this.badges.size === 0) return;
    const camera = this.viewer.camera;
    const renderer = this.viewer.renderer;
    if (!camera || !renderer) return;
    const canvasHeight = renderer.domElement.clientHeight;
    if (!canvasHeight) return;
    for (const entry of this.badges.values()) {
      applyScreenSpaceScale(entry.handle.root, BADGE_MARKER_PX, camera, canvasHeight);
    }
  }

  setActive(enabled: boolean): void {
    if (enabled === this.active) return;
    this.active = enabled;
    if (enabled) {
      this.clickUnsub = this.viewer.on('object-clicked', ({ node }) => this.onObjectClicked(node));
      this.rebuild(true);
    } else {
      this.clickUnsub?.();
      this.clickUnsub = null;
      this.clearBadges();
    }
  }

  dispose(): void {
    this.setActive(false);
    this.reducedMotion.dispose();
    this.modeUnsub?.();
    this.modeUnsub = null;
    this.dragUnsub?.();
    this.dragUnsub = null;
    this.plannerUnsub?.();
    this.plannerUnsub = null;
    for (const unsub of this.modelUnsub) unsub();
    this.modelUnsub = [];
    const manager = this.viewer.signalBindingManager;
    if (manager) manager.onStateChanged = this.previousStateListener;
    this.previousStateListener = null;
  }

  /**
   * Persistent badges are shown when signal linking is on AND no drag is
   * running. While a signal IS being dragged they step aside completely so the
   * payload-filtered `drop-target-overlay` is the only marker layer in the
   * scene — `enumerateAllBindableTargets()` takes no payload and therefore
   * cannot filter, which is what made every bindable plug light up for a signal
   * only a few of them could accept (plan-341 F17).
   */
  private syncMode(): void {
    const dragging = getSignalDragPhase() === 'dragging';
    this.setActive(getSignalLinkModeSnapshot().active && !dragging);
  }

  private rebuild(force: boolean): void {
    if (!this.viewer.signalBindingManager) return;
    const targets = enumerateAllBindableTargets(this.viewer);
    const signature = targets.map((target) => target.id).join('|');
    if (!force && signature === this.lastSignature) return;
    this.lastSignature = signature;

    const wanted = new Set<string>();
    for (const target of targets) {
      wanted.add(target.id);
      this.ensureBadge(target);
    }
    for (const id of this.badges.keys()) {
      if (!wanted.has(id)) this.removeBadge(id);
    }
  }

  private ensureBadge(target: BindableTarget): void {
    const manager = this.viewer.signalBindingManager!;
    const state = manager.getElementState(target.id);
    // Motion and shape come from ONE place (plan-341 Phase 5): a conflict pulses
    // well below the WCAG 2.3.1 threshold, and under `prefers-reduced-motion` it
    // does not pulse at all but switches to the static `alert` marker instead.
    const { blinkHz, variant } = conflictBadgeAppearance(state, this.reducedMotion.matches());
    const existing = this.badges.get(target.id);
    if (existing) {
      existing.target = target;
      // A sprite texture is create-time only, so a variant change (conflict
      // gaining or losing its static ring) has to go through a rebuild.
      if (existing.variant !== variant) {
        this.removeBadge(target.id);
      } else {
        if (existing.state === state) return;
        existing.state = state;
        existing.handle.update({ color: SIGNAL_BADGE_STATE_COLOR[state], blinkHz });
        this.decorateState(existing.handle, state);
        this.viewer.markRenderDirty();
        return;
      }
    }

    const handle = this.viewer.gizmoManager.create(target.node, {
      shape: 'sprite',
      color: SIGNAL_BADGE_STATE_COLOR[state],
      opacity: 0.92,
      // A badge born straight into `conflict` used to be created without any
      // blinkHz at all and therefore stayed silent for its whole life; the
      // create path now carries the same appearance as the update path.
      blinkHz,
      spriteTexture: makePortMarkerTexture(variant),
      worldSize: BADGE_WORLD_SIZE_M,
      attachToNode: true,
      depthTest: false,
      renderOrder: 2100,
      userDataMarker: 'rvSignalBadge',
      category: 'signals',
    });
    this.decorateState(handle, state);
    this.badges.set(target.id, { handle, state, target, variant });
    this.viewer.markRenderDirty();
  }

  /**
   * Re-apply the motion preference to badges already on screen. Only conflict
   * badges can change: every other state is static under both settings, so a
   * blanket rebuild would churn the scene for nothing.
   */
  private applyMotionPreference(): void {
    if (!this.active) return;
    const reduced = this.reducedMotion.matches();
    for (const [id, entry] of [...this.badges]) {
      if (entry.state !== 'conflict') continue;
      const { blinkHz, variant } = conflictBadgeAppearance(entry.state, reduced);
      if (entry.variant === variant) {
        entry.handle.update({ blinkHz });
        continue;
      }
      const target = entry.target;
      this.removeBadge(id);
      this.ensureBadge(target);
    }
    this.viewer.markRenderDirty();
  }

  private decorateState(handle: GizmoHandle, state: ElementBindingState): void {
    handle.root.userData.rvSignalBadgeState = state;
    handle.root.userData.rvSignalBadgeLabel = SIGNAL_BADGE_STATE_LABEL[state];
  }

  private refreshBadge(id: string): void {
    const target = enumerateAllBindableTargets(this.viewer).find((candidate) => candidate.id === id);
    if (!target) {
      this.removeBadge(id);
      return;
    }
    this.ensureBadge(target);
  }

  private removeBadge(id: string): void {
    const entry = this.badges.get(id);
    if (!entry) return;
    entry.handle.dispose();
    this.badges.delete(id);
    this.viewer.markRenderDirty();
  }

  private clearBadges(): void {
    if (this.badges.size === 0) {
      this.lastSignature = '';
      return;
    }
    for (const entry of this.badges.values()) entry.handle.dispose();
    this.badges.clear();
    this.lastSignature = '';
    this.viewer.markRenderDirty();
  }

  private onObjectClicked(node: Object3D): void {
    if (!this.active) return;
    const target = findSignalBindTarget(this.viewer as RVViewer, node);
    if (!target || !this.badges.has(signalBindTargetId(target))) return;
    openSignalBindPopover(target);
  }
}
