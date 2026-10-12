// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-document-mode — the storage-free half of "the mode a document was last
 * used in" (plan-513).
 *
 * Same split as the recents ring (`rv-project-recents.ts` vs
 * `rv-project-recents-store.ts`): this module decides; `rv-document-mode-store`
 * is the one place those decisions meet IndexedDB. Every function here is pure.
 *
 * ## One decision per open
 *
 * Which mode a deliberate open ends in is answered ONCE, by
 * {@link effectiveOpenMode}, and the same answer is what the mode chip beside a
 * document row shows. A chip and a click that disagreed would be a chip that
 * lies; sharing the function is what keeps them from drifting.
 */

import type { RecentBackend } from './rv-project-recents';

/** One stored entry: the mode and when it was recorded (ISO). */
export interface DocumentModeRecord {
  mode: string;
  usedAt: string;
}

/**
 * The storage key of a document: `<backend>:<projectId>:<documentId>`.
 *
 * The backend is part of the identity for the reason the model index gives
 * (`modelIndexKey`): the bundled demo and a linked folder can carry the same
 * project id and are still two different projects.
 */
export function documentModeKey(
  backend: RecentBackend,
  projectId: string,
  documentId: string,
): string {
  return `${backend}:${projectId}:${documentId}`;
}

/** The key prefix of every document of one project — for a project-wide forget. */
export function documentModeProjectPrefix(backend: RecentBackend, projectId: string): string {
  return `${backend}:${projectId}:`;
}

/**
 * The mode a deliberate open ends in — or null when nothing names one.
 *
 * Precedence (user decision): the stored last mode, then the mode the
 * document's row declares, then nothing (the caller then stays in the active
 * mode). A demo project never restores a last mode (plan-478 stays); a mode
 * this build does not register counts as absent — an unknown mode is a missing
 * target, never a reason to fail the open.
 */
export function effectiveOpenMode(input: {
  lastMode: string | null | undefined;
  declaredMode: string | null | undefined;
  isDemo: boolean;
  has: (mode: string) => boolean;
}): string | null {
  const { lastMode, declaredMode, isDemo, has } = input;
  if (!isDemo && lastMode && has(lastMode)) return lastMode;
  if (declaredMode && has(declaredMode)) return declaredMode;
  return null;
}

/**
 * The mode the editor handoff parks in while an editor → editor open reloads
 * the document: the first non-editor mode, `hmi` when there is none.
 *
 * ONE spelling for the chain's guard question and the handoff's actual
 * departure (`handoffExitTarget` in the dashboard host delegates here) — two
 * spellings is how the question asked and the move made start to disagree.
 */
export function handoffParkMode(modes: { list(): readonly { id: string }[] }): string {
  return modes.list().map(m => m.id).find(id => id !== 'editor') ?? 'hmi';
}

/**
 * The exit-guard question an open causes, or none.
 *
 * `target` when it differs from the active mode; the handoff's park mode when
 * both are the editor, because that open leaves the editor to reload it
 * (SOL R2 F1) and the editor's guard must still be asked; null otherwise.
 */
export function plannedDeparture(
  active: string | null,
  target: string,
  parkMode: string,
): string | null {
  if (active === 'editor' && target === 'editor') return parkMode;
  return target !== active ? target : null;
}

/**
 * The mode a boot resume activates (plan-513 F9): {@link effectiveOpenMode},
 * and only when that names nothing the remembered session's own mode.
 *
 * The session mode is the fallback, not the answer: `rememberSession` writes it
 * when a document is OPENED and never when the user switches afterwards, so on
 * its own it restores the mode the document was opened in rather than the one
 * it was last used in (SOL R1 F1). `?mode=` and a published boot mode outrank
 * this in the mode boot and are not the business of this function.
 */
export function resumeModeOf(input: {
  lastMode: string | null | undefined;
  declaredMode: string | null | undefined;
  isDemo: boolean;
  has: (mode: string) => boolean;
  sessionMode: string | null | undefined;
}): string | null {
  return effectiveOpenMode(input) ?? input.sessionMode ?? null;
}
