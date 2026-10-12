// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-514 §9.1–9.3 — layout guardrails for the inspector's component actions,
 * measured in real Chromium with the viewer's theme and font:
 *
 *  - §9.1 the Drive section's segment group (Jog − | Stop | Jog +) at a 320 px
 *    panel: exactly 3 buttons, all on one line, nothing overflows the panel,
 *    the action row or the group — also with one segment DISABLED (the
 *    command's reason wraps the button in a `<span>`);
 *  - §9.2 the same for the FMU lifecycle row (Stop | Re-provision) of a
 *    running FMU (fake CONNECT, a real lease);
 *  - §9.3 component management (`placement: 'menu'` / `danger`) is only in
 *    the ⋮ menu, never a button in the section body. Removing a single FIELD
 *    entry (ReorderableList, RibbonPath.Rollers) is not component management
 *    and stays covered by ribbon-rollers-renderer.test.tsx.
 *
 * Measurement rule (plan-514 §9): render like the viewer — `rvDarkTheme` +
 * `CssBaseline` + the Inter weights App.tsx imports — then
 * `await document.fonts.ready`, inside `<div data-testid="panel" style="width:320px">`.
 */

import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.setConfig({ hookTimeout: 60_000, testTimeout: 30_000 });
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from 'vitest/browser';
import { CssBaseline } from '@mui/material';
import { ThemeProvider } from '@mui/material/styles';
import { Group, Object3D, Scene } from 'three';
import type { ReactNode } from 'react';
import type { RVViewer } from '../../src/core/rv-viewer';
import { rvDarkTheme } from '../../src/core/hmi/theme';
import { ComponentSection } from '../../src/core/hmi/rv-component-section';
import { commandRegistry } from '../../src/core/hmi/rv-command-registry';
import { componentActionRegistry } from '../../src/core/hmi/rv-component-action-registry';
import { _resetButtonSimStateForTest } from '../../src/core/hmi/button-sim-state';
import { ensureSimCommandsRegistered, registerRuntimeInspectorActions } from '../../src/plugins/sim-controller/sim-commands';
import '../../src/core/hmi/FmuAttachAction';
import { FMU_REPROVISION_LABEL, FMU_STOP_LABEL, runAttachFmu } from '../../src/core/hmi/FmuAttachAction';
import { FmuProvisioningPlugin } from '../../src/plugins/fmu-provisioning-plugin';
import type { ConnectFmuApi } from '../../src/core/hmi/connect-fmu';
import { NodeRegistry } from '../../src/core/engine/rv-node-registry';
import { SignalStore } from '../../src/core/engine/rv-signal-store';
import { binaryResources } from '../../src/core/engine/rv-binary-resources';
import { fmuOf, getFmuInstances } from '../../src/core/engine/rv-fmu';
import { setActiveAssetContext } from '../../src/core/editor/active-asset-store';
import { resetProblemsForTests } from '../../src/core/hmi/problems-store';
import { scratchAssetDocument } from '../helpers/scratch-asset-document';
import feedthroughUrl from '../fixtures/Feedthrough.fmu?url';

// ─── Measurement rule ───────────────────────────────────────────────────

function mountInPanel(ui: ReactNode) {
  return render(
    <ThemeProvider theme={rvDarkTheme}>
      <CssBaseline />
      <div data-testid="panel" style={{ width: 320 }}>{ui}</div>
    </ThemeProvider>,
  );
}

/** No horizontal overflow: the content fits its own box. */
function expectNoOverflow(el: HTMLElement, what: string): void {
  expect(el.scrollWidth, `${what} overflows (scrollWidth ${el.scrollWidth} > clientWidth ${el.clientWidth})`)
    .toBeLessThanOrEqual(el.clientWidth);
}

/**
 * plan-514 §9 measurement: the expected buttons exist (exact count, real size),
 * sit on ONE line, lie inside the panel, and panel / action row / group do not overflow.
 */
async function expectOneLine(group: HTMLElement, row: HTMLElement, count: number): Promise<void> {
  await document.fonts.ready;
  const panel = screen.getByTestId('panel');
  const buttons = [...group.querySelectorAll('button')] as HTMLButtonElement[];
  expect(buttons).toHaveLength(count);
  const pr = panel.getBoundingClientRect();
  const rects = buttons.map((b) => b.getBoundingClientRect());
  for (const r of rects) {
    expect(r.width).toBeGreaterThan(0);
    expect(r.height).toBeGreaterThan(0);
    expect(r.left).toBeGreaterThanOrEqual(pr.left - 0.5);
    expect(r.right).toBeLessThanOrEqual(pr.right + 0.5);
  }
  const top = rects[0].top;
  for (const r of rects) expect(Math.abs(r.top - top), 'a button wrapped to a second line').toBeLessThanOrEqual(0.5);
  expectNoOverflow(panel, 'panel');
  expectNoOverflow(row, 'action row');
  expectNoOverflow(group, 'group');
}

// ─── Drive (§9.1, §9.3) ─────────────────────────────────────────────────

function makeDriveViewer() {
  const node = new Object3D();
  node.name = 'Conveyor';
  const drive = { name: 'Conveyor', node, jogForward: false, jogBackward: false, stop: vi.fn() };
  const viewer = {
    drives: [drive],
    signalStore: null,
    simTime: 0,
    isSimulationPaused: false,
    simulationPauseReasons: [],
    registry: { getNode: (p: string) => (p === 'Cell/Conveyor' ? node : null), getPathForNode: () => 'Cell/Conveyor' },
    on: () => () => {},
    emit: () => {},
    markRenderDirty() {},
    getPlugin: () => undefined,
  } as unknown as RVViewer;
  return viewer;
}

function driveSection(viewer: RVViewer) {
  return mountInPanel(
    <ComponentSection
      nodePath="Cell/Conveyor" componentType="Drive" data={{ TargetSpeed: 100, Direction: 'LinearY' }}
      overriddenFields={new Set()} consumedOnly={false}
      onFieldEdit={() => {}} onFieldReset={() => {}} onResetComponent={() => {}}
      viewer={viewer} signalStore={null}
    />,
  );
}

describe('Drive segment group at 320 px (plan-514 §9.1)', () => {
  beforeEach(() => {
    ensureSimCommandsRegistered();
    registerRuntimeInspectorActions();
    _resetButtonSimStateForTest();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    _resetButtonSimStateForTest();
  });

  it('all segments enabled: Jog − | Stop | Jog + on one line, no overflow', async () => {
    driveSection(makeDriveViewer());
    const group = await screen.findByTestId('rv-action-group-jog');
    await waitFor(() => expect(group.querySelectorAll('button')).toHaveLength(3));
    expect([...group.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Jog −', 'Stop', 'Jog +']);
    await expectOneLine(group, screen.getByTestId('rv-component-actions'), 3);
  });

  it('one segment disabled (reason → <span> wrapper): still one line, no overflow', async () => {
    const original = commandRegistry.enabled.bind(commandRegistry);
    vi.spyOn(commandRegistry, 'enabled').mockImplementation(((id: string, ...rest: unknown[]) =>
      (id === 'drive.stop' ? { reason: 'Drive is driven by an FMU' } : (original as (...a: unknown[]) => unknown)(id, ...rest))) as typeof commandRegistry.enabled);
    driveSection(makeDriveViewer());
    const group = await screen.findByTestId('rv-action-group-jog');
    await waitFor(() => {
      const stop = [...group.querySelectorAll('button')].find((b) => b.textContent === 'Stop') as HTMLButtonElement;
      expect(stop.disabled).toBe(true);
      expect(stop.parentElement?.tagName).toBe('SPAN');
    });
    await expectOneLine(group, screen.getByTestId('rv-component-actions'), 3);
  });
});

describe('component management only in the ⋮ menu (plan-514 §9.3)', () => {
  const MENU_ACTION = { id: 'p514-remove-drive', label: 'Remove component', placement: 'menu', danger: true } as const;

  beforeEach(() => {
    ensureSimCommandsRegistered();
    registerRuntimeInspectorActions();
    if (!componentActionRegistry.get('Drive').some((a) => a.id === MENU_ACTION.id)) {
      componentActionRegistry.register('Drive', [{ ...MENU_ACTION, visible: () => true, onClick: () => {} }]);
    }
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('the danger action is in the menu, and no menu / danger action is a body button', async () => {
    driveSection(makeDriveViewer());
    await screen.findByTestId('rv-action-group-jog');

    // (a) positive: ⋮ opens and shows the danger item.
    await userEvent.click(screen.getByTestId('rv-component-menu'));
    const item = await screen.findByTestId(`rv-component-menu-item-${MENU_ACTION.id}`);
    expect(item.textContent).toContain(MENU_ACTION.label);

    // (b) close it.
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());

    // (c) no button of a registered menu / danger action anywhere in the section body.
    const menuLabels = componentActionRegistry.get('Drive')
      .filter((a) => a.placement === 'menu' || a.danger)
      .map((a) => (typeof a.label === 'string' ? a.label : a.id));
    expect(menuLabels).toContain(MENU_ACTION.label);
    const bodyButtons = [...screen.getByTestId('panel').querySelectorAll('button')]
      .filter((b) => b.getAttribute('data-testid') !== 'rv-component-menu');
    expect(bodyButtons.length).toBeGreaterThan(0);
    for (const b of bodyButtons) expect(menuLabels, `body button "${b.textContent}"`).not.toContain(b.textContent?.trim());
    // Danger / menu actions are never registered into the body filter either.
    for (const a of componentActionRegistry.get('Drive')) {
      if (a.danger) expect(a.placement, `${a.id}: a danger action must live in the menu`).toBe('menu');
    }
  });
});

// ─── FMU lifecycle (§9.2) ───────────────────────────────────────────────

describe('FMU lifecycle row at 320 px (plan-514 §9.2)', () => {
  let doc: ReturnType<typeof scratchAssetDocument>;
  let plugin: FmuProvisioningPlugin | null = null;

  function fmuWorld() {
    const scene = new Scene();
    const model = new Group();
    model.name = 'Asset';
    scene.add(model);
    const hyd = new Object3D();
    hyd.name = 'Hydraulics';
    model.add(hyd);
    const registry = new NodeRegistry();
    model.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
    const store = new SignalStore();
    const viewer = {
      scene, registry, signalStore: store, transportManager: {},
      get currentModelRoot() { return model; },
      markRenderDirty() {}, markShadowsDirty() {}, emit() {}, on() { return () => {}; }, rebuildGroupedBvh() {},
    } as unknown as RVViewer;
    return { viewer, hyd, store };
  }

  const calls: string[] = [];
  const fakeApi: ConnectFmuApi = {
    getPackage: async (sha) => ({ sha256: sha, trusted: true, refCount: 0, meta: { modelName: 'Feedthrough', guid: '', fmiVersion: '2.0', byteLength: 1 }, variables: [] }),
    uploadPackage: async () => { throw new Error('unused'); },
    trust: async () => { calls.push('trust'); },
    revokeTrust: async () => {},
    createInstance: async () => { calls.push('instance'); return { interfaceId: 'fmu-1', leaseId: 'L1', created: true }; },
    renewLease: async (id) => ({ leaseId: id, interfaceId: 'fmu-1' }),
    releaseLease: async (id) => { calls.push(`release ${id}`); },
    fetchWorkerStatuses: async () => ({ 'fmu-1': { status: 'Connected' } }),
  };

  beforeEach(() => {
    binaryResources._resetForTesting();
    resetProblemsForTests();
    for (const i of [...getFmuInstances()]) i.dispose();
    calls.length = 0;
  });

  afterEach(() => {
    cleanup();
    plugin?.dispose();
    plugin = null;
    setActiveAssetContext(null);
    doc?.dispose();
    for (const i of [...getFmuInstances()]) i.dispose();
  });

  it('a running FMU (lease): Stop | Re-provision on one line, no overflow', async () => {
    const w = fmuWorld();
    doc = scratchAssetDocument(w.viewer);
    setActiveAssetContext({ viewer: w.viewer, doc });
    const path = NodeRegistry.computeNodePath(w.hyd);
    const bytes = await (await fetch(feedthroughUrl)).arrayBuffer();
    expect(await runAttachFmu(path, new File([bytes], 'Feedthrough.fmu'))).toBe(true);
    const fmu = fmuOf(w.hyd)!;

    plugin = new FmuProvisioningPlugin({
      api: fakeApi, gatewayUrl: () => 'http://127.0.0.1:5100', subscribeGateway: () => () => {},
      confirmTrust: async () => true, renewIntervalMs: 3_600_000, statusIntervalMs: 3_600_000,
    });
    plugin.init({
      ...w.viewer,
      on: () => () => {},
      getPlugin: (id: string) => (id === 'connect'
        ? { id, streamEndpoint: new URL('ws://127.0.0.1:5100/ws'), streamConnectionState: 'connected' }
        : undefined),
    } as unknown as RVViewer);
    await waitFor(() => expect(fmu.state).toBe('running'));
    expect(calls).toContain('instance');

    const data = (w.hyd.userData.realvirtual as Record<string, Record<string, unknown>>).Fmu;
    await act(async () => {
      mountInPanel(
        <ComponentSection
          nodePath={path} componentType="Fmu" data={data}
          overriddenFields={new Set()} consumedOnly={false}
          onFieldEdit={() => {}} onFieldReset={() => {}} onResetComponent={() => {}}
          viewer={w.viewer} signalStore={w.store}
        />,
      );
    });
    const row = await screen.findByTestId('fmu-lifecycle');
    // Positive first: the two lifecycle buttons exist.
    expect(screen.getByRole('button', { name: FMU_STOP_LABEL })).toBeTruthy();
    expect(screen.getByRole('button', { name: FMU_REPROVISION_LABEL })).toBeTruthy();
    const group = row.querySelector('.rv-inspector-action-row-buttons') as HTMLElement;
    await expectOneLine(group, row, 2);
  });
});
