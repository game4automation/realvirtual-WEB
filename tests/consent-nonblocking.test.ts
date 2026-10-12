// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-598 §9.1 — the boot runs behind an open consent dialog; only Google
 * Analytics waits for the answer.
 *
 * `startNonBlockingConsent` is the whole rule `main.ts` used to spell out as
 * `const analyticsConsent = await requireAnalyticsConsent(); if (…) initAnalytics();`.
 * Pinned here as BEHAVIOUR instead of a source regex:
 *   - nothing waits on the question (the caller gets control back at once);
 *   - `initAnalytics` runs only after `granted`, exactly once;
 *   - a `model_view` reported while the question is open is fired exactly once
 *     on the grant, never on a decline;
 *   - after the grant every `model_view` goes out immediately.
 */

import { describe, it, expect, vi } from 'vitest';
import { startNonBlockingConsent } from '../src/core/rv-consent-boot';
import type { AnalyticsConsentOutcome } from '../src/core/hmi/consent-gate';

function deferredConsent() {
  let answer!: (o: AnalyticsConsentOutcome) => void;
  const promise = new Promise<AnalyticsConsentOutcome>((r) => { answer = r; });
  return { promise, answer };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe('startNonBlockingConsent (plan-598 F1)', () => {
  it('returns at once while the dialog is open and loads nothing before the answer', async () => {
    const q = deferredConsent();
    const initAnalytics = vi.fn();
    const track = vi.fn();
    const consent = startNonBlockingConsent({ requireConsent: () => q.promise, initAnalytics, track });
    // The boot continues here — e.g. a model loads behind the dialog.
    consent.modelView({ model: 'DemoRealvirtualWeb' });
    await flush();
    expect(initAnalytics).not.toHaveBeenCalled();
    expect(track).not.toHaveBeenCalled();
  });

  it('a late grant loads GA once and fires the held model_view exactly once', async () => {
    const q = deferredConsent();
    const initAnalytics = vi.fn();
    const track = vi.fn();
    const consent = startNonBlockingConsent({ requireConsent: () => q.promise, initAnalytics, track });
    consent.modelView({ model: 'First' });
    consent.modelView({ model: 'Second' }); // only the latest view is kept
    q.answer('granted');
    await flush();
    expect(initAnalytics).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith('model_view', { model: 'Second' });
    // From now on views go out immediately — and the held one is not repeated.
    consent.modelView({ model: 'Third' });
    expect(track).toHaveBeenCalledTimes(2);
    expect(track).toHaveBeenLastCalledWith('model_view', { model: 'Third' });
    await flush();
    expect(initAnalytics).toHaveBeenCalledTimes(1);
  });

  it('a decline never loads GA and never sends a model_view — not even later', async () => {
    const q = deferredConsent();
    const initAnalytics = vi.fn();
    const track = vi.fn();
    const consent = startNonBlockingConsent({ requireConsent: () => q.promise, initAnalytics, track });
    consent.modelView({ model: 'Held' });
    q.answer('declined');
    await flush();
    consent.modelView({ model: 'After' });
    await flush();
    expect(initAnalytics).not.toHaveBeenCalled();
    expect(track).not.toHaveBeenCalled();
  });

  it('a prior consent (resolves immediately) behaves like before: GA first, then every view', async () => {
    const initAnalytics = vi.fn();
    const track = vi.fn();
    const consent = startNonBlockingConsent({
      requireConsent: () => Promise.resolve('granted'), initAnalytics, track,
    });
    await flush();
    expect(initAnalytics).toHaveBeenCalledTimes(1);
    consent.modelView({ model: 'M' });
    expect(track).toHaveBeenCalledWith('model_view', { model: 'M' });
  });

  it('no tracker configured: initAnalytics is still the decision point (a no-op there)', async () => {
    const initAnalytics = vi.fn();
    const track = vi.fn();
    startNonBlockingConsent({ requireConsent: () => Promise.resolve('not-configured'), initAnalytics, track });
    await flush();
    expect(initAnalytics).toHaveBeenCalledTimes(1);
  });
});
