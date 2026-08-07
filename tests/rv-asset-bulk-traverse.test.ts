// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * The hierarchy panel's scene scan across a bulk edit (plan-359 §9.2).
 *
 * `RvExtrasEditorPlugin` re-scans the WHOLE scene on every `editor-structure-changed`
 * (`_scanEditableNodes` → `scene.traverse`). With one event per moved node that is
 * `ops × sceneSize` work: instrumenting a 4493-node assembly with 434 moves put
 * 158 ms of the 217 ms total — 73% — in that traverse, the single largest
 * contributor by a wide margin (matrix updates 9%, registry remap 5.5%).
 *
 * Three properties keep it off the hot path, and all three are asserted here:
 *   1. a closed panel does not scan at all (nothing reads the result),
 *   2. the deferred scan lands when something finally reads the tree,
 *   3. an open panel scans ONCE per burst of events, not once per event.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Scene, Group } from 'three';
import { RvExtrasEditorPlugin } from '../src/core/hmi/rv-extras-editor';
import { LeftPanelManager } from '../src/core/hmi/left-panel-manager';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';

const LS_PANEL_OPEN = 'rv-extras-editor-open';

function makeHarness(nodeCount: number) {
  const scene = new Scene();
  const model = new Group();
  model.name = 'Asset';
  scene.add(model);
  for (let i = 0; i < nodeCount; i++) {
    const n = new Group();
    n.name = `Node_${i}`;
    // Half carry a component, so the scan has real work rather than an early out.
    if (i % 2 === 0) n.userData.realvirtual = { Sensor: { Length: 1 } };
    model.add(n);
  }

  const registry = new NodeRegistry();
  model.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));

  const handlers = new Map<string, Set<(p: unknown) => void>>();
  const viewer = {
    scene,
    registry,
    currentModelRoot: model,
    currentModelUrl: './models/test.glb',
    getPlugin: () => undefined,
    on(event: string, fn: (p: unknown) => void) {
      let set = handlers.get(event);
      if (!set) { set = new Set(); handlers.set(event, set); }
      set.add(fn);
      return () => set!.delete(fn);
    },
    leftPanelManager: new LeftPanelManager(),
    contextMenu: { register: vi.fn() },
    selectionManager: { selectedPaths: [], count: 0, isSelected: () => false },
  };
  const loadResult = {
    registry, drives: [], transportManager: null, signalStore: null,
    playback: null, replayRecordings: [], recorderSettings: null,
    logicEngine: null, boundingBox: null, triangleCount: 0,
  };
  const emitStructureChanged = (times: number) => {
    for (let i = 0; i < times; i++) {
      for (const fn of handlers.get('editor-structure-changed') ?? []) {
        fn({ source: 'asset-editor' });
      }
    }
  };
  return { scene, model, registry, viewer, loadResult, emitStructureChanged };
}

/** Let the macrotask-coalesced refresh fire. */
const settle = () => new Promise((r) => setTimeout(r, 5));

describe('hierarchy panel scan on bulk structural change', () => {
  beforeEach(() => { localStorage.clear(); });

  it('does not traverse the scene while the panel is closed', async () => {
    localStorage.setItem(LS_PANEL_OPEN, 'false');
    const h = makeHarness(200);
    const plugin = new RvExtrasEditorPlugin();
    plugin.onModelLoaded(h.loadResult as never, h.viewer as never);
    expect(plugin.panelOpen).toBe(false);

    const traverse = vi.spyOn(h.scene, 'traverse');
    h.emitStructureChanged(50);
    await settle();
    expect(traverse).not.toHaveBeenCalled();

    // …and the deferred scan lands as soon as anything reads the tree.
    expect(plugin.getEditableNodes().length).toBe(100);
    expect(traverse).toHaveBeenCalled();
    plugin.onModelCleared();
  });

  it('traverses once for 50 events with the panel open, not 50 times', async () => {
    localStorage.setItem(LS_PANEL_OPEN, 'true');
    const h = makeHarness(200);
    const plugin = new RvExtrasEditorPlugin();
    plugin.onModelLoaded(h.loadResult as never, h.viewer as never);
    expect(plugin.panelOpen).toBe(true);

    const traverse = vi.spyOn(h.scene, 'traverse');
    h.emitStructureChanged(50);
    await settle();
    // One scan. The coalescing is a MACROTASK on purpose: a transaction awaits
    // each op and a microtask drains BETWEEN those awaits, which is what turned
    // "once per transaction" back into "once per op".
    expect(traverse).toHaveBeenCalledTimes(1);
    plugin.onModelCleared();
  });

  it('opening the panel settles a scan deferred while it was closed', async () => {
    localStorage.setItem(LS_PANEL_OPEN, 'false');
    const h = makeHarness(20);
    const plugin = new RvExtrasEditorPlugin();
    plugin.onModelLoaded(h.loadResult as never, h.viewer as never);
    const initial = plugin.getSnapshot().editableNodes.length;

    // A node appears while nobody is looking.
    const late = new Group();
    late.name = 'LateArrival';
    late.userData.realvirtual = { Drive: {} };
    h.model.add(late);
    h.registry.registerNode(NodeRegistry.computeNodePath(late), late);
    h.emitStructureChanged(1);
    await settle();
    expect(plugin.getSnapshot().editableNodes.length).toBe(initial);

    plugin.togglePanel();
    expect(plugin.panelOpen).toBe(true);
    expect(plugin.getSnapshot().editableNodes.map((n) => n.path))
      .toContain('Asset/LateArrival');
    plugin.onModelCleared();
  });
});
