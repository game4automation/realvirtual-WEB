// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-project-open — one "Open…", and what it lands on (plan-703 §2.6.3,
 * decisions 1, 2, 3, 24; F14, F15).
 *
 * Two separate questions, deliberately two separate functions, because they
 * fail for different reasons and are answered at different times:
 *
 *  1. **What did the user just pick?** — {@link detectOpenTarget}. A folder with
 *     its own `project.json` is a project; a folder holding child projects is a
 *     workspace; a folder that is neither is an offer to create one.
 *  2. **What should be open once it is loaded?** — {@link resolveResumeTarget}.
 *     URL beats the remembered pair beats `defaultModel`, and a kiosk always
 *     takes `defaultModel`.
 *
 * ## Why "Open…" is one button (decision 1)
 *
 * Because the user knows which folder they mean and does not know, or care,
 * which of our two internal concepts it is. Two buttons made them guess, and
 * guessing wrong produced an empty screen with no explanation. The detection is
 * a directory listing — cheap, and it is exactly the listing the caller has to
 * do anyway.
 *
 * ## Project beats workspace (decision 2)
 *
 * A folder can legitimately be both: a project whose subfolders happen to be
 * projects too. It opens as the project, and the child projects surface as a
 * HINT in the detail pane ({@link OpenTarget.childProjects}) rather than as a
 * second interpretation. Opening the workspace instead would hide the manifest
 * the user actually named.
 *
 * ## The mode follows the SESSION, not the asset (decision 24)
 *
 * This is the rule most likely to be broken by accident, so it is expressed as a
 * type: {@link ResumeTarget} carries a mode **only** when the session is being
 * established. {@link resumeTargetForAssetSwitch} is the function for switching
 * assets inside a live session, and it cannot return a mode at all.
 *
 * Storage-free and React-free: every input is a value.
 */

/** What the picked folder turned out to be. */
export type OpenTargetKind = 'project' | 'workspace' | 'empty';

export interface OpenTarget {
  kind: OpenTargetKind;
  /**
   * Child folders holding a `project.json`.
   *
   * For a `workspace` these are the content. For a `project` they are the hint
   * of decision 2 — shown in the detail pane, not acted on.
   */
  childProjects: string[];
}

/** What a caller learnt by listing the picked folder. Nothing is read twice. */
export interface OpenProbe {
  /** Does the folder itself hold a `project.json`? */
  hasManifest: boolean;
  /** Names of direct child folders that hold a `project.json`. */
  childProjectFolders?: readonly string[];
}

/**
 * Classify a picked folder. Total: every probe has an answer.
 *
 * Deliberately NOT async and deliberately not given a handle: the listing is the
 * caller's, which is what lets §9.15 state all three cases as plain objects.
 */
export function detectOpenTarget(probe: OpenProbe): OpenTarget {
  const childProjects = [...(probe.childProjectFolders ?? [])];
  if (probe.hasManifest) return { kind: 'project', childProjects };
  if (childProjects.length > 0) return { kind: 'workspace', childProjects };
  return { kind: 'empty', childProjects: [] };
}

// ─── Resume ─────────────────────────────────────────────────────────────

/** The two modes a session can resume into; anything else is not remembered. */
export type ResumeMode = string;

/** Where the resume answer came from — the panel and the tests both want it. */
export type ResumeSource = 'url' | 'remembered' | 'defaultModel' | 'none';

export interface ResumeTarget {
  /** Project-relative asset path (or the raw URL parameter value). */
  asset: string | null;
  /** Mode to enter. Null means "the caller's own default". */
  mode: ResumeMode | null;
  source: ResumeSource;
}

/** The `(asset, mode)` snapshot stored per project id (decision 24). */
export interface RememberedSession {
  asset: string;
  mode?: ResumeMode;
}

export interface ResumeInputs {
  /** `window.location.search`. */
  search: string;
  /** The remembered pair for THIS project id, or null. */
  remembered?: RememberedSession | null;
  /** `settings.defaultModel`. */
  defaultModel?: string | null | undefined;
  /** Kiosk. Beats everything (decision 3). */
  modeLocked?: boolean;
}

/**
 * URL parameters that name an asset, in the order they win.
 *
 * `scene` and `model` are the two legacy spellings of the same thing since
 * plan-413 — "every GLB is an asset" is exactly what this plan is about — so
 * they are read as synonyms rather than as a distinction to preserve. `project`
 * selects the project, not the asset, and therefore does not appear here.
 */
const ASSET_PARAMS = ['scene', 'model'] as const;

/** localStorage key of the remembered pair for one project. */
export function resumeStorageKey(projectId: string): string {
  return `rv-project/resume/${projectId}`;
}

/**
 * What to open when a project is opened. **Order is the decision, not taste.**
 *
 *  1. **Kiosk short-circuits to `defaultModel`.** A locked deployment must land
 *     in its machine no matter what a stale localStorage entry or a pasted URL
 *     says — the same reasoning `shouldAutoOpenProjects` already applies to the
 *     dashboard, applied to the document.
 *  2. **URL.** Somebody typed or shared it; it is the most recent statement of
 *     intent there is.
 *  3. **The remembered pair** (asset AND mode, per project id). This is the one
 *     place a mode is restored, because it is the one place a session begins.
 *  4. **`settings.defaultModel`** — what the deployer chose.
 *  5. Nothing, and the caller decides.
 */
export function resolveResumeTarget(inputs: ResumeInputs): ResumeTarget {
  const fallback = (inputs.defaultModel ?? '').trim();

  if (inputs.modeLocked) {
    // Not merely "defaultModel wins" — the remembered MODE is dropped too, or a
    // kiosk that was once opened in planner would come back up in planner.
    return { asset: fallback === '' ? null : fallback, mode: null, source: fallback === '' ? 'none' : 'defaultModel' };
  }

  const params = new URLSearchParams(inputs.search ?? '');
  for (const key of ASSET_PARAMS) {
    const value = (params.get(key) ?? '').trim();
    // A URL names an asset, never a mode: a link must not be able to put the
    // recipient into a mode their deployment does not offer.
    if (value !== '') return { asset: value, mode: null, source: 'url' };
  }

  const remembered = inputs.remembered;
  if (remembered && remembered.asset.trim() !== '') {
    return {
      asset: remembered.asset.trim(),
      mode: remembered.mode?.trim() || null,
      source: 'remembered',
    };
  }

  if (fallback !== '') return { asset: fallback, mode: null, source: 'defaultModel' };
  return { asset: null, mode: null, source: 'none' };
}

/**
 * Switching to another asset inside a live session.
 *
 * Returns the asset and **nothing else** — decision 24 in the type system. The
 * mode belongs to the session, so there is deliberately no parameter here that
 * could carry one and no field that could return one.
 */
export function resumeTargetForAssetSwitch(asset: string): { asset: string } {
  return { asset };
}

/** The snapshot to store when a session settles on an asset and a mode. */
export function rememberedSessionOf(asset: string, mode?: string | null): RememberedSession {
  const trimmed = (mode ?? '').trim();
  return trimmed === '' ? { asset } : { asset, mode: trimmed };
}

/** Parse a stored snapshot defensively; a broken one is simply "nothing remembered". */
export function parseRememberedSession(raw: unknown): RememberedSession | null {
  if (typeof raw === 'string') {
    try { return parseRememberedSession(JSON.parse(raw) as unknown); } catch { return null; }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const asset = typeof record.asset === 'string' ? record.asset.trim() : '';
  if (asset === '') return null;
  const mode = typeof record.mode === 'string' && record.mode.trim() !== ''
    ? record.mode.trim()
    : undefined;
  return mode ? { asset, mode } : { asset };
}
