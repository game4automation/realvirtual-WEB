// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-344 Phase 4 — the three lazy panels, behaviourally.
 *
 * `bundle-splitting.test.ts` proves the chunks exist and left the entry. This
 * file proves the runtime half, which is where the real risk lives:
 *
 *  - the chunk is NOT fetched until the panel is first opened (a `React.lazy`
 *    whose parent renders it unconditionally would load it immediately — the
 *    exact trap Phase 4 was written around),
 *  - the gating pattern differs per target and MUST: `hasLoaded || open` for the
 *    Matrix and the Layout Library, because both hold user state that a plain
 *    `{open && …}` would silently discard on every close; a real unmount only for
 *    the Settings tabs, which hold none,
 *  - the mobile reveal tab still works before the library chunk exists,
 *  - and a chunk that fails to load degrades to an inline notice instead of
 *    taking the whole overlay down.
 *
 * "Was the chunk fetched?" is observed through `performance.getEntriesByType
 * ('resource')`: in the browser test runner a dynamic import is a real network
 * request for the module URL. Tests that assert "not requested" therefore run
 * BEFORE the ones that open the panel — a module stays in the browser's cache
 * (and in the resource timeline) for the rest of the page's life.
 */

import React, { Suspense, lazy, useState } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import { LazyPanelBoundary } from '../src/core/hmi/LazyPanelBoundary';
import { LayoutLibraryPanelHost } from '../src/plugins/layout-planner/LayoutLibraryPanelHost';
import { DESControllerToolbar } from '../src/plugins/sim-controller/DESControllerToolbar';
import { toggleDesMatrixWindow, closeDesMatrixWindow } from '../src/plugins/sim-controller/des-matrix-window-store';
import { LeftPanelManager } from '../src/core/hmi/left-panel-manager';
import { activateContext, deactivateContext } from '../src/core/hmi/ui-context-store';
import { rvDarkTheme } from '../src/core/hmi/theme';
import { RVViewerProvider } from '../src/hooks/use-viewer';
import type { RVViewer } from '../src/core/rv-viewer';
import desToolbarSource from '../src/plugins/sim-controller/DESControllerToolbar.tsx?raw';
import settingsPanelSource from '../src/core/hmi/SettingsPanel.tsx?raw';
import plannerIndexSource from '../src/plugins/layout-planner/index.ts?raw';

const LAYOUT_PANEL_ID = 'layout-planner';

// The resource timeline is this file's only witness, and it is a FIXED-SIZE
// buffer: browsers keep 250 entries by default and then silently drop every
// later one. This file's own module graph (the DES toolbar, the planner, three
// `?raw` sources and their transitive imports) already costs ~250 entries, so
// the lazy chunk's entry — recorded last, at the moment that actually matters —
// fell off the end. The panel opened and the chunk loaded exactly as specified;
// `moduleRequested` just never saw it, and the waits below burned their full
// budget waiting for evidence that had been discarded on arrival.
// A raised ceiling, not a longer timeout, is the fix: the reported symptom was
// a timeout, but nothing was ever slow.
performance.setResourceTimingBufferSize(20_000);

/**
 * How often the browser fetched a module whose URL matches `pattern`.
 *
 * A PATTERN, not a substring: `LayoutLibraryPanelHost.tsx` contains the string
 * `LayoutLibraryPanel`, so a naive `includes()` would report the lazy chunk as
 * already loaded the moment its (eager) host module was imported.
 */
function moduleRequests(pattern: RegExp): number {
  return performance.getEntriesByType('resource').filter((e) => pattern.test(e.name)).length;
}

function moduleRequested(pattern: RegExp): boolean {
  return moduleRequests(pattern) > 0;
}

const MATRIX_MODULE = /DESExperimentMatrixPanel\.tsx/;
const LIBRARY_MODULE = /\/LayoutLibraryPanel\.tsx/;

function themed(node: React.ReactNode, viewer: RVViewer) {
  return (
    <ThemeProvider theme={rvDarkTheme}>
      <RVViewerProvider value={viewer}>{node}</RVViewerProvider>
    </ThemeProvider>
  );
}

function makeViewer(extra: Record<string, unknown> = {}): RVViewer {
  return {
    leftPanelManager: new LeftPanelManager(),
    simulationKernel: null,
    simulationPauseReasons: new Set<string>(),
    simulationPaused: false,
    registry: null,
    signalStore: null,
    on: () => () => {},
    emit: () => {},
    getPlugin: () => undefined,
    ...extra,
  } as unknown as RVViewer;
}

/** Minimal kernel that reports "a DES runner exists", which is what unlocks the
 *  toolbar branch holding the Experiment Matrix window. */
function makeDesViewer(): RVViewer {
  const desControl = {
    subMode: 'animated', multiplier: 1, ffProgress: null,
    eventStats: () => ({ currentTime: 0, processed: 0, pending: 0 }),
    endTime: Infinity, statResetTime: 0, masterSeed: 42,
    setSubMode: () => {}, setEndTime: () => {}, setStatResetTime: () => {},
  };
  return makeViewer({
    simulationKernel: {
      mode: 'des',
      isSwitching: false,
      hasDesRunner: () => true,
      desControl: () => desControl,
    },
  });
}

beforeEach(() => { localStorage.clear(); });
afterEach(() => {
  cleanup();
  closeDesMatrixWindow();
  deactivateContext('planner');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

// ── T1 / T4: nothing is fetched before the first open ───────────────────────
// These MUST come first in file order: once a module has been imported, its
// resource-timing entry stays for the rest of the page.

describe('lazy panels — nothing loads before the first open', () => {
  it('T1 the DES toolbar with the Matrix window closed does not request its chunk', async () => {
    render(themed(<DESControllerToolbar viewer={makeDesViewer()} />, makeDesViewer()));
    await act(async () => { await new Promise((r) => setTimeout(r, 100)); });
    expect(moduleRequested(MATRIX_MODULE)).toBe(false);
  });

  it('T4a the planner overlay host with the library closed does not request its chunk', async () => {
    render(themed(<LayoutLibraryPanelHost />, makeViewer()));
    await act(async () => { await new Promise((r) => setTimeout(r, 100)); });
    expect(moduleRequested(LIBRARY_MODULE)).toBe(false);
  });

  it('T5 the mobile reveal tab appears WITHOUT pulling the library chunk', async () => {
    // `useMobileLayout` is a media query; stub matchMedia so the compact layout
    // is reported without resizing the runner window.
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('max-width'),
      media: query,
      onchange: null,
      addListener: () => {}, removeListener: () => {},
      addEventListener: () => {}, removeEventListener: () => {},
      dispatchEvent: () => false,
    }));
    activateContext('planner');

    render(themed(<LayoutLibraryPanelHost />, makeViewer()));
    // The tab is the ONLY way into the library on a phone, so it has to exist
    // before the chunk does.
    expect(await screen.findByText('Library')).toBeTruthy();
    expect(moduleRequested(LIBRARY_MODULE)).toBe(false);
  });
});

// ── T2 / T3 / T4b: opening loads once and keeps state ───────────────────────

describe('lazy panels — first open loads the chunk, reopen does not', () => {
  it('T4b opening the library loads the chunk; closing keeps the panel mounted', async () => {
    const viewer = makeViewer();
    const lpm = viewer.leftPanelManager;
    render(themed(<LayoutLibraryPanelHost />, viewer));

    await act(async () => {
      lpm.open(LAYOUT_PANEL_ID, 320, 'right');
      await new Promise((r) => setTimeout(r, 250));
    });
    // Explicit budget: testing-library's default is 1 s, which raced the lazy
    // chunk's dynamic import once the full 864-file suite contended for the
    // dev server. The assertion is unchanged — only the patience is.
    await waitFor(() => expect(moduleRequested(LIBRARY_MODULE)).toBe(true), { timeout: 15_000 });

    // `hasLoaded || open`: after closing, the host still renders the loaded
    // panel (which hides itself) rather than dropping it — that is what keeps
    // the active tab, the search text and the chip filter alive.
    await act(async () => {
      lpm.close(LAYOUT_PANEL_ID);
      await new Promise((r) => setTimeout(r, 100));
    });
    // Reopening must not need a second fetch (module cache + still mounted).
    const entriesBefore = moduleRequests(LIBRARY_MODULE);
    await act(async () => {
      lpm.open(LAYOUT_PANEL_ID, 320, 'right');
      await new Promise((r) => setTimeout(r, 150));
    });
    const entriesAfter = moduleRequests(LIBRARY_MODULE);
    expect(entriesAfter).toBe(entriesBefore);
  });

  it('T2/T3 opening the Matrix loads its chunk once and keeps it mounted after close', async () => {
    const viewer = makeDesViewer();
    render(themed(<DESControllerToolbar viewer={viewer} />, viewer));

    await act(async () => {
      toggleDesMatrixWindow();
      await new Promise((r) => setTimeout(r, 300));
    });
    // Explicit budget — see the note on the library chunk above.
    await waitFor(() => expect(moduleRequested(MATRIX_MODULE)).toBe(true), { timeout: 15_000 });

    const before = moduleRequests(MATRIX_MODULE);
    await act(async () => {
      closeDesMatrixWindow();
      await new Promise((r) => setTimeout(r, 100));
      toggleDesMatrixWindow();
      await new Promise((r) => setTimeout(r, 200));
    });
    const after = moduleRequests(MATRIX_MODULE);
    expect(after).toBe(before);
  });
});

// ── The gating contract, asserted at the source ─────────────────────────────

describe('lazy panels — the gating pattern is the one the plan requires', () => {
  it('the Matrix is imported dynamically and gated on hasLoaded||open', () => {
    expect(desToolbarSource).not.toMatch(/import\s*\{[^}]*DESExperimentMatrixPanel[^}]*\}\s*from/);
    expect(desToolbarSource).toMatch(/lazy\(\s*\(\)\s*=>\s*\n?\s*import\('\.\/DESExperimentMatrixPanel'\)/);
    // Without this gate the lazy import would fire on the toolbar's first render.
    expect(desToolbarSource).toContain('{(matrixEverOpened || runsOpen) && (');
  });

  it('the Layout Library slot registers the HOST, not the panel', () => {
    expect(plannerIndexSource).toContain('component: LayoutLibraryPanelHost');
    expect(plannerIndexSource).not.toMatch(/import\s*\{\s*LayoutLibraryPanel\s*\}\s*from\s*'\.\/LayoutLibraryPanel'/);
  });

  it('T6 the Settings tabs keep the existing real-unmount gate', () => {
    // Settings tabs hold no long-lived state, so `{settingsTab === N && …}` is
    // both the pre-existing behaviour AND a valid lazy gate — nothing to change
    // beyond the import. Asserted so a later "optimisation" to hasLoaded||open
    // (which would keep 11 tabs mounted) has to argue with a test.
    for (const tab of ['VisualTab', 'DevToolsTab', 'GroupsTab', 'McpTab']) {
      expect(settingsPanelSource).toMatch(new RegExp(`const ${tab} = lazy\\(\\(\\) => import\\('\\./settings/`));
    }
    expect(settingsPanelSource).toMatch(/settingsTab === 1 && !isTabLocked\('visual'\) && <VisualTab \/>/);
    expect(settingsPanelSource).toContain('<LazyPanelBoundary label="Settings tab">');
  });
});

// ── T7: a failed chunk must not take the overlay down ───────────────────────

describe('lazy panels — chunk load failure is contained', () => {
  const FailingLazy = lazy(() => Promise.reject(new Error('Failed to fetch dynamically imported module')));

  it('T7 shows an inline notice and leaves the rest of the HMI operable', async () => {
    // The boundary logs the cause; silence it so the failure path is not
    // mistaken for a broken test run.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    let clicks = 0;
    render(
      <ThemeProvider theme={rvDarkTheme}>
        <>
          <button onClick={() => { clicks++; }}>Other HMI control</button>
          <LazyPanelBoundary label="Experiment Matrix">
            <FailingLazy />
          </LazyPanelBoundary>
        </>
      </ThemeProvider>,
    );

    const notice = await screen.findByTestId('lazy-panel-error');
    expect(notice.textContent).toContain('Experiment Matrix');
    expect(errorSpy).toHaveBeenCalled();

    // The rest of the overlay is untouched — no white screen.
    fireEvent.click(screen.getByText('Other HMI control'));
    expect(clicks).toBe(1);
  });

  it('shows the Suspense fallback while a chunk is in flight, then the panel', async () => {
    let resolve!: () => void;
    const gate = new Promise<void>((r) => { resolve = r; });
    const SlowLazy = lazy(async () => {
      await gate;
      return { default: () => <div data-testid="slow-panel">panel</div> };
    });

    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>open</button>
          {open && (
            <LazyPanelBoundary label="Slow panel">
              <SlowLazy />
            </LazyPanelBoundary>
          )}
        </>
      );
    }

    render(<ThemeProvider theme={rvDarkTheme}><Host /></ThemeProvider>);
    expect(screen.queryByTestId('lazy-panel-loading')).toBeNull();

    fireEvent.click(screen.getByText('open'));
    expect(await screen.findByTestId('lazy-panel-loading')).toBeTruthy();

    await act(async () => { resolve(); await Promise.resolve(); });
    expect(await screen.findByTestId('slow-panel')).toBeTruthy();
    expect(screen.queryByTestId('lazy-panel-loading')).toBeNull();
  });
});

// Keep `Suspense` referenced so the import stays meaningful for readers who
// wonder where the fallback lives — it is inside LazyPanelBoundary.
void Suspense;
