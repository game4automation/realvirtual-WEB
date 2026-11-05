// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * C3 / tutorial gaps #10 and #11 — `ui.panel.list`, `ui.panel.open`, `ui.panel.close`: every
 * window is discoverable by a stable panelId (the Event Queue included) and opens the way its own
 * button opens it; the experiment windows are a commercial feature without the experiment manager.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import { useSyncExternalStore } from 'react';
import { rvDarkTheme } from '../src/core/hmi/theme';
import { CommandRegistry } from '../src/core/hmi/rv-command-registry';
import { ensureUiPanelCommandsRegistered } from '../src/core/hmi/ui-panel-commands';
import { FloatingPanel } from '../src/core/hmi/FloatingPanel';
import { DESEventQueueWindow } from '../src/plugins/des/hmi/DESEventQueueWindow';
import type { DESRunner } from '../src/plugins/des/des-runner';
import {
  isEventQueueWindowOpen, setEventQueueWindowOpen, subscribeEventQueueWindow,
} from '../src/plugins/sim-controller/event-queue-window-store';
import { closeStatsHub, isStatsHubOpen } from '../src/core/stats/stats-hub-store';
import { registerPanelOpener } from '../src/core/hmi/panel-registry';
import { commandClassOf } from '../src/plugins/mcp-bridge/rv-mcp-tool-class';
import type { RVViewer } from '../src/core/rv-viewer';

vi.mock('../src/hooks/use-mobile-layout', async importOriginal => ({
  ...await importOriginal<typeof import('../src/hooks/use-mobile-layout')>(),
  useMobileLayout: () => false,
}));

const WAIT = { timeout: 15000, interval: 25 };
const fakeSource = {
  getManager: () => ({ mode: 'animated', isComplete: false, pendingEventCount: 0, getEventQueueSnapshot: () => [] }),
} as unknown as DESRunner;

/** What event-queue-overlay renders: the window following the shared open-store. */
function EventQueueHost() {
  const open = useSyncExternalStore(subscribeEventQueueWindow, isEventQueueWindowOpen);
  return <DESEventQueueWindow source={fakeSource} open={open} onClose={() => setEventQueueWindowOpen(false)} />;
}

let registry: CommandRegistry;
const run = (id: string, args: unknown = {}) => registry.execute(id, args, { origin: 'mcp', viewer: {} as RVViewer });
const list = async () => {
  const r = await run('ui.panel.list');
  expect(r.ok).toBe(true);
  return (r as { value: { panels: Array<{ panelId: string; title: string; open: boolean; openable: boolean }> } }).value.panels;
};

beforeEach(() => {
  registry = new CommandRegistry();
  ensureUiPanelCommandsRegistered(registry);
  setEventQueueWindowOpen(false);
  closeStatsHub();
});
afterEach(() => {
  cleanup();
  setEventQueueWindowOpen(false);
  localStorage.removeItem('rv-panel-geo:des-event-queue');
});

describe('ui.panel.list / open / close (C3 #10, #11)', () => {
  it('registers list as read and open/close as edit', () => {
    expect(commandClassOf(registry.get('ui.panel.list')!)).toBe('read');
    expect(commandClassOf(registry.get('ui.panel.open')!)).toBe('edit');
    expect(commandClassOf(registry.get('ui.panel.close')!)).toBe('edit');
    expect(registry.get('ui.panel.open')!.argsSchema).toEqual({ panelId: 'string', target: 'string' });
  });

  it('lists the core windows, stats-hub included, with title and open state', async () => {
    const panels = await list();
    expect(panels).toEqual(expect.arrayContaining([
      { panelId: 'stats-hub', title: 'Statistics', open: false, openable: true },
      { panelId: 'des-event-queue', title: 'Event Queue', open: false, openable: true },
      expect.objectContaining({ panelId: 'problems', openable: true }),
    ]));
  });

  it('opens and closes the Event Queue like its button; it is a mounted window with a stable id', { timeout: 60_000 }, async () => {
    render(<ThemeProvider theme={rvDarkTheme}><EventQueueHost /></ThemeProvider>);
    expect(await run('ui.panel.open', { panelId: 'des-event-queue' })).toMatchObject({ ok: true });
    expect(isEventQueueWindowOpen()).toBe(true);
    await waitFor(async () => {
      expect((await list()).find(p => p.panelId === 'des-event-queue')).toMatchObject({ title: 'Event Queue', open: true });
    }, WAIT);
    // The geometry command reaches it under the same id.
    expect(await run('ui.panel', { panelId: 'des-event-queue', rect: [100, 100, 500, 300] })).toMatchObject({ ok: true });
    expect(JSON.parse(localStorage.getItem('rv-panel-geo:des-event-queue')!)).toMatchObject({ w: 500, h: 300 });
    expect(await run('ui.panel.close', { panelId: 'des-event-queue' })).toMatchObject({ ok: true });
    expect(isEventQueueWindowOpen()).toBe(false);
  });

  it('opens the statistics window through its store', async () => {
    expect(await run('ui.panel.open', { panelId: 'stats-hub' })).toMatchObject({ ok: true });
    expect(isStatsHubOpen()).toBe(true);
    expect(await run('ui.panel.close', { panelId: 'stats-hub' })).toMatchObject({ ok: true });
    expect(isStatsHubOpen()).toBe(false);
  });

  it('a mounted window without an opener is listed and can be closed, not opened', { timeout: 60_000 }, async () => {
    const onClose = vi.fn();
    render(<ThemeProvider theme={rvDarkTheme}>
      <FloatingPanel open panelId="c3-plain" title="Plain" onClose={onClose}><div>x</div></FloatingPanel>
    </ThemeProvider>);
    await waitFor(async () => {
      expect((await list()).find(p => p.panelId === 'c3-plain')).toEqual({ panelId: 'c3-plain', title: 'Plain', open: true, openable: false });
    }, WAIT);
    expect(await run('ui.panel.open', { panelId: 'c3-plain' })).toMatchObject({ ok: false, reason: expect.stringContaining('no opener') });
    expect(await run('ui.panel.close', { panelId: 'c3-plain' })).toMatchObject({ ok: true });
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => { cleanup(); });
    expect((await list()).some(p => p.panelId === 'c3-plain')).toBe(false);
  });

  it('a registered opener receives the drill-down target and may refuse', async () => {
    const seen: Array<[boolean, string | undefined]> = [];
    const off = registerPanelOpener('c3-drill', {
      title: 'Runs', setOpen: (open, target) => { seen.push([open, target]); return open && !target ? 'target required' : undefined; },
    });
    try {
      expect(await run('ui.panel.open', { panelId: 'c3-drill' })).toMatchObject({ ok: false, reason: 'target required' });
      expect(await run('ui.panel.open', { panelId: 'c3-drill', target: 'Base' })).toMatchObject({ ok: true });
      expect(seen).toEqual([[true, undefined], [true, 'Base']]);
    } finally { off(); }
  });

  it('refuses the experiment windows as commercial-feature while the experiment manager is absent', async () => {
    for (const panelId of ['des-experiment-matrix', 'des-matrix-runs']) {
      expect(await run('ui.panel.open', { panelId, target: 'Base' })).toMatchObject({
        ok: false, kind: 'commercial-feature', details: { module: 'des-experiments' },
      });
    }
    expect(await run('ui.panel.open', { panelId: 'nope' })).toMatchObject({ ok: false, kind: 'threw', reason: "Unknown panel 'nope'" });
    expect(await run('ui.panel.open', {})).toMatchObject({ ok: false, reason: 'panelId must be a string' });
  });
});
