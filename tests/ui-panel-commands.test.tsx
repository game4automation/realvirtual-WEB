// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import { FloatingPanel } from '../src/core/hmi/FloatingPanel';
import { rvDarkTheme } from '../src/core/hmi/theme';
import { CommandRegistry } from '../src/core/hmi/rv-command-registry';
import { ensureUiPanelCommandsRegistered } from '../src/core/hmi/ui-panel-commands';
import type { RVViewer } from '../src/core/rv-viewer';

vi.mock('../src/hooks/use-mobile-layout', async importOriginal => ({
  ...await importOriginal<typeof import('../src/hooks/use-mobile-layout')>(),
  useMobileLayout: () => false,
}));
vi.mock('../src/core/hmi/panel-anchor-store', async importOriginal => ({
  ...await importOriginal<typeof import('../src/core/hmi/panel-anchor-store')>(),
  getRecentAnchorPoint: () => null,
  // The commanded rectangle must fit even in the browser suite's mobile viewport.
  getCSSViewportSize: () => ({ w: 1600, h: 1200 }),
}));

const WAIT = { timeout: 15000, interval: 25 };
const geoKey = 'rv-panel-geo:stats-hub';
const collapsedKey = 'rv-panel-collapsed:stats-hub';
const rect = [72, 400, 1120, 640];
let registry: CommandRegistry;
beforeEach(() => {
  localStorage.removeItem(geoKey);
  localStorage.removeItem(collapsedKey);
  registry = new CommandRegistry();
  ensureUiPanelCommandsRegistered(registry);
});
afterEach(() => {
  cleanup();
  localStorage.removeItem(geoKey);
  localStorage.removeItem(collapsedKey);
});

const execute = (args: Record<string, unknown>) => registry.execute('ui.panel', {
  panelId: 'stats-hub', ...args,
}, { origin: 'ui', viewer: {} as RVViewer });

function mount() {
  render(<ThemeProvider theme={rvDarkTheme}>
    <FloatingPanel panelId="stats-hub" title="Statistics" open collapsible persistCollapsed onClose={() => {}}>
      <div data-testid="chart-content">chart</div>
    </FloatingPanel>
  </ThemeProvider>);
}

async function expectGeometry() {
  await waitFor(() => {
    const panel = document.querySelector('[data-ui-panel]');
    expect(panel).not.toBeNull();
    const style = getComputedStyle(panel!);
    expect([style.left, style.top, style.width, style.height].map(parseFloat)).toEqual(rect);
  }, WAIT);
  expect(JSON.parse(localStorage.getItem(geoKey)!)).toEqual({ x: 72, y: 400, w: 1120, h: 640 });
}

describe('ui.panel command (plan-2031)', () => {
  it.each([
    { name: 'below minimum size at the top-left edge', input: [0, 0, 200, 120], expected: [72, 8, 320, 200] },
    { name: 'overflowing the right edge', input: [1500, 0, 600, 240], expected: [992, 8, 600, 240] },
  ])('normalizes $name identically before mount, while open and after reopening', { timeout: 60_000 }, async ({ input, expected }) => {
    expect(await execute({ rect: input })).toMatchObject({ ok: true });
    const panel = (open: boolean) => <ThemeProvider theme={rvDarkTheme}>
      <FloatingPanel panelId="stats-hub" title="Statistics" open={open} minWidth={320} onClose={() => {}}>
        <div data-testid="chart-content">chart</div>
      </FloatingPanel>
    </ThemeProvider>;
    const view = render(panel(true));
    const geometry = async () => {
      await waitFor(() => {
        const element = document.querySelector('[data-ui-panel]');
        expect(element).not.toBeNull();
        const style = getComputedStyle(element!);
        expect([style.left, style.top, style.width, style.height].map(parseFloat)).toEqual(expected);
      }, WAIT);
    };
    await geometry();

    // Move elsewhere first so the live update must actually restore the requested rectangle.
    await act(async () => { expect(await execute({ rect })).toMatchObject({ ok: true }); });
    await act(async () => { expect(await execute({ rect: input })).toMatchObject({ ok: true }); });
    await geometry();
    const [x, y, w, h] = expected;

    view.rerender(panel(false));
    await waitFor(() => expect(document.querySelector('[data-ui-panel]')).toBeNull(), WAIT);
    expect(JSON.parse(localStorage.getItem(geoKey)!)).toEqual({ x, y, w, h });
    view.rerender(panel(true));
    await geometry();
    expect(JSON.parse(localStorage.getItem(geoKey)!)).toEqual({ x, y, w, h });
  });

  it('moves and sizes a mounted panel and persists its rectangle', async () => {
    mount();
    await act(async () => { expect(await execute({ rect })).toMatchObject({ ok: true }); });
    await expectGeometry();
  });

  it('restores a command issued before mount', async () => {
    expect(await execute({ rect })).toMatchObject({ ok: true });
    mount();
    await expectGeometry();
  });

  it('rejects zero width atomically, including a simultaneous collapse request', async () => {
    mount();
    await act(async () => { await execute({ rect }); });
    const before = [localStorage.getItem(geoKey), localStorage.getItem(collapsedKey)];
    await act(async () => {
      expect(await execute({ rect: [0, 0, 0, 10], collapsed: true })).toMatchObject({
        ok: false, reason: expect.stringContaining('width and height must be greater than 0'),
      });
    });
    expect([localStorage.getItem(geoKey), localStorage.getItem(collapsedKey)]).toEqual(before);
    expect(screen.queryByTestId('chart-content')).not.toBeNull();
    await expectGeometry();
  });

  it('collapses a mounted panel and persists the state', async () => {
    mount();
    await act(async () => { expect(await execute({ collapsed: true })).toMatchObject({ ok: true }); });
    expect(screen.queryByTestId('chart-content')).toBeNull();
    expect(screen.getByLabelText('Expand panel').getAttribute('aria-expanded')).toBe('false');
    expect(localStorage.getItem(collapsedKey)).toBe('1');
  });
});
