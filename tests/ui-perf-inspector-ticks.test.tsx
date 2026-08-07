// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-344 Phase 3.1 + 3.2 — the inspector's two unconditional 200-ms ticks and
 * `useSignalValues`.
 *
 * Both bugs had the same shape: a poll that committed React state whether or not
 * anything had changed, so an idle scene paid a steady 5 Hz re-render bill.
 *
 * The risk in fixing them is the mirror image — gating on too NARROW a comparison
 * silently freezes a live read-out, which is much worse than the re-render. So
 * these tests assert both directions for every observed value: no commit when it
 * is unchanged, exactly one commit when it moves.
 *
 * The transform/live polls are exercised through `useChangeGatedTick`, the shared
 * hook both inspector call sites now use, plus the two pure fingerprint helpers.
 * Rendering the full PropertyInspector would require an editor plugin, a scene
 * and a component registry — that would test the fixture, not the gate.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, render, screen, waitFor, act } from '@testing-library/react';
import { Object3D } from 'three';
import { useChangeGatedTick } from '../src/hooks/use-change-gated-tick';
import { useSignalValues } from '../src/core/hmi/rv-signal-badge';
import { collectBehaviorData } from '../src/core/hmi/inspector-behavior-section';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import type { RVViewer } from '../src/core/rv-viewer';

const TICK_MS = 200;
/** Poll periods to wait so a missing gate would definitely have committed. */
const TEN_TICKS = TICK_MS * 10 + 120;

// ── Fingerprints under test ─────────────────────────────────────────────────
// Mirrors `readTransformSignature` in rv-property-inspector.tsx. Kept here as a
// local copy on purpose: the assertion is about the CONTRACT (which fields are
// observed), so the test states it independently instead of importing it.

const TRANSFORM_EPSILON = 1e-6;

function transformSignature(node: Object3D | null): readonly number[] | null {
  if (!node) return null;
  return [
    node.position.x, node.position.y, node.position.z,
    node.rotation.x, node.rotation.y, node.rotation.z,
    node.scale.x, node.scale.y, node.scale.z,
    node.visible ? 1 : 0,
  ];
}

function transformEqual(a: readonly number[] | null, b: readonly number[] | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.length !== b.length) return false;
  return a.every((v, i) => Math.abs(v - b[i]) <= TRANSFORM_EPSILON);
}

// ── Probes ──────────────────────────────────────────────────────────────────

/** Renders `useChangeGatedTick` and reports how often the component committed. */
function GatedProbe<T>({ read, equal, counter, resetKey }: {
  read: () => T;
  equal?: (a: T, b: T) => boolean;
  counter: { commits: number };
  resetKey?: string;
}) {
  const tick = useChangeGatedTick({ read, equal, resetKey });
  counter.commits++;
  return <span data-testid="tick">{tick}</span>;
}

beforeEach(() => { localStorage.clear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('inspector transform tick (Phase 3.1)', () => {
  it('T1 a static node produces ZERO extra commits over 10 poll periods', async () => {
    const node = new Object3D();
    const counter = { commits: 0 };
    render(<GatedProbe read={() => transformSignature(node)} equal={transformEqual} counter={counter} />);
    const initial = counter.commits;

    await act(async () => { await new Promise((r) => setTimeout(r, TEN_TICKS)); });

    expect(counter.commits).toBe(initial);
    expect(screen.getByTestId('tick').textContent).toBe('0');
  });

  it('T2/T3 position, rotation, scale and visibility each produce exactly one commit', async () => {
    const node = new Object3D();
    const counter = { commits: 0 };
    render(<GatedProbe read={() => transformSignature(node)} equal={transformEqual} counter={counter} />);
    const initial = counter.commits;

    const mutations: Array<() => void> = [
      () => { node.position.x += 1; },
      () => { node.rotation.y += 0.5; },
      () => { node.scale.z = 2; },
      () => { node.visible = false; },
    ];
    for (let i = 0; i < mutations.length; i++) {
      mutations[i]();
      await waitFor(
        () => expect(screen.getByTestId('tick').textContent).toBe(String(i + 1)),
        { timeout: 2000 },
      );
    }
    // One commit per change, no more: nothing re-fires on the following polls.
    await act(async () => { await new Promise((r) => setTimeout(r, TICK_MS * 3)); });
    expect(screen.getByTestId('tick').textContent).toBe('4');
    expect(counter.commits).toBe(initial + 4);
  });

  it('ignores sub-epsilon jitter (below what the section can display)', async () => {
    const node = new Object3D();
    const counter = { commits: 0 };
    render(<GatedProbe read={() => transformSignature(node)} equal={transformEqual} counter={counter} />);
    const initial = counter.commits;

    node.position.x += TRANSFORM_EPSILON / 10;
    await act(async () => { await new Promise((r) => setTimeout(r, TICK_MS * 3)); });
    expect(counter.commits).toBe(initial);
  });

  it('T7 a selection change (resetKey) and unmount clear every interval', async () => {
    const clearSpy = vi.spyOn(window, 'clearInterval');
    const setSpy = vi.spyOn(window, 'setInterval');
    const nodeA = new Object3D();
    const nodeB = new Object3D();
    nodeB.position.set(9, 9, 9);
    const counter = { commits: 0 };

    const { rerender, unmount } = render(
      <GatedProbe read={() => transformSignature(nodeA)} equal={transformEqual} counter={counter} resetKey="A" />,
    );
    const setsAfterMount = setSpy.mock.calls.length;
    const clearsAfterMount = clearSpy.mock.calls.length;

    // Selection change: the old interval must be torn down, a new one started,
    // and the baseline re-taken against the NEW node (no spurious commit).
    rerender(
      <GatedProbe read={() => transformSignature(nodeB)} equal={transformEqual} counter={counter} resetKey="B" />,
    );
    expect(clearSpy.mock.calls.length).toBe(clearsAfterMount + 1);
    expect(setSpy.mock.calls.length).toBe(setsAfterMount + 1);
    await act(async () => { await new Promise((r) => setTimeout(r, TICK_MS * 3)); });
    expect(screen.getByTestId('tick').textContent).toBe('0');

    unmount();
    expect(clearSpy.mock.calls.length).toBe(clearsAfterMount + 2);

    // Nothing keeps polling after unmount.
    const commitsAfterUnmount = counter.commits;
    nodeB.position.x += 5;
    await act(async () => { await new Promise((r) => setTimeout(r, TICK_MS * 3)); });
    expect(counter.commits).toBe(commitsAfterUnmount);
  });
});

describe('inspector live (non-signal) tick (Phase 3.1)', () => {
  /** Minimal Drive-shaped live component: only `getLiveState()` is consulted. */
  function makeDrive(state: Record<string, unknown>) {
    return { getLiveState: () => ({ ...state }) };
  }

  function makeViewerWithDrive(drive: { getLiveState(): Record<string, unknown> }): RVViewer {
    return {
      registry: { getByPath: () => drive },
    } as unknown as RVViewer;
  }

  /** Mirrors `readLiveSignature`'s component branch. */
  function liveSignature(viewer: RVViewer, types: string[]): string {
    const reg = (viewer as unknown as { registry: { getByPath(t: string, p: string): { getLiveState?(): Record<string, unknown> } | null } }).registry;
    return types
      .map((t) => `${t}=${JSON.stringify(reg.getByPath(t, 'Node')?.getLiveState?.() ?? null)}`)
      .join(';');
  }

  it('T4 a Drive whose live state does not move produces no commits, one when it does', async () => {
    const state: Record<string, unknown> = { CurrentPosition: 0, CurrentSpeed: 0, IsRunning: false };
    const viewer = makeViewerWithDrive(makeDrive(state));
    const counter = { commits: 0 };
    render(<GatedProbe read={() => liveSignature(viewer, ['Drive'])} counter={counter} />);
    const initial = counter.commits;

    await act(async () => { await new Promise((r) => setTimeout(r, TEN_TICKS)); });
    expect(counter.commits).toBe(initial);

    state.CurrentPosition = 12.5;
    await waitFor(() => expect(screen.getByTestId('tick').textContent).toBe('1'), { timeout: 2000 });

    state.IsRunning = true;
    await waitFor(() => expect(screen.getByTestId('tick').textContent).toBe('2'), { timeout: 2000 });
  });

  it('T6 a TransportSurface speed change produces exactly one commit', async () => {
    const state: Record<string, unknown> = { Speed: 0 };
    const viewer = makeViewerWithDrive(makeDrive(state));
    render(<GatedProbe read={() => liveSignature(viewer, ['TransportSurface'])} counter={{ commits: 0 }} />);

    await act(async () => { await new Promise((r) => setTimeout(r, TICK_MS * 3)); });
    expect(screen.getByTestId('tick').textContent).toBe('0');

    state.Speed = 250;
    await waitFor(() => expect(screen.getByTestId('tick').textContent).toBe('1'), { timeout: 2000 });
    await act(async () => { await new Promise((r) => setTimeout(r, TICK_MS * 3)); });
    expect(screen.getByTestId('tick').textContent).toBe('1');
  });

  it('T5 a CHILD drive moving while the root does not still commits', async () => {
    // This is the surface the plan's "child drives" requirement is about: the
    // behavior virtual component lists every drive in the SELECTED node's
    // subtree. If the fingerprint only covered the root, each child's speed
    // read-out would freeze at the value it had when the section mounted.
    const root = new Object3D();
    root.name = 'Conveyor';
    const childNode = new Object3D();
    root.add(childNode);
    const childDrive = { name: 'Child', node: childNode, currentSpeed: 0, jogForward: false };

    const viewer = {
      drives: [childDrive],
      transportManager: null,
      signalStore: null,
    } as unknown as RVViewer;

    const read = () => JSON.stringify(collectBehaviorData(viewer as never, root));
    render(<GatedProbe read={read} counter={{ commits: 0 }} />);

    await act(async () => { await new Promise((r) => setTimeout(r, TICK_MS * 3)); });
    expect(screen.getByTestId('tick').textContent).toBe('0');

    // Root untouched; only the child moves.
    childDrive.currentSpeed = 800;
    childDrive.jogForward = true;
    await waitFor(() => expect(screen.getByTestId('tick').textContent).toBe('1'), { timeout: 2000 });
  });
});

describe('useSignalValues (Phase 3.2)', () => {
  function ValuesProbe({ viewer, names, counter }: {
    viewer: RVViewer; names: string[]; counter: { commits: number; lastMap: unknown };
  }) {
    const values = useSignalValues(viewer, names);
    counter.commits++;
    counter.lastMap = values;
    return <span data-testid="v">{values.get(names[0])?.value ?? '-'}</span>;
  }

  function makeViewer(): { viewer: RVViewer; store: SignalStore } {
    const store = new SignalStore();
    store.register('A', 'Root/A', false, 'PLCInputBool');
    store.register('B', 'Root/B', 0, 'PLCInputInt');
    const viewer = { signalStore: store, registry: null } as unknown as RVViewer;
    return { viewer, store };
  }

  /**
   * On the FIRST `setValues` call after a real change, React may re-render the
   * component once even though the updater returned the identical state — the
   * documented "bail out, but possibly render this component once more" path. It
   * happens at most once and then stops, which is why the assertions below are
   * written as "the count stops growing" rather than an exact single number: the
   * property that matters is that an idle model costs ZERO renders per second,
   * not that a one-off bail-out render never happens.
   */
  it('T8 poll periods without a value change stop producing renders and keep the Map identity', async () => {
    const { viewer } = makeViewer();
    const counter = { commits: 0, lastMap: null as unknown };
    render(<ValuesProbe viewer={viewer} names={['A', 'B']} counter={counter} />);

    await waitFor(() => expect(screen.getByTestId('v').textContent).toBe('False'));
    // Window 1 — absorbs the one-off bail-out render.
    await act(async () => { await new Promise((r) => setTimeout(r, TICK_MS * 5 + 80)); });
    const settledCommits = counter.commits;
    const settledMap = counter.lastMap;

    // Window 2 — five more poll periods. Before the fix this added 5 renders
    // (a fresh Map committed unconditionally on every tick).
    await act(async () => { await new Promise((r) => setTimeout(r, TICK_MS * 5 + 80)); });

    expect(counter.commits).toBe(settledCommits);
    // Same reference — that is what stops every consumer from re-rendering.
    expect(counter.lastMap).toBe(settledMap);
  });

  it('T9 one changed value yields a NEW Map, the right value, and then settles again', async () => {
    const { viewer, store } = makeViewer();
    const counter = { commits: 0, lastMap: null as unknown };
    render(<ValuesProbe viewer={viewer} names={['A', 'B']} counter={counter} />);

    await waitFor(() => expect(screen.getByTestId('v').textContent).toBe('False'));
    await act(async () => { await new Promise((r) => setTimeout(r, TICK_MS * 5 + 80)); });
    const before = counter.commits;
    const mapBefore = counter.lastMap;

    store.set('A', true);
    await waitFor(() => expect(screen.getByTestId('v').textContent).toBe('True'), { timeout: 2000 });

    expect(counter.lastMap).not.toBe(mapBefore);
    // One real render for the change, plus at most one React bail-out render.
    expect(counter.commits).toBeGreaterThanOrEqual(before + 1);
    expect(counter.commits).toBeLessThanOrEqual(before + 2);

    // …and it settles again: two further poll windows add nothing.
    await act(async () => { await new Promise((r) => setTimeout(r, TICK_MS * 5 + 80)); });
    const afterSettle = counter.commits;
    await act(async () => { await new Promise((r) => setTimeout(r, TICK_MS * 5 + 80)); });
    expect(counter.commits).toBe(afterSettle);
  });
});
