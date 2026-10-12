// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * forget-project-traces — what unlinking a folder project takes with it
 * (plan-478 F10, extended by plan-509 F7).
 *
 * Every verb that unlinks a project — Remove from list, Delete project, and the
 * Replace branch of Locate — must drop the same traces, or the one it forgot
 * keeps offering a project the user just took away. One function, called at
 * every such site, is what keeps the three from drifting apart:
 *
 *  - its **recents** (a row pointing at an unlinked project can only ever
 *    answer "that project could not be opened");
 *  - its **model-index snapshot** — the FOLDER one only. The bundled demo
 *    exists under the same id as `bundled:<id>` and is not the user's to
 *    unlink. A write already scheduled for the project is cancelled by the
 *    store's forget hook before the delete;
 *  - its documents' **last modes** (plan-513 F11) — the FOLDER ones only, for
 *    the same reason as the snapshot.
 */

import { forgetRecentsOfProject } from '../../project/rv-project-recents-store';
import { forgetModelIndexOfProject } from '../../project/rv-model-index-store';
import { forgetDocumentModesOfProject } from '../../project/rv-document-mode-store';

export interface ForgetProjectTracesDeps {
  forgetRecentsOfProject(projectId: string): void;
  forgetModelIndexOfProject(backend: 'folder', projectId: string): Promise<void>;
  forgetDocumentModesOfProject(backend: 'folder', projectId: string): Promise<void>;
}

const defaultDeps: ForgetProjectTracesDeps = {
  forgetRecentsOfProject, forgetModelIndexOfProject, forgetDocumentModesOfProject,
};

/** Drop the recents, the folder model-index snapshot and the folder last modes of an unlinked project. */
export async function forgetProjectTraces(
  projectId: string,
  deps: ForgetProjectTracesDeps = defaultDeps,
): Promise<void> {
  deps.forgetRecentsOfProject(projectId);
  await deps.forgetModelIndexOfProject('folder', projectId);
  await deps.forgetDocumentModesOfProject('folder', projectId);
}
