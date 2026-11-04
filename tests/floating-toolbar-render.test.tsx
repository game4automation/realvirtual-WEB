// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2010 §9.8 — the REAL floating tool toolbar, rendered, with the real
 * public plugins, in the real workspace modes. The composition test counts
 * DECLARATIONS; this one counts what is drawn — a slot entry can render `null`
 * (no DES runner, no planner plugin, no scene store) and one entry can draw two
 * buttons (the snapshot actions used to).
 *
 * Preconditions are produced, not assumed (gate finding SOL R2-1): one viewer
 * for the planner and the UI, a scene store (Undo / Redo render `null` without
 * one), the path visualizer registered BEFORE the path-network UI and the layer
 * visible (no Path network button without an active interaction). Undo, Redo,
 * Delete and Path network are checked one by one first, so a wrong sum comes
 * with a message that names the missing piece.
 *
 * The mobile hook is pinned to desktop (the browser viewport is phone-sized).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import { ButtonPanel } from '../src/core/hmi/ButtonPanel';
import { rvDarkTheme } from '../src/core/hmi/theme';
import { RVViewerProvider } from '../src/hooks/use-viewer';
import { SignalBindingManager } from '../src/core/engine/rv-signal-binding-manager';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { initSceneStore } from '../src/core/hmi/scene/scene-store-singleton';
import { LayoutPlannerPlugin } from '../src/plugins/layout-planner';
import { PathVisualizerPlugin } from '../src/plugins/path-visualizer-plugin';
import { PathNetworkUiPlugin } from '../src/plugins/path-network/path-network-ui-plugin';
import { ClippingPlugin } from '../src/plugins/rv-clipping-plugin';
import { SignalBindPlugin } from '../src/plugins/signal-bind/SignalBindPlugin';
import { DESHMIPlugin } from '../src/plugins/des/hmi/des-hmi-plugin';
import { MeasurementPlugin } from '../src/plugins/measurement-plugin';
import { TestAxesPlugin } from '../src/plugins/demo/test-axes-plugin';
import { DemoHMIPlugin } from '../src/plugins/demo/demo-hmi-plugin';
import type { SimDesControl } from '../src/core/material-flow/simulation-kernel';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';

vi.mock('../src/hooks/use-mobile-layout', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/hooks/use-mobile-layout')>(),
  useMobileLayout: () => false,
}));


let handle: TestViewerHandle;
/** Whether the viewer reports a DES control (the toolbar entries of the DES runner need one). */
let desControl: SimDesControl | null = null;

beforeAll(async () => {
  handle = await createTestViewer('webgl');
  const viewer = handle.viewer;
  initSceneStore(viewer);
  // The two signal buttons render only with a binding manager (viewer flag plannerSignalLinking): a stub is enough.
  viewer.signalBindingManager = new SignalBindingManager(new SignalStore(), new NodeRegistry());
  // The test viewer has no workspace modes yet (main.ts registers them at boot).
  viewer.modes.register({ id: 'hmi', label: 'HMI', order: 10 }).register({ id: 'des', label: 'DES', order: 20 }).register({ id: 'planner', label: 'Planner', order: 30 });
  // Order matters: the path visualizer BEFORE the path-network UI (its init bails without it).
  viewer.use(new PathVisualizerPlugin());
  viewer.use(new LayoutPlannerPlugin());
  const pathUi = new PathNetworkUiPlugin();
  viewer.use(pathUi);
  viewer.use(new ClippingPlugin());
  viewer.use(new SignalBindPlugin());
  viewer.use(new DESHMIPlugin());
  viewer.use(new MeasurementPlugin());
  viewer.use(new TestAxesPlugin());
  viewer.use(new DemoHMIPlugin());
  // The DES side tools draw only while the kernel has an active DES runner and
  // hands out a DES control. The test viewer has no runner, so a fake kernel
  // answers — but ONLY while `desControl` is set (after the mode switch), so
  // the real mode machinery never talks to it.
  // plan-2036: the path-network controller loads lazily; the tool button draws once it is there.
  await pathUi.whenInteractionReady();
  const fakeKernel = { mode: 'des', activeExecutor: { instances: () => [] }, desControl: () => desControl };
  vi.spyOn(viewer, 'simulationKernel', 'get').mockImplementation(() => (desControl ? fakeKernel : null) as never);
}, 60_000);

afterAll(() => {
  vi.restoreAllMocks();
  if (handle) { handle.viewer.signalBindingManager?.dispose(); handle.viewer.signalBindingManager = null; }
  handle?.dispose();
});

afterEach(() => {
  cleanup();
  desControl = null;
});

function renderPanel() {
  return render(
    <ThemeProvider theme={rvDarkTheme}>
      <RVViewerProvider value={handle.viewer}><ButtonPanel /></RVViewerProvider>
    </ThemeProvider>,
  );
}

async function enter(mode: 'planner' | 'des') {
  await act(async () => { await handle.viewer.modes.requestMode(mode); });
  expect(handle.viewer.modes.activeMode).toBe(mode);
}

const sections = () => [...document.querySelectorAll<HTMLElement>('[data-rv-tool-group]')];
const isShown = (el: HTMLElement) => getComputedStyle(el).display !== 'none';
const visibleSections = () => sections().filter((s) => isShown(s) && s.childElementCount > 0);
const hasTopLine = (el: HTMLElement) => {
  const cs = getComputedStyle(el);
  return cs.borderTopStyle === 'solid' && parseFloat(cs.borderTopWidth) > 0;
};
const triggersIn = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('button, [role="button"]')]
  .filter((b) => b.getClientRects().length > 0);
const allTriggers = () => visibleSections().flatMap(triggersIn);
const labels = () => allTriggers().map((b) => b.getAttribute('aria-label') ?? b.getAttribute('data-testid') ?? b.textContent ?? '?');

/**
 * The stable identity of a drawn tool: its `data-testid` when it has one, else
 * its `aria-label`. plan-2047 pins these SETS instead of a bare count, so the
 * next deviation says WHICH tool appeared or vanished — a naked number cost
 * this test three days of looking for two tools that were never meant to be
 * there (see TOOLS_IN_DES).
 */
const toolIds = () => allTriggers()
  .map((b) => b.getAttribute('data-testid') ?? b.getAttribute('aria-label') ?? '?')
  .sort();

/**
 * Tools of the AUTHORING set: the layout planner's own seven, the path-network
 * tool and the clipping tool. Shown in every authoring mode (planner AND des,
 * `AUTHORING_TOOL_RULE` — `authoring-modes.ts`), the clip tool unconditionally
 * (`visibilityRule: {}`).
 */
const TOOLS_AUTHORING = [
  // LayoutPlannerPlugin, editing group
  'Undo', 'Redo', 'Delete selected',
  // LayoutPlannerPlugin + PathNetworkUiPlugin, model group
  'planner-snap-flyout', 'Toggle planner library', 'path-network-tool',
  // LayoutPlannerPlugin, analysis group
  'Toggle vanish MUs at end of line',
  // ClippingPlugin (view) and LayoutPlannerPlugin (view)
  'Section / Clip', 'Toggle documentation mode',
];

/**
 * Planner mode = the authoring set plus the two signal-linking tools, whose
 * rule is `shownOnlyInAny: SIGNAL_LINK_TOOLBAR_CONTEXTS` — every signal-link
 * mode EXCEPT des (`signal-link-gate.ts:37`), plus the Align tool (plan-779,
 * `shownOnlyIn: ['planner', 'mode:planner']` — Planner only, not DES).
 *
 * Not shown here: the three DES side tools (`shownOnlyInAny: ['mode:des']`),
 * the measurement tool (`hiddenIn` planner + des), the test-axes tool
 * (`hiddenIn` des, planner, editor, viewer) and the five ruleless DemoHMI
 * buttons (ButtonPanel hides ruleless entries in any focused mode).
 * The private PLC editor button (model group) would make it 12.
 */
const TOOLS_IN_PLANNER = [...TOOLS_AUTHORING, 'signal-link-mode-toggle', 'bindings-overview-toggle', 'Toggle Align tool'];

/**
 * DES mode = the authoring set plus the three DES side tools, which need an
 * active DES control.
 *
 * plan-2047 Fall 4 — this used to assert a bare `14` and was red from the day
 * it was written (`73ce080d`). The 14 counted the authoring set, the DES tools
 * AND the two signal-linking tools — but `1db2b30a`, an ancestor of that very
 * commit, had already taken the signal tools out of DES, which is what the test
 * name ("no signal buttons") and the assertion below both say. Nothing was
 * removed from the product; the number was arithmetically wrong from birth.
 * (The later lazy-load fix, `48fca3c1`, ADDED `path-network-tool` here: the
 * case drew 11, then 12, against a 14 that was never reachable.)
 */
const TOOLS_IN_DES = [...TOOLS_AUTHORING,
  'des-side-event-queue', 'des-side-experiments', 'des-side-snapshot'];

/** Tell WHICH of the preconditions is missing before any count is judged. */
function expectPresent(testIdOrLabel: string, why: string) {
  const found = allTriggers().some((b) => b.getAttribute('data-testid') === testIdOrLabel || b.getAttribute('aria-label') === testIdOrLabel);
  expect(found, `${testIdOrLabel} is not drawn (${why}); drawn: ${labels().join(' | ')}`).toBe(true);
}

describe('floating toolbar, rendered', () => {
  it('Planner: the authoring set + the two signal tools, in four sections with three dividers', async () => {
    desControl = null;
    await enter('planner');
    renderPanel();

    await waitFor(() => expectPresent('Undo', 'SceneStore missing?'));
    expectPresent('Redo', 'SceneStore missing?');
    expectPresent('Delete selected', 'planner plugin missing?');
    expectPresent('path-network-tool', 'path visualizer / layer not active?');
    expectPresent('planner-snap-flyout', 'planner plugin missing?');

    const secs = visibleSections();
    expect(secs.map((s) => s.dataset.rvToolGroup), labels().join(' | ')).toEqual(['editing', 'model', 'analysis', 'view']);
    expect(secs.map(hasTopLine)).toEqual([false, true, true, true]);
    expect(toolIds(), labels().join(' | ')).toEqual([...TOOLS_IN_PLANNER].sort());
  });

  it('DES with a DES control: the authoring set + the three DES tools, ONE snapshot trigger, no signal buttons', async () => {
    desControl = null;
    await enter('des');
    desControl = { snapshotJson: () => '{}', restoreJson: () => {} } as unknown as SimDesControl;
    renderPanel();

    await waitFor(() => expectPresent('des-side-snapshot', 'no DES control?'));
    expectPresent('Undo', 'SceneStore missing?');
    expectPresent('path-network-tool', 'path visualizer / layer not active?');

    const secs = visibleSections();
    expect(secs.map((s) => s.dataset.rvToolGroup), labels().join(' | ')).toEqual(['editing', 'model', 'analysis', 'view']);
    expect(secs.map(hasTopLine)).toEqual([false, true, true, true]);
    expect(toolIds(), labels().join(' | ')).toEqual([...TOOLS_IN_DES].sort());
    // The snapshot actions are inside the menu, not two toolbar buttons.
    expect(document.querySelectorAll('[data-testid="des-side-snapshot"]').length).toBe(1);
    expect(document.querySelector('[data-testid="des-side-snapshot-save"]')).toBeNull();
    // Signal linking is not part of the DES toolbar.
    expect(document.querySelector('[data-testid="signal-link-mode-toggle"]')).toBeNull();
  });

  it('DES without a DES control: only Vanish MUs is left in Analysis, still 3 dividers, none at the edges', async () => {
    desControl = null;
    await enter('des');
    renderPanel();

    await waitFor(() => expectPresent('Undo', 'SceneStore missing?'));
    const secs = visibleSections();
    const analysis = secs.find((s) => s.dataset.rvToolGroup === 'analysis');
    expect(analysis, labels().join(' | ')).toBeDefined();
    expect(triggersIn(analysis!).length).toBe(1);
    expect(secs.map((s) => s.dataset.rvToolGroup)).toEqual(['editing', 'model', 'analysis', 'view']);
    expect(secs.map(hasTopLine)).toEqual([false, true, true, true]);
  });
});
