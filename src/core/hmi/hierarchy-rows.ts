// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * The hierarchy IS the scene graph (plan-754 D1, Phase 2).
 *
 * Before this module the panel rendered a PROJECTION: a tree rebuilt from the
 * path strings of every node that happened to carry rv_extras, with raw
 * Three.js children lazily grafted back in for `LayoutObject` / `CADLink`, a
 * synthetic `Geometry` type for bare meshes and a composition view for the
 * planner. Four ways to invent a tree that already existed.
 *
 * Now a row IS an `Object3D`. `viewer.scene` is the root, `children` is the
 * whole answer, and everything else — badges, path, eye state — is read off the
 * object. Nothing is filtered out by kind: floor, lights, gizmos, chunk meshes
 * and hover overlays all get a row (D1). What the registry does not know is
 * simply flagged `runtime` and the toolbar can hide it (D2).
 *
 * ## Why an adapter and not `TreeNode` everywhere
 *
 * `TreeNode` / `flattenVisibleTree` stay: the project tree borrows them for
 * files, where there IS no Object3D. This module produces `TreeNode`-SHAPED
 * rows for the EXPANDED part of the graph only, on demand — a 70k-node model
 * costs as many rows as the user has opened, never more.
 *
 * ## Identity
 *
 * Row key = `Object3D.uuid`. Paths change on rename and reparent and do not
 * exist at all for unregistered nodes, so they cannot key a virtualized list;
 * the uuid is stable for the object's whole life, which is what keeps the
 * virtualizer's measurement cache intact across a live mutation (R8).
 *
 * ## The one presentation exception: the baked-geometry fold row (plan-505)
 *
 * A boundary's direct chunk meshes are not listed as siblings of its real
 * children. They are folded behind ONE display-only row,
 * `Geometry · N chunks · M tris` ({@link ChunkFoldRow}), which is the only row
 * that is NOT an `Object3D` — the same kind of presentation choice as
 * `snapLabel` and the model-root label, and deliberately narrow:
 *
 * - it exists only as `synthetic: 'baked-fold'`, recognised by {@link isChunkFoldRow};
 * - it has no `object`, no path, no selection, no context menu, no drag;
 * - its key is `${boundary.uuid}::baked` — stable for the boundary's life (R8);
 * - it is invisible to MCP (`web_node_tree` / the scene snapshot read the graph
 *   through `rv-node-classification.ts`, never through this adapter).
 *
 * The chunk meshes under it stay real rows (selectable, inspectable). The
 * toolbar toggle "Show baked geometry" (`hideBaked`, default hidden) removes
 * fold and chunk rows; a SELECTED chunk stays visible (`revealObjects`).
 */

import type { Material, Mesh, Object3D } from 'three';
import type { RVExtrasOverlay } from '../engine/rv-extras-overlay-store';
import { isChunkMesh, isRuntimeNode } from '../engine/rv-node-classification';
import { RV_SYNTHETIC_KEY } from '../engine/rv-bake-chunk';
import { chunkRowLabel, chunkTriangles, foldRowLabel } from './chunk-row-labels';
import { extractComponentTypes } from './rv-inspector-helpers';
import { matchesFilter, parseFilterId, snapLabel, type HierarchyFilterId, type TreeNode, type VisibleTreeRow } from './hierarchy-utils';
import { categoryOf, type CategoryId } from '../engine/rv-component-category';

// ─── Types ───────────────────────────────────────────────────────────────

/** A hierarchy row that is backed by a real scene object. */
export interface SceneTreeNode extends TreeNode {
  /** The scene object this row IS. */
  object: Object3D;
  /** Not registered in the `NodeRegistry` — the document does not address it (D2). */
  runtime: boolean;
  /** A mesh the bake produced (merged triangles of a boundary). */
  chunk: boolean;
  /** A chunk row shown only because it is selected while the toggle hides
   *  baked geometry (plan-505 F6) — rendered dimmed. */
  revealed?: boolean;
}

/**
 * The display-only row that folds a boundary's direct chunk meshes (plan-505).
 *
 * The one documented exception to "a row IS an Object3D" (see the module
 * header): no object, no path, not selectable, not an MCP target.
 */
export interface ChunkFoldRow extends TreeNode {
  synthetic: 'baked-fold';
  /** The boundary whose direct chunk children this row folds. */
  boundary: Object3D;
  chunkCount: number;
  triangles: number;
  /** `${boundary.uuid}::baked` — stable across bakes of the same boundary (R8). */
  expandKey: string;
  /** True when hidden by the toggle but shown for the selection (F6). */
  revealed: boolean;
}

/** Any row the scene hierarchy renders. */
export type HierarchyRow = SceneTreeNode | ChunkFoldRow;

/** Is this row the baked-geometry fold row? */
export function isChunkFoldRow(row: TreeNode): row is ChunkFoldRow {
  return (row as Partial<ChunkFoldRow>).synthetic === 'baked-fold';
}

/** Expand key of a boundary's fold row. */
export function chunkFoldKey(boundary: Object3D): string {
  return `${boundary.uuid}::baked`;
}

/** Everything the row adapter reads about the world it renders. */
export interface SceneRowContext {
  /** The document's address book. A node it does not know is `runtime`. */
  getPathForNode(node: Object3D): string | null;
  /** Override badge source; may be null. */
  overlay: RVExtrasOverlay | null;
  /** `viewer.currentModelRoot` — its row carries the label + lock (plan-715). */
  modelRoot: Object3D | null;
  /** Document name for the model-root row. */
  modelRootLabel?: string | null;
  /** Hide rows the registry does not know (toolbar toggle, default off). */
  hideRuntime: boolean;
  /**
   * Hide baked chunk meshes and their fold rows (plan-505 F5). The panel
   * defaults it to true; absent means false (everything shown), so a fixture
   * that predates the toggle keeps rendering chunks.
   */
  hideBaked?: boolean;
  /** Selected objects that must stay visible although the toggle hides them. */
  revealObjects?: ReadonlySet<Object3D>;
}

// ─── Node classification ─────────────────────────────────────────────────

/** The `chunk` / `runtime` classification is shared with the MCP observation
 *  layer so panel and agent answer identically (plan-754 F11). Re-exported
 *  because the panel's consumers have always imported it from here. */
export { isChunkMesh };

/** Anything the renderer draws: `Mesh`, `Line`, `Points`, `Sprite`. */
function isDrawable(object: Object3D): boolean {
  const o = object as Partial<Mesh> & { isLine?: boolean; isPoints?: boolean; isSprite?: boolean };
  return o.isMesh === true || o.isLine === true || o.isPoints === true || o.isSprite === true;
}

/**
 * The nearest ancestor whose subtree actually owns drawable geometry — the
 * boundary this node's triangles were merged INTO (D8). Used for the disabled
 * eye's tooltip; null when there is no such ancestor.
 */
export function mergedBoundaryName(object: Object3D): string | null {
  for (let a = object.parent; a; a = a.parent) {
    for (const child of a.children) {
      if (isChunkMesh(child) || isDrawable(child)) return a.name || a.type;
      // plan-755: a boundary whose geometry is ALL partitioned has no direct
      // chunk child — its chunks hang one level down, under the partition
      // objects the bake created. It is still the boundary.
      if ((child.userData as Record<string, unknown> | undefined)?.[RV_SYNTHETIC_KEY] === true) {
        for (const grandChild of child.children) if (isChunkMesh(grandChild)) return a.name || a.type;
      }
    }
  }
  return null;
}

/**
 * Does this subtree contain anything that is actually drawn?
 *
 * The eye is enabled exactly when the answer is yes (D8): `.visible = false` on
 * a node whose triangles live in an ancestor's chunk hides nothing, and an
 * affordance that silently does nothing is worse than a disabled one.
 *
 * Memoised per object and invalidated by `revision` (the `BakeRegistry`'s), so
 * a virtualized list pays one walk per row per bake, not one per frame.
 */
const drawableCache = new WeakMap<Object3D, { revision: number; value: boolean }>();

export function subtreeHasDrawable(object: Object3D, revision = 0): boolean {
  const hit = drawableCache.get(object);
  if (hit && hit.revision === revision) return hit.value;
  let found = false;
  object.traverse((n) => { if (!found && isDrawable(n)) found = true; });
  drawableCache.set(object, { revision, value: found });
  return found;
}

/** Label for a row: the node name, a snap's readable form, a chunk's, or
 *  `<type> <short uuid>` for the nameless nodes D1 insists on showing.
 *
 *  A chunk's label is a DISPLAY label ("kind + size", plan-505), not a rename:
 *  `Mesh.name` is the chunk key and doubles as the pick/debug identity that
 *  `web_node_find`, the inspector and the placement tests read. */
export function rowLabel(object: Object3D): string {
  if (isChunkMesh(object)) return chunkRowLabel(object as Mesh);
  const name = object.name;
  if (name) return snapLabel(name) ?? name;
  if (object.type === 'Scene') return 'Scene';
  return `${object.type} ${object.uuid.slice(0, 6)}`;
}

// ─── Row construction ────────────────────────────────────────────────────

/**
 * One row for one object. Cheap by construction: a registry Map lookup, the
 * extras key scan and four field reads — no traversal, no allocation beyond
 * the row itself and its (empty) children array.
 */
export function sceneRow(object: Object3D, ctx: SceneRowContext): SceneTreeNode {
  const path = ctx.getPathForNode(object);
  const types = extractComponentTypes((object.userData as Record<string, unknown> | undefined)?.realvirtual);
  const isRoot = ctx.modelRoot !== null && object === ctx.modelRoot;
  const label = rowLabel(object);
  const chunk = isChunkMesh(object);
  return {
    object,
    // A chunk mesh is unregistered too, but it is not "runtime": it IS the
    // document's geometry, merged. It gets its own badge and survives the
    // toggle, so "hide runtime objects" still leaves a drawable tree (§3).
    runtime: isRuntimeNode(object, path),
    chunk,
    name: object.name || object.type,
    displayLabel: isRoot ? (ctx.modelRootLabel || label) : label,
    path,
    types,
    hasOverrides: path !== null && !!ctx.overlay?.nodes[path],
    children: [],
    hasChildren: object.children.length > 0,
    expandKey: object.uuid,
    isModelRoot: isRoot || undefined,
    locked: isLockedLayoutObject(object) || undefined,
  };
}

/** `LayoutObject.Locked` on THIS object — the same field the planner's
 *  `isLockedLayoutInstance` reads; duplicated here so the row adapter does not
 *  pull the plugin into core. */
function isLockedLayoutObject(object: Object3D): boolean {
  const rv = (object.userData as Record<string, unknown> | undefined)?.realvirtual as
    Record<string, Record<string, unknown>> | undefined;
  return rv?.LayoutObject?.Locked === true;
}

/**
 * Is this row open?
 *
 * Accepts BOTH key spellings (§2.7 "keys migrate from path to path-or-uuid"):
 * the persisted `rv-hierarchy-expanded` set is full of path keys from before
 * this change, and honouring them keeps a user's open branches open across the
 * upgrade. New writes are always uuids; a stale path key matches nothing and
 * therefore expands nothing.
 */
export function isRowExpanded(row: SceneTreeNode, expanded: ReadonlySet<string>): boolean {
  if (expanded.has(row.object.uuid)) return true;
  return row.path !== null && expanded.has(row.path);
}

/** A row is skipped entirely when the toggle hides runtime objects (D2), or
 *  when it is a chunk the baked-geometry toggle hides and nobody selected it
 *  (plan-505 F5/F6). */
function isHidden(row: SceneTreeNode, ctx: SceneRowContext): boolean {
  if (ctx.hideRuntime && row.runtime) return true;
  return !!ctx.hideBaked && row.chunk && !ctx.revealObjects?.has(row.object);
}

/**
 * The fold row for `boundary`'s direct chunk children. Aggregates over the
 * given children only — never a traversal.
 */
function foldRowFor(boundary: Object3D, chunks: readonly Object3D[], revealed: boolean): ChunkFoldRow {
  let triangles = 0;
  for (const c of chunks) triangles += chunkTriangles(c as Mesh);
  return {
    synthetic: 'baked-fold',
    boundary,
    chunkCount: chunks.length,
    triangles,
    expandKey: chunkFoldKey(boundary),
    revealed,
    name: 'Geometry',
    displayLabel: foldRowLabel(chunks.length, triangles),
    path: null,
    types: [],
    hasOverrides: false,
    children: [],
    hasChildren: true,
  };
}

// ─── Flatten (the render path) ───────────────────────────────────────────

/**
 * The visible rows of the scene graph, in render order.
 *
 * Walks `children` and descends ONLY into expanded rows, so the cost is the
 * number of rows on screen plus their siblings — never the graph size. This is
 * the function that replaces `buildStructureTree` + `applyLazyInjection` +
 * `filterTree` + `flattenVisibleTree` on the non-search path.
 */
export function flattenSceneRows(
  root: Object3D,
  expanded: ReadonlySet<string>,
  ctx: SceneRowContext,
): VisibleTreeRow[] {
  const rows: VisibleTreeRow[] = [];

  const walk = (parent: Object3D, depth: number): void => {
    // `setSize`/`posInSet` are ARIA sibling metadata and must count the rows we
    // actually render, so hidden runtime siblings are resolved first. Direct
    // chunk children are split off: they render behind ONE fold row, after the
    // real children (plan-505 F1).
    const visible: HierarchyRow[] = [];
    let chunks: Object3D[] | null = null;
    for (const object of parent.children) {
      if (isChunkMesh(object)) { (chunks ??= []).push(object); continue; }
      const row = sceneRow(object, ctx);
      if (!isHidden(row, ctx)) visible.push(row);
    }
    let shownChunks: SceneTreeNode[] | null = null;
    if (chunks) {
      // With the toggle on, only selected chunks survive `isHidden` — and they
      // are shown "despite the filter".
      const revealed = !!ctx.hideBaked;
      for (const object of chunks) {
        const row = sceneRow(object, ctx);
        if (isHidden(row, ctx)) continue;
        if (revealed) row.revealed = true;
        (shownChunks ??= []).push(row);
      }
      if (shownChunks) visible.push(foldRowFor(parent, chunks, revealed));
    }
    for (let i = 0; i < visible.length; i++) {
      const row = visible[i];
      if (isChunkFoldRow(row)) {
        rows.push({ node: row, depth, rowKey: row.expandKey, posInSet: i + 1, setSize: visible.length });
        if (shownChunks && expanded.has(row.expandKey)) {
          for (let j = 0; j < shownChunks.length; j++) {
            const chunkRow = shownChunks[j];
            rows.push({ node: chunkRow, depth: depth + 1, rowKey: chunkRow.object.uuid, posInSet: j + 1, setSize: shownChunks.length });
            if (chunkRow.hasChildren && isRowExpanded(chunkRow, expanded)) walk(chunkRow.object, depth + 2);
          }
        }
        continue;
      }
      rows.push({ node: row, depth, rowKey: row.object.uuid, posInSet: i + 1, setSize: visible.length });
      if (row.hasChildren && isRowExpanded(row, expanded)) {
        walk(row.object, depth + 1);
      }
    }
  };

  const rootRow = sceneRow(root, ctx);
  rows.push({ node: rootRow, depth: 0, rowKey: root.uuid, posInSet: 1, setSize: 1 });
  if (rootRow.hasChildren && isRowExpanded(rootRow, expanded)) walk(root, 1);
  return rows;
}

/**
 * The expand keys that make `target`'s row visible: the uuids of its ancestors
 * up to (and including) `root`, plus — for a chunk mesh — its boundary's fold
 * row (plan-505 F6). The object form of the path-based reveal, for nodes the
 * registry does not address.
 */
export function revealExpandKeysFor(target: Object3D, root: Object3D): string[] {
  const keys: string[] = [];
  for (let a: Object3D | null = target.parent; a; a = a.parent) {
    keys.unshift(a.uuid);
    if (a === root) break;
  }
  if (isChunkMesh(target) && target.parent) keys.push(chunkFoldKey(target.parent));
  return keys;
}

// ─── Search + type filters (scene walks, D11) ────────────────────────────

/** Extra searchable text for a node (AAS description, Metadata content, …). */
export type SearchTextProvider = (object: Object3D) => readonly string[];

/**
 * THE hierarchy search predicate (name, display label, full path, component
 * search text) — shared by the All-view tree search, the category view's flat
 * list and the "3/21" chip counts (plan-597 Phase 6b), so a count can never
 * disagree with the list it summarises. `lower` must already be lower case.
 */
export function matchesSearchTerm(
  object: Object3D,
  path: string | null,
  lower: string,
  ctx: Pick<SceneRowContext, 'modelRoot' | 'modelRootLabel'>,
  searchText?: SearchTextProvider,
): boolean {
  const name = object.name || object.type;
  const own = rowLabel(object);
  const label = ctx.modelRoot !== null && object === ctx.modelRoot ? (ctx.modelRootLabel || own) : own;
  if (label.toLowerCase().includes(lower) || name.toLowerCase().includes(lower)) return true;
  if (path && path.toLowerCase().includes(lower)) return true;
  return !!searchText && searchText(object).some((t) => t.toLowerCase().includes(lower));
}

/**
 * Prune the scene graph to the branches that match `term`, with their ancestors.
 *
 * Replaces `filterTree` over the projection: same matching rules (name, full
 * path, component search text), but sourced from the graph, so a raw CAD part
 * or a chunk mesh is findable too.
 */
export function buildSceneSearchTree(
  root: Object3D,
  term: string,
  ctx: SceneRowContext,
  searchText?: SearchTextProvider,
): SceneTreeNode[] {
  const lower = term.toLowerCase();

  // The runtime and baked toggles are deliberately NOT applied here: a search
  // is an explicit request for a name, so a hidden light, gizmo or chunk must
  // still be findable. The toggles only de-clutter the browsing tree (and the
  // scene root itself is a runtime node, so honouring it here would prune every
  // match). Matching chunks keep their fold row, so the pruned tree has the
  // same shape as the browsing tree (plan-505 F8).
  const visit = (object: Object3D): SceneTreeNode | null => {
    const row = sceneRow(object, ctx);

    const children: TreeNode[] = [];
    let chunks: Object3D[] | null = null;
    let keptChunks: SceneTreeNode[] | null = null;
    for (const child of object.children) {
      const chunk = isChunkMesh(child);
      if (chunk) (chunks ??= []).push(child);
      const kept = visit(child);
      if (!kept) continue;
      if (chunk) (keptChunks ??= []).push(kept);
      else children.push(kept);
    }
    if (chunks && keptChunks) {
      const fold = foldRowFor(object, chunks, false);
      fold.children = keptChunks;
      children.push(fold);
    }

    const matches = matchesSearchTerm(object, row.path, lower, ctx, searchText);
    if (!matches && children.length === 0) return null;
    row.children = children;
    row.hasChildren = children.length > 0;
    return row;
  };

  const kept = visit(root);
  return kept ? [kept] : [];
}

/** Every expand key of a pruned search tree — a match must never hide under a
 *  collapsed ancestor, nor under a collapsed fold row. */
export function searchExpandKeys(nodes: readonly TreeNode[]): Set<string> {
  const keys = new Set<string>();
  const walk = (n: TreeNode): void => {
    keys.add(isChunkFoldRow(n) ? n.expandKey : (n as SceneTreeNode).object.uuid);
    for (const c of n.children) walk(c);
  };
  for (const n of nodes) walk(n);
  return keys;
}

/**
 * Rows matching one category filter, in scene order (D11).
 *
 * A scene walk over `userData.realvirtual`, deliberately NOT
 * `NodeRegistry.typeIndex`: the panel shows the graph, and the graph is the one
 * thing that is true for unregistered nodes too. Called once per filter change
 * and cached by the caller — never per frame.
 */
export function collectTypeRows(
  root: Object3D,
  filter: HierarchyFilterId,
  ctx: SceneRowContext,
): SceneTreeNode[] {
  const out: SceneTreeNode[] = [];
  root.traverse((object) => {
    const types = extractComponentTypes((object.userData as Record<string, unknown> | undefined)?.realvirtual);
    if (types.length === 0) return;
    if (!matchesFilter(types, filter)) return;
    const row = sceneRow(object, ctx);
    if (!isHidden(row, ctx)) out.push(row);
  });
  return out;
}

/** Row counts of the panel: footer total + toggle hints, and the category /
 *  label counts the filter chips show (plan-597). */
export interface TypeCounts {
  total: number;
  withOverrides: number;
  runtimeHidden: number;
  bakedHidden: number;
  /** Nodes per category — a node counts ONCE per category it has a type in. */
  byCategory: Map<CategoryId, number>;
  /** Nodes per label within a category — a node counts ONCE per label. */
  byLabel: Map<CategoryId, Map<string, number>>;
  /** One type key per label (`<category>/<label>` → first type seen) — the
   *  colour source of the label's menu dot. */
  labelType: Map<string, string>;
}

// Per-node dedupe scratch (a node has 1-3 types; a linear scan beats a Set and
// allocates nothing). Reset per node; the walk is synchronous, so no two
// counts ever share it.
const seenCategories: CategoryId[] = [];
const seenLabels: string[] = [];

/** A search restricting {@link collectTypeCounts} to the nodes that match it. */
export interface CountSearch {
  term: string;
  searchText?: SearchTextProvider;
}

/** How many rows each category / label would show, plus the total row count and
 *  how many runtime nodes / baked chunks the toggles currently hide (footer
 *  hints). ONE scene walk; per typed node only memoised `categoryOf` lookups.
 *
 *  With `search` (plan-597 Phase 6b, the "3/21" chip counts) only nodes that
 *  pass {@link matchesSearchTerm} are counted — the same toggles apply, so a
 *  matching count is never above its total, and a category's matching count is
 *  exactly the length of that category's flat list under the same term.
 *  `runtimeHidden` / `bakedHidden` stay unfiltered toggle counts. */
export function collectTypeCounts(root: Object3D, ctx: SceneRowContext, search?: CountSearch): TypeCounts {
  const lower = search && search.term ? search.term.toLowerCase() : null;
  const searchText = search?.searchText;
  const byCategory = new Map<CategoryId, number>();
  const byLabel = new Map<CategoryId, Map<string, number>>();
  const labelType = new Map<string, string>();
  let total = 0;
  let withOverrides = 0;
  let runtimeHidden = 0;
  let bakedHidden = 0;
  root.traverse((object) => {
    const path = ctx.getPathForNode(object);
    if (ctx.hideRuntime && isRuntimeNode(object, path)) { runtimeHidden++; return; }
    if (ctx.hideBaked && isChunkMesh(object)) { bakedHidden++; return; }
    if (lower !== null && !matchesSearchTerm(object, path, lower, ctx, searchText)) return;
    total++;
    if (path !== null && ctx.overlay?.nodes[path]) withOverrides++;
    const types = extractComponentTypes((object.userData as Record<string, unknown> | undefined)?.realvirtual);
    if (types.length === 0) return;
    seenCategories.length = 0;
    seenLabels.length = 0;
    for (const t of types) {
      const { category, label } = categoryOf(t);
      if (!seenCategories.includes(category)) {
        seenCategories.push(category);
        byCategory.set(category, (byCategory.get(category) ?? 0) + 1);
      }
      // Label dedupe is per (category, label): the same label string in two
      // categories is two entries. Pairs are stored flat.
      let seen = false;
      for (let i = 0; i < seenLabels.length; i += 2) {
        if (seenLabels[i] === category && seenLabels[i + 1] === label) { seen = true; break; }
      }
      if (seen) continue;
      seenLabels.push(category, label);
      let labels = byLabel.get(category);
      if (!labels) { labels = new Map(); byLabel.set(category, labels); }
      const prev = labels.get(label);
      labels.set(label, (prev ?? 0) + 1);
      if (prev === undefined) labelType.set(`${category}/${label}`, t);
    }
  });
  return { total, withOverrides, runtimeHidden, bakedHidden, byCategory, byLabel, labelType };
}

/** Rows the filter would show according to `counts` (`all` → the total). */
export function filterCount(counts: TypeCounts, id: HierarchyFilterId): number {
  if (id === 'all') return counts.total;
  const { category, label } = parseFilterId(id);
  if (category === null) return counts.total;
  if (label === null) return counts.byCategory.get(category as CategoryId) ?? 0;
  return counts.byLabel.get(category as CategoryId)?.get(label) ?? 0;
}

// ─── Filter validation after a model load (plan-597 §2.3) ─────────────────

/** The slice of the viewer the filter validation reads. */
export interface FilterValidationViewer {
  on(event: 'model-loaded' | 'model-cleared', handler: () => void): () => void;
  whenSceneReady(): Promise<void>;
  readonly currentModelRoot: Object3D | null;
}

export interface FilterValidationOptions {
  viewer: FilterValidationViewer;
  /** The subtree the panel counts (`viewer.scene` or the root override). */
  getRoot(): Object3D;
  getCtx(): SceneRowContext;
  getFilter(): HierarchyFilterId;
  /** Called when the persisted filter has no hits in the freshly loaded model. */
  onInvalid(): void;
  /** True while an asset document is active OR still opening (draft replay):
   *  its ops may add exactly the nodes the filter is waiting for. */
  isAssetBusy(): boolean;
}

/**
 * Event-bound validation of the active filter (plan-597 §2.3).
 *
 * `rootObject` is the scene itself and a model switch only bumps a tick, so a
 * switch is not visible to a memo. The validation runs on `model-loaded`
 * instead, after `whenSceneReady()` (placements and nested references settle
 * outside `model-loaded`), counting FRESH (the memoised counts trail one
 * animation frame behind). A generation counter drops a validation that a
 * newer load or a clear overtook. On mount it runs once if a model is already
 * loaded; before the first load it does nothing (the empty scene would reset
 * every filter). While an asset document is active or opening it never resets
 * (a draft replay runs after `whenSceneReady`). Any other structural change
 * does NOT validate: an active filter is never pulled away under the user.
 * Returns the unsubscribe.
 */
export function watchHierarchyFilterValidation(opts: FilterValidationOptions): () => void {
  const { viewer } = opts;
  let gen = 0;
  let disposed = false;
  const validate = async (): Promise<void> => {
    const mine = ++gen;
    const busyAtLoad = opts.isAssetBusy();
    try {
      await viewer.whenSceneReady();
    } catch {
      return;
    }
    if (disposed || mine !== gen) return;
    if (busyAtLoad || opts.isAssetBusy()) return;
    const id = opts.getFilter();
    if (id === 'all') return;
    if (filterCount(collectTypeCounts(opts.getRoot(), opts.getCtx()), id) === 0) opts.onInvalid();
  };
  const offLoaded = viewer.on('model-loaded', () => { void validate(); });
  const offCleared = viewer.on('model-cleared', () => { gen++; });
  if (viewer.currentModelRoot !== null) void validate();
  return () => {
    disposed = true;
    offLoaded();
    offCleared();
  };
}

// ─── Live mutation (R8) ──────────────────────────────────────────────────

/**
 * Subscribe to structural change under the rows that are currently OPEN.
 *
 * Three.js dispatches `childadded` / `childremoved` on the DIRECT parent and
 * does not bubble (Object3D.js:773-777, issue #27563 is still open), so a
 * listener per expanded object is not an optimisation — it is the only thing
 * that works. The subscription count follows the UI state, never the 70k graph.
 *
 * `onChange` is called on every event; the caller coalesces to one re-flatten
 * per frame, which is what keeps hover overlays (added and removed under an
 * expanded row EVERY frame) from re-rendering the list 60× a second.
 *
 * Returns the unsubscribe for the whole set.
 */
export function subscribeStructure(
  objects: readonly Object3D[],
  onChange: () => void,
): () => void {
  const listener = () => onChange();
  for (const object of objects) {
    object.addEventListener('childadded', listener);
    object.addEventListener('childremoved', listener);
  }
  return () => {
    for (const object of objects) {
      object.removeEventListener('childadded', listener);
      object.removeEventListener('childremoved', listener);
    }
  };
}

/** The objects a row set must listen on: every rendered row that is expanded
 *  (its children are on screen) plus the root. A fold row has no object and is
 *  skipped — its boundary is already a rendered row (plan-505). */
export function structuralListenTargets(rows: readonly VisibleTreeRow[]): Object3D[] {
  const targets: Object3D[] = [];
  for (const row of rows) {
    const object = (row.node as SceneTreeNode).object;
    if (object) targets.push(object);
  }
  return targets;
}

// ─── Mesh material helper (shared by the row tooltip) ────────────────────

/** Material names of a drawable, for the row tooltip. Kept here so the row
 *  component stays free of Three.js type narrowing. */
export function materialNames(object: Object3D): string[] {
  const material = (object as Partial<Mesh>).material as Material | Material[] | undefined;
  if (!material) return [];
  return (Array.isArray(material) ? material : [material]).map((m) => m.name || m.type);
}
