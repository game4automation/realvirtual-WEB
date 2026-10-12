// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * The hierarchy panel across a bulk edit (plan-359 §9.2, rewritten for plan-754).
 *
 * `RvExtrasEditorPlugin` used to re-scan the WHOLE scene on every
 * `editor-structure-changed` (`_scanEditableNodes` → `scene.traverse`). With one
 * event per moved node that is `ops × sceneSize` work: instrumenting a 4493-node
 * assembly with 434 moves put 158 ms of the 217 ms total — 73% — in that
 * traverse, the single largest contributor by a wide margin.
 *
 * Since plan-754 the hierarchy renders the scene graph itself, so the scan is
 * GONE rather than merely deferred. What is left to protect is that the plugin
 * has not quietly grown a new one, and that a burst of ops still publishes ONE
 * coalesced tick rather than one per op — both asserted here.
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
    // Half carry a component, so a scan would have real work rather than an early out.
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

/** Let the macrotask-coalesced tick fire. */
const settle = () => new Promise((r) => setTimeout(r, 5));

describe('hierarchy panel on bulk structural change', () => {
  beforeEach(() => { localStorage.clear(); });

  it('never traverses the scene, open panel or closed (plan-754)', async () => {
    localStorage.setItem(LS_PANEL_OPEN, 'true');
    const h = makeHarness(200);
    const plugin = new RvExtrasEditorPlugin();
    plugin.onModelLoaded(h.loadResult as never, h.viewer as never);

    const traverse = vi.spyOn(h.scene, 'traverse');
    h.emitStructureChanged(50);
    await settle();

    expect(traverse).not.toHaveBeenCalled();
    plugin.onModelCleared();
  });

  it('publishes ONE structural tick for 50 events, not 50', async () => {
    localStorage.setItem(LS_PANEL_OPEN, 'true');
    const h = makeHarness(200);
    const plugin = new RvExtrasEditorPlugin();
    plugin.onModelLoaded(h.loadResult as never, h.viewer as never);
    const before = plugin.getSnapshot().structureVersion;

    h.emitStructureChanged(50);
    await settle();

    // The coalescing is a MACROTASK on purpose: a transaction awaits each op and
    // a microtask drains BETWEEN those awaits, which is what turned "once per
    // transaction" back into "once per op".
    expect(plugin.getSnapshot().structureVersion).toBe(before + 1);
    plugin.onModelCleared();
  });

  it('ticks while the panel is closed too — the hierarchy may open onto it', async () => {
    localStorage.setItem(LS_PANEL_OPEN, 'false');
    const h = makeHarness(20);
    const plugin = new RvExtrasEditorPlugin();
    plugin.onModelLoaded(h.loadResult as never, h.viewer as never);
    expect(plugin.panelOpen).toBe(false);
    const before = plugin.getSnapshot().structureVersion;

    // A node appears while nobody is looking.
    const late = new Group();
    late.name = 'LateArrival';
    late.userData.realvirtual = { Drive: {} };
    h.model.add(late);
    h.registry.registerNode(NodeRegistry.computeNodePath(late), late);
    h.emitStructureChanged(1);
    await settle();

    expect(plugin.getSnapshot().structureVersion).toBe(before + 1);
    // And the node is simply THERE — the panel reads `children`, so there is no
    // deferred scan that could be stale when it opens.
    expect(h.registry.getNode('Asset/LateArrival')).toBe(late);
    plugin.onModelCleared();
  });
});
