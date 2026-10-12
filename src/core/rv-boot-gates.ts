// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-boot-gates — the order of the two boot gates and the early starts
 * (plan-598, Entscheidungs-Log "Gate-Prioritaet").
 *
 *   1. the hosted PASSWORD gate — blocking, first;
 *   2. the analytics CONSENT question — started, never awaited;
 *   3. the EARLY STARTS (discovery incl. the project manifest, feature
 *      prefetch, presets, Draco) — only now.
 *
 * Why this order is a rule and not an accident:
 *   - nothing project-related (manifest, documents) may leave the tab before an
 *     encrypted deploy's key is in — the early starts come after the password;
 *   - the consent dialog (z-index 30000) would sit ON TOP of the password
 *     overlay (21000); asking it only after the password makes "password first"
 *     true by construction instead of by z-index.
 *
 * Kept as its own tiny function so the order is tested as behaviour
 * (`tests/gate-priority.test.ts`), not only as a source pin on `main.ts`.
 */

import type { NonBlockingConsent } from './rv-consent-boot';

export interface BootGateDeps<T> {
  requirePassword: () => Promise<void>;
  startConsent: () => NonBlockingConsent;
  startEarly: () => T;
}

export async function runBootGates<T>(deps: BootGateDeps<T>): Promise<{ consent: NonBlockingConsent; early: T }> {
  await deps.requirePassword();
  const consent = deps.startConsent();
  const early = deps.startEarly();
  return { consent, early };
}
