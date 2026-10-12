// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-consent-boot — the analytics consent question WITHOUT blocking the boot
 * (plan-598 F1).
 *
 * Until plan-598 `main.ts` awaited `requireAnalyticsConsent()` before it created
 * the viewer: on the public demo a first-time visitor stared at the consent
 * dialog while nothing loaded behind it, and every second they spent reading it
 * came on top of the load time. Loading our OWN resources needs no consent
 * (§ 25 TDDDG is about access to the end device; third-party embedding before
 * consent is what is not allowed). So the boot now runs behind the open dialog
 * and only the third-party part — Google Analytics — waits for the answer:
 *
 *   - `granted`        → `initAnalytics()` (gtag injected) once, at that moment;
 *   - `declined`       → never;
 *   - `not-configured` → `initAnalytics()` is a no-op without a tracker id.
 *
 * The first `model_view` event usually happens BEFORE a human has clicked
 * "Accept" now. It is kept (the latest one only) and fired exactly once when
 * consent arrives; after that every `model_view` goes out immediately. A
 * declined session never sends it.
 *
 * The password gate is NOT part of this: it stays blocking and runs BEFORE the
 * consent question is even asked (`main.ts`), so the consent dialog can never
 * cover the password overlay.
 */

import type { AnalyticsConsentOutcome } from './hmi/consent-gate';

export interface NonBlockingConsentDeps {
  /** Shows the dialog when needed; resolves with the outcome. */
  requireConsent: () => Promise<AnalyticsConsentOutcome>;
  /** Injects the tracker (idempotent, no-op without an id). */
  initAnalytics: () => void;
  /** Sends one event (no-op while no tracker is loaded). */
  track: (name: string, params?: Record<string, unknown>) => void;
}

export interface NonBlockingConsent {
  /** Settles when the question is answered. Never awaited by the boot. */
  readonly outcome: Promise<AnalyticsConsentOutcome>;
  /** Report a `model_view`: sent now when consent is in, else held for the grant. */
  modelView(params: Record<string, unknown>): void;
}

export function startNonBlockingConsent(deps: NonBlockingConsentDeps): NonBlockingConsent {
  let analyticsOn = false;
  let settled = false;
  let pendingModelView: Record<string, unknown> | null = null;

  const outcome = deps.requireConsent();
  void outcome.then((answer) => {
    settled = true;
    if (answer === 'declined') { pendingModelView = null; return; }
    deps.initAnalytics();
    analyticsOn = true;
    if (pendingModelView) {
      const params = pendingModelView;
      pendingModelView = null;
      deps.track('model_view', params);
    }
  }, () => { settled = true; pendingModelView = null; });

  return {
    outcome,
    modelView(params) {
      if (analyticsOn) { deps.track('model_view', params); return; }
      // A declined (or failed) question never sends anything — not even later.
      if (settled) return;
      pendingModelView = params;
    },
  };
}
