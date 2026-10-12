// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * web-operator-panel.test.tsx — plan-543 F1–F3: the operator panel as data.
 *
 *  - F1 the `WebOperatorPanel` component: `Config` parses (string, tolerated
 *    object) and validates; invalid JSON / an unknown signal give messages with
 *    their JSON path (`buttons[0].signal 'BT9' not found in model`);
 *  - F2 the generic host: one window per component (two panels → two windows),
 *    a field edit re-renders without reload, a removed component and a model
 *    clear take their window away, an unusable config is shown in the window
 *    AND listed in the Problems panel; the JSON survives a GLB round-trip;
 *  - F3 the inspector field: invalid JSON is never applied (message shown),
 *    valid JSON is written through the edit target and validated.
 *
 * The MCP authoring flow (add → set Config → save → reload) is
 * `web-operator-panel-authoring.test.ts` (it uses the private editor commands).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import { Object3D, Scene } from 'three';
import { rvDarkTheme } from '../src/core/hmi/theme';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { getCapabilities } from '../src/core/engine/rv-component-registry';
import { listComponentTypes } from '../src/core/engine/rv-component-schema-info';
import {
  RVWebOperatorPanel, WEB_OPERATOR_PANEL_PROBLEM, WEB_OPERATOR_PANEL_TYPE, WebOperatorPanelHost,
  subscribeWebOperatorPanelChanges,
} from '../src/core/engine/rv-web-operator-panel';
import { parseWebOperatorPanelConfig, webOperatorPanelRuleWarnings } from '../src/core/engine/rv-extras-validator';
import { clearAllProblems, getProblems } from '../src/core/hmi/problems-store';
import {
  WEB_OPERATOR_PANEL_UI, WebOperatorPanelConfigField, WebOperatorPanelWindows, dockPosition,
} from '../src/core/hmi/operator-devices/WebOperatorPanelHost';
import { fieldRendererRegistry } from '../src/core/hmi/rv-field-renderer-registry';
import { setActiveEditTarget, type EditTarget } from '../src/core/hmi/rv-edit-target';
import { exportAssetGlb } from '../src/core/editor/rv-asset-glb-export';
import { gltfLoader } from '../src/core/engine/rv-glb-parse';

// plan-555: the F3 field tests below exercise the plain text field — the
// touch path (`useTouchDevice() === true`); the Monaco editor path is
// tests/rv-json-editor-field.test.tsx.
const device = vi.hoisted(() => ({ touch: true }));

vi.mock('../src/hooks/use-mobile-layout', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/hooks/use-mobile-layout')>(),
  useMobileLayout: () => false,
  useTouchDevice: () => device.touch,
}));

// ── Fixtures ─────────────────────────────────────────────────────────────

/** A small, complete panel: two buttons, a knob, an E-stop, a two-lamp tower. */
const CELL = {
  version: 1,
  id: 'cell-panel',
  title: 'Cell',
  buttons: [
    { label: 'Start', signal: 'S_Start', capColor: 'green', lamp: { signal: 'L_Run', color: 'green' }, row: 1, col: 1 },
    { label: 'Stop', signal: 'S_Stop', capColor: 'black', row: 1, col: 2 },
  ],
  selectors: [
    { label: 'Mode', variant: 'knob', signal: 'S_Auto', positions: [{ legend: 'Hand', value: false }, { legend: 'Auto', value: true }], row: 2, col: 1 },
  ],
  estops: [{ label: 'E-stop', signal: 'S_EStop', row: 2, col: 2 }],
  stackLight: [
    { name: 'Red', signal: 'L_Fault', color: 'red' },
    { name: 'Green', signal: 'L_Run', color: 'green' },
  ],
  status: [
    { kind: 'fault', tone: 'fault', text: 'FAULT', when: { signal: 'S_EStop', is: false } },
    { kind: 'running', tone: 'ok', text: 'RUNNING', when: { signal: 'L_Run', is: true } },
    { kind: 'idle', tone: 'neutral', text: 'READY' },
  ],
};
const SIGNALS = ['S_Start', 'S_Stop', 'S_Auto', 'S_EStop', 'L_Run', 'L_Fault'];
const STATION = { ...CELL, id: 'station-panel', title: 'Station', buttons: [CELL.buttons[1]], selectors: [], estops: [] };

interface World {
  root: Object3D;
  registry: NodeRegistry;
  store: SignalStore;
  host: WebOperatorPanelHost;
  viewer: { webOperatorPanels: WebOperatorPanelHost; signalStore: SignalStore; getPlugin: () => undefined };
  add(name: string, fields: Partial<Pick<RVWebOperatorPanel, 'Title' | 'Config' | 'Dock' | 'StartCollapsed'>>): RVWebOperatorPanel;
  remove(c: RVWebOperatorPanel): void;
}

function world(): World {
  const root = new Object3D();
  root.name = 'Model';
  new Scene().add(root);
  const registry = new NodeRegistry();
  registry.registerNode('Model', root);
  const store = new SignalStore();
  for (const name of SIGNALS) store.register(name, `Model/PLC/${name}`, name === 'S_EStop');
  const host = new WebOperatorPanelHost({ registry, signalStore: store, connectionMode: null });
  return {
    root, registry, store, host,
    viewer: { webOperatorPanels: host, signalStore: store, getPlugin: () => undefined },
    add(name, fields) {
      const node = new Object3D();
      node.name = name;
      node.userData.realvirtual = { WebOperatorPanel: { ...fields } };
      root.add(node);
      const path = NodeRegistry.computeNodePath(node);
      registry.registerNode(path, node);
      const c = new RVWebOperatorPanel(node);
      Object.assign(c, fields);
      registry.register(WEB_OPERATOR_PANEL_TYPE, path, c);
      c.init();
      return c;
    },
    remove(c) {
      c.dispose();
      registry.unregisterComponent(WEB_OPERATOR_PANEL_TYPE, NodeRegistry.computeNodePath(c.node));
    },
  };
}

/** Lets the host's coalesced rescan (one microtask) run. */
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

function showWindows(w: World) {
  return render(
    <ThemeProvider theme={rvDarkTheme}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <WebOperatorPanelWindows viewer={w.viewer as any} />
    </ThemeProvider>,
  );
}

const worlds: World[] = [];
function make(): World { const w = world(); worlds.push(w); return w; }

let capture: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  localStorage.clear();
  clearAllProblems();
  capture = vi.spyOn(Element.prototype, 'setPointerCapture').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  for (const w of worlds.splice(0)) w.host.dispose();
  setActiveEditTarget(null);
  capture.mockRestore();
  clearAllProblems();
  localStorage.clear();
});

// ── F1: component + validation ───────────────────────────────────────────

describe('plan-543 F1 — WebOperatorPanel component and its Config rule', () => {
  it('is a registered, authorable web component with the four schema fields', () => {
    expect(getCapabilities(WEB_OPERATOR_PANEL_TYPE).authorable).toBe(true);
    const info = listComponentTypes().find((t) => t.type === WEB_OPERATOR_PANEL_TYPE);
    expect(info).toBeTruthy();
    expect(Object.keys(RVWebOperatorPanel.schema).sort()).toEqual(['Config', 'Dock', 'StartCollapsed', 'Title']);
  });

  it('Config parses as a JSON string, tolerates an object, and says why it cannot', () => {
    expect(parseWebOperatorPanelConfig(JSON.stringify(CELL))).toEqual({ raw: CELL, errors: [] });
    expect(parseWebOperatorPanelConfig(CELL)).toEqual({ raw: CELL, errors: [] });
    expect(parseWebOperatorPanelConfig('').errors[0]).toMatch(/^Config is empty/);
    expect(parseWebOperatorPanelConfig('{ "version": 1, }').errors[0]).toMatch(/^Config is not valid JSON: /);
  });

  it('the rule reports structure and unknown signals with their JSON path', () => {
    const has = (n: string) => SIGNALS.includes(n);
    expect(webOperatorPanelRuleWarnings(JSON.stringify(CELL), has)).toEqual([]);
    const bad = { ...CELL, buttons: [{ ...CELL.buttons[0], signal: 'BT9' }, { ...CELL.buttons[1], capColor: 'pink' }] };
    expect(webOperatorPanelRuleWarnings(JSON.stringify(bad), has)[0]).toMatch(/^buttons\[1\]\.capColor must be one of/);
    const unknown = { ...CELL, buttons: [{ ...CELL.buttons[0], signal: 'BT9' }], status: [{ kind: 'x', tone: 'ok', text: 'X', when: { not: { signal: 'Q9', is: true } } }] };
    expect(webOperatorPanelRuleWarnings(JSON.stringify(unknown), has)).toEqual([
      "buttons[0].signal 'BT9' not found in model",
      "status[0].when.not.signal 'Q9' not found in model",
    ]);
  });

  it('announces init, field edits and disposal on the change channel', () => {
    const seen: string[] = [];
    const off = subscribeWebOperatorPanelChanges(() => seen.push('change'));
    const c = new RVWebOperatorPanel(new Object3D());
    c.init();
    c.reapplyConfig();
    c.dispose();
    off();
    expect(seen).toHaveLength(3);
    expect(c.disposed).toBe(true);
  });
});

// ── F2: generic host ─────────────────────────────────────────────────────

describe('plan-543 F2 — the generic host renders one window per component', () => {
  it('two panels → two windows; the station signals are live and written as an operator', async () => {
    const w = make();
    w.add('PanelA', { Config: JSON.stringify(CELL) });
    w.add('PanelB', { Title: 'Station B', Config: JSON.stringify(STATION), Dock: 'top-right', StartCollapsed: true });
    w.host.reset();
    showWindows(w);
    expect(w.host.entries.map((e) => [e.panelId, e.title, e.dock, e.dockIndex, e.startCollapsed])).toEqual([
      ['cell-panel', 'Cell', 'top-left', 0, false],
      ['station-panel', 'Station B', 'top-right', 0, true],
    ]);
    expect(screen.getByRole('region', { name: 'Cell' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Station B' })).toBeTruthy();
    // StartCollapsed: the second window shows only its title bar.
    expect(screen.getAllByRole('status', { name: 'Station state' })).toHaveLength(1);
    expect(screen.getByRole('status', { name: 'Station state' }).textContent).toBe('READY');
    const start = screen.getByRole('button', { name: /^Start(,|$)/ });
    fireEvent.pointerDown(start);
    expect(w.store.get('S_Start')).toBe(true);
    fireEvent.pointerUp(start);
    expect(w.store.get('S_Start')).toBe(false);
    act(() => { w.store.set('L_Run', true); });
    expect(screen.getByRole('status', { name: 'Station state' }).textContent).toBe('RUNNING');
  });

  it('a field edit re-renders the window without a reload; the window keeps its place', async () => {
    const w = make();
    const c = w.add('Panel', { Config: JSON.stringify(CELL) });
    w.host.reset();
    showWindows(w);
    const before = w.host.entries[0];
    c.Config = JSON.stringify({ ...CELL, title: 'Cell (edited)', buttons: [...CELL.buttons, { label: 'Reset', signal: 'S_Stop', capColor: 'blue', row: 1, col: 3 }] });
    c.reapplyConfig();
    await settle();
    expect(w.host.entries[0]).not.toBe(before);
    expect(w.host.entries[0].panelId).toBe('cell-panel');
    expect(screen.getByRole('region', { name: 'Cell (edited)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Reset(,|$)/ })).toBeTruthy();
    // The old controller is disconnected: no stale writes.
    before.controller.write('S_Start', true);
    expect(w.store.get('S_Start')).toBe(false);
    // An unchanged rescan keeps the very same entry (no rebuild, no flicker).
    const same = w.host.entries;
    w.host.rescan();
    expect(w.host.entries).toBe(same);
  });

  it('an unusable config shows its messages in the window and in the Problems panel', async () => {
    const w = make();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    w.add('Broken', { Config: '{ not json' });
    w.add('Unknown', { Config: JSON.stringify({ ...CELL, id: 'unknown-panel', title: 'Unknown', buttons: [{ ...CELL.buttons[0], signal: 'BT9' }] }) });
    w.host.reset();
    showWindows(w);
    const alerts = screen.getAllByRole('alert', { name: 'Operator panel configuration' }).map((a) => a.textContent);
    expect(alerts.some((t) => /Config is not valid JSON/.test(t ?? ''))).toBe(true);
    expect(alerts.some((t) => /buttons\[0\]\.signal 'BT9' not found in model/.test(t ?? ''))).toBe(true);
    expect((screen.getByRole('button', { name: /^Start/ }) as HTMLButtonElement).disabled).toBe(true);
    const problems = getProblems().filter((p) => p.code === WEB_OPERATOR_PANEL_PROBLEM);
    expect(problems.map((p) => p.nodePath).sort()).toEqual(['Model/Broken', 'Model/Unknown']);
    expect(problems.find((p) => p.nodePath === 'Model/Unknown')!.detail).toMatch(/buttons\[0\]\.signal 'BT9' not found in model/);
    warn.mockRestore();
  });

  it('a removed component and a model clear take the windows away', async () => {
    const w = make();
    const a = w.add('PanelA', { Config: JSON.stringify(CELL) });
    w.add('PanelB', { Config: JSON.stringify(STATION) });
    w.host.reset();
    showWindows(w);
    expect(screen.getAllByRole('region')).toHaveLength(2);
    const controllerA = w.host.entries[0].controller;
    w.remove(a);
    await settle();
    expect(screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'))).toEqual(['Station']);
    expect(controllerA.started).toBe(false);
    act(() => { w.host.clear(); });
    expect(screen.queryAllByRole('region')).toHaveLength(0);
    expect(w.host.entries).toEqual([]);
  });

  it('duplicate config ids get distinct window ids; docks stack', () => {
    const w = make();
    w.add('A', { Config: JSON.stringify(CELL) });
    w.add('B', { Config: JSON.stringify(CELL) });
    w.host.reset();
    expect(w.host.entries.map((e) => [e.panelId, e.dockIndex])).toEqual([['cell-panel', 0], ['cell-panel#2', 1]]);
    const vp = { w: 1600, h: 1000 };
    expect(dockPosition(w.host.entries[0], vp)).toEqual({ x: 80, y: 100 });
    expect(dockPosition(w.host.entries[1], vp)).toEqual({ x: 104, y: 148 });
    expect(dockPosition({ ...w.host.entries[0], dock: 'bottom-right' }, vp)).toEqual({ x: 1600 - 300 - 80, y: 1000 - 420 });
    // A config position wins over the dock.
    const placed = new WebOperatorPanelHost({ registry: null, signalStore: null });
    expect(dockPosition({ dock: 'top-right', dockIndex: 0, controller: { config: { position: { x: 5, y: 6 } } } as never }, vp)).toEqual({ x: 5, y: 6 });
    placed.dispose();
  });

  it('the overlay slot is one entry without a visibility rule (stays in every mode)', () => {
    expect(WEB_OPERATOR_PANEL_UI.slots).toHaveLength(1);
    expect(WEB_OPERATOR_PANEL_UI.slots[0].slot).toBe('overlay');
    expect(WEB_OPERATOR_PANEL_UI.slots[0].visibilityRule).toBeUndefined();
  });

  it('the Config JSON survives a GLB save and reload unchanged', async () => {
    const scene = new Scene();
    const root = new Object3D();
    root.name = 'Doc';
    const node = new Object3D();
    node.name = 'OperatorPanel';
    const config = JSON.stringify(CELL, null, 2);
    node.userData.realvirtual = { WebOperatorPanel: { Title: 'Panel', Config: config, Dock: 'bottom-left', StartCollapsed: true } };
    root.add(node);
    scene.add(root);
    const bytes = await exportAssetGlb(root, 'PanelDoc');
    const reloaded = (await gltfLoader.parseAsync(bytes.slice(0), '')).scene;
    let found: Record<string, unknown> | null = null;
    reloaded.traverse((n) => {
      const rv = n.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined;
      if (rv?.WebOperatorPanel) found = rv.WebOperatorPanel;
    });
    expect(found).toEqual({ Title: 'Panel', Config: config, Dock: 'bottom-left', StartCollapsed: true });
  });
});

// ── F3: inspector JSON field ─────────────────────────────────────────────

describe('plan-543 F3 — the Config JSON field in the inspector', () => {
  function field(value: unknown, store: SignalStore | null) {
    const recorded: unknown[] = [];
    const target: EditTarget = {
      available: true,
      setField: (_p: string, _c: string, _f: string, v: unknown) => { recorded.push(v); },
      unsetField: () => {},
      withTransaction: (_l: string, fn: () => unknown) => fn(),
    } as unknown as EditTarget;
    setActiveEditTarget(target);
    render(
      <ThemeProvider theme={rvDarkTheme}>
        <WebOperatorPanelConfigField
          value={value}
          fieldName="Config"
          componentType={WEB_OPERATOR_PANEL_TYPE}
          nodePath="Model/Panel"
          viewer={null}
          signalStore={store}
        />
      </ThemeProvider>,
    );
    return { recorded, input: screen.getByTestId('rv-web-operator-panel-config-input') as HTMLTextAreaElement };
  }

  it('is the registered renderer of WebOperatorPanel.Config, monospace and multi-line', () => {
    expect(fieldRendererRegistry.getRenderer(WEB_OPERATOR_PANEL_TYPE, 'Config')).toBe(WebOperatorPanelConfigField);
    const { input } = field(JSON.stringify(CELL), null);
    expect(input.tagName).toBe('TEXTAREA');
    expect(getComputedStyle(input).fontFamily).toMatch(/monospace/);
  });

  it('invalid JSON is never applied; the parse error is shown', () => {
    const { recorded, input } = field(JSON.stringify(CELL), null);
    fireEvent.change(input, { target: { value: '{ "version": 1, ' } });
    fireEvent.blur(input);
    expect(recorded).toEqual([]);
    const alert = screen.getByRole('alert', { name: 'Operator panel configuration' });
    expect(alert.textContent).toMatch(/Config is not valid JSON/);
    expect(alert.textContent).toMatch(/Not applied/);
  });

  it('valid JSON is written through the edit target and validated against the model signals', () => {
    const store = new SignalStore();
    for (const name of SIGNALS) store.register(name, `Model/PLC/${name}`, false);
    const { recorded, input } = field('', store);
    const next = JSON.stringify({ ...CELL, buttons: [{ ...CELL.buttons[0], signal: 'BT9' }] });
    fireEvent.change(input, { target: { value: next } });
    fireEvent.blur(input);
    expect(recorded).toEqual([next]);
    expect(screen.getByRole('alert', { name: 'Operator panel configuration' }).textContent)
      .toMatch(/buttons\[0\]\.signal 'BT9' not found in model/);
  });
});
