// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2005 test 9.13 — the planning window is locked while an experiment batch runs:
 * every mutating registry entry refuses an origin other than `experiment`
 * (`experiment-running`), `revertPending` and `loadScenario` refuse outright, display
 * switches stay free, and the `planning.*` commands answer the same.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPlanningRegistry, type PlanningRegistry } from '../../src/core/planning/rv-planning-registry';
import type { PlanningParamDef } from '../../src/core/planning/rv-planning-params';
import { CommandRegistry } from '../../src/core/hmi/rv-command-registry';
import type { RVViewer } from '../../src/core/rv-viewer';
import { PlanningParametersPlugin, PLANNING_PLUGIN_ID } from '../../src/plugins/planning-parameters';
import { ensurePlanningCommandsRegistered } from '../../src/plugins/planning-parameters/planning-command-descriptors';
import { clearAllProblems } from '../../src/core/hmi/problems-store';

const PARAMS: PlanningParamDef[] = [
  { key: 'size', label: 'Size', type: 'integer', min: 1, max: 8, default: 2, group: 'g', apply: 'reset' },
  { key: 'rate', label: 'Rate', type: 'number', min: 0, max: 100, default: 40, group: 'g', apply: 'live' },
  { key: 'trace', label: 'Trace', type: 'boolean', default: false, group: 'Anzeige', apply: 'live', role: 'display' },
];

function locked(): PlanningRegistry {
  const r = createPlanningRegistry({ problems: { report: () => {}, clear: () => {} } });
  r.declare({ owner: 'yard', title: 'Yard', params: PARAMS });
  r.set('yard.size', 3, 'ui');               // one pending value, to revert
  r.setExperimentRunning(true);
  return r;
}

describe('experiment lock in the registry (9.13)', () => {
  it('refuses set, setMany, resetToDefaults, applyPendingAndReset and applyScenario from ui/mcp', async () => {
    const r = locked();
    for (const origin of ['ui', 'mcp'] as const) {
      expect(r.set('yard.rate', 50, origin)).toEqual({ ok: false, error: 'experiment-running' });
      expect(r.set('yard.size', 4, origin)).toEqual({ ok: false, error: 'experiment-running' });  // reset class too
      expect(r.setMany({ 'yard.rate': 50 }, origin).results['yard.rate'].error).toBe('experiment-running');
      expect(r.resetToDefaults('yard', origin).ok).toBe(false);
      expect(r.applyScenario({ 'yard.rate': 60 }, origin).ok).toBe(false);
    }
    expect(await r.applyPendingAndReset('ui')).toMatchObject({ ok: false, error: 'experiment-running' });
    expect(await r.applyPendingAndReset()).toMatchObject({ ok: false, error: 'experiment-running' });  // default = ui
    expect(r.list().find((p) => p.key === 'yard.rate')!.value).toBe(40);
    expect(r.list().find((p) => p.key === 'yard.size')!.pending).toBe(3);
  });

  it('reconcileStructure refuses too; whenExperimentDone resolves when the lock goes', async () => {
    const r = locked();
    expect(await r.reconcileStructure('yard')).toMatchObject({ ok: false, error: 'experiment-running' });
    let done = false;
    const wait = r.whenExperimentDone().then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    r.setExperimentRunning(false);
    await wait;
    expect(done).toBe(true);
  });

  it('revertPending and loadScenario refuse without exception', () => {
    const r = locked();
    expect(r.revertPending('yard.size')).toBe(false);
    expect(r.list().find((p) => p.key === 'yard.size')!.pending).toBe(3);
    expect(r.loadScenario({ 'yard.rate': 70 })).toBe(false);
    expect(r.list().find((p) => p.key === 'yard.rate')!.value).toBe(40);
  });

  it('origin experiment passes; display switches stay free; unlocking restores the old behaviour', async () => {
    const r = locked();
    expect(r.set('yard.trace', true, 'ui')).toMatchObject({ ok: true, applied: 'display' });
    expect(r.setMany({ 'yard.size': 4, 'yard.rate': 55 }, 'experiment').ok).toBe(true);
    expect(await r.applyPendingAndReset('experiment')).toMatchObject({ ok: true });
    expect(r.list().find((p) => p.key === 'yard.size')!.value).toBe(4);
    expect(r.list().find((p) => p.key === 'yard.rate')!.value).toBe(55);   // live factor committed as a start value
    r.setExperimentRunning(false);
    expect(r.set('yard.rate', 50, 'ui').ok).toBe(true);
    expect(r.loadScenario({})).toBe(true);
  });
});

describe('experiment lock through the planning commands (9.13)', () => {
  let plugin: PlanningParametersPlugin;
  let commands: CommandRegistry;
  beforeEach(() => {
    plugin = new PlanningParametersPlugin();
    const store = new Map<string, string>([['M/Exp 1', JSON.stringify({ model: 'M', experiment: 'Exp 1', baseSeed: 42, createdAt: 0, replications: [] })]]);
    const viewer = {
      getPlugin: (id: string) => (id === PLANNING_PLUGIN_ID ? plugin : undefined),
      currentModelUrl: '/models/M.glb',
      simulationKernel: { desControl: () => ({
        readManifestJson: async (m: string, e: string) => store.get(`${m}/${e}`) ?? null,
        patchExperimentMetaJson: async () => {},
      }) },
      registry: null,
    } as unknown as RVViewer;
    commands = new CommandRegistry();
    commands.attachViewer(viewer);
    ensurePlanningCommandsRegistered(commands);
    plugin.registry.declare({ owner: 'yard', title: 'Yard', params: PARAMS });
    plugin.registry.setExperimentRunning(true);
  });
  afterEach(() => { plugin.dispose(); clearAllProblems(); });

  it('planning.param.set answers experiment-running; planning.factor.set no longer exists (plan-2211 G7b)', { timeout: 15000 }, async () => {
    const set = await commands.execute('planning.param.set', { values: '{"yard.rate":50}' }, { origin: 'mcp' });
    expect(set.ok && set.value).toMatchObject({ ok: false, results: { 'yard.rate': { error: 'experiment-running' } } });
    const factor = await commands.execute('planning.factor.set', { experiment: 'Exp 1', key: 'yard.size', value: '4' }, { origin: 'mcp' });
    // The factor commands were removed with the experiment factors (plan-2211 G7b).
    expect(factor).toMatchObject({ ok: false, kind: 'unknown' });
    const apply = await commands.execute('planning.param.apply', {}, { origin: 'mcp' });
    expect(apply.ok && apply.value).toMatchObject({ ok: false, error: 'experiment-running' });
  });
});
