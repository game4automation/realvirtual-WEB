// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, beforeEach, vi } from 'vitest';

// The open state lives at module level, so every test gets fresh modules.
async function load() {
  vi.resetModules();
  const store = await import('../src/core/hmi/problems-store');
  const panel = await import('../src/core/hmi/ProblemsPanel');
  return { store, panel, readOpen: panel.getProblemsPanelOpenForTests };
}

const report = (store: typeof import('../src/core/hmi/problems-store'), id = 'p1', title = 't') =>
  store.reportProblem({ id, severity: 'warning', code: 'test', title, detail: 'd' });

describe('ProblemsPanel — once closed, opens again only on news', () => {
  beforeEach(() => {
    localStorage.removeItem('rv-problems-acked');
    localStorage.removeItem('rv-problems-dismissed');
  });

  it('opens for a first problem', async () => {
    const { store, readOpen } = await load();
    report(store);
    expect(readOpen()).toBe(true);
  });

  it('stays closed when the identical set is reported again (reload, flicker, other doc key)', async () => {
    const { store, panel, readOpen } = await load();
    store.setProblemsDocument('blob:1');
    report(store);
    panel.setProblemsPanelOpen(false);

    store.clearAllProblems();
    store.setProblemsDocument('blob:2'); // same model, fresh url
    report(store);
    expect(readOpen()).toBe(false);

    store.clearProblem('p1'); // flicker out and back in
    report(store);
    expect(readOpen()).toBe(false);
  });

  it('opens again when a new problem appears', async () => {
    const { store, panel, readOpen } = await load();
    report(store, 'p1');
    panel.setProblemsPanelOpen(false);
    report(store, 'p2');
    expect(readOpen()).toBe(true);
  });

  it('opens again when an acknowledged problem changes its headline', async () => {
    const { store, panel, readOpen } = await load();
    report(store, 'p1', 'not found');
    panel.setProblemsPanelOpen(false);
    report(store, 'p1', 'could not be loaded');
    expect(readOpen()).toBe(true);
  });

  it('plan-628 8.11g: a quiet entry is never news (listed, panel stays closed); an error is', async () => {
    const { store, panel, readOpen } = await load();
    panel.setProblemsPanelOpen(false); // start closed (acknowledges whatever is listed)
    const u = `${Date.now()}-${Math.random().toString(36).slice(2)}`; // never acknowledged before
    store.reportProblem({ id: `path-network:path-open-end:A${u}`, severity: 'info', code: 'path-open-end', title: 'open', detail: 'd', quiet: true });
    store.reportProblem({ id: `path-network:path-radius-too-tight:A${u}:0`, severity: 'warning', code: 'path-radius-too-tight', title: 'tight', detail: 'd', quiet: true });
    expect(store.getProblems().filter((p) => p.id.endsWith(u) || p.id.endsWith(`${u}:0`))).toHaveLength(2);
    expect(readOpen()).toBe(false);
    // An error from the same publisher is reported loud → news, the panel opens.
    store.reportProblem({ id: `path-network:path-kink:A${u}>B`, severity: 'error', code: 'path-kink', title: 'kink', detail: 'd' });
    expect(readOpen()).toBe(true);
  });

  it('does not open when a problem merely goes away', async () => {
    const { store, panel, readOpen } = await load();
    report(store, 'p1');
    report(store, 'p2');
    panel.setProblemsPanelOpen(false);
    store.clearProblem('p2');
    expect(readOpen()).toBe(false);
  });

  it('survives a page reload; the user can always open it', async () => {
    let m = await load();
    report(m.store);
    m.panel.setProblemsPanelOpen(false);

    m = await load(); // fresh modules = page reload
    report(m.store);
    expect(m.readOpen()).toBe(false);

    m.panel.toggleProblemsPanel(); // user opens it
    expect(m.readOpen()).toBe(true);
  });
});
