// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * C3 / tutorial gap #9 — `problems.ack`: the Problems panel's own action (closing it acknowledges
 * what is listed) as a registry command, optionally narrowed to one id or a code prefix.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RVViewer } from '../src/core/rv-viewer';

async function load() {
  vi.resetModules();
  const store = await import('../src/core/hmi/problems-store');
  store.clearAllProblems(); // the list outlives resetModules; start each case empty
  const panel = await import('../src/core/hmi/ProblemsPanel');
  const reg = await import('../src/core/hmi/rv-command-registry');
  const { ensureDiagnoseCommandsRegistered } = await import('../src/core/diagnostics/diagnose-command-descriptors');
  const { commandClassOf } = await import('../src/plugins/mcp-bridge/rv-mcp-tool-class');
  const registry = new reg.CommandRegistry();
  ensureDiagnoseCommandsRegistered(registry);
  const ack = (args?: unknown) => registry.execute('problems.ack', args, { origin: 'mcp', viewer: {} as RVViewer });
  const report = (id: string, code = 'test', title = 't') =>
    store.reportProblem({ id, severity: 'warning', code, title, detail: 'd' });
  return { store, panel, registry, ack, report, commandClassOf, open: panel.getProblemsPanelOpenForTests };
}

describe('problems.ack (C3 #9)', () => {
  beforeEach(() => {
    localStorage.removeItem('rv-problems-acked');
  });

  it('is a write command of class edit with id/code arguments', async () => {
    const { registry, commandClassOf } = await load();
    const d = registry.get('problems.ack')!;
    expect(d).toMatchObject({ readOnly: false, argsSchema: { id: 'string', code: 'string' }, scope: 'none' });
    expect(commandClassOf(d)).toBe('edit');
    expect(registry.get('problems.list')).toBeDefined();
  });

  it('without arguments does what closing the panel does: closed, and a re-report does not reopen it', async () => {
    const { ack, report, open, store } = await load();
    report('p1');
    report('p2');
    expect(open()).toBe(true);
    expect(await ack()).toMatchObject({ ok: true, value: { acknowledged: ['p1', 'p2'], closed: true } });
    expect(open()).toBe(false);
    store.clearAllProblems();
    report('p1');
    report('p2');
    expect(open()).toBe(false);
    report('p3');
    expect(open()).toBe(true);
  });

  it('with an id acknowledges only that entry; the panel closes once nothing is left', async () => {
    const { ack, report, open, panel } = await load();
    report('a', 'alpha');
    report('b', 'beta');
    expect(await ack({ id: 'a' })).toMatchObject({ ok: true, value: { acknowledged: ['a'], closed: false } });
    expect(open()).toBe(true);
    // Closing by hand later acknowledges b as well; a re-reported a is no news.
    panel.setProblemsPanelOpen(false);
    report('a', 'alpha', 't');
    expect(open()).toBe(false);
  });

  it('a code prefix that covers every entry closes the panel; acked entries stay quiet', async () => {
    const { ack, report, open, store } = await load();
    report('x1', 'fleet-wait');
    report('x2', 'fleet-blocked');
    expect(await ack({ code: 'fleet-' })).toMatchObject({ ok: true, value: { closed: true } });
    expect(open()).toBe(false);
    store.clearProblem('x1');
    report('x1', 'fleet-wait');
    expect(open()).toBe(false);
  });

  it('refuses a filter that matches nothing and a non-string id', async () => {
    const { ack, report } = await load();
    report('p1');
    expect(await ack({ id: 'nope' })).toMatchObject({ ok: false, kind: 'threw', reason: 'No problem matches' });
    expect(await ack({ id: 5 })).toMatchObject({ ok: false, reason: 'id must be a string' });
  });
});
