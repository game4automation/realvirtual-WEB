// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-591 §9.3 — the two quality rows in the render-mode menu.
 *
 * The axis they add is NOT the shading axis: they are `kind: 'action'`, so the
 * three shading rows stay the only exclusive (radio) set. And their active
 * marking is checked against `listShippedPresets()` — the same list they
 * resolve against (F12) — otherwise a row could mark a preset active that it
 * would never apply.
 *
 * The published tier is seeded through the real `loadPublishedPresets()`: in
 * browser mode Vite serves `public/presets/`, so this exercises the shipped
 * files that actually ship rather than a hand-built stand-in.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { RVViewerProvider } from '../src/hooks/use-viewer';
import { commandRegistry } from '../src/core/hmi/rv-command-registry';
import { setAppConfig } from '../src/core/rv-app-config';
import { RenderModeGroup } from '../src/core/hmi/RenderModeBar';
import {
  loadPublishedPresets, listShippedPresets, matchPreset, applyVisualPreset,
  type VisualPreset,
} from '../src/core/hmi/visual-presets';
import { loadVisualSettings, saveVisualSettings } from '../src/core/hmi/visual-settings-store';
import { fakeRenderViewer, type FakeRenderViewer } from './helpers/fake-render-viewer';

const mount = (viewer: FakeRenderViewer) =>
  render(<RVViewerProvider value={viewer as never}><RenderModeGroup /></RVViewerProvider>);

const trigger = () => screen.getByTestId('render-mode-trigger');
const menu = () => screen.getByRole('menu');
const openMenu = async () => {
  fireEvent.click(trigger());
  await waitFor(() => expect(screen.queryByRole('menu')).not.toBeNull());
};

/** A viewer a preset apply can run against. */
function presetViewer(): FakeRenderViewer {
  const v = fakeRenderViewer({ renderMode: 'default', mode: 'viewer' }) as unknown as Record<string, unknown>;
  v['applyVisualSettings'] = () => { /* recorded by the fake's `calls` where relevant */ };
  v['antialiasActive'] = true;
  v['maxDpr'] = 0;
  return v as unknown as FakeRenderViewer;
}

function putLocalPreset(p: VisualPreset): void {
  const raw = localStorage.getItem('rv-visual-presets');
  const arr: VisualPreset[] = raw ? JSON.parse(raw) : [];
  localStorage.setItem('rv-visual-presets', JSON.stringify([...arr.filter((x) => x.name !== p.name), p]));
}

beforeEach(async () => {
  localStorage.clear();
  setAppConfig({});
  await loadPublishedPresets();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  setAppConfig({});
  vi.restoreAllMocks();
});

describe('render-mode menu — quality rows', () => {
  it('both rows exist, are actions, and leave the three shading rows the only radio set', async () => {
    mount(presetViewer());
    await openMenu();
    const maxQuality = screen.getByTestId('visual-preset-default');
    const fast = screen.getByTestId('visual-preset-fast');
    expect(maxQuality).toBeInTheDocument();
    expect(fast).toBeInTheDocument();
    // An icon row carries its label in `aria-label` + tooltip, not as text
    // (action-group: `{icon ?? <Box>{label}</Box>}`).
    expect(maxQuality).toHaveAttribute('aria-label', 'Max Quality');
    expect(fast).toHaveAttribute('aria-label', 'Fast');
    expect(maxQuality).toHaveAttribute('aria-description', 'Shadows, reflections, native resolution');
    // `kind: 'action'` — NOT part of the exclusive mode group.
    expect(within(menu()).getAllByRole('menuitemradio')).toHaveLength(3);
    expect(maxQuality.getAttribute('role')).toBe('menuitem');
    expect(fast.getAttribute('role')).toBe('menuitem');
  });

  it('the row of the ACTIVE shipped preset is marked, the other is not', async () => {
    const viewer = presetViewer();
    const fast = listShippedPresets().find((p) => p.name === 'Fast')!;
    applyVisualPreset(viewer, fast);
    expect(matchPreset(listShippedPresets())).toBe('Fast');
    mount(viewer);
    await openMenu();
    expect(screen.getByTestId('visual-preset-fast')).toHaveAttribute('data-active', 'true');
    expect(screen.getByTestId('visual-preset-default')).toHaveAttribute('data-active', 'false');
  });

  it('the marking follows a preset apply with NO new preset event (render-mode-changed is enough)', async () => {
    const viewer = presetViewer();
    const def = listShippedPresets().find((p) => p.name === 'Default')!;
    const fast = listShippedPresets().find((p) => p.name === 'Fast')!;
    applyVisualPreset(viewer, def);
    mount(viewer);
    await openMenu();
    expect(screen.getByTestId('visual-preset-default')).toHaveAttribute('data-active', 'true');

    // A real apply on the MOUNTED bar. The fake's `applyVisualSettings` emits
    // nothing, so this leans on exactly the channel the implementation claims:
    // `render-mode-changed` (emitted by the fake's renderMode setter) plus the
    // settings channel.
    act(() => { applyVisualPreset(viewer, fast); });
    await waitFor(() => expect(screen.getByTestId('visual-preset-fast')).toHaveAttribute('data-active', 'true'));
    expect(screen.getByTestId('visual-preset-default')).toHaveAttribute('data-active', 'false');
  });

  it('the marking follows a SINGLE slider change too — nothing is active on "Custom"', async () => {
    const viewer = presetViewer();
    applyVisualPreset(viewer, listShippedPresets().find((p) => p.name === 'Default')!);
    mount(viewer);
    await openMenu();
    expect(screen.getByTestId('visual-preset-default')).toHaveAttribute('data-active', 'true');

    // One dial moved, persisted only — no `render-mode-changed` at all. In
    // round 1 this was a documented stale-marking gap; `subscribeVisualSettings`
    // is what turned it into a requirement.
    //
    // 4, not 7: the store validates `shadowRadius` to 1..5 and silently falls
    // back to the default 2 otherwise — which is the shipped Default's own
    // value, so an out-of-range number would leave the preset still matching
    // and the test would be asserting nothing.
    expect(loadVisualSettings().shadowRadius).toBe(2);
    act(() => { saveVisualSettings({ ...loadVisualSettings(), shadowRadius: 4 }); });
    expect(loadVisualSettings().shadowRadius).toBe(4);
    await waitFor(() => expect(screen.getByTestId('visual-preset-default')).toHaveAttribute('data-active', 'false'));
    expect(screen.getByTestId('visual-preset-fast')).toHaveAttribute('data-active', 'false');
  });

  it('F12: a LOCAL "Default" does not mark the fixed row active', async () => {
    const viewer = presetViewer();
    // Apply a local preset that merely CALLS itself Default and is otherwise junk.
    const local: VisualPreset = {
      name: 'Default', schemaVersion: 1,
      settings: { maxDpr: 0.5, shadowRadius: 11 } as unknown as VisualPreset['settings'],
    };
    putLocalPreset(local);
    applyVisualPreset(viewer, local);
    // `listPresets()` would say "Default" — the shipped list must not.
    expect(matchPreset(listShippedPresets())).not.toBe('Default');
    mount(viewer);
    await openMenu();
    expect(screen.getByTestId('visual-preset-default')).toHaveAttribute('data-active', 'false');
  });

  it('a click dispatches view.visualPreset with source shipped', async () => {
    const viewer = presetViewer();
    const spy = vi.spyOn(commandRegistry, 'execute');
    mount(viewer);
    await openMenu();
    fireEvent.click(screen.getByTestId('visual-preset-default'));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    const call = spy.mock.calls.find((c) => c[0] === 'view.visualPreset');
    expect(call, 'the row must be a view of view.visualPreset').toBeDefined();
    expect(call![1]).toEqual({ name: 'Default', source: 'shipped' });
  });

  it('the trigger proxies both new button keys, and stays within the fixed slot count', async () => {
    mount(presetViewer());
    const proxy = trigger().getAttribute('data-rv-button-proxy') ?? '';
    expect(proxy).toContain('view.visualPreset:Default');
    expect(proxy).toContain('view.visualPreset:Fast');
    // Three shading keys + wireframe + two quality keys = 6 = PROXY_KEY_SLOTS.
    // A seventh key would be silently ignored by the trigger's fixed hook list.
    expect(proxy.split(/[\s,]+/).filter(Boolean)).toHaveLength(6);
  });

  it('the trigger keeps naming the MODE, never the quality row', async () => {
    const viewer = presetViewer();
    applyVisualPreset(viewer, listShippedPresets().find((p) => p.name === 'Default')!);
    mount(viewer);
    expect(trigger().getAttribute('aria-label')).toMatch(/^Render mode: /);
    expect(trigger().getAttribute('aria-label')).not.toMatch(/Max Quality/);
  });

  it('a locked Visual tab renders no segment at all — quality rows included', () => {
    setAppConfig({ lockedTabs: ['visual'] });
    mount(presetViewer());
    expect(screen.queryByTestId('render-mode-trigger')).toBeNull();
    expect(screen.queryByTestId('visual-preset-default')).toBeNull();
  });
});
