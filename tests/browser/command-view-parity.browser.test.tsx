// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-499 §9.11 — UI / MCP parity on the OPEN command surfaces, end to end.
 *
 * For each surface — the sim toolbar (`ActionSegment`), the planner Delete
 * (`IconButton`), the library entry (the `layout.place` card) and an inspector
 * action (`ComponentAction.command`) — a real UI click on the RENDERED
 * component and a real tool call through `McpBridgePlugin._handleMessage →
 * _handleCall` (the bridge test transport, no direct `execute`) are compared:
 *
 *  - the same command runs with the same effect, exactly ONE execute each;
 *  - a refusal answers `{error}` == the reason the button shows, with no mutation;
 *  - after the MCP call the RIGHT button carries the afterglow + AI marker
 *    (`aria-description`, `::after` "AI"), it expires after AI_TOUCH_MS and a
 *    repeat call restarts it (the CSS animation name alternates);
 *  - under `prefers-reduced-motion` the afterglow is colour/opacity only — no
 *    `transform`, marker still there.
 *
 * The Quick Edit `ActionButton` (private primitive) and the "closed panel is
 * opened" choreography are pinned in
 * (the private sibling's `tests/command-view-parity-quick-edit.test.tsx`)
 * so this file runs in the community edition too (`VITE_PUBLIC_BUILD=1`, where
 * the hover/press choreography is the no-op stub and only the afterglow shows).
 */

import { bridgeExecuteValue } from '../helpers/execute-value';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.setConfig({ hookTimeout: 60_000, testTimeout: 30_000 });
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { Group, Object3D } from 'three';
import type { ReactNode } from 'react';
import type { RVViewer } from '../../src/core/rv-viewer';
import { RVViewerProvider } from '../../src/hooks/use-viewer';
import { McpBridgePlugin } from '../../src/plugins/mcp-bridge-plugin';
import { buildMultiDispatcher } from '../../src/core/engine/rv-mcp-tools';
import { commandRegistry } from '../../src/core/hmi/rv-command-registry';
import {
  _resetButtonSimStateForTest,
  _setAiTouchMsForTest,
  getButtonSimPhase,
} from '../../src/core/hmi/button-sim-state';
import { SimControllerToolbar } from '../../src/plugins/sim-controller/SimControllerToolbar';
import {
  ensureSimCommandsRegistered,
  registerRuntimeInspectorActions,
  SIM_PLAY_PAUSE_KEY,
  SIM_RESET_KEY,
  driveJogKey,
} from '../../src/plugins/sim-controller/sim-commands';
import { PlannerDeleteButton } from '../../src/plugins/layout-planner/PlannerToolbarButtons';
import { ThumbnailCard } from '../../src/plugins/layout-planner/LayoutLibraryPanel';
import {
  ensurePlannerCommandsRegistered,
  libraryEntryKey,
  NOTHING_TO_DELETE,
  PLANNER_DELETE_KEY,
} from '../../src/plugins/layout-planner/planner-commands';
import { ComponentSection } from '../../src/core/hmi/rv-component-section';
import type { LibraryCatalogEntry } from '../../src/plugins/layout-planner/rv-layout-store';

// ─── Fake viewer + planner (the surfaces' real hooks read these) ────────

interface Placement { id: string; catalogId: string; label: string; position: number[]; rotation: number[]; scale: number[] }

const SPLAT: LibraryCatalogEntry = {
  id: 'cat:splat-hall', name: 'Hall scan', category: 'splat', splatUrl: 'blob:rv-test/hall.ply',
} as LibraryCatalogEntry;

function makeWorld() {
  const listeners = new Map<string, Set<(d: unknown) => void>>();
  const on = (evt: string, fn: (d: unknown) => void): (() => void) => {
    if (!listeners.has(evt)) listeners.set(evt, new Set());
    listeners.get(evt)!.add(fn);
    return () => { listeners.get(evt)?.delete(fn); };
  };
  const emit = (evt: string, d?: unknown): void => { for (const fn of listeners.get(evt) ?? []) fn(d); };

  // selection (stable snapshot per change — useSyncExternalStore)
  let selection = { nodes: [], primaryNode: null, selectedPaths: [] as string[], primaryPath: null as string | null };
  const selSubs = new Set<() => void>();
  const setSelection = (paths: string[]): void => {
    selection = { nodes: [], primaryNode: null, selectedPaths: [...paths], primaryPath: paths[0] ?? null };
    for (const l of selSubs) l();
  };

  // scene: a layout root with two placements + a drive node
  const layout = new Group(); layout.name = 'Layout';
  const nodes = new Map<string, Object3D>();
  const placements: Placement[] = [];
  const addPlacement = (id: string, catalogId: string): void => {
    const n = new Group(); n.name = id; layout.add(n);
    nodes.set(`Layout/${id}`, n);
    placements.push({ id, catalogId, label: id, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });
  };
  addPlacement('p1', 'cat:belt');
  addPlacement('p2', 'cat:belt');
  const driveNode = new Object3D(); driveNode.name = 'Conveyor';
  nodes.set('Cell/Conveyor', driveNode);
  const drive = {
    name: 'Conveyor', node: driveNode, jogForward: false, jogBackward: false,
    stop: vi.fn(function (this: { jogForward: boolean }) { /* halts motion */ }),
  };

  // pause reasons
  const reasons = new Set<string>();
  const tm = { mus: [1, 2, 3] as unknown[], totalSpawned: 3, sensors: [] as unknown[] };

  let n = 0;
  const catalogs = new Map([['test', { entries: [SPLAT] }]]);
  // `preparingEntryIds`: the library card reads it since plan-776 (386b6dcf).
  let storeSnap = { catalogs, placed: placements, preparingEntryIds: [] as string[] };
  const storeSubs = new Set<() => void>();
  const planner = {
    store: {
      selectedId: null as string | null,
      subscribe: (l: () => void) => { storeSubs.add(l); return () => { storeSubs.delete(l); }; },
      getSnapshot: () => storeSnap,
      setPlacementMode: vi.fn(),
    },
    snapshotPlacements: () => ({ placements }),
    getPlacedRootById: (id: string) => nodes.get(`Layout/${id}`) ?? null,
    removeByIds: vi.fn(async (ids: readonly string[]) => {
      const known = ids.filter((id) => placements.some((p) => p.id === id));
      for (const id of known) {
        placements.splice(placements.findIndex((p) => p.id === id), 1);
        nodes.get(`Layout/${id}`)?.removeFromParent();
        nodes.delete(`Layout/${id}`);
      }
      storeSnap = { ...storeSnap, placed: [...placements] };
      for (const l of storeSubs) l();
      return known;
    }),
    removeSelected: vi.fn(async () => {
      const ids = selection.selectedPaths.map((p) => p.replace(/^Layout\//, ''));
      await planner.removeByIds(ids);
      setSelection([]);
    }),
    placeComponent: vi.fn(async (entry: LibraryCatalogEntry, _pos: number[]) => {
      const id = `placed-${++n}`;
      addPlacement(id, entry.id);
      return id;
    }),
    moveById: vi.fn(async () => true),
    loadEntryModel: vi.fn(async () => new Group()),
    setDragEntry: vi.fn(),
  };

  const viewer = {
    get isSimulationPaused() { return reasons.size > 0; },
    get simulationPauseReasons() { return [...reasons]; },
    setSimulationPaused(r: string, p: boolean) {
      if (p) reasons.add(r); else reasons.delete(r);
      emit('simulation-pause-changed', { paused: reasons.size > 0 });
    },
    resetSimulation: vi.fn(() => { tm.mus.length = 0; }),
    get transportManager() { return tm; },
    drives: [drive],
    signalStore: null,
    simTime: 0,
    registry: {
      getNode: (p: string) => nodes.get(p) ?? null,
      getPathForNode: (o: Object3D) => [...nodes.entries()].find(([, v]) => v === o)?.[0] ?? null,
    },
    selectionManager: {
      subscribe: (l: () => void) => { selSubs.add(l); return () => { selSubs.delete(l); }; },
      getSnapshot: () => selection,
      selectPaths: (p: string[]) => setSelection(p),
      select: (p: string) => setSelection([p]),
      clear: () => setSelection([]),
    },
    modes: { activeMode: 'planner', has: () => true, setMode() {}, list: () => [{ id: 'planner' }], subscribe: () => () => {} },
    getPlugin: (id: string) => (id === 'layout-planner' ? planner : undefined),
    leftPanelManager: { isOpen: () => true, open() {}, close() {}, subscribe: () => () => {}, getSnapshot: () => ({ right: {} }) },
    on, emit, markRenderDirty() {}, markShadowsDirty() {},
  } as unknown as RVViewer;

  return { viewer, planner, drive, placements, tm, setSelection };
}

type World = ReturnType<typeof makeWorld>;

/** The bridge with the bridge TEST TRANSPORT — every tool call goes through `_handleCall`. */
function makeBridge(viewer: RVViewer) {
  const plugin = new McpBridgePlugin();
  // plan-668: the test transport stands for a tab with AI control on.
  (plugin as unknown as { _aiEnabled: boolean })._aiEnabled = true;
  (plugin as unknown as { viewer: RVViewer }).viewer = viewer;
  (plugin as unknown as { _dispatcher: ReturnType<typeof buildMultiDispatcher> })._dispatcher =
    buildMultiDispatcher(plugin.mcpToolInstances);
  const sent: string[] = [];
  (plugin as unknown as { _ws: unknown })._ws = {
    readyState: 1, send: (d: string) => { sent.push(d); }, close: vi.fn(),
    onclose: null, onerror: null, onmessage: null,
  };
  const handleMessage = (plugin as unknown as { _handleMessage: (raw: string) => Promise<void> })
    ._handleMessage.bind(plugin);
  let id = 0;
  return async (tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const k = sent.length;
    await handleMessage(JSON.stringify({ type: 'call', id: ++id, tool, arguments: args }));
    const frame = JSON.parse(sent[k]);
    expect(frame.error, `transport error: ${frame.error}`).toBeUndefined();
    return JSON.parse(frame.result);
  };
}

/** Record every distinct phase a button goes through while `fn` runs. */
async function watchPhases(key: string, fn: () => Promise<unknown>): Promise<string[]> {
  const phases: string[] = [];
  const probe = setInterval(() => {
    const p = getButtonSimPhase(key);
    if (p && phases[phases.length - 1] !== p) phases.push(p);
  }, 5);
  try { await fn(); } finally { clearInterval(probe); }
  const last = getButtonSimPhase(key);
  if (last && phases[phases.length - 1] !== last) phases.push(last);
  return phases;
}

/** The choreography the edition runs before the afterglow (the community stub presses nothing). */
const EXPECTED_PHASES = __RV_HAS_PRIVATE__ ? ['hover', 'pressed', 'afterglow'] : ['afterglow'];

const byKey = (key: string): HTMLElement => document.querySelector(`[data-rv-button-id="${CSS.escape(key)}"]`) as HTMLElement;
const glows = (el: HTMLElement | null): boolean => el?.getAttribute('aria-description') === 'Triggered by AI';

/** The afterglow is colour + opacity: an animation, the AI marker, NO transform. */
function expectAfterglowStyle(el: HTMLElement): void {
  const cs = getComputedStyle(el);
  expect(cs.animationName).toMatch(/^rvAiGlow[AB]$/);
  expect(cs.transform).toBe('none');
  expect(getComputedStyle(el, '::after').content).toBe('"AI"');
}

let world: World;
let call: ReturnType<typeof makeBridge>;

function mount(ui: ReactNode) {
  return render(<RVViewerProvider value={world.viewer}>{ui}</RVViewerProvider>);
}

beforeEach(() => {
  ensureSimCommandsRegistered();
  ensurePlannerCommandsRegistered();
  registerRuntimeInspectorActions();
  _resetButtonSimStateForTest();
  world = makeWorld();
  call = makeBridge(world.viewer);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  commandRegistry.attachViewer(undefined);
  _resetButtonSimStateForTest();
});

// ─── Sim toolbar (ActionSegment) ────────────────────────────────────────

describe('sim toolbar — ActionSegment views of sim.playPause / sim.reset', () => {
  it('UI click and web_sim_play_pause: the same command, one execute each, the same effect', async () => {
    mount(<SimControllerToolbar viewer={world.viewer} />);
    const seg = () => document.querySelector('[data-testid="sim-controller-playpause"]') as HTMLElement;
    expect(seg().getAttribute('data-rv-command-id')).toBe('sim.playPause');
    expect(seg().getAttribute('data-rv-button-id')).toBe(SIM_PLAY_PAUSE_KEY);

    const spy = vi.spyOn(commandRegistry, 'execute');
    fireEvent.click(seg());
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0].slice(0, 2)).toEqual(['sim.playPause', { paused: true }]);
    expect(spy.mock.calls[0][2]).toMatchObject({ origin: 'ui' });
    expect(world.viewer.simulationPauseReasons).toContain('user');
    expect(glows(seg())).toBe(false); // a human click leaves no afterglow

    spy.mockClear();
    let res: Record<string, unknown> = {};
    const phases = await watchPhases(SIM_PLAY_PAUSE_KEY, async () => {
      res = await bridgeExecuteValue(call, 'sim.playPause', { paused: false });
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0].slice(0, 2)).toEqual(['sim.playPause', { paused: false }]);
    // plan-2007: web_execute lets the registry derive the button (no explicit buttonKey option).
    expect(spy.mock.calls[0][2]).toMatchObject({ origin: 'mcp' });
    expect(commandRegistry.buttonKeyOf('sim.playPause', { paused: false })).toBe(SIM_PLAY_PAUSE_KEY);
    expect(res).toMatchObject({ wasPaused: true, paused: false, userPaused: false });
    expect(world.viewer.simulationPauseReasons).not.toContain('user');
    expect(phases).toEqual(EXPECTED_PHASES);
    await waitFor(() => expect(glows(seg())).toBe(true));
    expectAfterglowStyle(seg());
    // only the touched segment glows
    expect(glows(byKey(SIM_RESET_KEY))).toBe(false);
  });

  it('web_sim_reset: the Reset segment glows, the effect equals the click', async () => {
    mount(<SimControllerToolbar viewer={world.viewer} />);
    const res = await bridgeExecuteValue(call, 'sim.reset', {});
    expect(res).toMatchObject({ ok: true, before: { mus: 3 }, after: { mus: 0 } });
    expect(world.viewer.resetSimulation).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(glows(byKey(SIM_RESET_KEY))).toBe(true));
    fireEvent.click(byKey(SIM_RESET_KEY));
    expect(world.viewer.resetSimulation).toHaveBeenCalledTimes(2);
  });

  it('the afterglow expires after AI_TOUCH_MS and a repeat call restarts it', async () => {
    _setAiTouchMsForTest(400);
    mount(<SimControllerToolbar viewer={world.viewer} />);
    const seg = () => byKey(SIM_RESET_KEY);
    await bridgeExecuteValue(call, 'sim.reset', {});
    await waitFor(() => expect(glows(seg())).toBe(true));
    const first = getComputedStyle(seg()).animationName;
    await bridgeExecuteValue(call, 'sim.reset', {});
    await waitFor(() => expect(getComputedStyle(seg()).animationName).not.toBe(first)); // restarted
    await waitFor(() => expect(glows(seg())).toBe(false), { timeout: 3000 }); // expired
  });

  it('prefers-reduced-motion: the afterglow is colour only (no transform), the marker stays', async () => {
    const real = window.matchMedia;
    window.matchMedia = ((q: string) => ({
      matches: q.includes('prefers-reduced-motion'), media: q, onchange: null,
      addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    try {
      mount(<SimControllerToolbar viewer={world.viewer} />);
      await bridgeExecuteValue(call, 'sim.playPause', { paused: true });
      await waitFor(() => expect(glows(byKey(SIM_PLAY_PAUSE_KEY))).toBe(true));
      expectAfterglowStyle(byKey(SIM_PLAY_PAUSE_KEY));
    } finally {
      window.matchMedia = real;
    }
  });
});

// ─── Planner Delete (IconButton) ────────────────────────────────────────

describe('planner Delete — IconButton view of layout.remove', () => {
  it('refusal: the disabled tooltip is the command reason; the tool refuses without mutation and without glow', async () => {
    const { container } = mount(<PlannerDeleteButton />);
    const btn = () => container.querySelector(`[data-rv-button-id="${PLANNER_DELETE_KEY}"]`) as HTMLButtonElement;
    await waitFor(() => expect(btn().disabled).toBe(true));
    expect(btn().parentElement?.parentElement?.getAttribute('aria-label') ?? btn().parentElement?.getAttribute('aria-label'))
      .toBe(NOTHING_TO_DELETE);
    expect(commandRegistry.enabled('layout.remove', { id: null }, world.viewer)).toEqual({ reason: NOTHING_TO_DELETE });

    const spy = vi.spyOn(commandRegistry, 'execute');
    let res: Record<string, unknown> = {};
    const phases = await watchPhases(PLANNER_DELETE_KEY, async () => { res = await bridgeExecuteValue(call, 'layout.remove', { id: 'nope' }); });
    const reason = commandRegistry.enabled('layout.remove', { id: 'nope' }, world.viewer);
    expect(res).toEqual({ error: (reason as { reason: string }).reason });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(world.placements.map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(phases).toEqual([]); // preflight: no choreography, no afterglow
    expect(glows(btn())).toBe(false);
  });

  it('UI click (selection) and web_layout_remove (id): one execute each, placement gone, afterglow on Delete', async () => {
    const { container } = mount(<PlannerDeleteButton />);
    const btn = () => container.querySelector(`[data-rv-button-id="${PLANNER_DELETE_KEY}"]`) as HTMLButtonElement;
    act(() => world.setSelection(['Layout/p1']));
    await waitFor(() => expect(btn().disabled).toBe(false));

    const spy = vi.spyOn(commandRegistry, 'execute');
    fireEvent.click(btn());
    await waitFor(() => expect(world.placements.map((p) => p.id)).toEqual(['p2']));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0].slice(0, 2)).toEqual(['layout.remove', { id: null }]);
    expect(world.planner.removeSelected).toHaveBeenCalledTimes(1);
    expect(glows(btn())).toBe(false);

    spy.mockClear();
    let res: Record<string, unknown> = {};
    const phases = await watchPhases(PLANNER_DELETE_KEY, async () => { res = await bridgeExecuteValue(call, 'layout.remove', { id: 'p2' }); });
    // plan-2007: web_execute answers with the command's own value (the retired alias reshaped it).
    expect(res).toMatchObject({ removed: ['p2'] });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][2]).toMatchObject({ origin: 'mcp' });
    expect(commandRegistry.buttonKeyOf('layout.remove', { id: 'p2' })).toBe(PLANNER_DELETE_KEY);
    expect(world.placements).toEqual([]);
    // The button is disabled again (nothing selected) — the afterglow still marks it.
    expect(phases).toEqual(__RV_HAS_PRIVATE__ ? ['hover', 'pressed', 'afterglow'] : ['afterglow']);
    await waitFor(() => expect(glows(btn())).toBe(true));
    expectAfterglowStyle(btn());
  });
});

// ─── Library entry (layout.place card) ──────────────────────────────────

describe('library entry — the card is the view of layout.place', () => {
  it('UI click (splat = direct place) and web_layout_place: same command and effect; afterglow on the entry', async () => {
    mount(<ThumbnailCard entry={SPLAT} isPlacing={false} plugin={world.planner as never} />);
    const card = () => byKey(libraryEntryKey(SPLAT.id));
    expect(card()).not.toBeNull();
    expect(card().getAttribute('data-rv-command-id')).toBe('layout.place');

    const spy = vi.spyOn(commandRegistry, 'execute');
    fireEvent.click(card().firstElementChild as HTMLElement);
    await waitFor(() => expect(world.planner.placeComponent).toHaveBeenCalledTimes(1));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0].slice(0, 2)).toEqual(['layout.place', { catalogId: SPLAT.id, x: 0, y: 0, z: 0, onto: null }]);
    expect(world.planner.placeComponent.mock.calls[0][0]).toBe(SPLAT);

    spy.mockClear();
    let res: Record<string, unknown> = {};
    const phases = await watchPhases(libraryEntryKey(SPLAT.id), async () => {
      res = await bridgeExecuteValue(call, 'layout.place', { catalogId: SPLAT.id, x: 2, y: 0, z: 1 });
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ id: 'placed-2', catalogId: SPLAT.id, position: [2, 0, 1] });
    expect(world.planner.placeComponent).toHaveBeenCalledTimes(2);
    expect(world.planner.placeComponent.mock.calls[1]).toEqual([SPLAT, [2, 0, 1]]);
    expect(phases).toEqual(EXPECTED_PHASES);
    await waitFor(() => expect(glows(card())).toBe(true));
    expectAfterglowStyle(card());
  });

  it('refusal: an unknown catalog id answers the command reason and places nothing', async () => {
    mount(<ThumbnailCard entry={SPLAT} isPlacing={false} plugin={world.planner as never} />);
    const res = await bridgeExecuteValue(call, 'layout.place', { catalogId: 'cat:nope', x: 0, y: 0, z: 0 });
    const reason = commandRegistry.enabled('layout.place', { catalogId: 'cat:nope', x: 0, y: 0, z: 0 }, world.viewer);
    expect(res).toEqual({ error: (reason as { reason: string }).reason });
    expect(world.planner.placeComponent).not.toHaveBeenCalled();
    expect(glows(byKey(libraryEntryKey(SPLAT.id)))).toBe(false);
  });
});

// ─── Inspector action (ComponentAction.command) ─────────────────────────

describe('inspector Drive action — ComponentAction.command view of drive.jog', () => {
  function section() {
    return mount(
      <ComponentSection
        nodePath="Cell/Conveyor" componentType="Drive" data={{ TargetSpeed: 100 }}
        overriddenFields={new Set()} consumedOnly={false}
        onFieldEdit={() => {}} onFieldReset={() => {}} onResetComponent={() => {}}
        viewer={world.viewer} signalStore={null}
      />,
    );
  }

  it('UI click and web_drive_jog: the same command and effect; afterglow on THIS action button', async () => {
    section();
    const fwdKey = driveJogKey('Conveyor', true);
    await waitFor(() => expect(byKey(fwdKey)).not.toBeNull());
    const spy = vi.spyOn(commandRegistry, 'execute');
    fireEvent.click(byKey(fwdKey));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0].slice(0, 2)).toEqual(['drive.jog', { name: 'Conveyor', forward: true }]);
    expect(world.drive.jogForward).toBe(true);

    spy.mockClear();
    const backKey = driveJogKey('Conveyor', false);
    let res: Record<string, unknown> = {};
    const phases = await watchPhases(backKey, async () => { res = await bridgeExecuteValue(call, 'drive.jog', { name: 'Conveyor', forward: false }); });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ name: 'Conveyor', jogForward: false, jogBackward: true });
    expect(world.drive.jogBackward).toBe(true);
    expect(phases).toEqual(EXPECTED_PHASES);
    await waitFor(() => expect(glows(byKey(backKey))).toBe(true));
    expect(glows(byKey(fwdKey))).toBe(false);
    expectAfterglowStyle(byKey(backKey));
  });

  it('refusal: an unknown drive answers the command reason, nothing moves, no glow', async () => {
    section();
    const res = await bridgeExecuteValue(call, 'drive.jog', { name: 'Ghost', forward: true });
    expect(res).toEqual({ error: 'Drive "Ghost" not found' });
    expect(commandRegistry.enabled('drive.jog', { name: 'Ghost', forward: true }, world.viewer))
      .toEqual({ reason: 'Drive "Ghost" not found' });
    expect(world.drive.jogForward).toBe(false);
    expect(glows(byKey(driveJogKey('Ghost', true)))).toBe(false);
  });
});
