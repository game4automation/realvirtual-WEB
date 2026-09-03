// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-project-tree — one tree, several roots (plan-703 Phase 6, §2.6, F11–F13).
 *
 * The dashboard used to be two tabs over three lists. This module is the model
 * behind the thing that replaces them: **one** tree whose first root is the
 * project folder and whose remaining roots are the attached catalogs.
 *
 * ## The four rules, and the whole module is those four rules
 *
 *  1. **Several roots, one tree.** Root 1 is the project folder and is fully
 *     restructurable. Roots 2..n are catalogs — URL, GitHub, Asset Manager or a
 *     local folder — marked as such, and restructurable only where they are
 *     writable. **No catalog is another project** (decision 6), which is why
 *     there is no cross-project reference problem to solve here.
 *  2. **Folders lost their meaning.** `models` / `library` / `scenes` / `splats`
 *     are ordinary folders now; the folder path IS the category (decision 7).
 *     `settings` / `connect` / `rag` / `thumbnails` / `.trash` stay reserved,
 *     under ONE collapsed *System* node, and are not restructurable.
 *  3. **Nothing moves on disk from building a tree.** Every function here takes
 *     a listing and returns nodes. The reserved folders are *grouped* under a
 *     synthetic node; their paths are untouched.
 *  4. **A move never breaks a reference.** For a GLB, moving rewrites the
 *     manifest row's `path` and nothing else — Phase 5 built that
 *     ({@link moveDocumentPath}). For a non-GLB it rewrites `docs-index.json`
 *     (§2.6.5, decision 23), and it may only rewrite rows that already exist.
 *
 * ## Reuse, not a second tree implementation
 *
 * The rows are `TreeNode`s from `hierarchy-utils`, so `flattenVisibleTree` —
 * expansion, depth, `posInSet`/`setSize` for ARIA — is the *same* code the scene
 * hierarchy runs. Only the node payload differs, and it differs by ADDING
 * fields, never by changing the ones the flattener reads.
 *
 * ## What this module refuses to know
 *
 * Storage. There is no `FileSystemDirectoryHandle`, no backend and no React in
 * here, which is what lets the whole of §9.14's rule set be tested against
 * plain objects.
 */

import type { TreeNode, VisibleTreeRow } from '../hmi/hierarchy-utils';
import { flattenVisibleTree } from '../hmi/hierarchy-utils';
import {
  CONNECT_CONFIG_SUFFIX, KNOWLEDGE_FILE_SUFFIX,
  isConnectConfigPath, isKnowledgeFilePath,
} from './rv-project-refs';

// ─── Reserved folders ───────────────────────────────────────────────────

/**
 * Folders that keep their meaning and are NOT the user's to rearrange.
 *
 * Deliberately short, and deliberately not `models`/`library`/`scenes`/`splats`:
 * those four are what decision 7 demoted to ordinary folders. What is left is
 * machinery — the settings bundle, the CONNECT config, the RAG index, the
 * thumbnail cache and the trash. Moving any of them breaks a reader that looks
 * them up by name, and none of them is content the user authored.
 */
export const RESERVED_SYSTEM_FOLDERS: readonly string[] = [
  'settings', 'connect', 'rag', 'thumbnails', '.trash',
] as const;

/**
 * Synthetic path segment of the one collapsed node the reserved folders live
 * under.
 *
 * Double-underscored so it cannot collide with a real folder name: a project
 * that happened to hold a folder called `system` would otherwise give two rows
 * one row key, and the virtualizer would render whichever it saw last.
 */
export const SYSTEM_NODE_PATH = '__system__';

/** Is this a top-level folder name the user may not restructure? */
export function isReservedSystemFolder(name: string): boolean {
  return RESERVED_SYSTEM_FOLDERS.includes(name);
}

// ─── Node model ─────────────────────────────────────────────────────────

export type ProjectTreeKind = 'root' | 'folder' | 'document' | 'file' | 'system';

/** Where a root came from. Catalogs are marked; the project folder is not. */
export type ProjectTreeRootKind = 'project' | 'catalog';

/**
 * A tree row. Extends `TreeNode` rather than replacing it so
 * {@link flattenProjectTree} can be the scene hierarchy's flattener verbatim.
 *
 * `path` is the flattener's row key and must therefore be unique across the
 * WHOLE tree, not just within one root — two catalogs may both hold
 * `parts/Roll.glb`. So it is always `<rootId>/<relative path>`, and
 * {@link relPath} is what a caller hands to storage.
 */
export interface ProjectTreeNode extends TreeNode {
  kind: ProjectTreeKind;
  /** Which root this node belongs to. */
  rootId: string;
  /** Path INSIDE its root. Empty for the root node itself. */
  relPath: string;
  /** Manifest document id, for a GLB that has one. */
  documentId?: string;
  /** May the user move/rename/drop into this node? */
  writable: boolean;
  /**
   * A row the full-view listing shows but no verb acts on (plan-445 F2).
   *
   * The project browser lists EVERY file since plan-445, and a file that is
   * neither a manifest document, a docs-index attachment, a CONNECT config nor
   * a knowledge file has no reference model behind it — moving or renaming one
   * would rewrite bytes nothing points at, with no row to keep honest. So it is
   * visible, selectable, and inert.
   *
   * Enforced as a REFUSAL rather than as a UI state ({@link canMoveInTree},
   * {@link canRenameInTree} refuse an inert SOURCE), which is what makes the
   * MCP write path (`applyTreeMove`) obey it too and not only the tree widget.
   */
  inert?: boolean;
  /** Roots only: project or catalog. */
  rootKind?: ProjectTreeRootKind;
  /** Roots only: remote catalogs get the `(o)` origin mark of §3.1. */
  remote?: boolean;
  /**
   * Roots only: the provider-declared kind of a catalog source (e.g.
   * `'github'`). Presentation only — the row icon reads it; no verb does.
   */
  sourceKind?: string;
  /**
   * Folders/roots in a {@link foldersOnlyTree} projection: does the ORIGINAL
   * node hold anything at all — documents and attachments included?
   *
   * The projection strips documents out of `children`, so a folder holding one
   * GLB and a folder holding nothing look identical to anything that counts
   * children — which is how a folder with content drew the "empty" icon. Only
   * the projection knows what it removed, so it is the projection that records
   * the answer. Absent on an unprojected tree, where `children` is already the
   * whole truth.
   */
  hasContent?: boolean;
  children: ProjectTreeNode[];
}

/** A `VisibleTreeRow` whose node is known to be a {@link ProjectTreeNode}. */
export interface ProjectTreeRow extends Omit<VisibleTreeRow, 'node'> {
  node: ProjectTreeNode;
}

// ─── Input ──────────────────────────────────────────────────────────────

/** One file, as a listing reports it. Folders are derived from the paths. */
export interface ProjectTreeFile {
  /** Path relative to the root, `/`-separated, no leading slash. */
  path: string;
  /** Display name; the file name when omitted. */
  name?: string;
  /** Manifest document id, when the file has one. */
  documentId?: string;
  /** See {@link ProjectTreeNode.inert} — a listed file with no verbs. */
  inert?: boolean;
}

export interface ProjectTreeRootInput {
  /** Stable id — the project id, or the catalog's source id. */
  id: string;
  name: string;
  kind: ProjectTreeRootKind;
  /** A read-only catalog refuses every move and rename. */
  writable: boolean;
  /** Shown with the `(o)` origin mark (§3.1). */
  remote?: boolean;
  /** See {@link ProjectTreeNode.sourceKind}. */
  sourceKind?: string;
  files: readonly ProjectTreeFile[];
  /**
   * Folders that exist without holding anything (`RvProject.folders`).
   *
   * The union with the derived ones, not a replacement: a folder that holds a
   * document appears because of the document, whether or not it is declared
   * here, so the two lists can overlap freely.
   */
  folders?: readonly string[];
}

// ─── Build ──────────────────────────────────────────────────────────────

/** Extensions the tree treats as an asset rather than an attachment. */
const DOCUMENT_EXTENSIONS = ['.glb', '.gltf', '.splat', '.ksplat', '.ply'];

/** Is this path an asset (`document`) or an attachment (`file`)? */
export function isDocumentPath(path: string): boolean {
  const lower = path.toLowerCase();
  return DOCUMENT_EXTENSIONS.some(ext => lower.endsWith(ext));
}

function normalise(path: string): string {
  return (path ?? '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+|\/+$/g, '');
}

function leafOf(path: string): string {
  return normalise(path).split('/').filter(Boolean).pop() ?? path;
}

function emptyNode(partial: Partial<ProjectTreeNode> & {
  name: string; kind: ProjectTreeKind; rootId: string; relPath: string; writable: boolean;
}): ProjectTreeNode {
  return {
    types: [],
    hasOverrides: false,
    children: [],
    ...partial,
    path: partial.path ?? `${partial.rootId}/${partial.relPath}`,
  } as ProjectTreeNode;
}

/**
 * Build one root's subtree from a flat listing.
 *
 * Folders are derived from the paths, so a listing never has to report them and
 * an empty folder simply does not appear — which is the honest answer, since
 * neither the manifest nor a catalog index records one.
 */
function buildRoot(input: ProjectTreeRootInput): ProjectTreeNode {
  const root = emptyNode({
    name: input.name,
    kind: 'root',
    rootId: input.id,
    relPath: '',
    writable: input.writable,
    rootKind: input.kind,
    path: input.id,
    ...(input.remote ? { remote: true } : {}),
    ...(input.sourceKind ? { sourceKind: input.sourceKind } : {}),
  });

  // The System node is created lazily: a project with no reserved folder on disk
  // must not grow an empty one, or every fresh project would open showing a node
  // whose only content is the promise of content.
  let system: ProjectTreeNode | null = null;
  const folders = new Map<string, ProjectTreeNode>();

  const folderFor = (relDir: string, reserved: boolean): ProjectTreeNode => {
    if (relDir === '') return reserved ? systemNode() : root;
    const existing = folders.get(relDir);
    if (existing) return existing;
    const parentDir = relDir.slice(0, Math.max(0, relDir.lastIndexOf('/')));
    const parent = folderFor(parentDir, reserved);
    const node = emptyNode({
      name: leafOf(relDir),
      kind: 'folder',
      rootId: input.id,
      relPath: relDir,
      // A reserved folder and everything under it is off limits (§2.6.2).
      writable: input.writable && !reserved,
    });
    folders.set(relDir, node);
    parent.children.push(node);
    return node;
  };

  function systemNode(): ProjectTreeNode {
    if (system) return system;
    system = emptyNode({
      name: 'System',
      kind: 'system',
      rootId: input.id,
      relPath: '',
      writable: false,
      path: `${input.id}/${SYSTEM_NODE_PATH}`,
    });
    root.children.push(system);
    return system;
  }

  for (const file of input.files) {
    const rel = normalise(file.path);
    if (rel === '') continue;
    const segments = rel.split('/');
    const reserved = isReservedSystemFolder(segments[0]);
    const dir = segments.slice(0, -1).join('/');
    const parent = folderFor(dir, reserved);
    parent.children.push(emptyNode({
      name: file.name?.trim() || leafOf(rel),
      kind: isDocumentPath(rel) ? 'document' : 'file',
      rootId: input.id,
      relPath: rel,
      writable: input.writable && !reserved,
      ...(file.documentId ? { documentId: file.documentId } : {}),
      ...(file.inert ? { inert: true } : {}),
    }));
  }

  // Declared folders LAST, so a folder that also holds a file has already been
  // created by the loop above and `folderFor` simply returns it. Creating the
  // node is the whole job — an empty folder is exactly a node with no children.
  for (const declared of input.folders ?? []) {
    const rel = normalise(declared);
    if (rel === '') continue;
    folderFor(rel, isReservedSystemFolder(rel.split('/')[0]));
  }

  sortChildren(root);
  return root;
}

/** Folders first, then names, case-insensitively — and System always last. */
function sortChildren(node: ProjectTreeNode): void {
  node.children.sort((a, b) => {
    if (a.kind === 'system') return 1;
    if (b.kind === 'system') return -1;
    const aDir = a.kind === 'folder' ? 0 : 1;
    const bDir = b.kind === 'folder' ? 0 : 1;
    if (aDir !== bDir) return aDir - bDir;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
  for (const child of node.children) sortChildren(child);
}

/** The whole tree: the project root first, then the catalogs, as siblings. */
export function buildProjectTree(roots: readonly ProjectTreeRootInput[]): ProjectTreeNode[] {
  return roots.map(buildRoot);
}

/**
 * The visible rows, via the scene hierarchy's own flattener.
 *
 * The cast is the one place this module admits that `flattenVisibleTree` is
 * typed against `TreeNode`: it copies the node reference through untouched, so
 * every node in the result *is* the `ProjectTreeNode` that went in. Narrowing it
 * back is a statement about the flattener, not a claim about the data.
 */
export function flattenProjectTree(
  roots: readonly ProjectTreeNode[],
  expanded: ReadonlySet<string>,
): ProjectTreeRow[] {
  return flattenVisibleTree(roots as unknown as TreeNode[], expanded) as unknown as ProjectTreeRow[];
}

/** Every node of the tree, depth-first — the lookup the move rules run over. */
export function walkProjectTree(roots: readonly ProjectTreeNode[]): ProjectTreeNode[] {
  const out: ProjectTreeNode[] = [];
  const walk = (node: ProjectTreeNode): void => {
    out.push(node);
    for (const child of node.children) walk(child);
  };
  for (const root of roots) walk(root);
  return out;
}

/** The node at `path`, or null. */
export function findTreeNode(
  roots: readonly ProjectTreeNode[],
  path: string,
): ProjectTreeNode | null {
  return walkProjectTree(roots).find(n => n.path === path) ?? null;
}

/** Paths of the nodes that must be expanded for `path` to be visible. */
export function ancestorPathsOf(
  roots: readonly ProjectTreeNode[],
  path: string,
): string[] {
  const out: string[] = [];
  const walk = (node: ProjectTreeNode, trail: string[]): boolean => {
    if (node.path === path) { out.push(...trail); return true; }
    const next = [...trail, node.path!];
    return node.children.some(child => walk(child, next));
  };
  for (const root of roots) if (walk(root, [])) break;
  return out;
}

/**
 * The set of paths a freshly opened tree shows expanded.
 *
 * Every root, and nothing else. Specifically **not** the System node
 * (decision 7 says collapsed) and not the content folders — a plant with two
 * hundred parts must not open as two hundred rows.
 */
export function defaultExpandedPaths(roots: readonly ProjectTreeNode[]): Set<string> {
  return new Set(roots.map(r => r.path!).filter(Boolean));
}

// ─── Folders left, contents right (plan-703 Lauf 13) ────────────────────

/**
 * The same tree with every `document` and `file` row taken out.
 *
 * The Unity project-window split: the tree carries the folder structure and
 * nothing else, the assets are cards beside it. This is a **projection, not a
 * different tree** — it is built for rendering only and every rule still runs
 * against the full roots. That matters in three places that would silently go
 * wrong on a pruned tree: {@link planTreeMove} reads a folder's descendants off
 * it, {@link canMoveInTree} refuses a name that a *document* already occupies,
 * and the detail pane looks an attachment up by path.
 *
 * The copies are shallow apart from `children`, so `path` / `relPath` /
 * `writable` are identical objects' worth of data and a projected node can be
 * handed straight back to a rule that keys on `path`.
 */
export function foldersOnlyTree(
  roots: readonly ProjectTreeNode[],
): ProjectTreeNode[] {
  const prune = (node: ProjectTreeNode): ProjectTreeNode => ({
    ...node,
    // Recorded BEFORE the filter, because after it the answer is unknowable:
    // the icon asks "does this folder hold anything", and a folder whose only
    // content is a document must not read as empty (`hasContent`).
    hasContent: node.children.length > 0,
    children: node.children
      .filter(c => c.kind === 'folder' || c.kind === 'system' || c.kind === 'root')
      .map(prune),
  });
  return roots.map(prune);
}

/**
 * The folder whose contents a row belongs to.
 *
 * A folder, a root and the System node answer with themselves — selecting a
 * folder is what "show me this folder" means. A document or an attachment
 * answers with its parent, so clicking a card never navigates away from the
 * folder the card is in.
 */
export function nearestFolderPath(
  roots: readonly ProjectTreeNode[],
  path: string | null | undefined,
): string | null {
  if (!path) return null;
  const node = findTreeNode(roots, path);
  if (!node) return null;
  if (node.kind === 'folder' || node.kind === 'root' || node.kind === 'system') return node.path!;
  return parentOf(roots, node)?.path ?? null;
}

/**
 * The direct `document` / `file` children of one folder — what the cards show.
 *
 * Direct children only: a folder is a place, not a query. Showing a folder's
 * whole subtree would make the tree beside it redundant and would mean the same
 * asset appears under three different rows.
 */
export function folderContents(
  roots: readonly ProjectTreeNode[],
  folderPath: string | null | undefined,
): ProjectTreeNode[] {
  if (!folderPath) return [];
  const node = findTreeNode(roots, folderPath);
  if (!node) return [];
  return node.children.filter(c => c.kind === 'document' || c.kind === 'file');
}

/**
 * The direct `folder` children of one folder — the navigation tiles the grid
 * shows ABOVE the asset cards.
 *
 * Separate from {@link folderContents} because the two lists live under
 * different rules downstream: documents run through the search, chip and
 * classification filters, a subfolder tile only through the search. Without
 * these tiles a folder holding nothing but subfolders read as
 * "This folder is empty" — true of its direct documents, false of the folder.
 * The `system` node stays out: it is the tree's reserved row, not a place the
 * grid navigates into.
 */
export function folderSubfolders(
  roots: readonly ProjectTreeNode[],
  folderPath: string | null | undefined,
): ProjectTreeNode[] {
  if (!folderPath) return [];
  const node = findTreeNode(roots, folderPath);
  if (!node) return [];
  return node.children.filter(c => c.kind === 'folder');
}

// ─── Move and rename ────────────────────────────────────────────────────

export type TreeEditRefusal =
  | 'not-found'
  | 'read-only'
  | 'system'
  /** The SOURCE is an inert full-view row (plan-445 F2) — no verb acts on it. */
  | 'inert'
  | 'cross-root'
  | 'into-itself'
  | 'not-a-folder'
  | 'name-taken'
  | 'invalid-name'
  | 'unchanged';

export type TreeEditVerdict =
  | { ok: true; from: string; to: string }
  | { ok: false; reason: TreeEditRefusal };

/** Characters no path segment may carry — the intersection of what OSes allow. */
const ILLEGAL_NAME = /[\\/:*?"<>|]/;

function joinRel(dir: string, name: string): string {
  return dir === '' ? name : `${dir}/${name}`;
}

/** Does `parent` already hold a child called `name` (case-insensitively)? */
function hasChildNamed(parent: ProjectTreeNode, name: string, except?: ProjectTreeNode): boolean {
  const wanted = name.toLowerCase();
  return parent.children.some(c => c !== except && c.name.toLowerCase() === wanted);
}

/**
 * Does `parent` already hold a child whose REL PATH is `relPath`?
 *
 * The sibling of {@link hasChildNamed}, and the authoritative half of the pair:
 * a display name is suffix-stripped (`device.connect.json` shows as `device`),
 * so two rows can differ by name and still be one file — or agree by name and
 * be two. The name check answers "would the user see two identical rows", this
 * one answers "would the write clobber something".
 */
function hasChildAtRelPath(
  parent: ProjectTreeNode,
  relPath: string,
  except?: ProjectTreeNode,
): boolean {
  const wanted = relPath.toLowerCase();
  return parent.children.some(c => c !== except && c.relPath.toLowerCase() === wanted);
}

/**
 * The FILE name of a node — the last segment of its rel path.
 *
 * Deliberately not `node.name`. A row's name is a DISPLAY name: a manifest
 * document shows `Bar`, not `Bar.glb`, and a CONNECT config shows `device`, not
 * `device.connect.json`. Building a destination path out of it is how a move
 * silently renamed `models/Bar.glb` to `Bar` — the extension gone, the file
 * dropped out of every extension-filtered scan, and the row therefore invisible
 * everywhere afterwards (LOP-119, plan-445 F3). A folder has no extension to
 * lose and its name IS its segment, so the two agree there.
 */
export function fileNameOf(node: ProjectTreeNode): string {
  if (node.kind === 'folder' || node.relPath === '') return node.name;
  return node.relPath.split('/').pop() || node.name;
}

/**
 * Can SOME rename of this row succeed — the structural half of
 * {@link canRenameInTree}, without a candidate name.
 *
 * What a "Rename…" verb needs in order to decide whether to be OFFERED at all
 * (plan-445 F4): the name-dependent refusals (`invalid-name`, `name-taken`,
 * `unchanged`) are answers to a name the user has not typed yet, and hiding the
 * verb for them would hide it always. Kept beside `canRenameInTree` and reused
 * BY it, so the verb can never be offered where the commit refuses.
 */
export function isRenamableInTree(
  roots: readonly ProjectTreeNode[],
  path: string | null | undefined,
): boolean {
  const node = path ? findTreeNode(roots, path) : null;
  return node !== null && renameRefusalOf(node) === null;
}

/** The name-independent refusal for renaming `node`, or null when there is none. */
function renameRefusalOf(node: ProjectTreeNode): TreeEditRefusal | null {
  if (node.kind === 'root' || node.kind === 'system') return 'system';
  if (node.inert) return 'inert';
  if (!node.writable) return 'read-only';
  return null;
}

/**
 * May `node` be dropped into `target`, and where would it land?
 *
 * Every refusal is a named reason rather than a boolean, because the row that
 * refuses is also the row that has to say why — "this catalog is read-only" and
 * "there is already a file called that" send the user to two different places.
 *
 * **Cross-root moves are refused** (`cross-root`). A catalog is not the
 * project's storage and the project is not the catalog's; carrying bytes between
 * them is an import or a publish, both of which are their own verbs with their
 * own confirmations. A drag is not the place to invent one.
 */
export function canMoveInTree(
  roots: readonly ProjectTreeNode[],
  fromPath: string,
  targetFolderPath: string,
): TreeEditVerdict {
  const node = findTreeNode(roots, fromPath);
  const target = findTreeNode(roots, targetFolderPath);
  if (!node || !target) return { ok: false, reason: 'not-found' };
  if (node.kind === 'root' || node.kind === 'system') return { ok: false, reason: 'system' };
  // The SOURCE, not only the target: an inert row (plan-445 F2) is refused
  // here rather than merely hidden from the drag affordance, which is what
  // makes the MCP write path obey the rule as well as the tree widget.
  if (node.inert) return { ok: false, reason: 'inert' };
  if (target.kind === 'system') return { ok: false, reason: 'system' };
  if (target.kind !== 'folder' && target.kind !== 'root') return { ok: false, reason: 'not-a-folder' };
  if (!node.writable || !target.writable) return { ok: false, reason: 'read-only' };
  if (node.rootId !== target.rootId) return { ok: false, reason: 'cross-root' };

  // A folder cannot become its own descendant. Compared on the rel path with a
  // trailing slash so `parts` does not look like an ancestor of `parts_old`.
  if (node.kind === 'folder'
    && (target.relPath === node.relPath || target.relPath.startsWith(`${node.relPath}/`))) {
    return { ok: false, reason: 'into-itself' };
  }

  // The FILE name, never the display name — see {@link fileNameOf}. This one
  // line is LOP-119: with `node.name` a move rewrote `models/Bar.glb` to `Bar`.
  const to = joinRel(target.relPath, fileNameOf(node));
  if (to === node.relPath) return { ok: false, reason: 'unchanged' };
  // Both halves: the path decides whether bytes would be clobbered, the name
  // decides whether the user would end up with two rows they cannot tell apart.
  if (hasChildAtRelPath(target, to) || hasChildNamed(target, node.name)) {
    return { ok: false, reason: 'name-taken' };
  }
  return { ok: true, from: node.relPath, to };
}

/** May `node` be renamed to `name`, and what would its path become? */
export function canRenameInTree(
  roots: readonly ProjectTreeNode[],
  path: string,
  name: string,
): TreeEditVerdict {
  const node = findTreeNode(roots, path);
  if (!node) return { ok: false, reason: 'not-found' };
  // The same three name-independent refusals the "Rename…" verb consults
  // before it offers itself at all — one source, so the two cannot disagree.
  const structural = renameRefusalOf(node);
  if (structural) return { ok: false, reason: structural };

  let trimmed = (name ?? '').trim();
  if (trimmed === '' || trimmed === '.' || trimmed === '..' || ILLEGAL_NAME.test(trimmed)) {
    return { ok: false, reason: 'invalid-name' };
  }

  // A FILE keeps its extension unless the new name brings one of its own.
  // Every rename route funnels through here (F2, the card dialog, the detail
  // pane), and a display name without ".glb" is what users naturally type —
  // committing it verbatim renames the file out of every extension-filtered
  // scan, which reads as the asset being deleted.
  if (node.kind !== 'folder') {
    const leaf = node.relPath.split('/').pop() ?? '';
    if (isConnectConfigPath(leaf)) {
      // A CONNECT config is classified by its COMPOUND ending (plan-718), and
      // the simple-extension rule below would keep only ".json" — silently
      // declassifying the file out of every config listing. The ending is
      // therefore restored whole, whatever the user typed.
      if (!isConnectConfigPath(trimmed)) trimmed += CONNECT_CONFIG_SUFFIX;
    } else if (isKnowledgeFilePath(leaf)) {
      // Same compound-ending rule for knowledge files.
      if (!isKnowledgeFilePath(trimmed)) trimmed += KNOWLEDGE_FILE_SUFFIX;
    } else {
      const dot = leaf.lastIndexOf('.');
      const ext = dot > 0 ? leaf.slice(dot) : '';
      if (ext && !/\.[a-z0-9]+$/i.test(trimmed)) trimmed += ext;
    }
  }

  if (trimmed === node.name) return { ok: false, reason: 'unchanged' };

  const dir = node.relPath.slice(0, Math.max(0, node.relPath.lastIndexOf('/')));
  const to = joinRel(dir, trimmed);
  // A friendly display name plus the restored extension can land exactly on
  // the current path — that is "unchanged" at the level that matters. Answered
  // BEFORE the collision check below, so that a rename which lands back on the
  // row's own path reports "unchanged" rather than "name-taken by itself".
  if (to === node.relPath) return { ok: false, reason: 'unchanged' };

  const parent = parentOf(roots, node);
  // Path first (what a write would clobber), display name second (what the
  // user would be unable to tell apart) — the same pair `canMoveInTree` uses.
  if (parent
    && (hasChildAtRelPath(parent, to, node) || hasChildNamed(parent, trimmed, node))) {
    return { ok: false, reason: 'name-taken' };
  }
  return { ok: true, from: node.relPath, to };
}

/** The node whose `children` contains `node`, or null for a root. */
export function parentOf(
  roots: readonly ProjectTreeNode[],
  node: ProjectTreeNode,
): ProjectTreeNode | null {
  return walkProjectTree(roots).find(n => n.children.includes(node)) ?? null;
}

// ─── What a move has to write ───────────────────────────────────────────

/**
 * The two things a move touches, and neither is the other's business.
 *
 * A GLB with a manifest row moves by `moveDocumentPath` — its id is untouched,
 * which is the whole of F12. Anything else is an attachment whose links live in
 * `docs-index.json` (§2.6.5). Returning the plan instead of performing it keeps
 * the rules here and the writes at the caller, where the handles are.
 */
export interface TreeMovePlan {
  /** Rel path before and after, for the storage rename. */
  from: string;
  to: string;
  rootId: string;
  /** Set for a GLB carrying a manifest row — rewrite that row's `path`. */
  documentId?: string;
  /** True when `docs-index.json` has to be rewritten instead (§2.6.5). */
  rewritesDocsIndex: boolean;
  /**
   * True when the moved node IS a folder. A folder carries no bytes of its
   * own — its steps are exactly its descendants, and an EMPTY folder has
   * none. Without this fact the step flattening fell back to "one step for
   * the node itself" and tried to read the folder as a file, which threw
   * `"<name>" could not be read` on every empty-folder rename.
   */
  folder: boolean;
  /** Every descendant that moves with a folder, old → new rel path. */
  descendants: Array<{ from: string; to: string; documentId?: string; rewritesDocsIndex: boolean }>;
}

/** Turn an accepted verdict into the write plan. Throws on a refusal. */
export function planTreeMove(
  roots: readonly ProjectTreeNode[],
  path: string,
  verdict: TreeEditVerdict,
): TreeMovePlan {
  if (!verdict.ok) throw new Error(`planTreeMove on a refused edit: ${verdict.reason}`);
  const node = findTreeNode(roots, path);
  if (!node) throw new Error(`planTreeMove: no node at "${path}"`);

  const descendants: TreeMovePlan['descendants'] = [];
  const walk = (child: ProjectTreeNode): void => {
    if (child !== node && (child.kind === 'document' || child.kind === 'file')) {
      // Every descendant keeps its position under the moved folder.
      const suffix = child.relPath.slice(verdict.from.length);
      descendants.push({
        from: child.relPath,
        to: `${verdict.to}${suffix}`,
        ...(child.documentId ? { documentId: child.documentId } : {}),
        rewritesDocsIndex: child.kind === 'file',
      });
    }
    for (const grandchild of child.children) walk(grandchild);
  };
  walk(node);

  return {
    from: verdict.from,
    to: verdict.to,
    rootId: node.rootId,
    ...(node.documentId ? { documentId: node.documentId } : {}),
    // A GLB without a manifest row has nothing to rewrite: it is carried on its
    // path-derived id and the next save mints one (§2.5, rule 1).
    rewritesDocsIndex: node.kind === 'file',
    folder: node.kind === 'folder' || node.kind === 'root',
    descendants,
  };
}
