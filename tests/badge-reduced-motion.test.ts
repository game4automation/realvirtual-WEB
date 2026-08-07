// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * badge-reduced-motion.test.ts — plan-341 §9.12.
 *
 * The 3D conflict badge used to ask for `blinkHz: 3`, sitting exactly ON the
 * WCAG 2.3.1 flash threshold, and it knew nothing about
 * `prefers-reduced-motion`. Both are pinned here:
 *
 *  - the pulse is BELOW the threshold, never at it;
 *  - under reduced motion the badge is fully static and carries the warning on
 *    shape instead (the `alert` port marker), which is a different marker, not
 *    a slower blink;
 *  - a runtime flip of the setting takes effect without a reload;
 *  - disposing the controller detaches the media listener.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Object3D } from 'three';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import {
  SignalBindingManager,
  type ElementBindingState,
} from '../src/core/engine/rv-signal-binding-manager';
import { clearLiveControl } from '../src/core/engine/rv-live-control';
import { scopeSignalName } from '../src/core/engine/rv-instance-scope';
import {
  SignalBadgeController,
  type BadgePlannerLike,
  type BadgeViewerLike,
} from '../src/plugins/signal-bind/SignalBadgeController';
import {
  CONFLICT_BLINK_HZ,
  REDUCED_MOTION_QUERY,
  WCAG_FLASH_THRESHOLD_HZ,
  conflictBadgeAppearance,
  createReducedMotionWatcher,
  type MatchMediaFn,
} from '../src/plugins/signal-bind/conflict-blink';
import { signalBindStore } from '../src/plugins/signal-bind/signal-bind-store';
import {
  _resetSignalLinkModeStoreForTests,
  setSignalLinkModeExplicit,
} from '../src/plugins/signal-bind/signal-link-mode-store';
import type { GizmoHandle, GizmoOptions, GizmoOverlayManager } from '../src/core/engine/rv-gizmo-manager';

// ── A controllable media query ───────────────────────────────────────────
//
// A real browser cannot be told to change its OS accessibility setting, so the
// query is injected. It counts its own listeners: "dispose cleans up" is only
// meaningful if the removal is observed, not assumed.

interface FakeMedia {
  matchMedia: MatchMediaFn;
  set(matches: boolean): void;
  listenerCount(): number;
  queriedWith: string[];
}

function makeFakeMedia(initial: boolean): FakeMedia {
  let matches = initial;
  const listeners = new Set<() => void>();
  const queriedWith: string[] = [];
  const mql = {
    get matches() { return matches; },
    media: REDUCED_MOTION_QUERY,
    addEventListener: (_type: string, cb: () => void) => { listeners.add(cb); },
    removeEventListener: (_type: string, cb: () => void) => { listeners.delete(cb); },
    dispatchEvent: () => true,
  } as unknown as MediaQueryList;
  return {
    matchMedia: (query: string) => { queriedWith.push(query); return mql; },
    set(next: boolean) {
      matches = next;
      for (const cb of [...listeners]) cb();
    },
    listenerCount: () => listeners.size,
    queriedWith,
  };
}

// ── Badge harness ────────────────────────────────────────────────────────

interface CreatedGizmo {
  id: string;
  options: GizmoOptions;
  updates: Partial<GizmoOptions>[];
  disposed: boolean;
}

interface Harness {
  controller: SignalBadgeController;
  created: CreatedGizmo[];
  /** The gizmo currently representing the conveyor (the last one not disposed). */
  live(): CreatedGizmo;
  media: FakeMedia;
  setState(state: ElementBindingState): void;
}

const activeControllers: SignalBadgeController[] = [];

function makeHarness(initialReducedMotion: boolean, initialState: ElementBindingState): Harness {
  const store = new SignalStore();
  const registry = new NodeRegistry();
  const manager = new SignalBindingManager(store, registry);

  const node = new Object3D();
  node.name = 'C1';
  node.userData.realvirtual = { LayoutObject: { Label: 'C1' }, Conveyor: {} };
  registry.registerNode('conv', node);
  store.register(scopeSignalName('C1', 'Flow.Run'), 'conv/Flow.Run', false, 'PLCOutputBool');

  // The element state is what drives blink; stub it so every level of the
  // matrix is reachable without staging a real conflicting binding.
  let state: ElementBindingState = initialState;
  manager.getElementState = () => state;

  const created: CreatedGizmo[] = [];
  let idc = 0;
  const gizmoManager = {
    create: (_node: Object3D, options: GizmoOptions): GizmoHandle => {
      const entry: CreatedGizmo = { id: `g${idc++}`, options, updates: [], disposed: false };
      created.push(entry);
      return {
        id: entry.id,
        root: new Object3D(),
        update: (partial: Partial<GizmoOptions>) => { entry.updates.push(partial); },
        setVisible: () => {},
        dispose: () => { entry.disposed = true; },
      } as GizmoHandle;
    },
  } as unknown as GizmoOverlayManager;

  const planner: BadgePlannerLike = {
    store: {
      subscribe: () => () => {},
      getSnapshot: () => ({ placed: [{ id: 'conv' }] }),
    },
    getPlacedRootById: (id) => (id === 'conv' ? node : null),
    findPlacedAncestor: (candidate) => (candidate === node ? { id: 'conv', root: node } : null),
  };

  const viewer: BadgeViewerLike = {
    gizmoManager,
    registry,
    signalBindingManager: manager,
    behaviors: { getActiveBinds: () => [] } as unknown as BadgeViewerLike['behaviors'],
    getPlugin: ((id: string) => (id === 'layout-planner' ? planner : undefined)) as BadgeViewerLike['getPlugin'],
    markRenderDirty: vi.fn(),
    on: () => () => {},
  };

  const media = makeFakeMedia(initialReducedMotion);
  const controller = new SignalBadgeController(viewer, planner, { matchMedia: media.matchMedia });
  activeControllers.push(controller);
  setSignalLinkModeExplicit(true);

  return {
    controller,
    created,
    live: () => [...created].reverse().find((g) => !g.disposed)!,
    media,
    setState(next: ElementBindingState) {
      state = next;
      manager.onStateChanged?.('conv');
    },
  };
}

beforeEach(() => {
  clearLiveControl();
  signalBindStore.clear();
  localStorage.clear();
  _resetSignalLinkModeStoreForTests();
});
afterEach(() => {
  for (const controller of activeControllers.splice(0)) controller.dispose();
  _resetSignalLinkModeStoreForTests();
});

describe('conflictBadgeAppearance', () => {
  it('pulses BELOW the WCAG 2.3.1 threshold, never at it', () => {
    expect(CONFLICT_BLINK_HZ).toBeLessThan(WCAG_FLASH_THRESHOLD_HZ);
    const { blinkHz, variant } = conflictBadgeAppearance('conflict', false);
    expect(blinkHz).toBe(CONFLICT_BLINK_HZ);
    expect(blinkHz).toBeLessThan(WCAG_FLASH_THRESHOLD_HZ);
    expect(variant).toBe('idle');
  });

  it('under reduced motion is fully static and switches marker, not speed', () => {
    const { blinkHz, variant } = conflictBadgeAppearance('conflict', true);
    expect(blinkHz).toBe(0);
    expect(variant).toBe('alert');
  });

  it('leaves the calm states alone under both settings', () => {
    for (const state of ['unbound', 'live', 'pending', 'disconnected'] as ElementBindingState[]) {
      expect(conflictBadgeAppearance(state, false)).toEqual({ blinkHz: 0, variant: 'idle' });
      expect(conflictBadgeAppearance(state, true)).toEqual({ blinkHz: 0, variant: 'idle' });
    }
  });
});

describe('createReducedMotionWatcher', () => {
  it('asks the right query and reports live changes', () => {
    const media = makeFakeMedia(false);
    const seen: boolean[] = [];
    const watcher = createReducedMotionWatcher((reduced) => seen.push(reduced), media.matchMedia);

    expect(media.queriedWith).toEqual([REDUCED_MOTION_QUERY]);
    expect(watcher.matches()).toBe(false);
    media.set(true);
    expect(watcher.matches()).toBe(true);
    expect(seen).toEqual([true]);
    watcher.dispose();
  });

  it('dispose removes the listener and is idempotent', () => {
    const media = makeFakeMedia(false);
    const watcher = createReducedMotionWatcher(() => {}, media.matchMedia);
    expect(media.listenerCount()).toBe(1);
    watcher.dispose();
    watcher.dispose();
    expect(media.listenerCount()).toBe(0);
  });

  it('degrades to "no preference" when matchMedia is missing', () => {
    const watcher = createReducedMotionWatcher(undefined, undefined as unknown as MatchMediaFn);
    // A headless harness has no matchMedia at all; the watcher must not throw.
    expect(typeof watcher.matches()).toBe('boolean');
    watcher.dispose();
  });
});

describe('SignalBadgeController — motion', () => {
  it('a badge born in conflict blinks from the start (it used to be silent)', () => {
    const h = makeHarness(false, 'conflict');
    expect(h.live().options.blinkHz).toBe(CONFLICT_BLINK_HZ);
    expect(h.live().options.blinkHz).toBeLessThan(WCAG_FLASH_THRESHOLD_HZ);
  });

  it('a badge that BECOMES conflicting is updated below the threshold', () => {
    const h = makeHarness(false, 'live');
    expect(h.live().options.blinkHz).toBe(0);

    h.setState('conflict');
    const last = h.live().updates.at(-1);
    expect(last?.blinkHz).toBe(CONFLICT_BLINK_HZ);
    expect(last!.blinkHz!).toBeLessThan(WCAG_FLASH_THRESHOLD_HZ);
  });

  it('with reduced motion set, the conflict badge never blinks at all', () => {
    const h = makeHarness(true, 'conflict');
    expect(h.live().options.blinkHz).toBe(0);
  });

  it('flipping the OS setting at runtime takes effect without a reload', () => {
    const h = makeHarness(false, 'conflict');
    const before = h.live();
    expect(before.options.blinkHz).toBe(CONFLICT_BLINK_HZ);

    h.media.set(true);
    // A sprite texture cannot be swapped in place, so the static marker means a
    // rebuilt badge — the assertion is on the RESULT, not on the mechanism.
    const after = h.live();
    expect(after).not.toBe(before);
    expect(before.disposed).toBe(true);
    expect(after.options.blinkHz).toBe(0);

    // …and back again.
    h.media.set(false);
    expect(h.live().options.blinkHz).toBe(CONFLICT_BLINK_HZ);
  });

  it('a runtime flip leaves non-conflicting badges untouched', () => {
    const h = makeHarness(false, 'live');
    const before = h.live();
    h.media.set(true);
    expect(h.live()).toBe(before);
    expect(before.disposed).toBe(false);
    expect(before.updates.length).toBe(0);
  });

  it('disposing the controller detaches the media listener', () => {
    const h = makeHarness(false, 'conflict');
    expect(h.media.listenerCount()).toBe(1);
    h.controller.dispose();
    expect(h.media.listenerCount()).toBe(0);

    // A later flip must reach nobody.
    const created = h.created.length;
    h.media.set(true);
    expect(h.created.length).toBe(created);
  });
});
