// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * C3 review fixes: diagnose commands exist the moment the sim controller does (the recording seam
 * dispatches at once), sequential `problems.ack` calls close the panel, and a window that got a
 * panelId keeps the geometry stored under its old title key.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import { rvDarkTheme } from '../src/core/hmi/theme';
import type { RVViewer } from '../src/core/rv-viewer';

vi.mock('../src/hooks/use-mobile-layout', async importOriginal => ({
  ...await importOriginal<typeof import('../src/hooks/use-mobile-layout')>(),
  useMobileLayout: () => false,
}));
vi.mock('../src/core/hmi/panel-anchor-store', async importOriginal => ({
  ...await importOriginal<typeof import('../src/core/hmi/panel-anchor-store')>(),
  getRecentAnchorPoint: () => null,
  getCSSViewportSize: () => ({ w: 1600, h: 1200 }),
}));

afterEach(() => cleanup());

describe('C3 review fixes', () => {
  it('registers the diagnose commands synchronously with the sim controller', async () => {
    const { SimControllerPlugin } = await import('../src/plugins/sim-controller');
    const { commandRegistry } = await import('../src/core/hmi/rv-command-registry');
    new SimControllerPlugin({ shortcuts: false });
    for (const id of ['des.status', 'problems.list', 'problems.ack', 'diagnose']) expect(commandRegistry.get(id), id).toBeDefined();
    const r = await commandRegistry.execute('des.status', {}, { origin: 'ui', viewer: { modes: { activeMode: 'hmi' } } as unknown as RVViewer });
    expect(r).not.toMatchObject({ kind: 'unknown' });
  });

  it('closes the panel when sequential acks leave nothing unacknowledged', async () => {
    localStorage.removeItem('rv-problems-acked');
    vi.resetModules();
    const store = await import('../src/core/hmi/problems-store');
    store.clearAllProblems();
    const panel = await import('../src/core/hmi/ProblemsPanel');
    const reg = await import('../src/core/hmi/rv-command-registry');
    const { ensureDiagnoseCommandsRegistered } = await import('../src/core/diagnostics/diagnose-command-descriptors');
    const registry = new reg.CommandRegistry();
    ensureDiagnoseCommandsRegistered(registry);
    const ack = (args: unknown) => registry.execute('problems.ack', args, { origin: 'mcp', viewer: {} as RVViewer });
    store.reportProblem({ id: 'a', severity: 'warning', code: 'c', title: 'A', detail: 'd' });
    store.reportProblem({ id: 'b', severity: 'warning', code: 'c', title: 'B', detail: 'd' });
    expect(panel.getProblemsPanelOpenForTests()).toBe(true);
    expect(await ack({ id: 'a' })).toMatchObject({ ok: true, value: { closed: false } });
    expect(panel.getProblemsPanelOpenForTests()).toBe(true);
    expect(await ack({ id: 'b' })).toMatchObject({ ok: true, value: { acknowledged: ['b'], closed: true } });
    expect(panel.getProblemsPanelOpenForTests()).toBe(false);
    store.clearAllProblems();
  });

  it('migrates geometry and collapsed state from the old title key to the new panelId once', { timeout: 60_000 }, async () => {
    const { FloatingPanel } = await import('../src/core/hmi/FloatingPanel');
    localStorage.setItem('rv-panel-geo:Event Queue', JSON.stringify({ x: 300, y: 200, w: 520, h: 330 }));
    localStorage.setItem('rv-panel-collapsed:Event Queue', '1');
    localStorage.removeItem('rv-panel-geo:des-event-queue');
    localStorage.removeItem('rv-panel-collapsed:des-event-queue');
    try {
      render(<ThemeProvider theme={rvDarkTheme}>
        <FloatingPanel open panelId="des-event-queue" title="Event Queue" collapsible persistCollapsed onClose={() => {}}><div>q</div></FloatingPanel>
      </ThemeProvider>);
      expect(JSON.parse(localStorage.getItem('rv-panel-geo:des-event-queue')!)).toEqual({ x: 300, y: 200, w: 520, h: 330 });
      expect(localStorage.getItem('rv-panel-collapsed:des-event-queue')).toBe('1');
      expect(localStorage.getItem('rv-panel-geo:Event Queue')).toBeNull();
      expect(localStorage.getItem('rv-panel-collapsed:Event Queue')).toBeNull();
      await waitFor(() => {
        const el = document.querySelector('[data-ui-panel]') as HTMLElement | null;
        expect(el && parseFloat(getComputedStyle(el).width)).toBe(520);
      }, { timeout: 15000, interval: 25 });
      // A key that already exists under the new id is never overwritten by an old one.
      cleanup();
      localStorage.setItem('rv-panel-geo:Event Queue', JSON.stringify({ x: 1, y: 1, w: 400, h: 300 }));
      render(<ThemeProvider theme={rvDarkTheme}>
        <FloatingPanel open panelId="des-event-queue" title="Event Queue" onClose={() => {}}><div>q</div></FloatingPanel>
      </ThemeProvider>);
      expect(JSON.parse(localStorage.getItem('rv-panel-geo:des-event-queue')!)).toMatchObject({ w: 520 });
    } finally {
      for (const k of ['rv-panel-geo:Event Queue', 'rv-panel-collapsed:Event Queue', 'rv-panel-geo:des-event-queue', 'rv-panel-collapsed:des-event-queue']) localStorage.removeItem(k);
    }
  });

  it('keeps the old key when the new one cannot be written (storage full) and migrates on the next try', async () => {
    const { migratePanelKeys } = await import('../src/core/hmi/floating-panel-store');
    const keys = ['rv-panel-geo:Quota Win', 'rv-panel-collapsed:Quota Win', 'rv-panel-geo:quota-win', 'rv-panel-collapsed:quota-win'];
    localStorage.setItem(keys[0], JSON.stringify({ x: 1, y: 2, w: 400, h: 300 }));
    localStorage.setItem(keys[1], '1');
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    try {
      migratePanelKeys('Quota Win', 'quota-win');
      expect(localStorage.getItem(keys[0])).not.toBeNull();
      expect(localStorage.getItem(keys[1])).toBe('1');
      expect(localStorage.getItem(keys[2])).toBeNull();
      setItem.mockRestore();
      migratePanelKeys('Quota Win', 'quota-win');
      expect(JSON.parse(localStorage.getItem(keys[2])!)).toEqual({ x: 1, y: 2, w: 400, h: 300 });
      expect(localStorage.getItem(keys[3])).toBe('1');
      expect(localStorage.getItem(keys[0])).toBeNull();
      expect(localStorage.getItem(keys[1])).toBeNull();
    } finally {
      setItem.mockRestore();
      for (const k of keys) localStorage.removeItem(k);
    }
  });
});
