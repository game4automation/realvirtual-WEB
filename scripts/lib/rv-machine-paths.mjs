// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-machine-paths — machine-independent resolution of the paths that live
 * OUTSIDE the git repositories.
 *
 * The repos themselves are always found relative to a script's own location
 * (`import.meta.url`), so they need no help. What used to be hardcoded were the
 * siblings of the checkout — temp dir, worktree base, RAG runtime — which
 * differ per developer machine and broke every workflow on a second checkout.
 *
 * Single rule: everything derives from the **workspace root**, i.e. the nearest
 * ancestor directory that contains a `.plastic` folder. The tree below it is
 * identical on every machine:
 *
 *   <workspaceRoot>/                     E:\realvirtual6  |  C:\Users\<user>\wkspaces\game4automation-release
 *   ├── .plastic/                        ← the marker
 *   ├── ignore.conf
 *   ├── rv-tmp/                          ← build/child temp (tmpDir)
 *   ├── rag-runtime/                     ← RAG seed index (ragSeedIndex)
 *   └── game4automation/
 *       ├── realvirtual/                 ← this Unity project
 *       └── realvirtualReleaseDLLs/      ← out-of-repo build sources (releaseDllsDir)
 *
 *   <parent of workspaceRoot>/
 *   └── rv-worktrees/                    ← plan worktree sessions (worktreeRoot)
 *
 * Every getter takes an explicit env override first, so a machine that deviates
 * from the convention stays usable without code changes.
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));

/** Marker directory that identifies the Plastic workspace root. */
const WORKSPACE_MARKER = '.plastic';

/**
 * Nearest ancestor of `startDir` containing `.plastic`, or null when the
 * checkout is detached from a Plastic workspace (CI, a bare git clone, a
 * worktree session).
 */
export function findWorkspaceRoot(startDir = scriptDir) {
  let current = resolve(startDir);
  for (;;) {
    if (existsSync(join(current, WORKSPACE_MARKER))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * The workspace root. `RV_WORKSPACE_ROOT` wins; otherwise the `.plastic` walk-up;
 * otherwise the structural fallback four levels above this script's repo
 * (`<root>/game4automation/realvirtual/Assets/realvirtual-WebViewer~/scripts/lib`),
 * which keeps worktree sessions working where no `.plastic` marker exists.
 */
export function workspaceRoot() {
  const override = process.env.RV_WORKSPACE_ROOT;
  if (override) return resolve(override);
  return findWorkspaceRoot() ?? resolve(scriptDir, '../../../../../..');
}

/** Sibling of the workspace root, e.g. `rv-worktrees` next to `realvirtual6`. */
export function siblingOfWorkspace(name) {
  return join(dirname(workspaceRoot()), name);
}

/**
 * Temp directory for build children. The shell's inherited TMP/TEMP is often on
 * a full system drive and the RAG step then dies with ENOSPC, so callers force
 * this onto the workspace drive instead. Override: `RV_DELIVER_TMP`.
 */
export function tmpDir() {
  return resolve(process.env.RV_DELIVER_TMP || join(workspaceRoot(), 'rv-tmp'));
}

/** Base directory for plan worktree sessions. Override: `RV_WORKTREE_ROOT`. */
export function worktreeRoot() {
  return resolve(process.env.RV_WORKTREE_ROOT || siblingOfWorkspace('rv-worktrees'));
}

/** RAG vector index consumed by the delivery bundler. Override: `RV_RAG_SEED_INDEX`. */
export function ragSeedIndex() {
  return resolve(
    process.env.RV_RAG_SEED_INDEX
      || join(workspaceRoot(), 'rag-runtime', 'data-scaleway', 'runtime', 'vector-index.json'),
  );
}

/** Out-of-repo build sources (wasm/exe/dll crates). Override: `RV_RELEASE_DLLS`. */
export function releaseDllsDir() {
  return resolve(
    process.env.RV_RELEASE_DLLS || join(workspaceRoot(), 'game4automation', 'realvirtualReleaseDLLs'),
  );
}
