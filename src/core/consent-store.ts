// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Analytics consent (GDPR / §25 TDDDG).
 *
 * Google Analytics is a non-essential tracker: it sets cookies and transfers
 * personal data, so it must NOT load until the user has actively opted in.
 * This store persists that opt-in and gates both initAnalytics() and the
 * blocking consent gate shown at startup.
 *
 * Only an explicit 'granted' is persisted (localStorage). Anything else counts
 * as "undecided" — the gate is shown again on the next load. Consent can be
 * withdrawn (resetAnalyticsConsent) so revoking is as easy as giving it.
 *
 * When no analytics id is configured (e.g. private/self-hosted deploys),
 * isAnalyticsConfigured() is false and the whole consent flow is skipped —
 * the app boots normally with no banner and no gate.
 *
 * A SESSION DECLINE (plan-564 F6/F14) is a third, separate state: the link
 * parameter `?consent=decline` answers the dialog with "no" for this browser
 * session — the app starts, analytics never loads. It is kept apart from the
 * opt-in on purpose: it can never be read as consent, it is not persisted
 * beyond the session (sessionStorage), and declining unlocks nothing that the
 * Decline button does not — which is why any link may carry it.
 */

import { useSyncExternalStore } from 'react';
import { getAppConfig } from './rv-app-config';

const STORAGE_KEY = 'rv-analytics-consent';
/** sessionStorage key of the per-session decline (plan-564). */
export const SESSION_DECLINE_KEY = 'rv-analytics-declined-session';

const listeners = new Set<() => void>();
let granted = readInitial();
/** In-memory mirror of the session decline (sessionStorage may be disabled). */
let sessionDeclined = false;

function readInitial(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'granted';
  } catch {
    return false; // private mode / storage disabled
  }
}

function emit(): void {
  for (const l of listeners) l();
}

/** True when a tracker is configured in settings.json (analytics.googleAnalyticsId). */
export function isAnalyticsConfigured(): boolean {
  return !!getAppConfig().analytics?.googleAnalyticsId;
}

/** True once the user has explicitly opted in to analytics. */
export function hasAnalyticsConsent(): boolean {
  return granted;
}

/** Record an explicit opt-in. Persisted across sessions. */
export function grantAnalyticsConsent(): void {
  if (granted) return;
  granted = true;
  try { localStorage.setItem(STORAGE_KEY, 'granted'); } catch { /* private mode */ }
  emit();
}

/** Withdraw a prior opt-in → back to "undecided" (the gate returns on reload). */
export function resetAnalyticsConsent(): void {
  if (!granted) return;
  granted = false;
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* private mode */ }
  emit();
}

/**
 * The consent directive a link carries: `?consent=decline` → 'decline'.
 * Nothing else is recognised — in particular there is no URL way to GRANT.
 */
export function readConsentUrlDirective(search: string): 'decline' | null {
  try {
    return new URLSearchParams(search).get('consent') === 'decline' ? 'decline' : null;
  } catch {
    return null;
  }
}

/** Record a decline for this browser session (never persisted beyond it). */
export function declineAnalyticsForSession(): void {
  try { sessionStorage.setItem(SESSION_DECLINE_KEY, '1'); } catch { /* storage disabled */ }
  sessionDeclined = true;
  emit();
}

/** Forget the session decline — the dialog is asked again on the next boot. */
export function resetAnalyticsSessionDecline(): void {
  sessionDeclined = false;
  try { sessionStorage.removeItem(SESSION_DECLINE_KEY); } catch { /* storage disabled */ }
  emit();
}

/** True when this session declined analytics — a state distinct from consent. */
export function hasAnalyticsSessionDecline(): boolean {
  if (sessionDeclined) return true;
  try { return sessionStorage.getItem(SESSION_DECLINE_KEY) === '1'; } catch { return false; }
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** React hook — re-renders when consent changes. */
export function useAnalyticsConsent(): boolean {
  return useSyncExternalStore(subscribe, hasAnalyticsConsent, hasAnalyticsConsent);
}
