// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ai-consent-store — the ONE place that decides whether the AI Bridge surface
 * may open, plus the one-shot reachability probe behind the activity-bar entry
 * (plan-366 Phase 6).
 *
 * Why a store and not a click handler: the AI panel has two entrances. The
 * activity-bar button is one, the Settings ▸ AI tab is the other, and on mobile
 * the tab is the ONLY one. A gate that lived in the button would be bypassed by
 * the tab, so the consent is asked in front of the `McpTab` MOUNT (see
 * `AiBridgeGate`) and both entrances read the same state from here.
 *
 * The consent is versioned rather than boolean, after the model of
 * `LICENSE_TERMS_VERSION` in license-store.ts: if the bridge ever reaches
 * further than what the dialog describes today, raising the version asks again.
 * It is NEVER granted implicitly — only `grantAiBridgeConsent()`, called from a
 * button in the consent dialog, sets it.
 */

import { useSyncExternalStore } from 'react';
import {
  clearAiBridgeConsentVersion,
  readAiBridgeConsentVersion,
  writeAiBridgeConsentVersion,
} from './rv-storage-keys';
import { getConnectSnapshot } from './connect-store';
import { connectRestFetch } from './connect-rest';

/**
 * Version of the access scope the consent dialog describes. Bump this whenever
 * the AI Bridge gains reach beyond "scene, signals, simulation" so every device
 * is asked once more.
 */
export const AI_BRIDGE_CONSENT_VERSION = '2026-08';

/**
 * Consent accepted in THIS session even though storage refused the write.
 * Without it a browser with disabled localStorage would re-open the dialog on
 * every render pass — the user answered, so the answer holds for the session.
 */
let sessionGrant: string | null = null;

const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * True when THIS device has acknowledged the CURRENT access scope.
 * Reads through to storage on every call (the value is a primitive, so
 * `useSyncExternalStore` stays happy) and fails closed on a throwing storage.
 */
export function hasAiBridgeConsent(): boolean {
  const accepted = sessionGrant ?? readAiBridgeConsentVersion();
  return accepted === AI_BRIDGE_CONSENT_VERSION;
}

/** Record the acknowledgement. Only ever called from an explicit user action. */
export function grantAiBridgeConsent(): void {
  sessionGrant = AI_BRIDGE_CONSENT_VERSION;
  writeAiBridgeConsentVersion(AI_BRIDGE_CONSENT_VERSION);
  notify();
}

/** Withdraw the acknowledgement — the next AI-panel open asks again. */
export function revokeAiBridgeConsent(): void {
  sessionGrant = null;
  clearAiBridgeConsentVersion();
  notify();
}

/** React hook: does this device consent to the current AI Bridge scope? */
export function useAiBridgeConsent(): boolean {
  return useSyncExternalStore(subscribe, hasAiBridgeConsent, hasAiBridgeConsent);
}

/**
 * One-shot check whether a realvirtual CONNECT answers at the configured
 * gateway URL, using `/health` — the single route CONNECT leaves unauthenticated
 * (plan-366 Phase 7), so an unreachable answer here really means "no CONNECT",
 * not "no key".
 *
 * Deliberately NOT a background poll: probing a localhost target from a hosted
 * origin can surface Chrome's Local Network Access prompt, which page-load
 * probes must never trigger (see `canSilentlyProbeGateway` in connect-store).
 * This runs only inside the click that opens the AI entry, i.e. bound to a user
 * gesture, and a failure is answered with the download info rather than an error.
 */
export async function probeConnectReachable(): Promise<boolean> {
  try {
    const base = getConnectSnapshot().serverUrl.replace(/\/$/, '');
    const response = await connectRestFetch(`${base}/health`);
    return response.ok;
  } catch {
    return false;
  }
}
