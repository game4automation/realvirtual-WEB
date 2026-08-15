// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-legacy-format — the one thing this build says to a project that stayed
 * behind (plan-413 F10, phase 6).
 *
 * ## Why there is a module for one error
 *
 * Phase 6 removed the JSON scene reader in full — bodies, drafts, migrator,
 * validator. Everything it used to read is still out there: a `project.json`
 * whose scene rows point at `.scene.json` files, an entry still declaring the
 * old body format, a `rv-scenes/<id>` record carrying a `schemaVersion: 2`
 * op log. Three different places notice it, and if each of them phrased its
 * own refusal the user would meet three different sentences for one situation
 * and could act on none of them.
 *
 * So there is exactly one error and exactly one sentence, and it names the
 * version that can still convert. That is the whole point of a deprecation
 * error: not "this failed", but "here is the move that fixes it".
 *
 * ## Hard, never silent, never partial (F10)
 *
 * The three call sites all sit at the entrance of a read — the manifest read,
 * the backend scene read, the localStorage scene read. Throwing there means the
 * caller gets nothing rather than half of something. The tempting alternative,
 * skipping the offending row and opening the rest, is exactly the silent partial
 * load the requirement forbids: a project that opens with two of its five scenes
 * and no explanation is a project the user will save over.
 */

/**
 * The last release whose reader could still convert the old format.
 *
 * Deliberately a literal rather than something derived from `package.json`:
 * this build is the one that *cannot* read it, so its own version is the wrong
 * number, and the right one stops moving the moment this commit lands.
 */
export const LAST_CONVERTING_VERSION = '6.3.16';

/** What kind of leftover was found. Diagnostics and tests — never user-facing. */
export type LegacyFormatKind =
  /** A manifest scene row pointing at a `.scene.json` body, or declaring one. */
  | 'project-scene-json'
  /** A `rv-scenes/<id>` record still carrying a `schemaVersion: 2` op log. */
  | 'localstorage-scene-v2'
  /** A manifest that carries neither `documents[]` nor anything to derive it from. */
  | 'manifest-not-migratable';

/**
 * A stored artefact this build no longer reads.
 *
 * The message is assembled here and nowhere else, so "the sentence the user
 * sees" is one string in one place — which is what makes it translatable,
 * greppable, and impossible to drift.
 */
export class LegacyFormatError extends Error {
  constructor(
    readonly kind: LegacyFormatKind,
    /** The scene id, path or storage key that was refused. */
    readonly subject: string,
  ) {
    super(legacyFormatMessage(kind, subject));
    this.name = 'LegacyFormatError';
  }
}

/** The one sentence. See the class doc for why it lives in a single function. */
export function legacyFormatMessage(kind: LegacyFormatKind, subject: string): string {
  const what = kind === 'localstorage-scene-v2' ? 'This scene' : 'This project';
  return `${what} was saved in a format that is no longer supported (${subject}). `
    + `Open it once with realvirtual WEB ${LAST_CONVERTING_VERSION} `
    + '— the release before this one — to convert it, then open it here again.';
}

/**
 * True for a path that names a pre-phase-6 JSON scene body.
 *
 * Extension-driven, like the manifest-format helper it replaces: a backend is
 * handed a path and has to decide before it can look anything up, and a
 * declared format field is exactly what a half-finished migration gets wrong.
 */
export function isLegacyScenePath(relPath: string): boolean {
  return /\.json$/i.test((relPath ?? '').trim());
}

/**
 * Gate every scene body read. Throws {@link LegacyFormatError} for a JSON path.
 *
 * Called at the top of each backend's `readScene`, before any I/O: reading the
 * bytes first and failing to parse them afterwards is how "unsupported format"
 * degrades into "missing scene".
 */
export function assertReadableScenePath(relPath: string): void {
  if (isLegacyScenePath(relPath)) {
    throw new LegacyFormatError('project-scene-json', relPath);
  }
}
