// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Dev-server session info for realvirtual WEB.
 *
 * Answers a question the browser cannot otherwise answer: **which checkout is
 * this tab actually served from?** Parallel worktree sessions (see
 * `rv-worktree.ps1`) look identical in the viewport, and confusing one with the
 * canonical checkout has already cost a forensic investigation — an unattended
 * run wrote a worktree plan's changes into the canonical tree unnoticed.
 *
 * The served DIRECTORY is the authority. Branch and plan number are derived
 * metadata: they can disagree with reality, the path cannot.
 *
 * Injected at build time by Vite `define` (see vite.config.ts) and set to
 * `null` for every command except `serve` — so a production bundle contains
 * neither the badge nor any machine path. `vite preview` serves the built
 * bundle and therefore shows nothing either, which is correct: it simulates
 * the release.
 *
 * Always read through this module. Direct `__RV_SERVE_INFO__` references break
 * the node test pool, which defines no globals (vitest.node.config.ts).
 */

/** Shape of the injected constant. `null` outside the dev server. */
export interface RVServeInfo {
  /** Absolute path of the directory Vite is serving. */
  root: string;
  /** Current git branch of that directory ("" if git is unavailable). */
  branch: string;
  /** Plan numbers of the worktree session; null in the canonical checkout. */
  plans: number[] | null;
  /** Session slug, e.g. "webviewer-signal-residuals-consolidation". */
  slug: string | null;
  /** Deterministic session port (5000 + plan number). */
  vitePort: number | null;
}

/**
 * Serve info, or `null` when this is a built bundle.
 *
 * The `typeof` guard costs no dead-code elimination: `define` substitutes the
 * literal, so a build sees `typeof null !== 'undefined' ? null : null`, which
 * the minifier folds to `null`.
 */
export const RV_SERVE_INFO: RVServeInfo | null =
  typeof __RV_SERVE_INFO__ !== 'undefined' ? __RV_SERVE_INFO__ : null;

/**
 * True when the dev server runs on the canonical checkout instead of a
 * worktree — the state worth warning about, because pure web plans must not be
 * edited there (ADR-040).
 *
 * The absence of a session manifest is the signal; a corrupt or unreadable
 * manifest deliberately reports the same, so a broken session never
 * masquerades as a healthy one.
 */
export function isCanonicalCheckout(info: RVServeInfo | null = RV_SERVE_INFO): boolean {
  return info !== null && (info.plans === null || info.plans.length === 0);
}

/**
 * Served directory with separators normalised to backslashes.
 *
 * Deliberately NOT shortened: the discriminating part is the HEAD of the path
 * (the worktree base versus the canonical checkout), so the badge lets CSS clip
 * the tail and keeps the beginning. The `title` attribute carries the untouched
 * path.
 */
export function formatServeRoot(root: string): string {
  return root.replace(/\//g, '\\');
}

/** Short session label, e.g. "Plan 353" / "Plan 353+354" / "canonical". */
export function formatSessionLabel(info: RVServeInfo | null = RV_SERVE_INFO): string {
  if (!info) return '';
  if (isCanonicalCheckout(info)) return 'canonical';
  return `Plan ${info.plans!.join('+')}`;
}
