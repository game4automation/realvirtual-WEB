// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-project-resume-store — the persisted half of the resume rule
 * (plan-703 §2.6.3, decision 24).
 *
 * `rv-project-open.ts` is deliberately storage-free: it decides WHAT should be
 * open given the inputs. This module is the one place those inputs are read
 * from and written to `localStorage`, so the boot path and the dashboard cannot
 * disagree about the key, the encoding or what a broken entry means.
 *
 * ## Why it had to leave the dashboard
 *
 * Both functions used to be private to `ProjectsDashboardHost`, which made the
 * remembered pair readable in exactly one situation: the user opening a project
 * by hand. A RELOAD restores the project instead of opening it, so the boot in
 * `main.ts` had no way to ask where the session left off and fell through to
 * `settings.json`'s `defaultModel` — the demo model, however far away the user
 * had actually navigated. The pair was being written all along; nothing read it
 * at the one moment it exists for.
 *
 * Best-effort by design, in both directions: a private-mode `localStorage`, a
 * hand-edited entry or a quota error is "nothing remembered", never a crash. A
 * resume hint is a convenience, never a precondition for a working viewer.
 */

import {
  parseRememberedSession,
  rememberedSessionOf,
  resumeStorageKey,
  type RememberedSession,
} from './rv-project-open';

/**
 * The remembered `(asset, mode)` pair of one project, or null.
 *
 * Per project id, so two projects cannot overwrite each other's resume point.
 */
export function readRememberedSession(
  projectId: string | null | undefined,
): RememberedSession | null {
  if (!projectId) return null;
  try {
    return parseRememberedSession(localStorage.getItem(resumeStorageKey(projectId)));
  } catch {
    return null;
  }
}

/**
 * Record what this session settled on.
 *
 * Called when something OPENS, which is the moment decision 24 calls "the
 * session settles": the pair is `(asset, mode)`, the mode is the one that is
 * active right now, and a later asset switch inside the same session re-records
 * the pair without ever changing the mode.
 *
 * `asset` is a project-relative path or a document id — the consumers match
 * against both, because a URL names a path and a stored pair may hold either.
 */
export function rememberSession(
  projectId: string | null | undefined,
  asset: string | null | undefined,
  mode: string | null,
): void {
  if (!projectId || !asset) return;
  try {
    localStorage.setItem(
      resumeStorageKey(projectId),
      JSON.stringify(rememberedSessionOf(asset, mode)),
    );
  } catch { /* private mode — a resume hint is never a precondition */ }
}

/**
 * Forget the resume point of one project.
 *
 * Used when the remembered document turns out not to exist any more, so the
 * next boot asks the fallback chain once instead of retrying a dead path on
 * every reload.
 */
export function forgetRememberedSession(projectId: string | null | undefined): void {
  if (!projectId) return;
  try {
    localStorage.removeItem(resumeStorageKey(projectId));
  } catch { /* nothing to forget, then */ }
}
