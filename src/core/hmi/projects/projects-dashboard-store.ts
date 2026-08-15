// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * projects-dashboard-store — open/closed state and selection for the Projects
 * dashboard (plan-372 Phase 7).
 *
 * Deliberately *not* routed through `LeftPanelManager`. The dashboard is a
 * full-screen overlay, not a docked left panel: it has no width to negotiate,
 * no sibling to displace, and it must survive the panel manager's own
 * open/close bookkeeping. Sharing that manager would have meant teaching it
 * about a panel that breaks all of its layout assumptions.
 *
 * ## Two screens, one step apart
 *
 * The dashboard drills down exactly once: the project list, then the contents
 * of one project. That single step is `view`, and it is deliberately NOT a
 * history stack — there is one way back and the header arrow is it. Esc still
 * means "close", never "go back", so a user who wants the viewport never has
 * to press it twice.
 *
 * The selection lives here for the same reason it always did: the detail pane
 * and the section grids must agree on it, and it must survive a view switch.
 */

/**
 * Which rail group the dashboard was aimed at (§3.2).
 *
 * `scenes` and `models` are **legacy kinds** since plan-413 phase 4: the two
 * lists they named are one document list now. They are kept in the union rather
 * than deleted because a group value outlives the render that set it — a deep
 * link, a reopened dashboard, a caller in another plugin — and a kind that no
 * longer parses would be a crash where a fold-back is the honest answer.
 *
 * Since plan-703 Phase 6 the group no longer selects a *tab*: the project screen
 * is one tree, and the catalogs are roots of it rather than a second panel. What
 * the group still decides is the one thing it always decided first — whether an
 * open lands on the project list or inside the open project.
 */
export type ProjectsRailGroup =
  | { kind: 'projects' }
  | { kind: 'all' }
  | { kind: 'documents' }
  | { kind: 'scenes' }
  | { kind: 'models' }
  | { kind: 'library'; sourceId?: string }
  | { kind: 'globalLibraries'; sourceId?: string };

/**
 * What the detail pane is describing (§3.6).
 *
 * The `folder` and `file` variants are plan-703 Phase 6: with a tree instead of
 * a grid, a click can land on something that is not a document at all. Neither
 * is folded into `model` — they have no document id, nothing opens them, and
 * the verbs the pane offers for them are a different set. Their identity is the
 * pair `(rootId, relPath)`, which is what the tree addresses every node by;
 * `relPath` is empty for a root, so a root is a `folder` selection and needs no
 * variant of its own.
 *
 * They are two variants rather than one with a flag because they answer to
 * different verbs: a folder can be renamed and dropped into, a `file` is an
 * attachment whose move rewrites `docs-index.json` (§2.6.5).
 */
export type ProjectsSelection =
  | { kind: 'none' }
  | { kind: 'project'; projectId: string }
  | { kind: 'scene'; sceneId: string }
  | { kind: 'model'; modelId: string }
  | { kind: 'folder'; rootId: string; relPath: string }
  | { kind: 'file'; rootId: string; relPath: string }
  | { kind: 'asset'; providerId: string; sourceId: string; assetId: string };

/**
 * Which of the two screens is showing.
 *
 * `projects` is the list (or the "no workspace yet" empty state); `project` is
 * the contents of the open one. Nothing else is a view — a third screen would
 * need a real history stack, and §3.1 is explicit that this is one drill-down.
 */
export type ProjectsView = 'projects' | 'project';

export interface ProjectsDashboardSnapshot {
  open: boolean;
  view: ProjectsView;
  group: ProjectsRailGroup;
  selection: ProjectsSelection;
  search: string;
  /**
   * Selected classification chip of the document view, or null for "All"
   * (plan-413 §3.1).
   *
   * Typed `string | null` rather than the chip union so an unknown value —
   * a stale deep link, a future level — is a filter that matches nothing
   * rather than a type error at the store boundary. The view resolves it.
   */
  chip: string | null;
  /** Selected tag of the document view, or null for "any tag". */
  tag: string | null;
}

const NONE: ProjectsSelection = { kind: 'none' };
const DEFAULT_GROUP: ProjectsRailGroup = { kind: 'projects' };
const DEFAULT_VIEW: ProjectsView = 'projects';

let _snapshot: ProjectsDashboardSnapshot = {
  open: false,
  view: DEFAULT_VIEW,
  group: DEFAULT_GROUP,
  selection: NONE,
  search: '',
  chip: null,
  tag: null,
};

const _listeners = new Set<() => void>();

function publish(next: Partial<ProjectsDashboardSnapshot>): void {
  _snapshot = { ..._snapshot, ...next };
  for (const l of _listeners) {
    try { l(); } catch { /* a subscriber must never break the dashboard */ }
  }
}

export function subscribeProjectsDashboard(listener: () => void): () => void {
  _listeners.add(listener);
  return () => { _listeners.delete(listener); };
}

/**
 * Stable snapshot for `useSyncExternalStore`.
 *
 * Returns the *same object* until something actually changes. Minting a fresh
 * object per read is the classic infinite-render bug (see the store fallback
 * note in §2.6.4) — React treats a new identity as a change, every time.
 */
export function getProjectsDashboardSnapshot(): ProjectsDashboardSnapshot {
  return _snapshot;
}

/**
 * Open the dashboard, optionally aimed at a group.
 *
 * A group other than `projects` is a deep link into project *contents* (the
 * planner's "browse global libraries", for instance), so it lands on the
 * project screen rather than the list. Without a group the dashboard simply
 * resumes: {@link closeProjectsDashboard} keeps the whole state, so a plain
 * open shows exactly what the user left — screen, selection, filters. Only
 * the very FIRST plain open aims at the project screen, because there is
 * nothing to resume yet and whoever is working inside a project should not
 * re-enter it through the selection list. The host still falls back to the
 * list when no project is actually open.
 */
let _everOpened = false;

export function openProjectsDashboard(group?: ProjectsRailGroup): void {
  const first = !_everOpened;
  _everOpened = true;
  publish({
    open: true,
    ...(group
      ? { view: group.kind === 'projects' ? 'projects' : 'project', group }
      : first ? { view: 'project' } : {}),
  });
}

/**
 * Close, keeping everything else.
 *
 * The dashboard is a place the user returns to, and it used to forget itself
 * on the way out — selection, screen, search, filters all reset. Reopening
 * now resumes exactly where the user left; the resets stay with the actions
 * that change what the state refers to ({@link setProjectsView},
 * {@link setProjectsRailGroup}).
 */
export function closeProjectsDashboard(): void {
  publish({ open: false });
}

/**
 * Switch between the project list and the open project.
 *
 * The search term is cleared with the screen: it filters completely different
 * things on either side ("which project" vs "which scene"), so carrying it
 * across would silently hide most of wherever the user just landed.
 */
export function setProjectsView(view: ProjectsView): void {
  publish({ view, selection: NONE, search: '', chip: null, tag: null });
}

export function toggleProjectsDashboard(): void {
  if (_snapshot.open) closeProjectsDashboard();
  else openProjectsDashboard();
}

/** Switching group clears the selection — it almost never survives the switch. */
export function setProjectsRailGroup(group: ProjectsRailGroup): void {
  publish({ group, selection: NONE, chip: null, tag: null });
}

export function setProjectsSelection(selection: ProjectsSelection): void {
  publish({ selection });
}

export function setProjectsSearch(search: string): void {
  publish({ search });
}

export function setProjectsChip(chip: string | null): void {
  publish({ chip });
}

/** Select a tag to narrow the document view by, or null to stop narrowing. */
export function setProjectsTag(tag: string | null): void {
  publish({ tag });
}

/** Test seam: restore the module to its initial state. */
export function resetProjectsDashboardForTests(): void {
  _snapshot = {
    open: false, view: DEFAULT_VIEW, group: DEFAULT_GROUP, selection: NONE,
    search: '', chip: null, tag: null,
  };
  _everOpened = false;
  _listeners.clear();
}
