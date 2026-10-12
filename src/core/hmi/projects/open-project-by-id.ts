// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * open-project-by-id — "open THIS project, and tell me what happened".
 *
 * Extracted from `ProjectsDashboardHost.handleOpenProject` (plan-478 Phase 3),
 * which the host keeps calling: the verb's behaviour is unchanged, it is just
 * no longer welded to a `void runVerb(...)` that nobody can await.
 *
 * Two things the inline version could not do, and both are why the recents
 * chain needs it:
 *
 *  - **it is awaitable to the END of the open**, not to the start of a
 *    fire-and-forget verb (SOL R2 F3: `runVerb`'s `busy` ends with its own
 *    callback, which says nothing about the load);
 *  - **it answers WHY** — `cancelled` (the dirty guard), `denied` (grant
 *    refused), `missing` (handle evicted or folder moved) and `failed` are
 *    four different things the caller must react to differently, where a bare
 *    `false` made them one.
 *
 * ## Three backends, three verbs (SOL R1 F4)
 *
 * `openRecentProject` needs a folder HANDLE, so it can only ever bring back a
 * `folder` project. A browser project comes back through
 * `openWorkspaceProject()`, a bundled one through `openDemoProject()`. Routing
 * on the entry's recorded `backend` is what keeps a recent of a browser
 * document from silently failing.
 *
 * ## Identity is the PAIR (SOL R2 F5)
 *
 * "Already open" is `(projectId, backend)`, never the id alone: DemoRealvirtual
 * exists under one id both as the bundled HTTP fallback and as a linked folder,
 * and treating the folder click as navigation is what left it permanently
 * read-only (the comment at `ProjectsDashboardHost.tsx:691` names that bug).
 */

import type { RecentBackend } from '../../project/rv-project-recents';

export type OpenProjectResult =
  | 'opened'
  | 'already-open'
  | 'cancelled'
  | 'denied'
  | 'missing'
  | 'failed';

export interface OpenProjectTarget {
  projectId: string;
  backend: RecentBackend;
}

/** What the verb needs from the world. Injected so it runs without React. */
export interface OpenProjectDeps {
  /** The open project's identity pair, or null when nothing is open. */
  currentProject(): { id: string; backend: RecentBackend | null } | null;
  /** Is this id one of the LINKED folder rows? */
  isLinked(projectId: string): boolean;
  resolveLinkedOpen(projectId: string):
    Promise<{ kind: 'ready'; dir: FileSystemDirectoryHandle }
      | { kind: 'denied' | 'missing' }>;
  store: {
    openDemoProject(): Promise<boolean>;
    openWorkspaceProject(): Promise<boolean>;
    openRecentProject(projectId: string): Promise<boolean>;
    openProjectFolder(dir: FileSystemDirectoryHandle): Promise<boolean>;
  };
  /** Refresh the linked list after a folder open (the host's `refreshLinked`). */
  afterLinkedOpen?(): Promise<unknown>;
  /**
   * Report what the handle lookup found, so a recents click paints the same
   * row states as the project list does (F7) instead of a second vocabulary.
   */
  onRowState?(projectId: string, state: 'ready' | 'denied' | 'missing'): void;
}

export async function openProjectById(
  target: OpenProjectTarget,
  deps: OpenProjectDeps,
): Promise<OpenProjectResult> {
  const current = deps.currentProject();
  if (current && current.id === target.projectId && current.backend === target.backend) {
    return 'already-open';
  }

  try {
    if (target.backend === 'browser') {
      return (await deps.store.openWorkspaceProject()) ? 'opened' : 'cancelled';
    }
    if (target.backend === 'bundled') {
      return (await deps.store.openDemoProject()) ? 'opened' : 'cancelled';
    }

    // folder — linked rows resolve their handle (and prompt) first, so
    // "no handle stored" and "grant refused" stay two different answers.
    if (deps.isLinked(target.projectId)) {
      const resolved = await deps.resolveLinkedOpen(target.projectId);
      if (resolved.kind !== 'ready') {
        deps.onRowState?.(target.projectId, resolved.kind);
        return resolved.kind;
      }
      deps.onRowState?.(target.projectId, 'ready');
      const ok = await deps.store.openProjectFolder(resolved.dir);
      if (!ok) return 'cancelled';
      await deps.afterLinkedOpen?.();
      return 'opened';
    }
    return (await deps.store.openRecentProject(target.projectId)) ? 'opened' : 'cancelled';
  } catch {
    // A throw is the store's own failure surface; the host already reports it
    // as "That project could not be opened."
    return 'failed';
  }
}
