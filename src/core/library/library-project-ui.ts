// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * library-project-ui — the shared view rules of a library PROJECT in every
 * browsing surface (plan-778 Phase 2): the planner's Library window, the
 * Projects dashboard's library roots, the Add library… dialog.
 *
 * React-free on purpose: the planner panel and the dashboard render it their
 * own way; what a state is CALLED and which repair it offers is decided once.
 *
 * | state | badge | repair |
 * |---|---|---|
 * | pending | Loading… | — |
 * | ready | Ready | — |
 * | locked | Access needed | **Grant** (`library.grant`) |
 * | unknown | Not found | **Locate folder…** (`library.locate`, only with `showDirectoryPicker`) |
 * | error | Failed to load | **Locate folder…** (same) |
 */

import { commandRegistry, type ExecuteResult } from '../hmi/rv-command-registry';
import type { RVViewer } from '../rv-viewer';
import type { RegisteredLibrarySource } from './library-source-registry';
import { isLibraryProjectSource, type LibraryProjectSource } from './library-projects-provider';
import { LIBRARY_PROJECTS_PROVIDER_ID } from './library-origin';
import { canLocateLibrary, canPickLibraryFolder, LIBRARY_GRANT_COMMAND, LIBRARY_LOCATE_COMMAND } from './library-availability';

export type LibraryProjectStateKind = 'pending' | 'ready' | 'locked' | 'unknown' | 'error';

export interface LibraryStateBadge {
  /** Short word(s) for the badge. */
  text: string;
  /** The repair button's label, or null. */
  repairLabel: string | null;
  /** The repair command, or null. */
  repairCommand: string | null;
  /** True for a state that needs the user (locked / unknown / error). */
  attention: boolean;
}

/** The badge + repair of one state. Locate is offered only where a folder can be picked (F10), never for the built-in realvirtual library (review U4). */
export function libraryStateBadge(state: string | null | undefined, projectId?: string): LibraryStateBadge {
  switch (state) {
    case 'ready': return { text: 'Ready', repairLabel: null, repairCommand: null, attention: false };
    case 'locked': return { text: 'Access needed', repairLabel: 'Grant', repairCommand: LIBRARY_GRANT_COMMAND, attention: true };
    case 'unknown':
    case 'error': {
      const locate = canPickLibraryFolder() && (projectId === undefined || canLocateLibrary(projectId));
      return {
        text: state === 'unknown' ? 'Not found' : 'Failed to load',
        repairLabel: locate ? 'Locate folder…' : null,
        repairCommand: locate ? LIBRARY_LOCATE_COMMAND : null,
        attention: true,
      };
    }
    default: return { text: 'Loading…', repairLabel: null, repairCommand: null, attention: false };
  }
}

/**
 * Dispatch the repair of a library — call it DIRECTLY from the click handler,
 * never after an await: the command reaches `requestPermission` /
 * `showDirectoryPicker` synchronously only from here.
 */
export function runLibraryRepair(
  projectId: string,
  state: string | null | undefined,
  viewer?: RVViewer,
): Promise<ExecuteResult> | null {
  const { repairCommand } = libraryStateBadge(state, projectId);
  if (!repairCommand) return null;
  return commandRegistry.execute(repairCommand, { projectId }, { origin: 'ui', ...(viewer ? { viewer } : {}) });
}

/** One "needed by <B>" group: the transitive libraries B needs. Not placeable. */
export interface NeededByGroup {
  /** Project id of the library that needs them. */
  neededById: string;
  /** Its label. */
  neededByLabel: string;
  items: Array<{ projectId: string; label: string; state: LibraryProjectStateKind }>;
}

/** The library-projects sources of a registry snapshot. */
export function libraryProjectSourcesOf(sources: readonly RegisteredLibrarySource[]): LibraryProjectSource[] {
  const out: LibraryProjectSource[] = [];
  for (const { providerId, source } of sources) {
    if (providerId === LIBRARY_PROJECTS_PROVIDER_ID && isLibraryProjectSource(source)) out.push(source);
  }
  return out;
}

/**
 * The transitive libraries, grouped by the library that needs them (Decision 4:
 * only direct libraries are placeable — these are listed, never offered for
 * placing). A library needed by two others appears in both groups.
 */
export function buildNeededByGroups(sources: readonly RegisteredLibrarySource[]): NeededByGroup[] {
  const libs = libraryProjectSourcesOf(sources);
  const labelOf = (id: string): string => libs.find((s) => s.id === id)?.label ?? id;
  const groups = new Map<string, NeededByGroup>();
  for (const s of libs) {
    if (s.direct) continue;
    for (const by of s.neededBy) {
      let g = groups.get(by);
      if (!g) { g = { neededById: by, neededByLabel: labelOf(by), items: [] }; groups.set(by, g); }
      g.items.push({ projectId: s.id, label: s.label, state: s.state });
    }
  }
  return [...groups.values()];
}
