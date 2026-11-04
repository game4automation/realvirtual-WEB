// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-578 §9.4 — the compacted camera part of the bottom-right cluster.
 *
 * `useCameraSegments()` / `useFollowSegments()` hand the HOST a flat list of the
 * segments that are actually visible, and `withDividers()` interpolates over
 * that already-filtered list — which is what makes "no leading, doubled or
 * missing divider" a property of the data rather than of a children walk.
 *
 * The follow lifecycle is driven by the REAL `CameraFollowPlugin`: it exits the
 * mode itself when the selection stops being followable
 * (`camera-follow-plugin.tsx:50-51`), so the test never mocks the unreachable
 * "active without a selection" state the first plan draft wanted to cover.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { userEvent } from 'vitest/browser';
import { Vector3 } from 'three';
import { commandRegistry } from '../src/core/hmi/rv-command-registry';
import { ensureCameraCommandsRegistered } from '../src/core/hmi/camera-commands';
import { RVViewerProvider } from '../src/hooks/use-viewer';
import type { RVViewer } from '../src/core/rv-viewer';
import type { LoadResult } from '../src/core/engine/rv-scene-loader';
import { CameraFollowPlugin } from '../src/plugins/camera-follow-plugin';
import { cameraBookmarkKey, useCameraSegments, useFollowSegments } from '../src/core/hmi/CameraBar';
import { ActionGroupPill, withDividers } from '../src/core/hmi/action-group';
import { loadVisualSettings, saveVisualSettings, type CameraBookmark } from '../src/core/hmi/visual-settings-store';

const GREEN = 'rgb(102, 187, 106)';

const bookmark = (n: number): CameraBookmark => ({ px: n, py: n, pz: n, tx: 0, ty: 0, tz: 0 });

/** Seed the persisted bookmark slots (the schema itself is unchanged). */
function seedCameras(cameras: (CameraBookmark | null)[]): void {
  const s = loadVisualSettings();
  s.cameras = cameras;
  saveVisualSettings(s);
}

interface Fake {
  viewer: RVViewer;
  plugin: CameraFollowPlugin;
  emit(ev: string, data?: unknown): void;
  setSelection(path: string | null): void;
  calls: string[];
}

function makeFake(): Fake {
  const listeners = new Map<string, Set<(d?: unknown) => void>>();
  const calls: string[] = [];
  let primaryPath: string | null = null;
  const emit = (ev: string, data?: unknown) => { listeners.get(ev)?.forEach((cb) => cb(data)); };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const v: any = {
    calls,
    on(ev: string, cb: (d?: unknown) => void) {
      let set = listeners.get(ev);
      if (!set) { set = new Set(); listeners.set(ev, set); }
      set.add(cb);
      return () => { listeners.get(ev)?.delete(cb); };
    },
    off(ev: string, cb: (d?: unknown) => void) { listeners.get(ev)?.delete(cb); },
    emit,
    renderer: { domElement: document.createElement('canvas') },
    selectionManager: { get primaryPath() { return primaryPath; }, getSnapshot: () => ({ selectedPaths: [], primaryPath }) },
    // resolveFollowSource needs nothing but a node for the path.
    registry: { getNode: (p: string) => (p ? { isObject3D: true, children: [], userData: {}, name: p } : null) },
    getCameraState: () => ({ position: new Vector3(1, 2, 3), target: new Vector3(4, 5, 6) }),
    animateCameraTo: (p: Vector3, t: Vector3) => calls.push(`animate=${p.x},${t.x}`),
    // Stateful stand-in for the CameraManager: mode + owner, and the same
    // camera-mode-changed emission the real viewer wires to the manager hook.
    cameraFollowMode: 'off' as 'off' | 'follow' | 'siton',
    cameraFollowOwner: null as 'selection' | 'agent-eye' | null,
    startCameraFollow() { calls.push('startFollow'); v.cameraFollowMode = 'follow'; v.cameraFollowOwner = 'selection'; emit('camera-mode-changed', { mode: 'follow' }); },
    startCameraSitOn() { calls.push('startSitOn'); v.cameraFollowMode = 'siton'; v.cameraFollowOwner = 'selection'; emit('camera-mode-changed', { mode: 'siton' }); },
    stopCameraFollow() { calls.push('stopFollow'); v.cameraFollowMode = 'off'; v.cameraFollowOwner = null; emit('camera-mode-changed', { mode: null }); },
    getPlugin: (id: string) => (id === 'camera-follow' ? plugin : null),
  };
  const plugin = new CameraFollowPlugin();
  plugin.init(v as RVViewer);
  plugin.onModelLoaded({} as LoadResult, v as RVViewer);
  return {
    viewer: v as RVViewer,
    plugin,
    emit,
    setSelection(path) { primaryPath = path; emit('selection-changed', { path }); },
    calls,
  };
}

/** The host composition — exactly what TopBar does with the two producers. */
function Cluster() {
  const cameraSegments = useCameraSegments();
  const followSegments = useFollowSegments();
  return (
    <ActionGroupPill data-testid="camera-pill">
      {withDividers([...cameraSegments, ...followSegments])}
    </ActionGroupPill>
  );
}

const mount = (f: Fake) =>
  render(<RVViewerProvider value={f.viewer}><Cluster /></RVViewerProvider>);

const pill = () => screen.getByTestId('camera-pill');
const dividers = () => pill().querySelectorAll('.MuiDivider-root');
const segments = () => pill().querySelectorAll('button');

beforeEach(async () => {
  ensureCameraCommandsRegistered();
  await commandRegistry.preload(['camera.follow']);
  seedCameras([null, null, null]);
});

afterEach(() => {
  cleanup();
  seedCameras([null, null, null]);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('camera bookmark compaction', () => {
  it('renders only occupied bookmark slots plus one add segment', () => {
    seedCameras([bookmark(1), null, bookmark(3)]);
    mount(makeFake());
    expect(screen.getByTestId('camera-bookmark-1')).toBeInTheDocument();
    expect(screen.queryByTestId('camera-bookmark-2')).toBeNull();
    expect(screen.getByTestId('camera-bookmark-3')).toBeInTheDocument();
    expect(screen.getByTestId('camera-bookmark-add')).toBeInTheDocument();
    expect(segments()).toHaveLength(3);
  });

  it('the add segment saves the current view into the first free slot', () => {
    seedCameras([bookmark(1), null, null]);
    mount(makeFake());
    fireEvent.click(screen.getByTestId('camera-bookmark-add'));
    // Slot 2 (index 1) is the first free one — slot 1 is untouched.
    const stored = loadVisualSettings().cameras;
    expect(stored[0]).toEqual(bookmark(1));
    expect(stored[1]).toEqual({ px: 1, py: 2, pz: 3, tx: 4, ty: 5, tz: 6 });
    expect(stored[2]).toBeNull();
    expect(screen.getByTestId('camera-bookmark-2')).toBeInTheDocument();
  });

  it('no add segment when all three slots are occupied', () => {
    seedCameras([bookmark(1), bookmark(2), bookmark(3)]);
    mount(makeFake());
    expect(screen.queryByTestId('camera-bookmark-add')).toBeNull();
    expect(segments()).toHaveLength(3);
  });

  it('long-press on an occupied slot still overwrites it and flashes', () => {
    vi.useFakeTimers();
    seedCameras([bookmark(9), null, null]);
    const f = makeFake();
    mount(f);
    const slot = screen.getByTestId('camera-bookmark-1');
    act(() => { fireEvent.pointerDown(slot); });
    act(() => { vi.advanceTimersByTime(500); });
    expect(loadVisualSettings().cameras[0]).toEqual({ px: 1, py: 2, pz: 3, tx: 4, ty: 5, tz: 6 });
    expect(getComputedStyle(screen.getByTestId('camera-bookmark-1')).color).toBe(GREEN);
    // The long press consumed the gesture: releasing — and the click the browser
    // fires after it — must not also restore.
    act(() => { fireEvent.pointerUp(screen.getByTestId('camera-bookmark-1')); });
    act(() => { fireEvent.click(screen.getByTestId('camera-bookmark-1')); });
    expect(f.calls.filter((c) => c.startsWith('animate'))).toHaveLength(0);
    // … and the flash expires.
    act(() => { vi.advanceTimersByTime(800); });
    expect(getComputedStyle(screen.getByTestId('camera-bookmark-1')).color).not.toBe(GREEN);
  });

  it('a short click on an occupied slot restores the view', () => {
    vi.useFakeTimers();
    seedCameras([bookmark(7), null, null]);
    const f = makeFake();
    mount(f);
    const slot = screen.getByTestId('camera-bookmark-1');
    act(() => { fireEvent.pointerDown(slot); });
    act(() => { vi.advanceTimersByTime(100); });
    act(() => { fireEvent.pointerUp(slot); });
    // Restore runs on the CLICK (what Enter / Space produce too), not on pointer-up.
    expect(f.calls.filter((c) => c.startsWith('animate'))).toHaveLength(0);
    act(() => { fireEvent.click(slot); });
    expect(f.calls).toContain('animate=7,0');
  });

  it('works from the keyboard: Enter restores, Shift+Enter overwrites', async () => {
    seedCameras([bookmark(7), null, null]);
    const f = makeFake();
    mount(f);
    const slot = screen.getByTestId('camera-bookmark-1');
    // A REAL key press: only the browser turns Enter on a focused <button> into
    // a click — fireEvent.keyDown would not, and would prove nothing.
    slot.focus();
    await userEvent.keyboard('{Enter}');
    expect(f.calls).toContain('animate=7,0');
    await userEvent.keyboard('{Shift>}{Enter}{/Shift}');
    expect(loadVisualSettings().cameras[0]).toEqual({ px: 1, py: 2, pz: 3, tx: 4, ty: 5, tz: 6 });
  });

  it('global 1/2/3 restore and Shift+1/2/3 save, not while typing', () => {
    seedCameras([bookmark(7), null, null]);
    const f = makeFake();
    mount(f);
    act(() => { fireEvent.keyDown(document.body, { code: 'Digit1', key: '1' }); });
    expect(f.calls).toContain('animate=7,0');
    act(() => { fireEvent.keyDown(document.body, { code: 'Digit2', key: '"', shiftKey: true }); });
    expect(loadVisualSettings().cameras[1]).toEqual({ px: 1, py: 2, pz: 3, tx: 4, ty: 5, tz: 6 });
    // The new slot shows up as a segment right away.
    expect(screen.getByTestId('camera-bookmark-2')).toBeInTheDocument();
    const input = document.createElement('input');
    document.body.appendChild(input);
    try {
      const before = f.calls.length;
      act(() => { fireEvent.keyDown(input, { code: 'Digit1', key: '1' }); });
      expect(f.calls.length).toBe(before);
    } finally {
      input.remove();
    }
  });
});

describe('cameraBookmarkKey', () => {
  const base = { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false };
  const ctx = { typing: false, editorActive: false };
  it('maps Digit1-3 to restore and Shift+Digit1-3 to save', () => {
    expect(cameraBookmarkKey({ ...base, code: 'Digit1' }, ctx)).toEqual({ slot: 0, save: false });
    expect(cameraBookmarkKey({ ...base, code: 'Digit3', shiftKey: true }, ctx)).toEqual({ slot: 2, save: true });
  });
  it('ignores other keys, accelerators, repeats, typing and the asset editor', () => {
    expect(cameraBookmarkKey({ ...base, code: 'Digit4' }, ctx)).toBeNull();
    expect(cameraBookmarkKey({ ...base, code: 'Numpad1' }, ctx)).toBeNull();
    expect(cameraBookmarkKey({ ...base, code: 'Digit1', ctrlKey: true }, ctx)).toBeNull();
    expect(cameraBookmarkKey({ ...base, code: 'Digit1', repeat: true }, ctx)).toBeNull();
    expect(cameraBookmarkKey({ ...base, code: 'Digit1' }, { typing: true, editorActive: false })).toBeNull();
    expect(cameraBookmarkKey({ ...base, code: 'Digit1' }, { typing: false, editorActive: true })).toBeNull();
  });
});

describe('follow / sit-on are bound to the selection', () => {
  it('hands Agent-Eye follow over to the selection without showing it as active', async () => {
    const f = makeFake();
    f.setSelection('Part/A');
    Object.assign(f.viewer, { cameraFollowOwner: 'agent-eye', cameraFollowMode: 'follow' });
    mount(f);
    expect(screen.getByTestId('camera-follow')).toHaveAttribute('aria-pressed', 'false');

    act(() => { f.emit('camera-mode-changed', { mode: 'follow' }); });
    expect(screen.getByTestId('camera-follow')).toHaveAttribute('aria-pressed', 'false');

    await act(async () => { fireEvent.click(screen.getByTestId('camera-follow')); });
    expect(f.calls).toContain('startFollow');
    expect(f.viewer.cameraFollowOwner).toBe('selection');
    expect(screen.getByTestId('camera-follow')).toHaveAttribute('aria-pressed', 'true');
  });

  it('follow/siton are absent without a followable selection', () => {
    seedCameras([bookmark(1), null, null]);
    mount(makeFake());
    expect(screen.queryByTestId('camera-follow')).toBeNull();
    expect(screen.queryByTestId('camera-siton')).toBeNull();
  });

  it('deselection exits the plugin and removes the segments', async () => {
    seedCameras([bookmark(1), null, null]);
    const f = makeFake();
    mount(f);
    act(() => { f.setSelection('Part/A'); });
    expect(screen.getByTestId('camera-follow')).toBeInTheDocument();
    expect(screen.getByTestId('camera-siton')).toBeInTheDocument();

    await act(async () => { fireEvent.click(screen.getByTestId('camera-follow')); });
    expect(f.calls).toContain('startFollow');
    expect(f.plugin.mode).toBe('follow');

    // The REAL lifecycle: the plugin's own selection-changed handler exits.
    act(() => { f.setSelection(null); });
    expect(f.plugin.mode).toBeNull();
    expect(f.calls).toContain('stopFollow');
    expect(screen.queryByTestId('camera-follow')).toBeNull();
    expect(screen.queryByTestId('camera-siton')).toBeNull();
  });

  it('a rendered follow segment is always clickable (no canFollow guard)', async () => {
    seedCameras([bookmark(1), null, null]);
    const f = makeFake();
    mount(f);
    act(() => { f.setSelection('Part/A'); });
    const follow = screen.getByTestId('camera-follow') as HTMLButtonElement;
    expect(follow.disabled).toBe(false);
    // Re-clicking the active mode toggles it off — the former grey-out colour
    // plus click guard made exactly that impossible.
    await act(async () => { fireEvent.click(follow); });
    expect(f.plugin.mode).toBe('follow');
    await act(async () => { fireEvent.click(screen.getByTestId('camera-follow')); });
    expect(f.plugin.mode).toBeNull();
    // And it is NOT painted in the old disabled grey.
    expect(getComputedStyle(screen.getByTestId('camera-follow')).color)
      .not.toBe('rgba(255, 255, 255, 0.35)');
  });
});

describe('divider interpolation over the filtered list', () => {
  it('no leading, doubled or missing dividers when segments are conditional', () => {
    seedCameras([bookmark(1), null, null]);
    const f = makeFake();
    mount(f);
    // 1 bookmark + add = 2 segments → exactly 1 divider, and not in front.
    expect(segments()).toHaveLength(2);
    expect(dividers()).toHaveLength(1);
    expect(pill().firstElementChild?.classList.contains('MuiDivider-root')).toBe(false);
    expect(pill().lastElementChild?.classList.contains('MuiDivider-root')).toBe(false);

    // + follow/siton → 4 segments, 3 dividers, still none at either edge.
    act(() => { f.setSelection('Part/A'); });
    expect(segments()).toHaveLength(4);
    expect(dividers()).toHaveLength(3);
    expect(pill().firstElementChild?.classList.contains('MuiDivider-root')).toBe(false);
    expect(pill().lastElementChild?.classList.contains('MuiDivider-root')).toBe(false);

    // Back to two — no orphaned divider survives the removal.
    act(() => { f.setSelection(null); });
    expect(segments()).toHaveLength(2);
    expect(dividers()).toHaveLength(1);
  });

  it('a single segment gets no divider at all', () => {
    seedCameras([bookmark(1), bookmark(2), bookmark(3)]);
    const f = makeFake();
    mount(f);
    expect(segments()).toHaveLength(3);
    expect(dividers()).toHaveLength(2);
    // All slots full AND no selection → nothing to separate beyond the slots.
    expect(screen.queryByTestId('camera-bookmark-add')).toBeNull();
  });
});
