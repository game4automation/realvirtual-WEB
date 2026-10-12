// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-591 §9.4 — the antialias reload hint.
 *
 * Two things are under test, and the second is the one that is easy to miss:
 *
 *  1. The hint has its OWN derived state: it appears on a mismatch, disappears
 *     when the mismatch goes, survives a concurrent `withInfoOverlay` and a
 *     model load, dims nothing, and comes back after a dismiss on the NEXT
 *     apply (the dismiss epoch).
 *  2. **F13 covers BOTH display paths.** The Visual tab has had its own
 *     "Reload required" + "Reload now" since long before this plan. Gating only
 *     the new host would have left exactly the ineffective button standing that
 *     F13 exists to remove — one level deeper, where nobody looks.
 *
 * `isMobileDevice` is mocked rather than simulated: it is result-cached after
 * the first call, so a media-query fake would be read once per session and
 * could not be flipped between cases.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RVViewerProvider } from '../src/hooks/use-viewer';
import { setAppConfig } from '../src/core/rv-app-config';
import {
  loadVisualSettings, saveVisualSettings, getDefaultVisualSettings,
} from '../src/core/hmi/visual-settings-store';
import { applyVisualPreset, type VisualPreset } from '../src/core/hmi/visual-presets';
import { ReloadHintHost, dismissReloadHint, resetReloadHintDismiss } from '../src/core/hmi/reload-hint-store';
import { VisualTab } from '../src/core/hmi/settings/VisualTab';
import { visualTabCapableFake, type FakeRenderViewer } from './helpers/fake-render-viewer';

// ── The one device-class seam (F13) ──────────────────────────────────────
const isMobile = vi.hoisted(() => ({ value: false }));
vi.mock('../src/hooks/use-mobile-layout', async (orig) => {
  const actual = await orig<typeof import('../src/hooks/use-mobile-layout')>();
  return { ...actual, isMobileDevice: () => isMobile.value };
});

/** A viewer whose renderer has NO MSAA — the interesting half of the mismatch. */
function hintViewer(antialiasActive: boolean): FakeRenderViewer {
  const v = visualTabCapableFake({ renderMode: 'default', mode: 'viewer' }) as unknown as Record<string, unknown>;
  v['antialiasActive'] = antialiasActive;
  v['applyVisualSettings'] = () => { /* no renderer in this test */ };
  return v as unknown as FakeRenderViewer;
}

const mountHost = (viewer: FakeRenderViewer) =>
  render(<RVViewerProvider value={viewer as never}><ReloadHintHost /></RVViewerProvider>);

const mountTab = (viewer: FakeRenderViewer) =>
  render(<RVViewerProvider value={viewer as never}><VisualTab /></RVViewerProvider>);

const preset = (name: string, settings: Record<string, unknown>): VisualPreset =>
  ({ name, schemaVersion: 1, settings: settings as unknown as VisualPreset['settings'] });

/** Persist a desired antialias value without any preset involved. */
function setDesiredAntialias(on: boolean): void {
  saveVisualSettings({ ...loadVisualSettings(), antialias: on });
}

const hint = () => screen.queryByTestId('reload-hint');

beforeEach(() => {
  localStorage.clear();
  setAppConfig({});
  isMobile.value = false;
  resetReloadHintDismiss();
  saveVisualSettings(getDefaultVisualSettings());
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  setAppConfig({});
  resetReloadHintDismiss();
  vi.restoreAllMocks();
});

describe('reload hint — own derived state', () => {
  it('appears on a mismatch and offers a reload', () => {
    setDesiredAntialias(true);
    mountHost(hintViewer(false));
    expect(hint()).not.toBeNull();
    expect(hint()).toHaveTextContent('Antialiasing needs a reload to take effect.');
    expect(screen.getByTestId('reload-hint-reload')).toHaveTextContent('Reload now');
  });

  it('stays away while settings and renderer agree', () => {
    setDesiredAntialias(true);
    mountHost(hintViewer(true));
    expect(hint()).toBeNull();
  });

  it('appears after MOUNT when only the antialias switch is persisted (no render-mode-changed)', async () => {
    setDesiredAntialias(false);
    mountHost(hintViewer(false));
    expect(hint()).toBeNull();
    // This is the path `render-mode-changed` does NOT cover: the Visual tab's
    // antialias switch only persists (`persist({antialias: v})`).
    act(() => setDesiredAntialias(true));
    await waitFor(() => expect(hint()).not.toBeNull());
  });

  it('disappears again when the mismatch goes — no imperative hide anywhere', async () => {
    const viewer = hintViewer(false);
    mountHost(viewer);
    // Fast (no MSAA) → Default (MSAA) → Fast.
    act(() => { applyVisualPreset(viewer, preset('Fast', { antialias: false })); });
    expect(hint()).toBeNull();
    act(() => { applyVisualPreset(viewer, preset('Default', { antialias: true })); });
    await waitFor(() => expect(hint()).not.toBeNull());
    act(() => { applyVisualPreset(viewer, preset('Fast', { antialias: false })); });
    await waitFor(() => expect(hint()).toBeNull());
  });

  it('dismiss hides it, and the SAME apply brings it back (the apply epoch)', async () => {
    const viewer = hintViewer(false);
    mountHost(viewer);
    act(() => { applyVisualPreset(viewer, preset('Default', { antialias: true })); });
    await waitFor(() => expect(hint()).not.toBeNull());

    fireEvent.click(screen.getByTestId('reload-hint-dismiss'));
    await waitFor(() => expect(hint()).toBeNull());

    // The identical apply again — a plain mismatch boolean would stay silent
    // here forever, which is exactly the bug the epoch prevents.
    act(() => { applyVisualPreset(viewer, preset('Default', { antialias: true })); });
    await waitFor(() => expect(hint()).not.toBeNull());
  });

  it('a concurrent info overlay neither hides nor overwrites it, and the shared store is untouched', async () => {
    const overlay = await import('../src/core/hmi/info-overlay-store');
    const viewer = hintViewer(false);
    mountHost(viewer);
    act(() => { applyVisualPreset(viewer, preset('Default', { antialias: true })); });
    await waitFor(() => expect(hint()).not.toBeNull());

    // A model load / any operation using the shared single-slot overlay.
    await act(async () => {
      await overlay.withInfoOverlay('Loading…', async () => { /* an unrelated job */ });
    });
    overlay.hideInfoOverlay();
    expect(hint(), 'a global hideInfoOverlay must not reach this hint').not.toBeNull();
    act(() => { overlay.showInfoOverlay('Model loaded'); });
    expect(hint(), 'the single overlay slot must not overwrite this hint').not.toBeNull();
  });

  it('dims nothing: no full-screen scrim and no pointer-events capture', () => {
    setDesiredAntialias(true);
    mountHost(hintViewer(false));
    const el = hint()!;
    const style = window.getComputedStyle(el);
    // A small fixed box, not a sheet over the viewport.
    expect(style.position).toBe('fixed');
    expect(el.getBoundingClientRect().width).toBeLessThan(window.innerWidth);
    expect(el.getBoundingClientRect().height).toBeLessThan(window.innerHeight / 2);
  });
});

describe('reload hint — F13, the seam to plan-592 (both display paths)', () => {
  it('(a) desktop with a mismatch: the HOST shows it', () => {
    setDesiredAntialias(true);
    mountHost(hintViewer(false));
    expect(hint()).not.toBeNull();
  });

  it('(b) touch device with the SAME mismatch: the HOST shows nothing', () => {
    isMobile.value = true;
    setDesiredAntialias(true);
    mountHost(hintViewer(false));
    expect(hint()).toBeNull();
  });

  it('(c) desktop: the Visual tab hint is there, unchanged', async () => {
    setDesiredAntialias(true);
    mountTab(hintViewer(false));
    await waitFor(() => expect(screen.queryByText('Reload required')).not.toBeNull());
    expect(screen.getByText('Reload now')).toBeInTheDocument();
  });

  it('(d) touch device: the Visual tab hint is suppressed TOO — the easily-forgotten path', async () => {
    isMobile.value = true;
    setDesiredAntialias(true);
    mountTab(hintViewer(false));
    // The tab itself renders (this is not a crash test) …
    await waitFor(() => expect(screen.queryByText('Antialiasing')).not.toBeNull());
    // … but the ineffective button is gone.
    expect(screen.queryByText('Reload required')).toBeNull();
    expect(screen.queryByText('Reload now')).toBeNull();
  });

  it('the touch gate changes NOTHING else about the apply', () => {
    isMobile.value = true;
    const viewer = hintViewer(false);
    mountHost(viewer);
    const r = applyVisualPreset(viewer, preset('Default', { antialias: true, maxDpr: 2 }));
    // The apply still reports the mismatch honestly — only the DISPLAY is gated.
    expect(r.antialiasNeedsReload).toBe(true);
    expect(loadVisualSettings().maxDpr).toBe(2);
    expect(loadVisualSettings().antialias).toBe(true);
    expect(hint()).toBeNull();
  });

  it('dismissReloadHint is inert while the gate is on (no state surprises)', () => {
    isMobile.value = true;
    setDesiredAntialias(true);
    mountHost(hintViewer(false));
    expect(() => dismissReloadHint()).not.toThrow();
    expect(hint()).toBeNull();
  });
});
