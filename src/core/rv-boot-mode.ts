// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-boot-mode.ts — which workspace mode the boot block enters (plan-652 §2.4.4).
 *
 * The boot block in `main.ts` has always walked the candidates in one precedence:
 * `?mode=` > the hosted start document's mode (plan-640) > the opened published
 * example's mode > the resumed project session's mode > `restore('hmi')`. With
 * on-demand features the boot must know the target BEFORE it switches, so it can
 * wait for the mode's code at the one existing await point. This function is that
 * precedence, pure and testable; each candidate counts only when the mode is
 * registered (an unknown one falls through to the next, as before) AND allowed
 * by the open document's mode restriction (`documents[].modes`): `?mode=hmi` on
 * a document that forbids HMI falls through, ending in the restriction's
 * default via `peekRestoreTarget`.
 */

import type { ModeId } from './rv-mode-manager';

/** The boot candidates, as `main.ts` collects them. */
export interface BootModeCandidates {
  /** `modes.lockedMode` — a kiosk lock wins over everything. */
  locked: ModeId | null;
  /** `?mode=` */
  url: string | null;
  /** The hosted start document's `settings.start.mode` (plan-640). */
  hostedStart: string | null;
  /** The opened published example's catalogue mode. */
  published: string | null;
  /** The resumed project session's mode. */
  resume: string | null;
}

/** What the resolver needs from the ModeManager. */
export interface BootModeHost {
  has(id: ModeId): boolean;
  /** The open document's restriction (`ModeManager.isAllowed`). Absent = every mode allowed. */
  isAllowed?(id: ModeId): boolean;
  peekRestoreTarget(fallback?: ModeId): ModeId;
}

/** Which candidate decided — `restore` covers the persisted mode and the fallback. */
export type BootModeSource = 'locked' | 'url' | 'hostedStart' | 'published' | 'resume' | 'restore';

//! Resolves the boot target mode in the established precedence; never answers an unregistered candidate.
export function resolveBootMode(
  candidates: BootModeCandidates,
  modes: BootModeHost,
  fallback: ModeId = 'hmi',
): { mode: ModeId; source: BootModeSource } {
  if (candidates.locked !== null && modes.has(candidates.locked)) {
    return { mode: candidates.locked, source: 'locked' };
  }
  const ordered: Array<[BootModeSource, string | null]> = [
    ['url', candidates.url],
    ['hostedStart', candidates.hostedStart],
    ['published', candidates.published],
    ['resume', candidates.resume],
  ];
  const allowed = (m: ModeId) => (modes.isAllowed ? modes.isAllowed(m) : true);
  for (const [source, mode] of ordered) {
    if (mode && modes.has(mode) && allowed(mode)) return { mode, source };
  }
  return { mode: modes.peekRestoreTarget(fallback), source: 'restore' };
}
