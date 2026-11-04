// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * tooltip-pin-usability — the pinned (3D-click) tooltip stays put while the
 * user works in it (AAS tooltip usability review, 2026-10-24).
 *
 * Thomas' report: "sometimes they close, and they are a bit fiddly". Measured
 * on the Festo cell, three causes, each pinned down here:
 *
 *  1. The 10 s pin auto-hide ran while the pointer was INSIDE the bubble — the
 *     tooltip vanished under a user reading the document list.
 *  2. Once a pin was gone (auto-hide, orbit, wheel zoom, touch tap) a click on
 *     the still-selected part — or its AAS badge — did nothing, because
 *     `SelectionManager.select()` of the same path is a silent no-op and the
 *     controller only pinned on a selection CHANGE.
 *  3. A pinned bubble is anchored by its BOTTOM edge at a world point. Growing
 *     content (expanding a document group) pushed the header the user had just
 *     clicked upwards, and on a moving axis the bubble ran away from the mouse.
 *     Once the pointer is inside, the bubble now stays where it is.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { Object3D } from 'three';
import { act, cleanup, render } from '@testing-library/react';
import { useState, type FC } from 'react';
import { tooltipStore } from '../src/core/hmi/tooltip/tooltip-store';
import { tooltipRegistry } from '../src/core/hmi/tooltip/tooltip-registry';
import { registerCapabilities } from '../src/core/engine/rv-component-registry';
import { RVViewerProvider } from '../src/hooks/use-viewer';
import type { RVViewer } from '../src/core/rv-viewer';

const PATH = 'Cell/Axis/Gripper';
const NODE = new Object3D();
NODE.name = 'Gripper';
NODE.userData.realvirtual = { PinTestComp: { a: 1 } };

let selectedPaths: string[] = [];
vi.mock('../src/hooks/use-hover', () => ({ useHoveredObject: () => null }));
vi.mock('../src/hooks/use-drives', () => ({ useFocusedDrive: () => ({ drive: null, node: null }) }));
vi.mock('../src/hooks/use-selection', () => ({ useSelection: () => ({ selectedPaths }) }));

const { GenericTooltipController, PIN_AUTOHIDE_MS } = await import(
  '../src/core/hmi/tooltip/GenericTooltipController');
const { TooltipLayer } = await import('../src/core/hmi/tooltip/TooltipLayer');

// ── Minimal viewer: controls + event bus + a 3D-click selection ──
type Listener = (payload?: unknown) => void;
function makeViewer() {
  const controlListeners = new Map<string, Set<Listener>>();
  const busListeners = new Map<string, Set<Listener>>();
  const viewer = {
    registry: { getNode: (p: string) => (p === PATH ? NODE : null), getPathForNode: () => PATH },
    selectionManager: {
      lastHitPoint: [0, 0, 0] as [number, number, number] | null,
      isSelected: (p: string) => selectedPaths.includes(p),
    },
    controls: {
      addEventListener: (t: string, cb: Listener) => { (controlListeners.get(t) ?? controlListeners.set(t, new Set()).get(t)!).add(cb); },
      removeEventListener: (t: string, cb: Listener) => { controlListeners.get(t)?.delete(cb); },
    },
    on: (t: string, cb: Listener) => {
      (busListeners.get(t) ?? busListeners.set(t, new Set()).get(t)!).add(cb);
      return () => { busListeners.get(t)?.delete(cb); };
    },
  };
  const fire = (map: Map<string, Set<Listener>>, t: string, p?: unknown) => { for (const cb of map.get(t) ?? []) cb(p); };
  return {
    viewer: viewer as unknown as RVViewer,
    orbitStart: () => fire(controlListeners, 'start'),
    emit: (t: string, p?: unknown) => fire(busListeners, t, p),
  };
}

function pinnedIds(): string[] {
  return tooltipStore.getSnapshot().visible
    .filter((b) => b.primary.lifecycle === 'pinned')
    .flatMap((b) => b.contentEntries.map((e) => e.id));
}

beforeEach(() => {
  registerCapabilities('PinTestComp', { ui: { tooltip: 'pin-test', priority: 3 } });
  tooltipRegistry.registerDataResolver('pin-test', () => ({ type: 'pin-test', label: 'Gripper' }));
  selectedPaths = [];
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  tooltipStore.hideAll();
  tooltipStore.setPointerInsidePinned('test', false);
});

describe('pin auto-hide never closes under the pointer', () => {
  it('hides an untouched pin after PIN_AUTOHIDE_MS', () => {
    vi.useFakeTimers();
    const { viewer } = makeViewer();
    selectedPaths = [PATH];
    render(<RVViewerProvider value={viewer}><GenericTooltipController /></RVViewerProvider>);
    expect(pinnedIds()).toEqual([`tooltip-pin:pin-test:${PATH}`]);
    act(() => { vi.advanceTimersByTime(PIN_AUTOHIDE_MS + 10); });
    expect(pinnedIds()).toEqual([]);
  });

  it('never auto-hides while the pointer is inside the bubble', () => {
    vi.useFakeTimers();
    const { viewer } = makeViewer();
    selectedPaths = [PATH];
    render(<RVViewerProvider value={viewer}><GenericTooltipController /></RVViewerProvider>);
    act(() => { vi.advanceTimersByTime(PIN_AUTOHIDE_MS - 1000); });
    act(() => { tooltipStore.setPointerInsidePinned('test', true); });
    act(() => { vi.advanceTimersByTime(PIN_AUTOHIDE_MS * 6); });
    expect(pinnedIds()).toHaveLength(1); // still open: the user is reading it
  });

  it('keeps a pin the pointer has been in after it leaves, until an explicit close', () => {
    vi.useFakeTimers();
    const { viewer, orbitStart } = makeViewer();
    selectedPaths = [PATH];
    render(<RVViewerProvider value={viewer}><GenericTooltipController /></RVViewerProvider>);
    act(() => { tooltipStore.setPointerInsidePinned('test', true); });
    act(() => { tooltipStore.setPointerInsidePinned('test', false); });
    act(() => { vi.advanceTimersByTime(PIN_AUTOHIDE_MS * 6); });
    expect(pinnedIds()).toHaveLength(1);
    act(() => { orbitStart(); }); // explicit close still works
    expect(pinnedIds()).toEqual([]);
  });
});

describe('a click on the already-selected part re-pins', () => {
  it('re-pins after an orbit dismissed the pin (object-clicked on the selected path)', () => {
    const { viewer, orbitStart, emit } = makeViewer();
    selectedPaths = [PATH];
    render(<RVViewerProvider value={viewer}><GenericTooltipController /></RVViewerProvider>);
    expect(pinnedIds()).toHaveLength(1);
    act(() => { orbitStart(); });
    expect(pinnedIds()).toEqual([]);
    // Same part clicked again: selection unchanged, only the click event arrives.
    act(() => { emit('object-clicked', { path: PATH, node: NODE }); });
    expect(pinnedIds()).toEqual([`tooltip-pin:pin-test:${PATH}`]);
  });

  it('re-pins on an explicit requestPin (AAS badge click on the selected part)', () => {
    const { viewer, orbitStart } = makeViewer();
    selectedPaths = [PATH];
    render(<RVViewerProvider value={viewer}><GenericTooltipController /></RVViewerProvider>);
    act(() => { orbitStart(); });
    expect(pinnedIds()).toEqual([]);
    act(() => { tooltipStore.requestPin(); });
    expect(pinnedIds()).toHaveLength(1);
  });

  it('does not pin from a click on a part that is not selected', () => {
    const { viewer, orbitStart, emit } = makeViewer();
    selectedPaths = [PATH];
    render(<RVViewerProvider value={viewer}><GenericTooltipController /></RVViewerProvider>);
    act(() => { orbitStart(); });
    act(() => { emit('object-clicked', { path: 'Other/Part', node: new Object3D() }); });
    expect(pinnedIds()).toEqual([]);
  });
});

// ── Bubble position stays put once the pointer is inside ──

let grow: (() => void) | null = null;
const GrowingContent: FC = () => {
  const [rows, setRows] = useState(2);
  grow = () => setRows(12);
  return <div data-testid="grow">{Array.from({ length: rows }, (_, i) => <div key={i} style={{ height: 20 }}>row {i}</div>)}</div>;
};

const nextFrames = (n = 3) => new Promise<void>((resolve) => {
  let left = n;
  const step = () => { if (--left <= 0) resolve(); else requestAnimationFrame(step); };
  requestAnimationFrame(step);
});

function bubbleEl(): HTMLElement {
  const el = document.querySelector('[data-testid="grow"]')?.parentElement?.parentElement as HTMLElement | null;
  if (!el) throw new Error('bubble not rendered');
  return el;
}

describe('pinned bubble keeps its place while the pointer is inside', () => {
  it('does not move when content grows or the anchor moves after pointerenter', async () => {
    tooltipRegistry.register({ contentType: 'grow-test', component: GrowingContent as never });
    const canvas = document.createElement('canvas');
    const viewer = { camera: {}, renderer: { domElement: canvas }, registry: null } as unknown as RVViewer;
    const entry = {
      id: 'pin-grow', lifecycle: 'pinned' as const, targetPath: 'Cell/X', mode: 'fixed' as const,
      data: { type: 'grow-test' }, fixedPos: { x: 20, y: 500 },
    };
    act(() => { tooltipStore.show(entry); });
    render(<RVViewerProvider value={viewer}><TooltipLayer /></RVViewerProvider>);
    await nextFrames();
    const el = bubbleEl();
    const before = el.getBoundingClientRect();
    // Unlocked: the bubble's bottom sits on the anchor (grows upwards).
    expect(Math.round(before.bottom)).toBe(500 - 8);

    el.dispatchEvent(new PointerEvent('pointerenter'));
    act(() => { grow!(); });
    act(() => { tooltipStore.show({ ...entry, fixedPos: { x: 60, y: 560 } }); });
    await nextFrames();
    const after = el.getBoundingClientRect();
    expect(after.height).toBeGreaterThan(before.height + 100);
    expect(Math.round(after.top)).toBe(Math.round(before.top));
    expect(Math.round(after.left)).toBe(Math.round(before.left));
    expect(tooltipStore.pointerInsidePinned).toBe(true);

    // Unmount while inside must not leave the auto-hide frozen forever.
    act(() => { tooltipStore.hide('pin-grow'); });
    await nextFrames(1);
    expect(tooltipStore.pointerInsidePinned).toBe(false);
  });
});
