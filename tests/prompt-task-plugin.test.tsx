// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-486 §9.4 — the plugin, the context-menu entry, the shortcut and the panel.
 *
 * The two cases worth naming:
 *
 *  - **`onSubmit` uses the MENU TARGET.** Right-click B while A is selected and
 *    the task must be about B. Taking the path from the selection store looks
 *    right in every manual test where the two agree, and is wrong exactly when
 *    it matters.
 *  - **The shortcut carries no hit point.** Click A (a hit point is remembered
 *    somewhere), select B programmatically, press the shortcut: the task must
 *    NOT arrive with A's coordinate glued to B.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { Object3D } from 'three';
import { ContextMenuStore, type ContextMenuTarget } from '../src/core/hmi/context-menu-store';
import { activateContext, deactivateContext, _resetStore } from '../src/core/hmi/ui-context-store';
import {
  PROMPT_TASK_PLUGIN_ID,
  PromptTaskPlugin,
  isPromptTaskShortcut,
  promptTaskContextMenuItems,
  promptUiAvailable,
  shortcutMenuTarget,
  submitPromptTask,
} from '../src/plugins/prompt-task-plugin';
import { PromptTaskPanel, noRecentClaim } from '../src/core/hmi/PromptTaskPanel';
import {
  PromptTaskStore,
  _setPromptTaskStore,
  type PromptStorageLike,
} from '../src/core/hmi/prompt-task-store';
import { buildPromptTask } from '../src/core/hmi/prompt-task-envelope';
import type { RVViewer } from '../src/core/rv-viewer';

// ─── Fixture ────────────────────────────────────────────────────────────

class MemoryStorage implements PromptStorageLike {
  readonly map = new Map<string, string>();
  getItem(key: string): string | null { return this.map.get(key) ?? null; }
  setItem(key: string, value: string): void { this.map.set(key, value); }
  removeItem(key: string): void { this.map.delete(key); }
}

let store: PromptTaskStore;
let menu: ContextMenuStore;
let nodeA: Object3D;
let nodeB: Object3D;
let selection: { selectedPaths: string[]; primaryPath: string | null };

function makeViewer(): RVViewer {
  const nodes: Record<string, Object3D> = { 'Line/A': nodeA, 'Line/B': nodeB };
  return {
    contextMenu: menu,
    registry: {
      getNode: (path: string) => nodes[path] ?? null,
      getComponentTypes: (path: string) => (path === 'Line/B' ? ['Drive'] : ['Sensor']),
    },
    selectionManager: { getSnapshot: () => selection },
    errorStore: { getActive: () => [] },
    signalStore: null,
    drives: [],
    transportManager: { sensors: [] },
    isSimulationPaused: true,
    currentModelUrl: 'models/demo.glb',
  } as unknown as RVViewer;
}

function targetFor(path: string, hitPoint?: [number, number, number]): ContextMenuTarget {
  return {
    path,
    node: path === 'Line/A' ? nodeA : nodeB,
    types: path === 'Line/B' ? ['Drive'] : ['Sensor'],
    extras: {},
    ...(hitPoint ? { hitPoint } : {}),
  };
}

beforeEach(() => {
  _resetStore();
  menu = new ContextMenuStore();
  nodeA = new Object3D(); nodeA.name = 'A';
  nodeB = new Object3D(); nodeB.name = 'B';
  selection = { selectedPaths: ['Line/A'], primaryPath: 'Line/A' };
  store = new PromptTaskStore({
    local: new MemoryStorage(), session: new MemoryStorage(), autoHeartbeat: false,
  });
  _setPromptTaskStore(store);
});

afterEach(() => {
  cleanup();
  store.dispose();
  _setPromptTaskStore(null);
  _resetStore();
});

// ─── Context menu ───────────────────────────────────────────────────────

describe('plan-486 §9.4 — the context-menu entry', () => {
  it('appears only when there is a node path', () => {
    const items = promptTaskContextMenuItems(makeViewer());
    const entry = items.find((i) => i.id === 'prompt.task')!;
    expect(entry.condition!(targetFor('Line/B'))).toBe(true);
    expect(entry.condition!({ ...targetFor('Line/B'), path: '' })).toBe(false);
    expect(entry.input).toBeTruthy();
    expect(entry.action).toBeUndefined();   // an input row, not an action row
  });

  it('onSubmit queues exactly ONE task, about the TARGET — not the selection', () => {
    const viewer = makeViewer();
    const entry = promptTaskContextMenuItems(viewer).find((i) => i.id === 'prompt.task')!;
    // A is selected; the user right-clicked B.
    entry.input!.onSubmit('Sensor triggert zu frueh', targetFor('Line/B', [1, 2, 3]));

    const tasks = store.list();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].context.targetPath).toBe('Line/B');
    expect(tasks[0].context.selectedPaths[0]).toBe('Line/B');
    expect(tasks[0].context.componentTypes).toEqual(['Drive']);
    expect(tasks[0].context.hitPoint).toEqual([1, 2, 3]);
  });

  it('the task carries node context AND machine status', () => {
    const task = submitPromptTask(makeViewer(), 'Reibung stimmt nicht', targetFor('Line/B'), store)!;
    expect(task.context.nodeContext).toContain('Node: Line/B');
    expect(task.context.machineStatus).toContain('[MACHINE_STATUS]');
    expect(task.context.machineStatus).toContain('Simulation: paused');
    expect(task.context.modelName).toBe('demo.glb');
  });

  it('an empty prompt queues nothing', () => {
    expect(submitPromptTask(makeViewer(), '   ', targetFor('Line/B'), store)).toBeNull();
    expect(store.list()).toHaveLength(0);
  });

  it('the entry is gone in viewer and kiosk mode', () => {
    const entry = promptTaskContextMenuItems(makeViewer()).find((i) => i.id === 'prompt.task')!;
    expect(promptUiAvailable()).toBe(true);
    activateContext('mode:viewer');
    expect(promptUiAvailable()).toBe(false);
    expect(entry.condition!(targetFor('Line/B'))).toBe(false);
    deactivateContext('mode:viewer');
    activateContext('kiosk');
    expect(entry.condition!(targetFor('Line/B'))).toBe(false);
    deactivateContext('kiosk');
    expect(entry.condition!(targetFor('Line/B'))).toBe(true);
  });
});

// ─── Shortcut ───────────────────────────────────────────────────────────

describe('plan-486 F9 — the shortcut guesses no hit point', () => {
  const base = { ctrlKey: true, metaKey: false, altKey: true, shiftKey: false, target: null };

  it('fires on Ctrl/Cmd+Alt+A and nothing else', () => {
    expect(isPromptTaskShortcut({ ...base, key: 'a' })).toBe(true);
    expect(isPromptTaskShortcut({ ...base, key: 'A' })).toBe(true);
    expect(isPromptTaskShortcut({ ...base, key: 'a', ctrlKey: false, metaKey: true })).toBe(true);
    expect(isPromptTaskShortcut({ ...base, key: 'a', altKey: false })).toBe(false);
    expect(isPromptTaskShortcut({ ...base, key: 'a', shiftKey: true })).toBe(false);
    expect(isPromptTaskShortcut({ ...base, key: 'b' })).toBe(false);
  });

  it('never steals a keystroke from an input', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    expect(isPromptTaskShortcut({ ...base, key: 'a', target: input })).toBe(false);
    input.remove();
  });

  it('click A, select B, shortcut → the task is about B and carries NO hit point', () => {
    const viewer = makeViewer();
    // The user clicked A first (a hit point exists somewhere in the app) …
    submitPromptTask(viewer, 'about A', targetFor('Line/A', [9, 9, 9]), store);
    // … then selected B programmatically, which updates no hit point at all.
    selection = { selectedPaths: ['Line/B'], primaryPath: 'Line/B' };

    const target = shortcutMenuTarget(viewer)!;
    expect(target.path).toBe('Line/B');
    expect(target.hitPoint).toBeUndefined();

    const task = submitPromptTask(viewer, 'about B', target, store)!;
    expect(task.context.targetPath).toBe('Line/B');
    expect(task.context.hitPoint).toBeUndefined();
  });

  it('with nothing selected the shortcut has no target', () => {
    selection = { selectedPaths: [], primaryPath: null };
    expect(shortcutMenuTarget(makeViewer())).toBeNull();
  });
});

// ─── Plugin lifecycle ───────────────────────────────────────────────────

describe('plan-486 §9.4 — registration and teardown', () => {
  it('registers the menu items on init and removes them on dispose', () => {
    const viewer = makeViewer();
    const plugin = new PromptTaskPlugin();
    plugin.init(viewer);
    menu.open({ x: 0, y: 0 }, targetFor('Line/B'));
    expect(menu.getSnapshot().items.some((i) => i.id === 'prompt.task')).toBe(true);
    menu.close();

    plugin.dispose();
    menu.open({ x: 0, y: 0 }, targetFor('Line/B'));
    expect(menu.getSnapshot().items.some((i) => i.id === 'prompt.task')).toBe(false);
  });

  it('the keydown listener is removed too', () => {
    const viewer = makeViewer();
    const plugin = new PromptTaskPlugin();
    plugin.init(viewer);
    plugin.dispose();
    // After dispose the shortcut must not be able to open anything.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, altKey: true }));
    expect(menu.getSnapshot().open).toBe(false);
  });

  it('declares the UI overlay slot and the plugin id', () => {
    const plugin = new PromptTaskPlugin();
    expect(plugin.id).toBe(PROMPT_TASK_PLUGIN_ID);
    expect(plugin.core).toBe(true);
    expect(plugin.slots?.[0].slot).toBe('overlay');
    expect(plugin.slots?.[0].visibilityRule?.hiddenIn).toEqual(['mode:viewer', 'kiosk']);
  });
});

// ─── Panel ──────────────────────────────────────────────────────────────

describe('plan-486 F7 — the panel', () => {
  function task(prompt: string) {
    return buildPromptTask({ prompt, targetPath: 'Line/Belt02/Drive', componentTypes: ['Drive'] });
  }

  it('lists the queue and offers reopen only for claimed tasks', () => {
    store.enqueue(task('Sensor triggert zu frueh'));
    store.enqueue(task('Reibung stimmt nicht'));
    const claimed = store.claim().task!;

    render(<PromptTaskPanel store={store} open onClose={() => {}} />);
    expect(screen.getByText('Sensor triggert zu frueh')).toBeTruthy();
    expect(screen.getByText('Reibung stimmt nicht')).toBeTruthy();
    expect(screen.getAllByLabelText(/^delete /)).toHaveLength(2);
    const reopen = screen.getAllByLabelText(/^reopen /);
    expect(reopen).toHaveLength(1);
    expect(reopen[0].getAttribute('aria-label')).toBe(`reopen ${claimed.id}`);
  });

  it('is absent in viewer mode', () => {
    store.enqueue(task('hidden here'));
    activateContext('mode:viewer');
    render(<PromptTaskPanel store={store} open onClose={() => {}} />);
    expect(screen.queryByText('hidden here')).toBeNull();
  });

  it('says so when nothing has been collected yet', () => {
    store.enqueue(task('waiting for an agent'));
    render(<PromptTaskPanel store={store} open onClose={() => {}} />);
    expect(screen.getByText(/Nothing collected yet/)).toBeTruthy();
  });

  it('noRecentClaim is false with an empty queue and true for a stale claim', () => {
    const base = { tasks: [], claimed: 0, persistError: null, notice: null, volatile: false };
    expect(noRecentClaim({ ...base, open: 0, lastClaimAt: null }, 1_000)).toBe(false);
    expect(noRecentClaim({ ...base, open: 1, lastClaimAt: null }, 1_000)).toBe(true);
    const now = Date.now();
    expect(noRecentClaim({ ...base, open: 1, lastClaimAt: new Date(now).toISOString() }, now)).toBe(false);
    expect(noRecentClaim(
      { ...base, open: 1, lastClaimAt: new Date(now - 60 * 60_000).toISOString() }, now,
    )).toBe(true);
  });
});
