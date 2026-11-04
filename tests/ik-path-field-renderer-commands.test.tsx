// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { fieldRendererRegistry } from '../src/core/hmi/rv-field-renderer-registry';
import { setActiveEditTarget, type EditTarget } from '../src/core/hmi/rv-edit-target';
import { commandRegistry } from '../src/core/hmi/rv-command-registry';
import type { RVViewer } from '../src/core/rv-viewer';
import { robotRunHarness } from './helpers/robot-run-harness';
import { SceneStore } from '../src/core/hmi/scene/scene-store';
import { setSceneStore } from '../src/core/hmi/scene/scene-store-ref';
import { EMPTY_SNAPSHOT } from '../src/core/engine/rv-selection-manager';
const mocks = vi.hoisted(() => ({ route: 'scene', persist: vi.fn() }));
vi.mock('../src/core/hmi/scene/scene-field-ops', () => ({ persistFieldOp: mocks.persist }));
vi.mock('../src/core/hmi/ReorderableList', () => ({ ReorderableList: (p: any) => <div>
  <span data-testid="order">{p.items.map((i: any) => i.label).join(',')}</span>
  <button onClick={() => p.onReorder(0, 1)}>Reorder</button><button onClick={() => p.onRemove(0)}>Remove</button>
</div> }));
import '../src/core/hmi/rv-ik-path-field-renderer';
afterEach(() => { cleanup(); setActiveEditTarget(null); vi.restoreAllMocks(); mocks.persist.mockReset(); });
function setup() {
  const live = { reorderTargets: vi.fn(), removeTarget: vi.fn() };
  const viewer = { selectionManager: { subscribe: () => () => {}, getSnapshot: () => EMPTY_SNAPSHOT }, registry: { getNode: () => null, getByPath: () => live } } as unknown as RVViewer;
  const Component = fieldRendererRegistry.getRenderer('IKPath', 'Path')!;
  render(<Component value={['A', 'B'].map(path => ({ type: 'ComponentReference', componentType: 'IKTarget', path }))} nodePath="Robot/Path" fieldName="Path" componentType="IKPath" viewer={viewer} signalStore={null} />);
  return { viewer, live };
}
describe('IKPath inspector command parity (T11)', () => {
  it.each(['Reorder', 'Remove'])('dispatches %s and waits for success before changing the list', async action => {
    setActiveEditTarget({ available: true, persistsTo: 'scene' } as EditTarget); let finish!: (v: any) => void;
    const execute = vi.spyOn(commandRegistry, 'execute').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const { viewer, live } = setup(); fireEvent.click(screen.getByText(action));
    await waitFor(() => expect(execute).toHaveBeenCalled());
    expect(screen.getByTestId('order').textContent).toBe('A,B');
    expect(execute).toHaveBeenCalledWith(action === 'Remove' ? 'ik.target.remove' : 'ik.target.reorder', action === 'Remove' ? { pathPath: 'Robot/Path', index: 0 } : { pathPath: 'Robot/Path', fromIndex: 0, toIndex: 1 }, { origin: 'ui', viewer });
    finish({ ok: true, value: {} });
    await waitFor(() => expect(screen.getByTestId('order').textContent).toBe(action === 'Remove' ? 'B' : 'B,A'));
    expect(mocks.persist).not.toHaveBeenCalled(); expect(live.removeTarget).not.toHaveBeenCalled(); expect(live.reorderTargets).not.toHaveBeenCalled();
  });
  it.each(['Reorder', 'Remove'])('shows a %s refusal and leaves order unchanged', async action => {
    setActiveEditTarget({ available: true, persistsTo: 'scene' } as EditTarget); vi.spyOn(commandRegistry, 'execute').mockResolvedValue({ ok: false, reason: 'Repair the path and retry.' } as any);
    setup(); fireEvent.click(screen.getByText(action));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Repair the path'));
    expect(screen.getByTestId('order').textContent).toBe('A,B'); expect(mocks.persist).not.toHaveBeenCalled();
  });
  it.each(['Reorder', 'Remove'])('preserves asset-route %s field writes', async action => {
    setActiveEditTarget({ available: true, persistsTo: 'asset' } as EditTarget); const execute = vi.spyOn(commandRegistry, 'execute');
    const { live } = setup(); fireEvent.click(screen.getByText(action));
    expect(mocks.persist).toHaveBeenCalledTimes(1); expect(execute).not.toHaveBeenCalled();
    expect(action === 'Remove' ? live.removeTarget : live.reorderTargets).toHaveBeenCalledTimes(1);
  });
});


it.each(['Reorder', 'Remove'])('scene %s creates exactly one shared undo step', async action => {
  setActiveEditTarget({ available: true, persistsTo: 'scene' } as EditTarget); const h = await robotRunHarness();
  const store = new SceneStore(h.viewer); setSceneStore(store);
  const transaction = vi.spyOn(store, 'withTransaction');
  Object.assign(h.viewer, { selectionManager: { subscribe: () => () => {}, getSnapshot: () => EMPTY_SNAPSHOT } });
  const Component = fieldRendererRegistry.getRenderer('IKPath', 'Path')!;
  const before = h.path.targets.map(t => t.node.name);
  try {
    render(<Component value={h.path.node.userData.realvirtual.IKPath.Path} nodePath={h.result.registry.getPathForNode(h.path.node)!} fieldName="Path" componentType="IKPath" viewer={h.viewer} signalStore={null} />);
    fireEvent.click(screen.getByText(action));
    await waitFor(() => expect(transaction).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(h.path.targets.map(t => t.node.name)).not.toEqual(before));
    expect(transaction.mock.calls[0][0]).toBe(action === 'Remove' ? 'Delete IK waypoint' : 'Reorder IK waypoints');
    await store.undo();
    expect(h.path.targets.map(t => t.node.name)).toEqual(before);
    expect(mocks.persist).not.toHaveBeenCalled();
  } finally { cleanup(); setSceneStore(null as unknown as SceneStore); h.dispose(); }
}, 180000);
