// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-499 §9.6 — context-menu items as command views (F7).
 *
 * `ContextMenuItem.command` survives resolution; `ContextMenuLayer` dispatches
 * it through the registry — ONE `execute` with `args(target)`, origin `ui` for
 * the mouse and `shortcut` for the open-menu chord; the item keeps its own
 * label and single-character chord. The editor's "Select ▸" items
 * (select-actions.ts) are views of `select.identical / sameMaterial / invert`,
 * and a right-click on a NOT-selected object seeds from that object
 * (`resolveSeedPaths`), exactly as before. The K picker (plan-499 R2-F1): the
 * real K key only OPENS the picker; picking an existing kinematic or submitting
 * "New kinematic…" dispatches `editor.assignToKinematic`; cancelling dispatches
 * nothing. The Delete / Ctrl+Z / Ctrl+Y keys dispatch with origin `shortcut`.
 * Chromium (renders the layer).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { BoxGeometry, Mesh, MeshBasicMaterial, Object3D } from 'three';
import type { RVViewer } from '../src/core/rv-viewer';
import { ContextMenuStore, type ContextMenuItem, type ContextMenuTarget } from '../src/core/hmi/context-menu-store';
import { ContextMenuLayer } from '../src/core/hmi/ContextMenuLayer';
import { RVViewerProvider } from '../src/hooks/use-viewer';
import { commandRegistry } from '../src/core/hmi/rv-command-registry';
import { buildSelectMenuItems } from '@rv-private/plugins/asset-editor/shared/select-actions';
import { buildKinematicMenuItems } from '@rv-private/plugins/asset-editor/group-actions';
import { setActiveAssetContext, type ActiveAssetContext } from '../src/core/editor/active-asset-store';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const target = (path: string): ContextMenuTarget => ({ path, node: new Object3D(), types: [], extras: {} });

function makeViewer(store: ContextMenuStore, selected: string[] = []): RVViewer {
  return {
    contextMenu: store,
    raycastManager: null,
    highlighter: { clear() {} },
    selectionManager: { getSnapshot: () => ({ selectedPaths: selected }), selectPaths() {} },
  } as unknown as RVViewer;
}

function mount(viewer: RVViewer) {
  return render(createElement(RVViewerProvider, { value: viewer }, createElement(ContextMenuLayer)));
}

const identicalItem: ContextMenuItem = {
  id: 'test.identical', label: 'Identical (2)', shortcut: 'I', order: 0,
  command: { id: 'select.identical', args: (t) => ({ seeds: [t.path] }) },
};

describe('ContextMenuItem.command', () => {
  it('survives resolution, keeps its label and single-character chord, and keeps a command-only submenu alive', () => {
    const store = new ContextMenuStore();
    store.openItems({ x: 0, y: 0 }, target('A'), [
      { id: 'parent', label: 'Select', shortcut: 'S', children: [identicalItem] },
    ]);
    const parent = store.getSnapshot().items[0];
    expect(parent.children?.[0]).toMatchObject({
      id: 'test.identical', resolvedLabel: 'Identical (2)', shortcut: 'I',
      command: { id: 'select.identical' },
    });
  });

  it('mouse click → ONE execute with args(target), origin ui', () => {
    const spy = vi.spyOn(commandRegistry, 'execute').mockResolvedValue({ ok: true, value: {} });
    const store = new ContextMenuStore();
    const viewer = makeViewer(store);
    mount(viewer);
    act(() => { store.openItems({ x: 10, y: 10 }, target('Asset/B'), [identicalItem]); });
    fireEvent.click(screen.getByText('Identical (2)'));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('select.identical', { seeds: ['Asset/B'] }, { origin: 'ui', viewer });
    expect(store.getSnapshot().open).toBe(false);
  });

  it('open-menu chord (I) → ONE execute, origin shortcut', () => {
    const spy = vi.spyOn(commandRegistry, 'execute').mockResolvedValue({ ok: true, value: {} });
    const store = new ContextMenuStore();
    const viewer = makeViewer(store);
    mount(viewer);
    act(() => { store.openItems({ x: 10, y: 10 }, target('Asset/B'), [identicalItem]); });
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'i', bubbles: true })); });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][2]).toMatchObject({ origin: 'shortcut' });
  });

  it('an action item without a command still runs its action and never dispatches', () => {
    const spy = vi.spyOn(commandRegistry, 'execute');
    const action = vi.fn();
    const store = new ContextMenuStore();
    mount(makeViewer(store));
    act(() => { store.openItems({ x: 10, y: 10 }, target('A'), [{ id: 'plain', label: 'Focus', action }]); });
    fireEvent.click(screen.getByText('Focus'));
    expect(action).toHaveBeenCalledTimes(1);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('editor "Select ▸" items are views of select.* commands', () => {
  function universe(): Map<string, Object3D> {
    const geo = new BoxGeometry(1, 1, 1);
    const mat = new MeshBasicMaterial();
    const m = new Map<string, Object3D>();
    for (const p of ['Asset/A', 'Asset/B', 'Asset/C']) m.set(p, new Mesh(geo, mat));
    return m;
  }

  it('each item carries its command; a right-click on an UNSELECTED object seeds from that object', () => {
    const viewer = makeViewer(new ContextMenuStore(), ['Asset/A']);
    const items = buildSelectMenuItems(viewer, { path: 'Asset/B' }, universe);
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));
    expect(byId['editor.select.identical'].command?.id).toBe('select.identical');
    expect(byId['editor.select.material'].command?.id).toBe('select.sameMaterial');
    expect(byId['editor.select.invert'].command?.id).toBe('select.invert');
    expect(byId['editor.select.identical'].shortcut).toBe('I'); // the local chord letter stays
    expect(byId['editor.select.identical'].command?.args(target('Asset/B'))).toEqual({ seeds: ['Asset/B'] });
    expect(byId['editor.select.material'].command?.args(target('Asset/B'))).toEqual({ seeds: ['Asset/B'] });
    // Clicked node is part of the selection → the whole selection seeds.
    expect(byId['editor.select.identical'].command?.args(target('Asset/A'))).toEqual({ seeds: ['Asset/A'] });
    expect(byId['editor.select.invert'].command?.args(target('Asset/B'))).toEqual({ selected: ['Asset/A'] });
    // No item keeps a second click path.
    for (const i of items) expect(i.action, i.id).toBeUndefined();
  });
});

describe('asset editor keys and the K picker dispatch editor commands', () => {
  afterEach(() => setActiveAssetContext(null));

  function editorViewer(selected: string[]) {
    const openItems = vi.fn();
    const root = new Object3D();
    const axis = new Object3D();
    axis.name = 'Turntable';
    axis.userData = { realvirtual: { Kinematic: { GroupName: 'Turntable' } } };
    root.add(axis);
    const viewer = {
      modes: { activeMode: 'editor' },
      currentModelRoot: root,
      selectionManager: { getSnapshot: () => ({ selectedPaths: selected, primaryPath: selected[0] ?? null }) },
      registry: {
        getNode: (p: string) => (p === 'Asset/A' ? new Object3D() : null),
        getComponentTypes: () => [],
      },
      contextMenu: { openItems },
      renderer: { domElement: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) } },
    } as unknown as RVViewer;
    setActiveAssetContext({ viewer, doc: { id: 'd' } as unknown as ActiveAssetContext['doc'] });
    return { viewer, openItems };
  }

  async function plugin(viewer: RVViewer) {
    const { AssetEditorPlugin } = await import('@rv-private/plugins/asset-editor/index');
    const p = Object.create(AssetEditorPlugin.prototype) as Record<string, unknown>;
    Object.assign(p, { viewer, doc: {}, testSession: null, lastPointerPos: { x: 5, y: 5 } });
    return (e: KeyboardEvent) => (p['_handleEditorKeys'] as (e: KeyboardEvent) => void).call(p, e);
  }

  it('the real K key opens the picker and dispatches nothing', async () => {
    const spy = vi.spyOn(commandRegistry, 'execute');
    const { viewer, openItems } = editorViewer(['Asset/A']);
    const keys = await plugin(viewer);
    keys(new KeyboardEvent('keydown', { code: 'KeyK', key: 'k' }));
    expect(openItems).toHaveBeenCalledTimes(1);
    expect(spy).not.toHaveBeenCalled();
  });

  it('picking an existing kinematic, or submitting a new name, dispatches editor.assignToKinematic (origin ui)', () => {
    const spy = vi.spyOn(commandRegistry, 'execute').mockResolvedValue({ ok: false, kind: 'disabled', reason: 'x' });
    const { viewer } = editorViewer(['Asset/A']);
    const items = buildKinematicMenuItems(viewer);
    const existing = items.find((i) => i.id === 'editor.kinematic.Turntable')!;
    existing.action!(target('Asset/A'));
    items.find((i) => i.id === 'editor.kinematic.new')!.input!.onSubmit('Lift', target('Asset/A'));
    expect(spy.mock.calls.map((c) => [c[0], c[1], (c[2] as { origin: string }).origin])).toEqual([
      ['editor.assignToKinematic', { name: 'Turntable', paths: ['Asset/A'], requireExisting: false }, 'ui'],
      ['editor.assignToKinematic', { name: 'Lift', paths: ['Asset/A'], requireExisting: false }, 'ui'],
    ]);
  });

  it('cancelling the picker (closing the menu) dispatches nothing', () => {
    const spy = vi.spyOn(commandRegistry, 'execute');
    const store = new ContextMenuStore();
    const { viewer } = editorViewer(['Asset/A']);
    store.openItems({ x: 0, y: 0 }, target('Asset/A'), buildKinematicMenuItems(viewer));
    store.close();
    expect(spy).not.toHaveBeenCalled();
  });

  it('Delete / Ctrl+Z / Ctrl+Y dispatch editor.delete / .undo / .redo with origin shortcut', async () => {
    const spy = vi.spyOn(commandRegistry, 'execute').mockResolvedValue({ ok: true, value: {} });
    const { viewer } = editorViewer(['Asset/A']);
    const keys = await plugin(viewer);
    keys(new KeyboardEvent('keydown', { key: 'Delete' }));
    keys(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }));
    keys(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true }));
    expect(spy.mock.calls.map((c) => [c[0], c[1], (c[2] as { origin: string }).origin])).toEqual([
      ['editor.delete', { paths: ['Asset/A'] }, 'shortcut'],
      ['editor.undo', { count: 1 }, 'shortcut'],
      ['editor.redo', { count: 1 }, 'shortcut'],
    ]);
  });
});
