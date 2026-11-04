// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2005 T9.2 — the filters of web_logs / web_signal_list are honoured,
 * web_status is lean by default — through the real dispatcher (`_handleCall`),
 * so the argument check and the aliases are part of what is tested.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildMultiDispatcher } from '../../src/core/engine/rv-mcp-tools';
import { clearLogBuffer, debug, logError, logWarn } from '../../src/core/engine/rv-debug';
import { reportProblem, resetProblemsForTests } from '../../src/core/hmi/problems-store';
import type { McpBridgePlugin as McpBridgePluginT } from '../../src/plugins/mcp-bridge-plugin';

let McpBridgePlugin: typeof McpBridgePluginT;

beforeAll(async () => {
  ({ McpBridgePlugin } = await import('../../src/plugins/mcp-bridge-plugin'));
}, 240_000);

afterEach(() => {
  vi.useRealTimers();
  clearLogBuffer();
  resetProblemsForTests();
});

function mockViewer() {
  const signalMap = new Map<string, boolean | number>([
    ['Stapler_1.Status.Fault', false],
    ['Stapler_2.Status.Fault', true],
    ['STAPLER_2.Battery', 0.4],
    ['Conveyor.Start', true],
  ]);
  return {
    drives: [],
    signalStore: { size: signalMap.size, getAll: () => signalMap, get: (n: string) => signalMap.get(n) },
    transportManager: { sensors: [], mus: [], sources: [], sinks: [], stoppers: [], zones: [] },
    logicEngine: { roots: [] },
    errorStore: { getActive: () => [] },
    currentFps: 60,
    connectionState: 'Connected',
    currentModelUrl: '/models/test.glb',
    lastLoadInfo: null,
    simTime: 12.5,
    simulationKernel: { mode: 'des' },
    scene: { traverse: () => {} },
    modes: { activeMode: 'des' },
    currentModelRoot: null,
    isSimulationPaused: false,
    emit: () => {},
    on: () => () => {},
  };
}

function setup() {
  const plugin = new McpBridgePlugin();
  (plugin as unknown as { _aiEnabled: boolean })._aiEnabled = true;
  (plugin as unknown as { viewer: unknown }).viewer = mockViewer();
  (plugin as unknown as { _dispatcher: unknown })._dispatcher = buildMultiDispatcher(plugin.mcpToolInstances);
  const sent: string[] = [];
  (plugin as unknown as { _ws: unknown })._ws = {
    readyState: 1, send: (d: string) => { sent.push(d); }, close: () => {},
  };
  const handle = (plugin as unknown as { _handleMessage: (raw: string) => Promise<void> })._handleMessage.bind(plugin);
  let id = 0;
  /** One call → `{error}` or the parsed result payload. */
  async function call(tool: string, args: Record<string, unknown> = {}): Promise<{ error?: string; value?: any }> {
    const before = sent.length;
    await handle(JSON.stringify({ type: 'call', id: ++id, tool, arguments: args }));
    const msg = JSON.parse(sent[before]);
    if (msg.error) return { error: msg.error };
    return { value: JSON.parse(msg.result) };
  }
  return { call };
}

describe('plan-2005 F6 — the dispatcher refuses undeclared arguments', () => {
  it('names the allowed parameters', async () => {
    const { call } = setup();
    const r = await call('web_logs', { verbose: true });
    expect(r.error).toMatch(/^unknown-param: 'verbose' is not a parameter of web_logs\. Allowed: level, limit, category, since$/);
  });

  it('lets _meta arguments through', async () => {
    const { call } = setup();
    expect((await call('web_logs', { _reason: 'diagnosis' })).error).toBeUndefined();
  });
});

describe('plan-2005 F7 — web_logs', () => {
  function seed() {
    for (let i = 0; i < 30; i++) debug('signal', `sig ${i}`);
    for (let i = 0; i < 5; i++) debug('drive', `drv ${i}`);
    logWarn('a warning');
    logError('an error');
    // The newest 10 entries are NOT signal entries — limit must apply after the filter.
    for (let i = 0; i < 12; i++) debug('loader', `ld ${i}`);
  }

  it('without arguments: no debug/trace entries', async () => {
    const { call } = setup();
    seed();
    const { value } = await call('web_logs');
    expect(value.length).toBe(2);
    expect(value.every((e: { level: string }) => e.level !== 'debug' && e.level !== 'trace')).toBe(true);
  });

  it('level is case-insensitive; an unknown level is an error', async () => {
    const { call } = setup();
    seed();
    const warn = (await call('web_logs', { level: 'WARN' })).value;
    expect(warn.map((e: { level: string }) => e.level)).toEqual(['warn', 'error']);
    const bad = (await call('web_logs', { level: 'loud' })).value;
    expect(bad.error).toContain("invalid level 'loud'");
  });

  it('category filters before the limit; types is the alias', async () => {
    const { call } = setup();
    seed();
    const sig = (await call('web_logs', { level: 'debug', category: 'signal', limit: 10 })).value;
    expect(sig).toHaveLength(10);
    expect(sig.every((e: { category: string }) => e.category === 'signal')).toBe(true);

    const two = (await call('web_logs', { level: 'debug', category: 'signal,drive' })).value;
    expect(new Set(two.map((e: { category: string }) => e.category))).toEqual(new Set(['signal', 'drive']));
    expect(two).toHaveLength(35);
    const alias = (await call('web_logs', { level: 'debug', types: 'signal,drive' })).value;
    expect(alias).toEqual(two);

    const bad = (await call('web_logs', { category: 'signals' })).value;
    expect(bad.error).toContain("unknown category 'signals'");
  });

  it('since keeps only the last N seconds', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-26T10:00:00Z'));
    const { call } = setup();
    debug('signal', 'old');
    vi.setSystemTime(new Date('2026-10-26T10:00:10Z'));
    debug('signal', 'new');
    const r = (await call('web_logs', { level: 'debug', since: 5 })).value;
    expect(r.map((e: { message: string }) => e.message)).toEqual(['new']);
  });
});

describe('plan-2005 F8 — web_signal_list', () => {
  it('filter is a case-insensitive substring, with total / truncated', async () => {
    const { call } = setup();
    const r = (await call('web_signal_list', { filter: 'stapler_2' })).value;
    expect(r.signals.map((s: { name: string }) => s.name)).toEqual(['Stapler_2.Status.Fault', 'STAPLER_2.Battery']);
    expect(r.total).toBe(2);
    expect(r.truncated).toBe(false);
  });

  it('name / pattern aliases and limit', async () => {
    const { call } = setup();
    expect((await call('web_signal_list', { name: 'conveyor' })).value.total).toBe(1);
    const cut = (await call('web_signal_list', { pattern: 'stapler', limit: 2 })).value;
    expect(cut.signals).toHaveLength(2);
    expect(cut.total).toBe(3);
    expect(cut.truncated).toBe(true);
  });

  it('without arguments: every signal', async () => {
    const { call } = setup();
    const r = (await call('web_signal_list')).value;
    expect(r.total).toBe(4);
    expect(r.signals).toHaveLength(4);
    expect(r.truncated).toBe(false);
  });
});

describe('plan-2005 F9 — web_status', () => {
  it('lean by default: no render / bake, but sim and problems', async () => {
    reportProblem({ id: 't-err', severity: 'error', code: 'test-error', title: 'boom', detail: 'e' });
    reportProblem({ id: 't-warn', severity: 'warning', code: 'test-warning', title: 'hm', detail: 'w' });
    const { call } = setup();
    const s = (await call('web_status')).value;
    expect(s.detail).toBe('basic');
    for (const k of ['render', 'bake', 'cache', 'features', 'raytraced']) expect(k in s, k).toBe(false);
    expect(s.problems).toEqual({ error: 1, warning: 1, info: 0 });
    expect(s.sim).toEqual({ kernelMode: 'des', simTime: 12.5 });
    expect(s.mode).toBe('des');
    expect(s.signalCount).toBe(4);
    expect('placements' in s).toBe(true);
  });

  it('an unknown detail is an error', async () => {
    const { call } = setup();
    expect((await call('web_status', { detail: 'everything' })).value.error).toContain("invalid detail 'everything'");
  });
});
