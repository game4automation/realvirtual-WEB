// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * One loading indicator at a time (2026-08-19 rework).
 *
 * The branded full-screen splash (`#loading-overlay`, main.ts) owns a model
 * load. While it is up, the scene-transition overlay ("Opening editor…") must
 * stay SUPPRESSED — the splash already covers the canvas, which is the only
 * job a destructive transition needs done — and must SURFACE the moment the
 * splash goes if its holder is still alive. Sequential, never stacked.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getSceneTransitionSnapshot,
  hide,
  setBrandedSplashVisible,
  showNowAndPaint,
  _resetSceneTransition,
} from '../src/core/hmi/scene-transition-store';

describe('scene transition vs. branded splash', () => {
  beforeEach(() => { _resetSceneTransition(); });

  it('a transition held while the splash is up stays invisible', async () => {
    setBrandedSplashVisible(true);
    const token = await showNowAndPaint('Opening editor…');
    expect(getSceneTransitionSnapshot().visible).toBe(false);
    hide(token);
  });

  it('the held transition surfaces when the splash goes', async () => {
    setBrandedSplashVisible(true);
    const token = await showNowAndPaint('Opening editor…');
    setBrandedSplashVisible(false);
    const snap = getSceneTransitionSnapshot();
    expect(snap.visible).toBe(true);
    expect(snap.label).toBe('Opening editor…');
    hide(token);
  });

  it('a transition released under the splash never appears at all', async () => {
    setBrandedSplashVisible(true);
    const token = await showNowAndPaint('Opening editor…');
    hide(token);
    setBrandedSplashVisible(false);
    expect(getSceneTransitionSnapshot().visible).toBe(false);
  });

  it('showNowAndPaint does not hang while suppressed', async () => {
    // The paint waiter must resolve promptly even though nothing will paint —
    // a scene transition must never hold the actual load hostage on cosmetics.
    setBrandedSplashVisible(true);
    const t0 = performance.now();
    const token = await showNowAndPaint('Opening editor…');
    expect(performance.now() - t0).toBeLessThan(1_000);
    hide(token);
  });

  it('without a splash the transition shows as before', async () => {
    const token = await showNowAndPaint('Opening editor…');
    expect(getSceneTransitionSnapshot().visible).toBe(true);
    hide(token);
  });
});
