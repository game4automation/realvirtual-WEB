// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-mcp-project-tree — the HEADLESS half of the project dashboard's tree.
 *
 * `web_project_tree`, `web_project_folder` and `web_document_update` need what
 * the dashboard host already has: the built tree, the move/rename verdicts and
 * the one write path (`applyTreeMove`). The host's versions live inside a React
 * component and close over hooks, so this module re-assembles the SAME pure
 * layers — `buildDashboardTree` → `buildProjectTree` for the model,
 * `canMoveInTree` / `canRenameInTree` for the verdicts, `planTreeMove` /
 * `applyTreeMove` for the write — against the project store directly. No rule
 * is restated here; every decision is imported from where the dashboard makes
 * it, which is what keeps an MCP rename and an F2 rename the same rename.
 *
 * Scope: the PROJECT root only. Catalogs are read-only sources with their own
 * verbs (import/publish); an MCP tree that offered them as rows would offer
 * moves the model refuses anyway (`cross-root`).
 */

import type { ProjectStore } from '../../core/project/project-store';
import type { ProjectTreeNode, TreeEditVerdict } from '../../core/project/rv-project-tree';
import {
  buildProjectTree,
  findTreeNode,
  isReservedSystemFolder,
  planTreeMove,
} from '../../core/project/rv-project-tree';
import { buildDashboardTree } from '../../core/project/rv-project-tree-sources';
import { listProjectFiles } from '../../core/project/backends/project-backend';
import {
  applyTreeMove,
  DOCS_INDEX_FILE,
  type TreeMoveIO,
  type TreeMoveOutcome,
} from '../../core/project/rv-project-tree-move';
import { docsIndexPaths, parseDocsIndex } from '../../core/project/rv-docs-index';
import { documentsOf } from '../../core/project/rv-project-documents';
import {
  normaliseFolderPath,
  readProjectFolders,
  withProjectFolders,
} from '../../core/project/rv-project-types';

/** A project-relative path, normalised the way the tree spells them. */
export function normaliseRelPath(raw: string | null | undefined): string {
  return (raw ?? '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+|\/+$/g, '').trim();
}

export interface LoadedProjectTree {
  store: ProjectStore;
  projectId: string;
  writable: boolean;
  /** The one root — the open project. */
  root: ProjectTreeNode;
  roots: ProjectTreeNode[];
}

/**
 * Build the project root's tree from the live store, or explain why not.
 *
 * The inputs are the dashboard's exactly: manifest document rows, the
 * `docs-index.json` attachment paths (best-effort — most projects have none)
 * and the declared folders, so an empty folder the user just created is a row
 * here too.
 */
export async function loadProjectTree(
  store: ProjectStore,
): Promise<LoadedProjectTree | { error: string }> {
  const project = store.getProject();
  const backend = store.getBackend();
  if (!project || !backend) {
    return { error: 'No project is open — open one with web_project_open.' };
  }

  let attachments: string[] = [];
  try {
    const bytes = await backend.readBlobBytes(DOCS_INDEX_FILE);
    if (bytes) {
      const text = new TextDecoder().decode(bytes);
      attachments = docsIndexPaths(parseDocsIndex(JSON.parse(text) as unknown));
    }
  } catch { /* a project without a docs index simply has no attachments */ }

  // The SAME listing derivation the dashboard host runs, not a second one
  // (plan-445 §2.4). Before this, `web_project_tree` was built without the
  // config and knowledge lists — so an MCP client and the screen beside it
  // disagreed about what the project contains, and `plainFiles` would have
  // made the gap wider still.
  const { configs, knowledge, plainFiles } = await listProjectFiles(backend);

  const tree = buildDashboardTree({
    project: {
      id: project.id,
      name: project.name,
      writable: backend.writable === true,
      documents: documentsOf(project),
      attachments,
      configs,
      knowledge,
      plainFiles,
      folders: readProjectFolders(project),
    },
  });
  const roots = buildProjectTree(tree.roots);
  const root = roots[0];
  if (!root) return { error: 'The open project produced no tree root.' };
  return { store, projectId: project.id, writable: backend.writable === true, root, roots };
}

/** The tree node at a project-relative path, or null. */
export function nodeAtRelPath(
  loaded: LoadedProjectTree,
  relPath: string,
): ProjectTreeNode | null {
  const rel = normaliseRelPath(relPath);
  if (rel === '') return loaded.root;
  return findTreeNode(loaded.roots, `${loaded.projectId}/${rel}`);
}

/** One human sentence per {@link TreeEditVerdict} refusal. */
export function refusalSentence(reason: string, path: string): string {
  switch (reason) {
    case 'not-found': return `Nothing in the project tree at "${path}" — check web_project_tree.`;
    case 'read-only': return 'This project (or this row) is read-only.';
    case 'system': return `"${path}" is a reserved system row (settings/connect/rag/thumbnails/.trash) and cannot be restructured.`;
    case 'cross-root': return 'Catalog rows cannot be restructured — only the project root is writable.';
    case 'into-itself': return 'A folder cannot be moved into itself or its own subtree.';
    case 'not-a-folder': return 'The destination is not a folder.';
    case 'inert': return `"${path}" is listed but carries no verbs — it is neither a document, an attachment, a CONNECT config nor a knowledge file.`;
    case 'name-taken': return 'The destination already holds an entry with that name.';
    case 'invalid-name': return 'Invalid name — it must be non-empty and free of \\ / : * ? " < > | characters.';
    case 'unchanged': return 'That edit changes nothing — the path stays the same.';
    default: return `Refused: ${reason}.`;
  }
}

/**
 * The `TreeMoveIO` an MCP edit writes through — the host's `treeMoveIO`,
 * re-spelled over `readBlobBytes` (no object URLs needed headlessly).
 */
export function mcpTreeMoveIO(store: ProjectStore): TreeMoveIO | null {
  const backend = store.getBackend();
  if (!backend?.writable) return null;
  const readBytes = async (relPath: string): Promise<Blob | null> => {
    const bytes = await backend.readBlobBytes(relPath).catch(() => null);
    return bytes ? new Blob([bytes]) : null;
  };
  return {
    readBytes,
    writeBytes: (relPath, blob) => backend.writeBlob(relPath, blob),
    deleteBytes: relPath => backend.deleteBlob(relPath),
    readManifest: async () => store.getProject(),
    writeManifest: next => store.replaceManifest(next),
    readDocsIndex: async () => {
      const blob = await readBytes(DOCS_INDEX_FILE);
      if (!blob) return null;
      try { return JSON.parse(await blob.text()) as unknown; } catch { return null; }
    },
    writeDocsIndex: index => backend.writeBlob(
      DOCS_INDEX_FILE,
      new Blob([JSON.stringify(index, null, 2)], { type: 'application/json' }),
    ),
  };
}

/**
 * Perform an ACCEPTED move/rename verdict — the headless `runTreeEdit`.
 *
 * Same three steps as the host, same order: `applyTreeMove` (manifest computed
 * first, bytes copy-then-delete, docs-index repoint), the declared-folders
 * remap for a folder node (an EMPTY folder has no bytes, so without this its
 * rename would snap back on the next rebuild), then `rescanDocuments()` so
 * every listing and the dashboard see the result immediately.
 */
export async function performTreeEdit(
  loaded: LoadedProjectTree,
  node: ProjectTreeNode,
  verdict: TreeEditVerdict,
): Promise<TreeMoveOutcome> {
  if (!verdict.ok) throw new Error(refusalSentence(verdict.reason, node.relPath));
  const io = mcpTreeMoveIO(loaded.store);
  if (!io) throw new Error('This project is read-only.');

  const plan = planTreeMove(loaded.roots, node.path!, verdict);
  const outcome = await applyTreeMove(io, plan);

  if (node.kind === 'folder') {
    const from = verdict.from;
    const to = verdict.to;
    await loaded.store.applyManifestDelta(current => {
      const remapped = readProjectFolders(current).map(p =>
        p === from ? to : (p.startsWith(`${from}/`) ? to + p.slice(from.length) : p));
      return withProjectFolders(current, remapped);
    });
  }
  await loaded.store.rescanDocuments();
  return outcome;
}

/**
 * Declare a new (empty) folder, after the same checks the dashboard's verb runs.
 *
 * Creation is a manifest entry, nothing on disk: a folder exists by being
 * declared or by holding something (`rv-project-tree` rule). Returns the
 * normalised path it declared.
 */
export async function declareFolder(
  loaded: LoadedProjectTree,
  rawPath: string,
): Promise<{ path: string } | { error: string }> {
  if (!loaded.writable) return { error: 'This project is read-only.' };
  const path = normaliseFolderPath(normaliseRelPath(rawPath));
  if (!path) return { error: 'A folder path is required, e.g. "parts" or "library/Machines".' };
  for (const segment of path.split('/')) {
    if (segment === '.' || segment === '..' || /[\\/:*?"<>|]/.test(segment)) {
      return { error: refusalSentence('invalid-name', path) };
    }
  }
  const existing = nodeAtRelPath(loaded, path);
  if (existing && existing.kind !== 'folder') {
    return { error: `"${path}" already exists and is not a folder.` };
  }
  if (existing?.kind === 'folder') {
    return { error: `The folder "${path}" already exists.` };
  }
  if (isReservedSystemFolder(path.split('/')[0])) {
    return { error: refusalSentence('system', path) };
  }
  await loaded.store.applyManifestDelta(current =>
    withProjectFolders(current, [...readProjectFolders(current), path]));
  await loaded.store.rescanDocuments();
  return { path };
}

/** Serializable projection of a tree node, depth-limited. */
export interface TreeNodeJson {
  name: string;
  kind: string;
  path: string;
  documentId?: string;
  writable: boolean;
  children?: TreeNodeJson[];
  childrenOmitted?: number;
}

export function serializeTreeNode(node: ProjectTreeNode, maxDepth: number): TreeNodeJson {
  const out: TreeNodeJson = {
    name: node.name,
    kind: node.kind,
    path: node.relPath,
    ...(node.documentId ? { documentId: node.documentId } : {}),
    writable: node.writable,
  };
  if (node.children.length > 0) {
    if (maxDepth <= 0) {
      out.childrenOmitted = node.children.length;
    } else {
      out.children = node.children.map(c => serializeTreeNode(c, maxDepth - 1));
    }
  }
  return out;
}
