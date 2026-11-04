// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-630 §9.3 (wiring half) — what the PLUGIN does around the registry.
 *
 * The window is tested in `planning-overlay.test.tsx`. What this file proves is
 * the part a screenshot cannot show: the overlay module is loaded ONLY once a
 * model declares something (a document without planning parameters must not pay
 * for it), the toolbar reset is not an apply, and the `planning-*` Problems
 * entries leave with the document they describe (the `owner-teardown` promise
 * `problems-clear-per-load` makes on behalf of this plugin).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlanningParametersPlugin, DISPLAY_OWNER } from '../../src/plugins/planning-parameters';
import { clearAllProblems, getProblems, reportProblem } from '../../src/core/hmi/problems-store';
import type { RVViewer } from '../../src/core/rv-viewer';

/** A viewer that records what the plugin asks of it. */
function makeViewer() {
  const registered: Array<{ id: string }> = [];
  const events = new Map<string, Set<() => void>>();
  const v = {
    simTime: 0,
    isSimulationPaused: false,
    uiRegistry: { register: (entry: { id: string }) => { registered.push(entry); } },
    on(name: string, fn: () => void) {
      const set = events.get(name) ?? new Set();
      set.add(fn);
      events.set(name, set);
      return () => set.delete(fn);
    },
    emit(name: string) { for (const fn of [...(events.get(name) ?? [])]) fn(); },
    whenSceneReady: () => Promise.resolve(),
    setSimulationPaused: () => {},
    // As the real viewer does: a reset emits, and the plugin's listener hears it
    // — including the reset the apply itself performs.
    resetSimulation() { v.resets += 1; v.emit('simulation-reset'); },
    resets: 0,
    simulationKernel: null,
    registered,
  };
  return v;
}

type FakeViewer = ReturnType<typeof makeViewer>;

let viewer: FakeViewer;
let plugin: PlanningParametersPlugin;

beforeEach(() => {
  clearAllProblems();
  viewer = makeViewer();
  plugin = new PlanningParametersPlugin();
  plugin.init(viewer as unknown as RVViewer);
  plugin.onModelLoaded(null, viewer as unknown as RVViewer);
});

afterEach(() => { plugin.dispose(); clearAllProblems(); });

describe('PlanningParametersPlugin', () => {
  it('loads the window only once a model declares a parameter', async () => {
    // A document without planning parameters must not pay for the overlay.
    await Promise.resolve();
    expect(viewer.registered).toEqual([]);

    plugin.registry.declare({
      owner: 'yard',
      title: 'Yard',
      params: [{ key: 'slots', label: 'Plätze', type: 'integer', min: 0, max: 8, default: 6, group: 'Stationen', apply: 'reset' }],
    });

    // The first import of the window pulls React + MUI through the browser
    // test transform, which takes seconds on a cold run — hence the long wait.
    await vi.waitFor(() => expect(viewer.registered.map((e) => e.id)).toEqual(['planning-parameters-ui']), { timeout: 15000 });
  });

  it('declares the display switches alongside the first model owner, never alone', async () => {
    expect(plugin.registry.getSnapshot().owners.map((o) => o.owner)).toEqual([]);

    plugin.registry.declare({
      owner: 'yard',
      title: 'Yard',
      params: [{ key: 'slots', label: 'Plätze', type: 'integer', min: 0, max: 8, default: 6, group: 'Stationen', apply: 'reset' }],
    });

    expect(plugin.registry.getSnapshot().owners.map((o) => o.owner)).toContain(DISPLAY_OWNER);
  });

  it('turns a toolbar reset into a new run that KEEPS the pending values', () => {
    plugin.registry.declare({
      owner: 'yard',
      title: 'Yard',
      params: [{ key: 'slots', label: 'Plätze', type: 'integer', min: 0, max: 8, default: 6, group: 'Stationen', apply: 'reset' }],
    });
    plugin.registry.set('yard.slots', 2, 'ui');

    viewer.emit('simulation-reset');

    const state = plugin.registry.list().find((p) => p.key === 'yard.slots');
    expect(state?.value).toBe(6);
    expect(state?.pending).toBe(2);
    expect(plugin.registry.changeLog()).toEqual([]);
  });

  it('keeps the commit rows of an apply, although its own reset emits too', async () => {
    plugin.registry.declare({
      owner: 'yard',
      title: 'Yard',
      params: [{ key: 'slots', label: 'Plätze', type: 'integer', min: 0, max: 8, default: 6, group: 'Stationen', apply: 'reset' }],
    });
    plugin.registry.set('yard.slots', 2, 'ui');

    // Straight at the registry, NOT through the plugin's convenience method:
    // the runner is what marks the apply, so this path must be safe too.
    const r = await plugin.registry.applyPendingAndReset();

    expect(r.ok).toBe(true);
    expect(viewer.resets).toBe(1);
    // The commit row survived the `simulation-reset` its own reset emitted.
    expect(plugin.registry.changeLog()).toEqual([
      { simTime: 0, seq: 0, key: 'yard.slots', from: 6, to: 2, origin: 'ui' },
    ]);
    // …and afterwards the listener works again.
    viewer.emit('simulation-reset');
    expect(plugin.registry.changeLog()).toEqual([]);
  });

  it('retires every planning finding with the document it describes', () => {
    for (const id of [
      'planning-declaration-invalid', 'planning-param-orphaned', 'planning-scenario-value-invalid',
      'planning-apply-failed', 'planning-apply-rollback-failed',
    ]) {
      reportProblem({ id, severity: 'warning', code: id, title: id, detail: 'test' });
    }
    expect(getProblems()).toHaveLength(5);

    plugin.onModelCleared(viewer as unknown as RVViewer);

    expect(getProblems()).toEqual([]);
  });

  it('gives every document its own identity, so an apply cannot cross a load', () => {
    const first = plugin.registry.getSnapshot().version;
    plugin.onModelCleared(viewer as unknown as RVViewer);
    plugin.onModelLoaded(null, viewer as unknown as RVViewer);
    // No value survived into the new document's log.
    expect(plugin.registry.changeLog()).toEqual([]);
    expect(plugin.registry.getSnapshot().version).toBeGreaterThanOrEqual(first);
  });
});
