// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * consent-url-decline.test.ts — plan-564 F6/F14: `?consent=decline` is a
 * SESSION DECLINE of the analytics question, modelled as its own state.
 *
 * With a tracker configured the viewer starts without the blocking dialog and
 * without analytics; nothing is persisted as consent; the URL can only ever
 * decline, never grant.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getAppConfig, setAppConfig } from '../src/core/rv-app-config';
import {
  SESSION_DECLINE_KEY,
  hasAnalyticsConsent,
  hasAnalyticsSessionDecline,
  readConsentUrlDirective,
  resetAnalyticsConsent,
  resetAnalyticsSessionDecline,
} from '../src/core/consent-store';
import { requireAnalyticsConsent } from '../src/core/hmi/consent-gate';
// The suite runs in a real browser: the boot source is read through Vite, not node:fs.
import mainSource from '../src/main.ts?raw';

const GATE_ID = 'rv-consent-gate-root';
let savedConfig: ReturnType<typeof getAppConfig>;

beforeEach(() => {
  savedConfig = getAppConfig();
  localStorage.clear();
  sessionStorage.clear();
  resetAnalyticsConsent();
  resetAnalyticsSessionDecline();
  setAppConfig({ ...savedConfig, analytics: { googleAnalyticsId: 'G-TEST123' } });
});

afterEach(() => {
  document.getElementById(GATE_ID)?.remove();
  setAppConfig(savedConfig);
  sessionStorage.clear();
});

describe('?consent=decline (plan-564)', () => {
  it('a tracker is configured, the viewer starts without the dialog, analytics stays off', async () => {
    const outcome = await requireAnalyticsConsent('?consent=decline&doc=demo');

    expect(outcome).toBe('declined');
    expect(document.getElementById(GATE_ID)).toBeNull();
    expect(hasAnalyticsConsent()).toBe(false);
    expect(localStorage.getItem('rv-analytics-consent')).toBeNull();
    expect(hasAnalyticsSessionDecline()).toBe(true);
    expect(sessionStorage.getItem(SESSION_DECLINE_KEY)).toBe('1');
  });

  it('the decline holds for the session even when a later URL drops the parameter', async () => {
    await requireAnalyticsConsent('?consent=decline');
    expect(await requireAnalyticsConsent('')).toBe('declined');
  });

  it('the URL can only decline: any other value shows the blocking gate', async () => {
    expect(readConsentUrlDirective('?consent=grant')).toBeNull();
    expect(readConsentUrlDirective('?consent=accept')).toBeNull();
    expect(readConsentUrlDirective('?consent=decline')).toBe('decline');

    let settled = false;
    void requireAnalyticsConsent('?consent=grant').then(() => { settled = true; });
    await Promise.resolve();
    expect(document.getElementById(GATE_ID)).not.toBeNull();
    expect(settled).toBe(false);
    expect(hasAnalyticsConsent()).toBe(false);
  });

  it('without a tracker nothing is asked and nothing is declined', async () => {
    setAppConfig({ ...savedConfig, analytics: undefined });
    expect(await requireAnalyticsConsent('?consent=decline')).toBe('not-configured');
    expect(hasAnalyticsSessionDecline()).toBe(false);
  });

  it('a prior opt-in still wins over a decline link', async () => {
    localStorage.setItem('rv-analytics-consent', 'granted');
    // The store reads its initial state at module load; an explicit opt-in is
    // what the user gave, and a link must not silently withdraw it.
    const { grantAnalyticsConsent } = await import('../src/core/consent-store');
    grantAnalyticsConsent();
    expect(await requireAnalyticsConsent('?consent=decline')).toBe('granted');
  });

  // plan-598: the boot no longer awaits the question — the "only when not
  // declined" rule moved into `startNonBlockingConsent` and is pinned there as
  // BEHAVIOUR (tests/consent-nonblocking.test.ts). What stays pinned on main.ts
  // is the wiring: the gate is the one that decides, analytics is loaded only
  // through it, and the boot does not wait for it.
  it('main.ts routes analytics through the non-blocking consent and never awaits the question', () => {
    const main = mainSource;
    expect(main).toMatch(/startNonBlockingConsent\(\{\s*requireConsent: \(\) => requireAnalyticsConsent\(\),\s*initAnalytics,/);
    expect(main).not.toMatch(/await requireAnalyticsConsent\(/);
    // initAnalytics is never called directly — only the consent outcome may load GA.
    const code = main.replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/\binitAnalytics\(\)/);
  });
});
