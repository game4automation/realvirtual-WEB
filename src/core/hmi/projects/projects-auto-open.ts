// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * projects-auto-open — should the dashboard open by itself at startup?
 * (plan-372 §2.12)
 *
 * plan-345 hung this on "the scene list is empty". That condition can no longer
 * ever be true: every session now has a project, and every project has at least
 * the sample scenes (F3). So the gate is rebuilt around a different question —
 * *did the session already say what to show?*
 *
 * The dashboard opens only when nothing else was asked for. Concretely, every
 * one of these must hold:
 *
 *   - no `?project=`, `?scene=` or `?model=` in the URL
 *   - no `defaultModel` in settings.json
 *   - the active project's manifest names no start document (plan-726 F3)
 *   - the mode is not locked (kiosk)
 *   - `projects.suppress` is not set
 *
 * The practical consequence is the one that matters: **every delivered customer
 * build either sets `defaultModel` or runs kiosk-locked**, so none of them
 * change behaviour. A customer opening their HMI must land in their machine,
 * not in a file browser.
 *
 * Pure and synchronous on purpose — it takes the state it needs as arguments so
 * it can be reasoned about, and tested, without a viewer.
 */

/** Everything the gate needs to know. */
export interface AutoOpenInputs {
  /** URL query string, e.g. `window.location.search`. */
  search: string;
  /** `settings.json` `defaultModel`, if any. */
  defaultModel?: string | null | undefined;
  /**
   * The ACTIVE PROJECT's own start document (`project.settings.defaultModel`),
   * if it names one (plan-726 F3).
   *
   * The second way a session says what to show, and it had to become one: since
   * plan-726 the public demo carries no global `defaultModel` at all — its
   * `project.json` is the boot SSOT — so the `defaultModel` field above is
   * empty on precisely the deployment that must never open a file browser.
   *
   * Treated exactly like `defaultModel` and checked in the same place, because
   * it answers the same question. The consequence is deliberate and wider than
   * the demo: ANY active project whose manifest names a start document now
   * keeps the dashboard shut, and eight private project manifests set that
   * field. Internal dev and QA flows that relied on the dashboard appearing by
   * itself will need `projects.force` or the dashboard button instead.
   */
  projectStartDocument?: string | null | undefined;
  /** True when the workspace mode is locked (kiosk deployment). */
  modeLocked: boolean;
  /** `projects.suppress` — never auto-open. */
  suppress?: boolean | undefined;
  /** `projects.force` — auto-open even with a default model. */
  force?: boolean | undefined;
  /**
   * The last session's project could not be restored at boot (grant lapsed or
   * folder unreadable — plan-702 Punkt 3). The user has to re-open it by hand,
   * so the dashboard opens even when the session otherwise said what to show:
   * whatever it said referred to a project that is not there.
   */
  restoreFailed?: boolean | undefined;
}

/** URL parameters that mean "the session already knows what to show". */
const ROUTING_PARAMS = ['project', 'scene', 'model'] as const;

/**
 * True when the Projects dashboard should open itself at startup.
 *
 * Order matters: `suppress` is checked before `force` so a contradictory
 * configuration resolves to *not* showing a window, and `modeLocked` beats
 * `force` because a kiosk must never be talked into a project browser by a
 * stale config file.
 */
export function shouldAutoOpenProjects(inputs: AutoOpenInputs): boolean {
  if (inputs.suppress) return false;
  if (inputs.modeLocked) return false;
  if (inputs.force) return true;
  if (inputs.restoreFailed) return true;

  const params = new URLSearchParams(inputs.search);
  if (ROUTING_PARAMS.some(p => (params.get(p) ?? '').trim() !== '')) return false;

  if ((inputs.defaultModel ?? '').trim() !== '') return false;
  if ((inputs.projectStartDocument ?? '').trim() !== '') return false;

  return true;
}
