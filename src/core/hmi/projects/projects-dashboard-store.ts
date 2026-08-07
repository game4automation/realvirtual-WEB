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

/** Which rail group the grid is showing (§3.2). */
export type ProjectsRailGroup =
  | { kind: 'projects' }
  | { kind: 'all' }
  | { kind: 'scenes' }
  | { kind: 'models' }
  | { kind: 'library'; sourceId?: string }
  | { kind: 'globalLibraries'; sourceId?: string };

/** What the detail pane is describing (§3.6). */
export type ProjectsSelection =
  | { kind: 'none' }
  | { kind: 'project'; projectId: string }
  | { kind: 'scene'; sceneId: string }
  | { kind: 'model'; modelId: string }
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
  /** Selected filter chip in the grid, or null for "All". */
  chip: string | null;
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
 * project screen rather than the list. Without a group the list is the entry
 * point — the host still falls back to it if no project is actually open.
 */
export function openProjectsDashboard(group?: ProjectsRailGroup): void {
  publish({
    open: true,
    ...(group ? { group, view: group.kind === 'projects' ? 'projects' : 'project' } : {}),
  });
}

/** Close and reset the transient view state, but keep the rail group. */
export function closeProjectsDashboard(): void {
  publish({ open: false, view: DEFAULT_VIEW, selection: NONE, search: '', chip: null });
}

/**
 * Switch between the project list and the open project.
 *
 * The search term is cleared with the screen: it filters completely different
 * things on either side ("which project" vs "which scene"), so carrying it
 * across would silently hide most of wherever the user just landed.
 */
export function setProjectsView(view: ProjectsView): void {
  publish({ view, selection: NONE, search: '', chip: null });
}

export function toggleProjectsDashboard(): void {
  if (_snapshot.open) closeProjectsDashboard();
  else openProjectsDashboard();
}

/** Switching group clears the selection — it almost never survives the switch. */
export function setProjectsRailGroup(group: ProjectsRailGroup): void {
  publish({ group, selection: NONE, chip: null });
}

/**
 * The three tabs of the project screen.
 *
 * Deliberately derived from {@link ProjectsRailGroup} rather than stored beside
 * it. The group already carries exactly this information, already survives a
 * close, and is already what `openProjectsDashboard({kind:'globalLibraries'})`
 * sets — a second field would be a copy that can disagree with it, and the
 * planner's deep link would have to remember to set both.
 */
export type ProjectTab = 'models' | 'scenes' | 'assets';

/**
 * Which tab a group means. Both library kinds collapse onto Assets, because
 * the Assets tab shows project and global libraries together; `all` and
 * `projects` carry no tab of their own and land on Models, the tab a project
 * is most useful opening on.
 */
export function projectTabOf(group: ProjectsRailGroup): ProjectTab {
  switch (group.kind) {
    case 'scenes': return 'scenes';
    case 'library':
    case 'globalLibraries': return 'assets';
    default: return 'models';
  }
}

/** Select a tab. Clears the selection, exactly as a group switch always has. */
export function setProjectsTab(tab: ProjectTab): void {
  setProjectsRailGroup(
    tab === 'assets' ? { kind: 'library' } : { kind: tab },
  );
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

/** Test seam: restore the module to its initial state. */
export function resetProjectsDashboardForTests(): void {
  _snapshot = {
    open: false, view: DEFAULT_VIEW, group: DEFAULT_GROUP, selection: NONE, search: '', chip: null,
  };
  _listeners.clear();
}
