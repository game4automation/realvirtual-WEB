// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommandRegistry } from '../../src/core/hmi/rv-command-registry';
import type { RVViewer } from '../../src/core/rv-viewer';
import { PlanningParametersPlugin, PLANNING_PLUGIN_ID } from '../../src/plugins/planning-parameters';
import { ensurePlanningCommandsRegistered, PLANNING_COMMAND_IDS } from '../../src/plugins/planning-parameters/planning-command-descriptors';
import { clearAllProblems } from '../../src/core/hmi/problems-store';

let plugin: PlanningParametersPlugin;
let commands: CommandRegistry;
let viewer: RVViewer;

beforeEach(() => {
  // Construction needs no DOM. Leave the overlay unmounted and use the real
  // registry's structural apply runner, as in the registry node tests.
  plugin = new PlanningParametersPlugin();
  viewer = { getPlugin: (id: string) => id === PLANNING_PLUGIN_ID ? plugin : undefined } as unknown as RVViewer;
  commands = new CommandRegistry();
  commands.attachViewer(viewer);
  ensurePlanningCommandsRegistered(commands);
});
afterEach(() => { plugin.dispose(); clearAllProblems(); });

function declare() {
  plugin.registry.declare({ owner: 'yard', title: 'Yard', params: [
    { key: 'a', label: 'A', group: 'Model', type: 'integer', default: 2, min: 0, max: 10, apply: 'reset' },
    { key: 'b', label: 'B', group: 'Model', type: 'number', default: 3, min: 0, max: 10, apply: 'live' },
  ], kpis: [{ key: 'output', label: 'Output', kind: 'sim', read: () => 42 }] });
}

async function run(id: string, args = {}) {
  const result = await commands.execute(id, args, { origin: 'mcp' });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}

describe('planning commands (plan-2005 test 9.9)', () => {
  it('registers idempotently and keeps runtime writes out of undo and macros', () => {
    ensurePlanningCommandsRegistered(commands);
    for (const id of PLANNING_COMMAND_IDS) {
      const descriptor = commands.get(id)!;
      expect(descriptor).toBeDefined();
      expect(descriptor.macro).toBeUndefined();
      expect(descriptor.undoLabel).toBeUndefined();
      expect(descriptor.readOnly).toBe(id === 'planning.param.list');
    }
    expect(commands.get('planning.reset')?.destructive).toBe(true);
  });

  // The FIRST command run imports the command bodies (and with them scenario persistence and the
  // project store) through the Node test transform — seconds on a cold, loaded machine (measured
  // 3.7-5.0 s on 2026-10-27), so this test gets the cold-import budget the overlay test also uses.
  it('rejects a bad b atomically and rejects malformed/non-object JSON', { timeout: 15000 }, async () => {
    declare();
    const before = plugin.registry.list();
    expect(await run('planning.param.set', { values: '{"yard.a":1,"yard.b":"bad"}' })).toMatchObject({
      ok: false, results: { 'yard.a': { ok: false, error: 'not-applied' }, 'yard.b': { ok: false, error: expect.any(String) } },
    });
    for (const values of ['{', 'null', '[]', '1', '"text"']) {
      expect(await run('planning.param.set', { values })).toMatchObject({ ok: false, error: expect.any(String) });
    }
    expect(plugin.registry.list()).toEqual(before);
    expect(plugin.registry.changeLog()).toEqual([]);
  });

  it('applies pending values, lists them and resets live now/reset-class pending', async () => {
    declare();
    expect(await run('planning.param.set', { values: '{"yard.a":7,"yard.b":8}' })).toMatchObject({ ok: true });
    expect(plugin.registry.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'yard.a', value: 2, pending: 7 }),
      expect.objectContaining({ key: 'yard.b', value: 8 }),
    ]));
    expect(await run('planning.param.apply')).toMatchObject({ ok: true, generation: 1 });
    expect(await run('planning.param.list')).toMatchObject({
      params: expect.arrayContaining([expect.objectContaining({ key: 'yard.a', value: 7 })]),
      kpis: expect.arrayContaining([expect.objectContaining({ value: 42 })]),
      changeLog: expect.arrayContaining([expect.objectContaining({ origin: 'mcp' })]),
      scenario: { persistable: false, names: expect.any(Array), dirty: expect.any(Boolean) },
    });
    expect(await run('planning.param.list', { owner: 'absent' })).toMatchObject({ params: [] });
    expect(await run('planning.reset', { owner: 'yard' })).toMatchObject({ ok: true });
    expect(plugin.registry.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'yard.a', value: 7, pending: 2 }),
      expect.objectContaining({ key: 'yard.b', value: 3 }),
    ]));
  });

  it('saves and activates a scenario, then switches through the real scenario API', async () => {
    declare();
    await run('planning.param.set', { values: '{"yard.a":7,"yard.b":8}' });
    await run('planning.param.apply');
    expect(await run('planning.scenario.save', { name: 'Seven' })).toMatchObject({ ok: true, persistedTo: 'session' });
    expect(plugin.getScenarioState().block.active).toBe('Seven');
    await run('planning.param.set', { values: '{"yard.a":4,"yard.b":5}' });
    await run('planning.param.apply');
    await run('planning.scenario.save', { name: 'Four' });
    expect(await run('planning.scenario.switch', { name: 'Seven' })).toMatchObject({ ok: true });
    expect(plugin.registry.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'yard.a', value: 4, pending: 7 }),
      expect.objectContaining({ key: 'yard.b', value: 8 }),
    ]));
    expect(plugin.registry.changeLog()).toEqual(expect.arrayContaining([
      expect.objectContaining({ origin: 'mcp' }), expect.objectContaining({ origin: 'scenario', key: 'yard.b' }),
    ]));
    await run('planning.param.apply');
    expect(await run('planning.param.list')).toMatchObject({
      params: expect.arrayContaining([expect.objectContaining({ key: 'yard.a', value: 7 })]),
      scenario: { active: 'Seven', names: expect.arrayContaining(['Seven', 'Four']) },
    });
    expect(await run('planning.scenario.save', { name: ' ' })).toMatchObject({ ok: false, error: expect.any(String) });
    expect(await run('planning.scenario.switch', { name: 'Missing' })).toMatchObject({ ok: false, error: expect.any(String) });
  });

  it('disables every command with the same reason for an empty or missing registry', async () => {
    await commands.preload(PLANNING_COMMAND_IDS);
    for (const id of PLANNING_COMMAND_IDS) {
      expect(commands.enabled(id, {})).toEqual({ reason: 'no planning parameters declared' });
      expect(commands.enabled(id, {}, { getPlugin: () => undefined } as unknown as RVViewer))
        .toEqual({ reason: 'no planning parameters declared' });
    }
  });
});
