// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-344 Phase 2 — the `--rv-ui-blur-scale` factor.
 *
 * What these tests protect, in order of importance:
 *
 *  1. **The default is unchanged.** The blur inventory is not uniform (16/12/8/6
 *     px), so the dial had to be a dimensionless FACTOR, not an absolute value.
 *     At factor 1 every one of those four classes must still resolve to exactly
 *     its authored radius — otherwise this "performance" change silently
 *     restyles the product.
 *  2. **All four classes react.** At 0.25 every class scales; none is left behind.
 *  3. **Portalled surfaces inherit it.** MUI renders Dialog / Menu / Popover into
 *     `document.body`, outside the HMI root — a token set on the HMI root would
 *     miss exactly the surfaces that cover the most pixels.
 *  4. **Preset semantics.** `Fast` carries 0.25; switching to a preset that
 *     predates the field normalises back to 1 instead of leaving the user on
 *     "Default" with Fast's blur.
 *  5. **A new blur declaration cannot bypass the factor** (source invariant).
 *
 * NOTE on `getComputedStyle`: Chromium resolves `backdrop-filter: blur(calc(...))`
 * to a concrete `blur(Npx)` string, which is what makes assertions 1/2 real
 * end-to-end checks rather than a re-read of the variable we just wrote.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import { Box, Dialog, Menu, Paper } from '@mui/material';
import { rvDarkTheme } from '../src/core/hmi/theme';
import {
  UI_BLUR_SCALE_VAR, DEFAULT_UI_BLUR_SCALE, FAST_UI_BLUR_SCALE,
  applyUIBlurScale, clampUIBlurScale, readUIBlurScale, uiBlur,
} from '../src/core/hmi/rv-ui-blur';
import { loadVisualSettings, saveVisualSettings, getDefaultVisualSettings } from '../src/core/hmi/visual-settings-store';
import {
  captureCurrentPreset, applyVisualPreset, VISUAL_PRESET_FIELDS, type VisualPreset,
} from '../src/core/hmi/visual-presets';
import { setAppConfig } from '../src/core/rv-app-config';
import type { RVViewer } from '../src/core/rv-viewer';

const viewerStub = { applyVisualSettings() { /* no-op */ } } as unknown as RVViewer;

/** Every authored base radius in the HMI (see the inventory assertion below). */
const BASE_RADII = [6, 8, 12, 16] as const;

/** Resolved `backdrop-filter` blur radius in px for a rendered element. */
function computedBlurPx(el: Element): number {
  const cs = getComputedStyle(el) as CSSStyleDeclaration & { webkitBackdropFilter?: string };
  const raw = cs.backdropFilter || cs.webkitBackdropFilter;
  const m = /blur\(([\d.]+)px\)/.exec(raw ?? '');
  if (!m) throw new Error(`no resolved blur in backdrop-filter: '${raw}'`);
  return Number(m[1]);
}

function renderBaseRadiiProbes() {
  return render(
    <ThemeProvider theme={rvDarkTheme}>
      <div>
        {BASE_RADII.map((px) => (
          <Box
            key={px}
            data-testid={`probe-${px}`}
            sx={{ backdropFilter: `blur(calc(${px}px * var(--rv-ui-blur-scale, 1)))` }}
          />
        ))}
      </div>
    </ThemeProvider>,
  );
}

function resetBlurVar(): void {
  document.documentElement.style.removeProperty(UI_BLUR_SCALE_VAR);
}

beforeEach(() => {
  localStorage.clear();
  setAppConfig({});
  resetBlurVar();
});

afterEach(() => {
  cleanup();
  resetBlurVar();
  localStorage.clear();
});

describe('ui blur token — default invariance', () => {
  it('T1 defaults to factor 1 on documentElement and resolves a Paper to blur(16px)', () => {
    applyUIBlurScale(getDefaultVisualSettings().uiBlurScale);
    expect(document.documentElement.style.getPropertyValue(UI_BLUR_SCALE_VAR)).toBe('1');
    expect(readUIBlurScale()).toBe(DEFAULT_UI_BLUR_SCALE);

    render(
      <ThemeProvider theme={rvDarkTheme}>
        <Paper data-testid="paper" />
      </ThemeProvider>,
    );
    expect(computedBlurPx(screen.getByTestId('paper'))).toBe(16);
  });

  it('T8 every authored radius class resolves to EXACTLY its base value at factor 1', () => {
    applyUIBlurScale(1);
    renderBaseRadiiProbes();
    for (const px of BASE_RADII) {
      expect(computedBlurPx(screen.getByTestId(`probe-${px}`))).toBe(px);
    }
  });

  it('T10 an unset variable falls back to the base value (embed builds, first paint)', () => {
    // No applyUIBlurScale() at all — the `var(..., 1)` fallback must hold, which
    // is what keeps the touch-media-query override and the embed UI intact.
    expect(document.documentElement.style.getPropertyValue(UI_BLUR_SCALE_VAR)).toBe('');
    renderBaseRadiiProbes();
    for (const px of BASE_RADII) {
      expect(computedBlurPx(screen.getByTestId(`probe-${px}`))).toBe(px);
    }
  });
});

describe('ui blur token — scaling', () => {
  it('T2 factor 0.25 takes a Paper from 16px to 4px without rebuilding the theme', () => {
    const themeBefore = rvDarkTheme;
    applyUIBlurScale(FAST_UI_BLUR_SCALE);
    render(
      <ThemeProvider theme={rvDarkTheme}>
        <Paper data-testid="paper" />
      </ThemeProvider>,
    );
    expect(computedBlurPx(screen.getByTestId('paper'))).toBe(4);
    // The token path exists precisely so the MUI theme object is untouched
    // (App.tsx memoises it on branding colors only).
    expect(rvDarkTheme).toBe(themeBefore);
  });

  it('T9 all four radius classes scale together at 0.25', () => {
    applyUIBlurScale(0.25);
    renderBaseRadiiProbes();
    expect(computedBlurPx(screen.getByTestId('probe-6'))).toBeCloseTo(1.5, 5);
    expect(computedBlurPx(screen.getByTestId('probe-8'))).toBe(2);
    expect(computedBlurPx(screen.getByTestId('probe-12'))).toBe(3);
    expect(computedBlurPx(screen.getByTestId('probe-16'))).toBe(4);
  });

  it('T3 returning to factor 1 restores blur(16px)', () => {
    applyUIBlurScale(0.25);
    applyUIBlurScale(1);
    render(
      <ThemeProvider theme={rvDarkTheme}>
        <Paper data-testid="paper" />
      </ThemeProvider>,
    );
    expect(computedBlurPx(screen.getByTestId('paper'))).toBe(16);
  });

  it('clamps out-of-range factors instead of switching the glass off', () => {
    // DESIGN.md forbids an opaque / blur-free panel, so 0 must not be reachable.
    expect(clampUIBlurScale(0)).toBe(0.1);
    expect(clampUIBlurScale(-5)).toBe(0.1);
    expect(clampUIBlurScale(4)).toBe(1);
    expect(clampUIBlurScale('nonsense')).toBe(DEFAULT_UI_BLUR_SCALE);
  });
});

describe('ui blur token — portalled surfaces', () => {
  it('T7 a MUI Dialog and Menu (portalled to document.body) also scale', async () => {
    applyUIBlurScale(0.25);
    render(
      <ThemeProvider theme={rvDarkTheme}>
        <>
          <Dialog open PaperProps={{ 'data-testid': 'dialog-paper' } as never}>
            <div>content</div>
          </Dialog>
          <Menu open anchorEl={document.body} slotProps={{ paper: { 'data-testid': 'menu-paper' } as never }}>
            <div>item</div>
          </Menu>
        </>
      </ThemeProvider>,
    );

    const dialogPaper = await screen.findByTestId('dialog-paper');
    const menuPaper = await screen.findByTestId('menu-paper');
    // Proof that the token is NOT on the HMI root: these two nodes are children
    // of document.body, outside any React-rendered wrapper.
    expect(dialogPaper.closest('body')).toBe(document.body);
    expect(computedBlurPx(dialogPaper)).toBe(4);
    expect(computedBlurPx(menuPaper)).toBe(4);
  });
});

describe('ui blur token — visual settings + presets', () => {
  it('T11 saveVisualSettings publishes the factor (boot path sets it before first paint)', () => {
    const s = getDefaultVisualSettings();
    s.uiBlurScale = 0.25;
    saveVisualSettings(s);
    expect(readUIBlurScale()).toBe(0.25);
    // …and it round-trips through localStorage, which is what main.ts reads at
    // boot BEFORE initHMI so a Fast user never sees one frame at full blur.
    expect(loadVisualSettings().uiBlurScale).toBe(0.25);
  });

  it('T5 captureCurrentPreset includes uiBlurScale and it survives JSON serialisation', () => {
    const s = getDefaultVisualSettings();
    s.uiBlurScale = 0.25;
    saveVisualSettings(s);

    const snap = captureCurrentPreset('Snapshot');
    expect(VISUAL_PRESET_FIELDS).toContain('uiBlurScale');
    expect(snap.settings.uiBlurScale).toBe(0.25);

    const roundTripped = JSON.parse(JSON.stringify(snap)) as VisualPreset;
    expect(roundTripped.settings.uiBlurScale).toBe(0.25);
  });

  it('T4 a preset WITHOUT uiBlurScale normalises back to 1 (does not inherit Fast)', () => {
    const fast = captureCurrentPreset('Fast');
    (fast.settings as Record<string, unknown>).uiBlurScale = 0.25;

    const legacyDefault = captureCurrentPreset('Default');
    delete (legacyDefault.settings as Record<string, unknown>).uiBlurScale;

    applyVisualPreset(viewerStub, fast);
    expect(loadVisualSettings().uiBlurScale).toBe(0.25);
    expect(readUIBlurScale()).toBe(0.25);

    applyVisualPreset(viewerStub, legacyDefault);
    // The documented exception to the generic "omitted = keep previous" rule.
    expect(loadVisualSettings().uiBlurScale).toBe(1);
    expect(readUIBlurScale()).toBe(1);
  });

  it('T6 of the shipped presets exactly Fast carries uiBlurScale 0.25', async () => {
    const stems: string[] = await (await fetch('/presets/index.json')).json();
    expect(stems.length).toBeGreaterThan(0);
    const seen: Record<string, number | undefined> = {};
    for (const stem of stems) {
      const preset = await (await fetch(`/presets/${stem}.preset.json`)).json() as VisualPreset;
      seen[preset.name] = (preset.settings as unknown as Record<string, number | undefined>).uiBlurScale;
    }
    expect(seen['Fast']).toBe(0.25);
    for (const [name, value] of Object.entries(seen)) {
      if (name === 'Fast') continue;
      // Either absent (→ normalised to 1 on apply) or explicitly 1. Never a
      // third value: only Fast is allowed to lower the glass.
      expect(value === undefined || value === 1).toBe(true);
    }
  });
});

describe('ui blur token — source invariant', () => {
  // Eagerly inlined source text; the whole point is that a NEW hardcoded blur
  // anywhere under src/ breaks this test.
  const sources = import.meta.glob('../src/**/*.{ts,tsx,css}', {
    query: '?raw', import: 'default', eager: true,
  }) as Record<string, string>;

  /** The module that DEFINES the helper legitimately documents the pattern. */
  const DEFINITION_MODULE = 'rv-ui-blur.ts';

  it('T12 every blur radius under src/ goes through the scale factor', () => {
    const naked: string[] = [];
    const scaled: string[] = [];
    for (const [path, text] of Object.entries(sources)) {
      for (const m of text.matchAll(/blur\((\d+(?:\.\d+)?)px\)/g)) naked.push(`${path}: ${m[0]}`);
      if (path.endsWith(DEFINITION_MODULE)) continue;
      for (const m of text.matchAll(/blur\(calc\(\d+(?:\.\d+)?px \* var\(--rv-ui-blur-scale, 1\)\)\)/g)) {
        scaled.push(`${path}: ${m[0]}`);
      }
    }
    expect(naked).toEqual([]);
    // Locked to the inventory verified on 01.08.2026 (12×12px, 11×8px, 9×16px,
    // 4×6px). A new glass surface must consciously update this number — which is
    // the moment to check it went through the factor. Last raise: the project
    // switcher (rv-project-switcher.tsx, 12px) added on 03.08.2026.
    //
    // 04.08.2026, plan-372: net unchanged at 37. The Projects dashboard
    // (ProjectsDashboard.tsx, 12px) added one — checked, it goes through the
    // scale factor — and Phase 13 deleted rv-project-switcher.tsx, removing the
    // one added the day before.
    //
    // 07.08.2026, plan-397 phase 6: 38. StorageNoticeBanner.tsx (8px) is the
    // consumer the storage layer never had — checked, it goes through the
    // factor, and it deliberately copies GPUWarningBanner's glass so the two
    // top-of-screen banners cannot drift apart.
    //
    // 08.08.2026, plan-410: 42. Three new editor-continuity surfaces, all
    // checked to go through the factor — SceneTransitionOverlay.tsx contributes
    // two (6px on the full-viewport scrim that covers a scene being torn down,
    // 16px on the status card, which copies OmniverseStatusOverlay's glass) and
    // the test-run banner in EditorToolbarButtons.tsx one (16px). The fourth is
    // SharedGlbInfoCard.tsx (8px): plan-386 phase 1 had introduced it as the one
    // NAKED blur in the tree, which is precisely what this invariant exists to
    // catch — so it was converted to the scaled form rather than exempted.
    //
    // 10.08.2026, plan-703 phase 4: still 42, and the exception is worth
    // recording. DocumentStackBar.tsx is a new FLOATING-tier glass surface with
    // a 16px radius, but it calls `uiBlur(16)` instead of writing the calc()
    // inline, so it is not part of this INLINE inventory. It is still scaled —
    // the assertion below pins that the helper emits the identical form.
    //
    // 11.08.2026, plan-423 (merge of main into the plan-423 branch): 43.
    // CommissioningTrustBanner.tsx (8px) — the shared-model trust banner, which
    // copies SigWarningBanner's glass on purpose: the two can stand on screen
    // together and must not look like two different products. Checked, it goes
    // through the factor. plan-703 added no INLINE blur, so its 42 plus this
    // one is 43.
    //
    // 12.08.2026: back to 42 — a REMOVAL, the first one this inventory records.
    // The editor's test-run banner (the 16px added by plan-410 above) is gone:
    // its Play/Stop moved into the leading toolbar group, and a fixed
    // top-center banner then sat on top of the very Stop button it pointed at.
    // Nothing replaced its glass — the red Stop segment and the greyed-out
    // authoring buttons carry the "a run is live" signal now — so this is one
    // inline blur fewer, not one relocated.
    expect(scaled.length).toBe(42);
  });

  it('the uiBlur() helper emits the same form as the inline declarations', () => {
    expect(uiBlur(12)).toBe('blur(calc(12px * var(--rv-ui-blur-scale, 1)))');
  });
});
