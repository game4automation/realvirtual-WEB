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
  /**
   * The document's mode restriction (`documents[].modes`, see
   * {@link isModeAllowedForRow}). A mode it forbids counts as absent — a last
   * mode the document may no longer be used in is not a target. Omitted = every
   * mode allowed.
   */
  isAllowed?: (mode: string) => boolean;
}): string | null {
  const { lastMode, declaredMode, isDemo, has } = input;
  const ok = (m: string) => has(m) && (input.isAllowed ? input.isAllowed(m) : true);
  if (!isDemo && lastMode && ok(lastMode)) return lastMode;
  if (declaredMode && ok(declaredMode)) return declaredMode;
  return null;
}

/**
 * A row's `modes` restriction, normalised: the non-empty, trimmed strings of
 * the array, or null when the row declares none (every mode allowed). An empty
 * array counts as "none" - a document no mode may show is not a restriction
 * anyone can mean, and the validator rejects it.
 */
export function allowedModesOf(row: { modes?: unknown } | null | undefined): string[] | null {
  const raw = row?.modes;
  if (!Array.isArray(raw)) return null;
  const list = raw
    .filter((m): m is string => typeof m === 'string')
    .map(m => m.trim())
    .filter(m => m !== '');
  return list.length > 0 ? list : null;
}

/**
 * Whether `mode` may be used with a row whose restriction is `allowed`: always
 * when there is none, when it is listed, and for authoring modes
 * (`runtime: 'detached'`, the asset editor) - the same rule as
 * `ModeManager.isAllowed`, for callers that decide BEFORE the restriction is
 * installed (the open chain picks its target before the document loads).
 */
export function isModeAllowedForRow(
  allowed: readonly string[] | null,
  mode: string,
  runtimeOf: (mode: string) => string | undefined,
): boolean {
  if (allowed === null) return true;
  if (allowed.includes(mode)) return true;
  return runtimeOf(mode) === 'detached';
}

/**
 * The mode an open under a restriction ends in when {@link effectiveOpenMode}
 * named none: the active mode when it is allowed, else the row's declared
 * `mode` when allowed, else the first allowed registered mode, else the active
 * mode (nothing better exists; the store's enforcement settles it).
 */
export function restrictedOpenTarget(input: {
  active: string | null;
  declaredMode: string | null | undefined;
  allowed: readonly string[] | null;
  has: (mode: string) => boolean;
  isAllowed: (mode: string) => boolean;
}): string | null {
  const { active, declaredMode, allowed, has, isAllowed } = input;
  if (allowed === null) return active;
  if (active && isAllowed(active)) return active;
  if (declaredMode && has(declaredMode) && isAllowed(declaredMode)) return declaredMode;
  return allowed.find(m => has(m)) ?? active;
}

/**
 * The mode the editor handoff parks in while an editor → editor open reloads
 * the document: the first non-editor mode, `hmi` when there is none.
 *
 * ONE spelling for the chain's guard question and the handoff's actual
 * departure (`handoffExitTarget` in the dashboard host delegates here) — two
 * spellings is how the question asked and the move made start to disagree.
 */
export function handoffParkMode(modes: {
  list(): readonly { id: string }[];
  available?: () => readonly { id: string }[];
}): string {
  // The modes the open document allows (`ModeManager.available`): parking in a
  // mode the document forbids would be refused and strand the handoff.
  const ids = (modes.available ? modes.available() : modes.list()).map(m => m.id);
  return ids.find(id => id !== 'editor') ?? 'hmi';
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
