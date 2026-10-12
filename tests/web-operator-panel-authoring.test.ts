// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * web-operator-panel-authoring.test.ts — plan-543 F4: an operator panel built
 * the way an AI builds it, through the commands behind the MCP tools.
 *
 *   web_editor_create_empty   → editor.createEmpty
 *   web_editor_add_component  → editor.addComponent (type WebOperatorPanel)
 *   web_editor_set_field      → editor.setField (Config, valueJson = the JSON as a JSON string)
 *   web_editor_save           → the GLB the document save writes (exportAssetGlb)
 *
 * The window follows every step live (the host over the editor's registry),
 * and after save + reload into a real viewer the panel is there, usable.
 *
 * PRIVATE-DEPENDENT (the editor command implementations live in the private
 * asset editor): listed in `tests/private-dependent-tests.json`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { makeAuthoringRig, rvOf, type AuthoringRig } from './helpers/collider-authoring-rig';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';
import { WebOperatorPanelHost, WEB_OPERATOR_PANEL_TYPE } from '../src/core/engine/rv-web-operator-panel';
import { exportAssetGlb } from '../src/core/editor/rv-asset-glb-export';
import type { CommandContext } from '../src/core/hmi/rv-command-registry';
import { impls } from '@rv-private/plugins/asset-editor/editor-commands';

interface Impl<A> {
  enabled(ctx: CommandContext, args: A): unknown;
  run(ctx: CommandContext, args: A): Promise<Record<string, unknown>>;
}
const command = <A>(id: string) => impls[id as keyof typeof impls] as unknown as Impl<A>;

/** The second, tiny panel an AI would write: one lit start button, a stop button, an E-stop. */
const MINI = {
  version: 1,
  id: 'mini-panel',
  title: 'Mini cell',
  buttons: [
    { label: 'Start', signal: 'Mini_Start', capColor: 'green', lamp: { signal: 'Mini_Running', color: 'green' }, row: 1, col: 1 },
    { label: 'Stop', signal: 'Mini_Stop', capColor: 'black', row: 1, col: 2 },
  ],
  selectors: [],
  estops: [{ label: 'E-stop', signal: 'Mini_EStop', row: 1, col: 3 }],
  stackLight: [{ name: 'Green', signal: 'Mini_Running', color: 'green' }],
  status: [
    { kind: 'estop', tone: 'fault', text: 'E-STOP', when: { signal: 'Mini_EStop', is: false } },
    { kind: 'running', tone: 'ok', text: 'RUNNING', when: { signal: 'Mini_Running', is: true } },
    { kind: 'idle', tone: 'neutral', text: 'READY' },
  ],
};
const SIGNALS: [string, string][] = [
  ['Mini_Start', 'PLCInputBool'], ['Mini_Stop', 'PLCInputBool'], ['Mini_EStop', 'PLCInputBool'], ['Mini_Running', 'PLCOutputBool'],
];

const cleanups: (() => void)[] = [];
afterEach(() => { for (const fn of cleanups.splice(0).reverse()) fn(); });

const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

function rig(): AuthoringRig {
  const r = makeAuthoringRig();
  cleanups.push(() => r.dispose());
  // The model's PLC signals (as an imported station would carry them).
  const plc = r.addNode('PLC');
  for (const [name, type] of SIGNALS) {
    r.addNode(name, { parent: plc, extras: { [type]: { Name: name, Status: { Value: name === 'Mini_EStop' }, Active: 'Always' } } });
    r.viewer.signalStore!.register(name, `Asset/PLC/${name}`, name === 'Mini_EStop');
  }
  return r;
}

describe('plan-543 F4 — an operator panel through the MCP command path, saved and reloaded', () => {
  it('create node → add WebOperatorPanel → set Config → save → reload: the panel is there', async () => {
    const r = rig();
    const ctx = { doc: r.doc, viewer: r.viewer, selection: [] } as unknown as CommandContext;
    const host = new WebOperatorPanelHost({ registry: r.registry, signalStore: r.viewer.signalStore, connectionMode: null });
    cleanups.push(() => host.dispose());

    // web_editor_create_empty(name="OperatorPanel")
    const created = await command<{ name: string }>('editor.createEmpty').run(ctx, { name: 'OperatorPanel' });
    const path = created.path as string;
    expect(path).toBe('Asset/OperatorPanel');

    // web_editor_add_component(path, type="WebOperatorPanel") — listed as authorable, so allowed.
    const add = command<{ path: string; type: string }>('editor.addComponent');
    expect(add.enabled(ctx, { path, type: WEB_OPERATOR_PANEL_TYPE })).toBe(true);
    const added = await add.run(ctx, { path, type: WEB_OPERATOR_PANEL_TYPE });
    expect(added.component).toBe(WEB_OPERATOR_PANEL_TYPE);
    await settle();
    // Live: the window exists at once and says what is missing.
    expect(host.entries).toHaveLength(1);
    expect(host.entries[0].errors[0]).toMatch(/^Config is empty/);

    // A first try with an unknown signal: the message names the JSON path.
    const set = command<{ path: string; componentType: string; fieldName: string; valueJson: string }>('editor.setField');
    const wrong = { ...MINI, buttons: [{ ...MINI.buttons[0], signal: 'Mini_Strat' }, MINI.buttons[1]] };
    await set.run(ctx, { path, componentType: WEB_OPERATOR_PANEL_TYPE, fieldName: 'Config', valueJson: JSON.stringify(JSON.stringify(wrong)) });
    await settle();
    expect(host.entries[0].errors).toEqual(["buttons[0].signal 'Mini_Strat' not found in model"]);

    // web_editor_set_field(Config, valueJson = the config as a JSON string) — fixed.
    const configText = JSON.stringify(MINI, null, 2);
    const out = await set.run(ctx, { path, componentType: WEB_OPERATOR_PANEL_TYPE, fieldName: 'Config', valueJson: JSON.stringify(configText) });
    expect(out.value).toBe(configText);
    await set.run(ctx, { path, componentType: WEB_OPERATOR_PANEL_TYPE, fieldName: 'Title', valueJson: '"Mini cell panel"' });
    await settle();
    expect(rvOf(r.registry.getNode(path)).WebOperatorPanel.Config).toBe(configText);
    const live = host.entries[0];
    expect([live.panelId, live.title, live.errors]).toEqual(['mini-panel', 'Mini cell panel', []]);
    expect(live.controller.getSnapshot().ready).toBe(true);

    // web_editor_save — the bytes the document save writes.
    const bytes = await exportAssetGlb(r.root, 'MiniCell');

    // Reload into a real viewer: the panel comes back from the GLB alone.
    const handle: TestViewerHandle = await createTestViewer('webgl');
    cleanups.push(() => handle.dispose());
    const url = URL.createObjectURL(new Blob([bytes], { type: 'model/gltf-binary' }));
    cleanups.push(() => URL.revokeObjectURL(url));
    await handle.viewer.loadModel(url);
    await handle.viewer.whenSceneReady();
    const entries = handle.viewer.webOperatorPanels.entries;
    expect(entries.map((e) => [e.nodePath.split('/').pop(), e.panelId, e.title, e.errors])).toEqual([
      ['OperatorPanel', 'mini-panel', 'Mini cell panel', []],
    ]);
    const panel = entries[0].controller;
    expect(panel.getSnapshot().ready).toBe(true);
    expect([...panel.signalNames].sort()).toEqual(SIGNALS.map(([n]) => n).sort());
    panel.write('Mini_Start', true);
    expect(handle.viewer.signalStore!.get('Mini_Start')).toBe(true);
    panel.write('Mini_Start', false);
    // Clearing the model takes the window away.
    handle.viewer.clearModel();
    expect(handle.viewer.webOperatorPanels.entries).toEqual([]);
  }, 120_000);
});
