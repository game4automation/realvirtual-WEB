// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandRegistry, type CommandContext } from '../../src/core/hmi/rv-command-registry';
import { getProblems, reportProblem, resetProblemsForTests } from '../../src/core/hmi/problems-store';
import { DIAGNOSE_COMMAND_IDS, ensureDiagnoseCommandsRegistered } from '../../src/core/diagnostics/diagnose-command-descriptors';
import { filterProblems, type ProblemsListArgs } from '../../src/core/diagnostics/diagnose-commands';

const viewer = {} as CommandContext['viewer'];
beforeEach(() => {
  resetProblemsForTests();
  reportProblem({ id: 'i', severity: 'info', code: 'other', title: 'Info', detail: 'Info detail', at: 1 });
  reportProblem({ id: 'w', severity: 'warning', code: 'bake-warning', title: 'Warning', detail: 'Warning detail', nodePath: '/Line/Station', at: 2 });
  reportProblem({ id: 'e', severity: 'error', code: 'bake-error', title: 'Error', detail: 'Error detail', nodePath: '/Line/Source', at: 3, quiet: true });
});
afterEach(resetProblemsForTests);

describe('problems.list', () => {
  it.each<[ProblemsListArgs, string[]]>([
    [{}, ['e', 'w', 'i']], [{ severity: 'ERROR' }, ['e']],
    [{ code: 'bake-' }, ['e', 'w']], [{ code: 'ake-' }, []],
    [{ node: 'lInE/sT' }, ['w']], [{ node: '' }, ['e', 'w']],
    [{ severity: 'warning', code: 'bake-', node: 'STATION' }, ['w']],
    [{ limit: 1 }, ['e']], [{ limit: 0 }, ['e']],
  ])('filters through both helper and registry: %j', async (args, ids) => {
    const registry = new CommandRegistry();
    ensureDiagnoseCommandsRegistered(registry);
    const result = filterProblems(getProblems(), args);
    expect(result.problems.map(p => p.id)).toEqual(ids);
    expect(result.counts).toEqual({ error: 1, warning: 1, info: 1 });
    expect(result.truncated).toBe(args.limit !== undefined);
    expect(await registry.execute('problems.list', args, { origin: 'mcp', viewer }))
      .toEqual({ ok: true, value: result });
  });

  it('keeps quiet entries and orders ties by timestamp, then id without changing the store', () => {
    reportProblem({ id: 'a', severity: 'error', code: 'x', title: 'A', detail: 'A', at: 3 });
    reportProblem({ id: 'z', severity: 'error', code: 'x', title: 'Z', detail: 'Z', at: 0 });
    const before = [...getProblems()];
    expect(filterProblems(before, { severity: null, code: null, node: null, limit: null } as never))
      .toEqual(filterProblems(before, {}));
    const result = filterProblems(getProblems(), {});
    expect(result.problems.map(p => p.id)).toEqual(['z', 'a', 'e', 'w', 'i']);
    expect(result.problems.find(p => p.id === 'e')?.quiet).toBe(true);
    expect(result.problems.find(p => p.id === 'w')?.quiet).toBe(false);
    expect(getProblems()).toEqual(before);
  });

  it('defaults to 100 and caps at 500, counting before truncation', () => {
    const entries = Array.from({ length: 510 }, (_, i) => ({ ...getProblems()[0], id: String(i) }));
    expect(filterProblems(entries, {}).problems).toHaveLength(100);
    const result = filterProblems(entries, { limit: 1000 });
    expect(result.problems).toHaveLength(500);
    expect(result.total).toBe(510);
    expect(result.truncated).toBe(true);
  });

  it('rejects an invalid severity with allowed values', async () => {
    expect(() => filterProblems(getProblems(), { severity: 'fatal' })).toThrow('error|warning|info');
    const registry = new CommandRegistry();
    ensureDiagnoseCommandsRegistered(registry);
    expect(await registry.execute('problems.list', { severity: 'fatal' }, { origin: 'mcp', viewer }))
      .toMatchObject({ ok: false, kind: 'threw', reason: expect.stringContaining('error|warning|info') });
  });

  it('registers once per registry with lazy, read-only descriptors', () => {
    for (const registry of [new CommandRegistry(), new CommandRegistry()]) {
      ensureDiagnoseCommandsRegistered(registry);
      const first = registry.list();
      const register = vi.spyOn(registry, 'register');
      ensureDiagnoseCommandsRegistered(registry);
      expect(register).not.toHaveBeenCalled();
      expect(registry.list()).toEqual(first);
      expect(first.map(d => d.id)).toEqual(DIAGNOSE_COMMAND_IDS);
      for (const d of first) {
        expect(d).toMatchObject({ scope: 'none', readOnly: d.id !== 'diag.blockageWatch' && d.id !== 'problems.ack', available: true });
        expect(d.eagerImpl).toBeUndefined();
        expect(d.undoLabel).toBeUndefined();
        expect(d.macro).toBeUndefined();
      }
    }
  });
});
