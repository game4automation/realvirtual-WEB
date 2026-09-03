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
 *     URL beats the remembered pair beats `defaultModel`, and a kiosk takes the
 *     start document its project names, then the project's own active document.
 *
 * A third question belongs to exactly one deployment shape and is therefore a
 * separate, deliberately tiny function: **did the kiosk boot actually land
 * anywhere?** — {@link diagnoseKioskBoot} (plan-721 F8).
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
export type ResumeSource = 'url' | 'remembered' | 'projectActive' | 'defaultModel' | 'none';

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
  /** The project's own `activeSceneId` — its last active document, or null. */
  projectActive?: string | null;
  /**
   * The deployer's chosen start document.
   *
   * Since plan-721 both call sites resolve it as
   * `project?.settings?.defaultModel ?? appConfig.defaultModel` — the PROJECT's
   * own manifest field first, the global `settings.json` one second. One input,
   * because the two are the same statement made in two places, and in a
   * delivered build they hold the same value anyway (`bareDefaultModel()`
   * derives the global one FROM the manifest).
   */
  defaultModel?: string | null | undefined;
  /** Kiosk. Beats everything (decision 3). */
  modeLocked?: boolean;
  /**
   * The manifest says `kind: "demo"` (plan-434). A public demo is a showcase,
   * not a workspace: every visit to the bare URL must land on the deployer's
   * start document, or the flagship HMI demo silently turns into whatever the
   * visitor tried last — after one planner session the public demo re-opened
   * DemoPlanner in planner mode instead of the HMI demo (2026-09-02, /demo).
   * A shared URL still wins (it is an explicit statement), only the remembered
   * pair and the remembered MODE are skipped — the same reasoning the kiosk
   * lock applies, minus the URL override.
   */
  demoProject?: boolean;
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
 *  1. **Kiosk short-circuits past URL and memory** — to `defaultModel` first and
 *     then to `projectActive`. A locked deployment must land in its machine no
 *     matter what a stale localStorage entry or a pasted URL says — the same
 *     reasoning `shouldAutoOpenProjects` already applies to the dashboard,
 *     applied to the document. See the kiosk block below for what feeds
 *     `defaultModel` there since plan-721.
 *  2. **URL.** Somebody typed or shared it; it is the most recent statement of
 *     intent there is.
 *  3. **The remembered pair** (asset AND mode, per project id). This is the one
 *     place a mode is restored, because it is the one place a session begins.
 *  4. **The project's own `activeSceneId`.** What the project itself last had
 *     open, and the only source of the four that travels with the folder: a
 *     project this browser has never seen has no remembered pair, and without
 *     this step a switch into it would land on `defaultModel` — a document from
 *     a different project — or on nothing at all. It carries no mode, for the
 *     same reason a URL does not: it is a statement about a document.
 *  5. **`settings.defaultModel`** — what the deployer chose.
 *  6. Nothing, and the caller decides.
 */
export function resolveResumeTarget(inputs: ResumeInputs): ResumeTarget {
  const fallback = (inputs.defaultModel ?? '').trim();

  if (inputs.modeLocked) {
    // Not merely "defaultModel wins" — the remembered MODE is dropped too, or a
    // kiosk that was once opened in planner would come back up in planner. The
    // URL and the remembered PAIR stay discarded here (decision 3, unchanged).
    //
    // What changed in plan-721 is only where `defaultModel` comes from and what
    // answers when it is empty:
    //
    //   * **The manifest's start document reaches this function THROUGH
    //     `defaultModel`.** Both production call sites feed
    //     `project?.settings?.defaultModel ?? appConfig.defaultModel`, so the
    //     project's own deploy field wins over the global `settings.json` one
    //     without this function needing to know which of the two it was handed.
    //     That merge is the appliance's whole point: the box ships NO global
    //     `defaultModel`, and its `project.json` is the boot SSOT.
    //   * **`projectActive` is the second kiosk stage**, not just a non-kiosk
    //     one. A project that names no start document still knows the document
    //     it was last left on, and it travels with the folder — which is
    //     strictly better than the previous answer, `null`, i.e. a boot that
    //     fell through to the caller's legacy catalogue resolution.
    //
    // Everything a locked deployment used to resolve, it still resolves
    // identically: with a baked global value and no manifest field the merge
    // yields that same global value, and it is still the first stage here.
    if (fallback !== '') return { asset: fallback, mode: null, source: 'defaultModel' };
    const lockedActive = (inputs.projectActive ?? '').trim();
    if (lockedActive !== '') return { asset: lockedActive, mode: null, source: 'projectActive' };
    return { asset: null, mode: null, source: 'none' };
  }

  const params = new URLSearchParams(inputs.search ?? '');
  for (const key of ASSET_PARAMS) {
    const value = (params.get(key) ?? '').trim();
    // A URL names an asset, never a mode: a link must not be able to put the
    // recipient into a mode their deployment does not offer.
    if (value !== '') return { asset: value, mode: null, source: 'url' };
  }

  // Demo deployments skip the remembered pair (see `ResumeInputs.demoProject`):
  // the bare URL always presents the start document, only an explicit URL
  // (handled above) overrides it.
  const remembered = inputs.demoProject ? null : inputs.remembered;
  if (remembered && remembered.asset.trim() !== '') {
    return {
      asset: remembered.asset.trim(),
      mode: remembered.mode?.trim() || null,
      source: 'remembered',
    };
  }

  if (inputs.demoProject && fallback !== '') {
    return { asset: fallback, mode: null, source: 'defaultModel' };
  }

  const projectActive = (inputs.projectActive ?? '').trim();
  if (projectActive !== '') {
    return { asset: projectActive, mode: null, source: 'projectActive' };
  }

  if (fallback !== '') return { asset: fallback, mode: null, source: 'defaultModel' };
  return { asset: null, mode: null, source: 'none' };
}

/**
 * The start document a project's own manifest names, or null (plan-721 §2.4).
 *
 * `project.settings.defaultModel` is the deploy field `_bunny-lib.mjs` writes
 * and `rv-project-types.ts` documents as a stable contract. Since plan-716 the
 * manifest is the boot SSOT, so this — not the global `settings.json` value —
 * is what a kiosk should open, and this function is the ONE place the two call
 * sites of {@link resolveResumeTarget} agree on how to read it.
 *
 * Typed defensively because `settings` is `Record<string, unknown>`: it arrives
 * from a foreign deploy manifest, so anything at all can be in that key. A
 * non-string, or a blank string, is "the project names none" — never a crash and
 * never a `"undefined"` path.
 */
export function projectStartDocument(
  project: { settings?: Record<string, unknown> | undefined } | null | undefined,
): string | null {
  const raw = project?.settings?.defaultModel;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

// ─── The kiosk boot verdict (plan-721 F8) ───────────────────────────────

/** Why a kiosk boot has nothing to show. Stable strings — log and test read them. */
export type KioskBootFailure =
  | 'no-manifest'
  | 'no-documents'
  | 'no-start-document'
  | 'start-document-missing';

/** What a caller learnt while resolving the served project. Nothing is fetched twice. */
export interface KioskBootProbe {
  /** The `?projectUrl=` this boot was pointed at, or null when it was not. */
  projectUrl?: string | null;
  /** `hasDeployedManifest()` — did that URL actually serve a `project.json`? */
  hasDeployedManifest?: boolean;
  /** How many documents the resolved manifest carries. */
  documentCount?: number;
  /** What {@link resolveResumeTarget} landed on, or null. */
  resolvedAsset?: string | null;
  /** Is `resolvedAsset` present in `documents[]`? Ignored when the asset is null. */
  assetExists?: boolean;
}

export interface KioskBootVerdict {
  /** False means: show the failure, do NOT fall through to a legacy boot. */
  ok: boolean;
  reason: KioskBootFailure | null;
  /** One user-readable sentence for the error card. Empty when `ok`. */
  detail: string;
}

/**
 * Did the kiosk boot land on something real? (plan-721 F8)
 *
 * The failure this exists to prevent is the most expensive support case an
 * appliance has: **the box shows nothing and says nothing.** All four causes
 * below were silent when this was written: a 404, a 500 and a corrupt
 * `project.json` were swallowed identically in `bundled-backend.ts`, which then
 * answered with a synthetic demo manifest; a dead start-document reference
 * simply resolved to no document; and an operator standing at a panel with no
 * keyboard and no DevTools had no way to tell any of that from "still loading".
 *
 * plan-735 removed the synthetic manifest and made the backend itself say which
 * of those happened, so this function is no longer the ONLY thing between an
 * appliance and a blank screen. It is still the thing that decides, per cause,
 * what the panel SHOWS — and the four-way split below is exactly the resolution
 * a single `readManifest() === null` cannot express, which is why the probe
 * keeps `hasDeployedManifest` as its own field (plan-735 4b).
 *
 * Deliberately a pure function over a probe rather than a check inside the boot
 * path: the boot path is an 800-line async sequence that needs a browser, a
 * viewer and a network, and the DECISION it makes here is four comparisons. This
 * is the seam plan-721 test 9.2 asserts against.
 *
 * Scoped to the remote-project boot on purpose. Without a `projectUrl` this is
 * not an appliance boot, every other deployment keeps its existing fall-through
 * behaviour, and the verdict is `ok` — a diagnosis, not a new gate.
 */
export function diagnoseKioskBoot(probe: KioskBootProbe): KioskBootVerdict {
  const url = (probe.projectUrl ?? '').trim();
  if (url === '') return { ok: true, reason: null, detail: '' };

  if (probe.hasDeployedManifest !== true) {
    return {
      ok: false,
      reason: 'no-manifest',
      detail: `No project was served at ${url} — project.json is missing, unreadable or not valid JSON.`,
    };
  }
  if ((probe.documentCount ?? 0) <= 0) {
    return {
      ok: false,
      reason: 'no-documents',
      detail: `The project at ${url} lists no documents.`,
    };
  }
  const asset = (probe.resolvedAsset ?? '').trim();
  if (asset === '') {
    return {
      ok: false,
      reason: 'no-start-document',
      detail: `The project at ${url} names no start document (settings.defaultModel) and has no active document.`,
    };
  }
  if (probe.assetExists !== true) {
    return {
      ok: false,
      reason: 'start-document-missing',
      detail: `The start document "${asset}" is not among the documents of the project at ${url}.`,
    };
  }
  return { ok: true, reason: null, detail: '' };
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
