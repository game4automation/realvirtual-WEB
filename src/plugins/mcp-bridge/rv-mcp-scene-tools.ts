// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-mcp-scene-tools — MCP tools for the STRUCTURE of what is loaded: node and
 * component queries, the workspace mode, the parts catalogue (`web_catalog_*`),
 * the layout planner with its snap-driven building, and the document write
 * verbs that operate on the loaded scene (`web_document_save` / `_new` /
 * `_update`).
 *
 * Delegate class of McpBridgePlugin (multi-instance dispatcher — see
 * rv-mcp-tools.ts). Split out of the plugin by plan-713 Phase 1 as a pure code
 * move, proven against the frozen baseline by `rv-mcp-delegate-split.test.ts`.
 * The four private helpers the planner tools depend on (`_planner`,
 * `_behaviorForEntry`, `_pickSnap`, `_freeSnaps`) moved with them, as F1
 * requires — they were plugin-private only because their callers were.
 *
 * The dividing line: this file answers "what IS there and where" — structure
 * that only changes when something authors it. Live values belong to
 * `rv-mcp-runtime-tools.ts`, editor authoring to `rv-mcp-editor-tools.ts`.
 *
 * TERMINOLOGY (2026-08-19 rework): asset = document = model — ONE concept, the
 * GLB document of the open project; scenes/models/library are storage places,
 * not types. The historic `web_scene_*` / `web_model_*` / `web_library_assets`
 * names are GONE (hard rename, no aliases): documents live under
 * `web_document_*`, the placeable parts catalogue under `web_catalog_*`, and
 * the planner snapshot export is `web_layout_export`.
 */

import { Box3, Vector3 } from 'three';
import type { Object3D } from 'three';
import type { RVViewer } from '../../core/rv-viewer';
import { McpTool, McpParam } from '../../core/engine/rv-mcp-tools';
import { lastPathSegment } from '../../core/engine/rv-constants';
import { builtinSources } from '../../core/rv-model-catalog';
import { isModelRoot } from '../../core/engine/rv-model-root';
import { getSceneStore } from '../../core/hmi/scene/scene-store-singleton';
import { matchMaterialFlows } from '../../core/material-flow/registry';
import type { SnapPoint } from '../../core/engine/rv-snap-point-registry';
import type { SnapPointPlugin } from '../snap-point';
import { oppositeDirection } from '../snap-point/snap-name-parser';
import { findCompatibleLibraryAssets } from '../snap-point/library-snap-index';
import type { LayoutPlannerPlugin } from '../layout-planner';
import type { LibraryCatalogEntry } from '../layout-planner/rv-layout-store';
import type { RvExtrasEditorPlugin } from '../../core/hmi/rv-extras-editor';
import { serializeProps } from './rv-mcp-serialize';

export class McpSceneTools {
  constructor(private readonly getViewer: () => RVViewer | undefined) {}

  private get viewer(): RVViewer | undefined { return this.getViewer(); }

  @McpTool('Find scene nodes by name AND/OR geometric filters. term = case-insensitive substring of node name or component type (empty term + filters = pure geometric search). Filters: sizeMin/sizeMax (largest AABB dim, m), region ("minX,minY,minZ,maxX,maxY,maxZ" world box the node center must lie in), color (hex like "#c00", tolerance-matched against mesh material color), hasComponent (rv type key, e.g. "Drive"), meshesOnly. Returns full paths + types + size — the paths every other tool takes. When names are meaningless CAD junk, filter by size/region/color instead, or use web_render mode=idmask / web_scene_query.', { readOnly: true })
  async webNodeFind(
    @McpParam('term', 'Name/component-type substring (may be empty when filters are given)', 'string', false) term: string,
    @McpParam('sizeMin', 'Minimum largest-AABB-dimension in meters', 'number', false) sizeMin?: number,
    @McpParam('sizeMax', 'Maximum largest-AABB-dimension in meters', 'number', false) sizeMax?: number,
    @McpParam('region', 'World box "minX,minY,minZ,maxX,maxY,maxZ" the node bounds-center must lie in', 'string', false) region?: string,
    @McpParam('color', 'Material color to match, hex (e.g. "#cc0000")', 'string', false) color?: string,
    @McpParam('hasComponent', 'Only nodes carrying this rv component key (e.g. "Drive", "Kinematic")', 'string', false) hasComponent?: string,
    @McpParam('meshesOnly', 'Only nodes that are meshes themselves (default false)', 'boolean', false) meshesOnly?: boolean,
    @McpParam('limit', 'Max results (default 100)', 'number', false) limit?: number,
  ): Promise<string> {
    const v = this.viewer;
    const reg = v?.registry;
    if (!v || !reg) return JSON.stringify({ error: 'No registry available' });
    const hasFilters = sizeMin != null || sizeMax != null || !!region || !!color || !!hasComponent || !!meshesOnly;
    if (!term?.trim() && !hasFilters) return JSON.stringify({ error: 'Give a term and/or at least one filter' });

    if (!hasFilters) {
      const results = reg.search(term);
      return JSON.stringify(results.map(r => ({
        path: r.path,
        name: lastPathSegment(r.path),
        types: r.types,
      })));
    }

    // Geometric search over the shared scene snapshot (O(N), plain data).
    const { buildSceneSnapshot } = await import('./rv-scene-snapshot');
    const snapshot = buildSceneSnapshot(v);
    let box: number[] | null = null;
    if (region) {
      box = region.split(',').map((s) => Number(s.trim()));
      if (box.length !== 6 || box.some(Number.isNaN)) {
        return JSON.stringify({ error: 'region must be "minX,minY,minZ,maxX,maxY,maxZ"' });
      }
    }
    let want: { r: number; g: number; b: number } | null = null;
    if (color) {
      try {
        const c = new (await import('three')).Color(color);
        want = { r: c.r, g: c.g, b: c.b };
      } catch {
        return JSON.stringify({ error: `Unparseable color "${color}"` });
      }
    }
    const lower = (term ?? '').trim().toLowerCase();
    const matches = snapshot.filter((n) => {
      if (lower && !n.name.toLowerCase().includes(lower)
        && !n.components.some((t) => t.toLowerCase().includes(lower))) return false;
      if (meshesOnly && !n.isMesh) return false;
      if (hasComponent && !n.components.some((t) => t.toLowerCase() === hasComponent.toLowerCase())) return false;
      const dim = n.bounds ? Math.max(...n.bounds.size) : 0;
      if (sizeMin != null && dim < sizeMin) return false;
      if (sizeMax != null && dim > sizeMax) return false;
      if (box) {
        if (!n.bounds) return false;
        const [cx, cy, cz] = n.bounds.center;
        if (cx < box[0] || cy < box[1] || cz < box[2] || cx > box[3] || cy > box[4] || cz > box[5]) return false;
      }
      if (want) {
        if (!n.material?.color) return false;
        const m = parseInt(n.material.color.slice(1), 16);
        const dr = ((m >> 16) & 255) / 255 - want.r;
        const dg = ((m >> 8) & 255) / 255 - want.g;
        const db = (m & 255) / 255 - want.b;
        if (Math.sqrt(dr * dr + dg * dg + db * db) > 0.25) return false;
      }
      return true;
    });
    const cap = Math.max(1, Math.min(500, Math.round(limit ?? 100)));
    return JSON.stringify({
      total: matches.length,
      ...(matches.length > cap ? { truncated: true } : {}),
      results: matches.slice(0, cap).map((n) => ({
        path: n.path,
        name: n.name,
        types: n.components,
        size: n.bounds?.size ?? null,
        ...(n.material?.color ? { color: n.material.color } : {}),
      })),
    });
  }

  @McpTool('Get the scene-graph tree from a root path (default: the loaded model root, which reports locked:true) with component types per node. Use to understand structure before selecting/kinematizing; depth defaults to 3. includeBounds adds per-node world AABB size [x,y,z] (m) + subtree meshCount — one call sizes a whole CAD assembly instead of N web_node_bounds calls.', { readOnly: true })
  async webNodeTree(
    @McpParam('root', 'Root path to start from (empty = the loaded model root, or the whole scene when no model is loaded)', 'string', false) root: string,
    @McpParam('depth', 'Max depth to traverse (default 3)', 'integer', false) depth: number,
    @McpParam('includeBounds', 'Add sizeM [x,y,z] + center + meshCount per node (default false)', 'boolean', false) includeBounds?: boolean,
  ): Promise<string> {
    const v = this.viewer;
    const reg = v?.registry;
    if (!v || !reg) return JSON.stringify({ error: 'No registry available' });

    const maxDepth = depth || 3;
    const scene = v.scene;
    if (!scene) return JSON.stringify({ error: 'No scene loaded' });

    // Default start = the MODEL ROOT, not the raw Three.js scene (plan-715 F6).
    // The scene is a container for the model plus runtime siblings (the planner's
    // `_layoutRoot`, gizmo groups); starting there spent the first level of the
    // depth budget on a node the user never authored. Child paths in the answer
    // are unchanged — `computeNodePath` is untouched — so only the root ENTRY and
    // the reachable depth per call differ. `root` stays the escape hatch, and a
    // viewer with no model loaded still falls back to the scene.
    let startNode = root ? reg.getNode(root) : (v.currentModelRoot ?? scene);
    if (!startNode) return JSON.stringify({ error: `Node not found: "${root}"` });

    // One O(N) snapshot pass joins bounds + mesh counts into the tree.
    let geo: Map<string, { size: [number, number, number]; center: [number, number, number]; meshCount: number }> | null = null;
    if (includeBounds) {
      const { buildSceneSnapshot } = await import('./rv-scene-snapshot');
      geo = new Map();
      for (const s of buildSceneSnapshot(v, root || undefined)) {
        if (s.bounds) geo.set(s.path, { size: s.bounds.size, center: s.bounds.center, meshCount: s.meshCount });
        else geo.set(s.path, { size: [0, 0, 0], center: [0, 0, 0], meshCount: 0 });
      }
    }

    const buildTree = (node: import('three').Object3D, d: number): object | null => {
      const path = reg.getPathForNode(node);
      const types = path ? reg.getComponentTypes(path) : [];
      const entry: Record<string, unknown> = {
        name: node.name,
        path: path ?? node.name,
        types,
      };
      // The model root is structurally frozen (plan-715 F4) — say so in the
      // tree, so an agent does not have to discover it by getting refused.
      if (isModelRoot(node, v.currentModelRoot)) entry.locked = true;
      if (geo && path) {
        const g = geo.get(path);
        if (g && g.meshCount > 0) {
          entry.sizeM = g.size;
          entry.center = g.center;
          entry.meshCount = g.meshCount;
        }
      }
      if (d < maxDepth && node.children.length > 0) {
        entry.children = node.children
          .map(c => buildTree(c, d + 1))
          .filter(Boolean);
      } else if (node.children.length > 0) {
        entry.childCount = node.children.length;
      }
      return entry;
    };

    return JSON.stringify(buildTree(startNode, 0));
  }

  @McpTool('Get all components on one node with their properties. Node paths from web_node_find / web_node_tree.', { readOnly: true })
  async webComponentGetAll(
    @McpParam('path', 'Full hierarchy path of the node') path: string,
  ): Promise<string> {
    const reg = this.viewer?.registry;
    if (!reg) return JSON.stringify({ error: 'No registry available' });

    const node = reg.getNode(path);
    if (!node) return JSON.stringify({ error: `Node not found: "${path}"` });

    const nodePath = reg.getPathForNode(node) ?? path;
    const entries = reg.getComponentsAt(nodePath);
    if (entries.length === 0) {
      return JSON.stringify({ path: nodePath, components: [] });
    }

    const components = entries.map(([type, instance]) => ({
      type,
      properties: serializeProps(instance, 2),
    }));
    return JSON.stringify({ path: nodePath, components });
  }

  @McpTool('Get one component on a node by path and type (e.g. Drive, Sensor, TransportSurface). Returns its properties.', { readOnly: true })
  async webComponentGet(
    @McpParam('path', 'Full hierarchy path of the node') path: string,
    @McpParam('type', 'Component type name (e.g. Drive, Sensor, TransportSurface, Source, Sink, Grip, GripTarget)') type: string,
  ): Promise<string> {
    const reg = this.viewer?.registry;
    if (!reg) return JSON.stringify({ error: 'No registry available' });

    const instance = reg.getByPath(type, path);
    if (!instance) return JSON.stringify({ error: `Component "${type}" not found at "${path}"` });

    return JSON.stringify({
      path,
      type,
      properties: serializeProps(instance, 2),
    });
  }

  @McpTool('List all components of one type across the scene with paths + properties. Unknown type returns the available types.', { readOnly: true })
  async webComponentList(
    @McpParam('type', 'Component type name (e.g. Drive, Sensor, TransportSurface, Source, Sink, Grip, GripTarget)') type: string,
  ): Promise<string> {
    const reg = this.viewer?.registry;
    if (!reg) return JSON.stringify({ error: 'No registry available' });

    const all = reg.getAll(type);
    if (all.length === 0) {
      // List available types for discoverability
      const stats = reg.size;
      return JSON.stringify({
        error: `No components of type "${type}" found`,
        availableTypes: stats.types,
      });
    }

    return JSON.stringify(all.map(({ path, instance }) => ({
      path,
      name: lastPathSegment(path),
      properties: serializeProps(instance, 1),
    })));
  }

  // ═══════════════════════════════════════════════════════════════════
  // Authoring tools — BUILD layouts (not just inspect/run). They wrap the
  // mode manager, the layout-planner and the extras-editor. Typical flow:
  // web_mode_set('planner') -> web_catalog_list -> web_layout_place -> web_layout_move /
  // web_component_set -> web_sim_play_pause -> web_document_save.
  // ═══════════════════════════════════════════════════════════════════

  /** Resolve the layout-planner plugin (helper — not an MCP tool). */
  private _planner(): LayoutPlannerPlugin | undefined {
    return this.viewer?.getPlugin<LayoutPlannerPlugin>('layout-planner');
  }

  /** Resolve a library entry to its behavior definition (for description/docs).
   *  Matches by the entry name + a de-spaced variant + the id, so e.g. "Chain
   *  Transfer Left" resolves to the ChainTransfer behavior (model glob `*ChainTransfer*`). */
  private _behaviorForEntry(entry: LibraryCatalogEntry): ReturnType<typeof matchMaterialFlows>[number] | undefined {
    for (const c of [entry.name, entry.name.replace(/\s+/g, ''), entry.id]) {
      const m = matchMaterialFlows(c);
      if (m.length) return m[0];
    }
    return undefined;
  }

  @McpTool('Switch the workspace mode: hmi (operate/monitor), planner (build layouts — required before web_layout_place), des (event simulation). For the asset editor use web_editor_open instead of setting mode directly.', { readOnly: false })
  async webModeSet(
    @McpParam('mode', 'Target mode: hmi | planner | des') mode: string,
  ): Promise<string> {
    const modes = this.viewer?.modes;
    if (!modes) return JSON.stringify({ error: 'No viewer' });
    if (!modes.has(mode)) {
      return JSON.stringify({ error: `Unknown mode "${mode}"`, available: modes.list().map(m => m.id) });
    }
    modes.setMode(mode);
    return JSON.stringify({ mode: modes.activeMode, available: modes.list().map(m => m.id) });
  }

  @McpTool('List the placeable PARTS CATALOG of the layout planner: catalogId, name, category, footprintMm [x,z], short description. Catalog entries are templates you can place, NOT the project documents (those are web_document_list). Pass catalogId to web_layout_place / web_layout_snap_attach; full build docs via web_catalog_describe.', { readOnly: true })
  async webCatalogList(): Promise<string> {
    const planner = this._planner();
    if (!planner) return JSON.stringify({ error: 'Layout planner not available — call web_mode_set(\"planner\") first' });
    const out: Array<{ catalogId: string; name: string; category: string; footprintMm: [number, number] | null; description: string | null }> = [];
    for (const cat of planner.store.getSnapshot().catalogs.values()) {
      for (const e of cat.entries) {
        out.push({
          catalogId: e.id, name: e.name, category: e.category,
          footprintMm: e.footprintMm ?? null,
          description: this._behaviorForEntry(e)?.description ?? null,
        });
      }
    }
    return JSON.stringify(out);
  }

  @McpTool('Describe one parts-catalog entry for building: purpose, material-flow direction, snap connections, key config. catalogId from web_catalog_list.', { readOnly: true })
  async webCatalogDescribe(
    @McpParam('catalogId', 'Catalog entry id (from web_catalog_list)') catalogId: string,
  ): Promise<string> {
    const planner = this._planner();
    if (!planner) return JSON.stringify({ error: 'Layout planner not available — call web_mode_set(\"planner\") first' });
    let entry: LibraryCatalogEntry | undefined;
    for (const cat of planner.store.getSnapshot().catalogs.values()) {
      const f = cat.entries.find(e => e.id === catalogId);
      if (f) { entry = f; break; }
    }
    if (!entry) return JSON.stringify({ error: `No catalog entry "${catalogId}". Use web_catalog_list.` });
    const def = this._behaviorForEntry(entry);
    return JSON.stringify({
      catalogId,
      name: entry.name,
      category: entry.category,
      footprintMm: entry.footprintMm ?? null,
      behaviorType: def?.type ?? null,
      description: def?.description ?? null,
      docs: def?.mcpDocs ?? null,
    });
  }

  // ─── Document file management (plan-713 F2/F3, unified 2026-08-19) ─────
  //
  // The FILE listing that used to live here (`web_library_assets`) is merged
  // into `web_document_list` — asset = document = model, one list. The write
  // verb below stays here, next to the other authoring tools. It is deliberately
  // NOT part of `web_catalog_*`: the catalogue is the planner's placeable
  // template list, keyed by `catalogId`; this operates on the project's OWN
  // document files, keyed by path, in any mode.
  //
  // Rename and move run through the SAME tree machinery as the dashboard
  // (`canRenameInTree` / `canMoveInTree` → `applyTreeMove`): the manifest is
  // computed before a byte moves, the row's id never changes, and references
  // keep resolving — plan-717 F6's "one rename path for every document".

  @McpTool('Delete, rename or move a saved DOCUMENT or attachment file of the open project (path from web_document_list / web_project_tree — any folder, not just library/). Refused: the document currently open in the editor, reserved system paths, read-only projects. rename/move go through the dashboard tree machinery, so the document id never changes and references keep resolving. Delete moves the bytes to .trash/ and drops the manifest row. Folders are managed by web_project_folder.', { readOnly: false, destructive: true, timeoutMs: 120_000 })
  async webDocumentUpdate(
    @McpParam('action', 'delete | rename | move') action: string,
    @McpParam('relPath', 'Project-relative document path, e.g. "library/Custom/MyAsset.glb" (from web_document_list). The legacy "Custom/…" spelling still resolves.') relPath: string,
    @McpParam('newName', 'New document name (rename only; the extension is kept when omitted).', 'string', false) newName?: string,
    @McpParam('toFolder', 'Destination folder, "" for the project root (move only; see web_project_tree).', 'string', false) toFolder?: string,
  ): Promise<string> {
    const verb = (action ?? '').trim().toLowerCase();
    if (verb !== 'delete' && verb !== 'rename' && verb !== 'move') {
      return JSON.stringify({ error: `Unknown action "${action}". Use delete, rename or move.` });
    }
    const [{ getProjectStore }, docs, ops, listing, treeMod, rules] = await Promise.all([
      import('../../core/project/project-store'),
      import('../../core/project/rv-project-documents'),
      import('../../core/project/rv-document-ops'),
      import('./rv-mcp-asset-listing'),
      import('./rv-mcp-project-tree'),
      import('../../core/project/rv-project-tree'),
    ]);
    const store = getProjectStore();
    const backend = store.getBackend();
    if (!backend) return JSON.stringify({ error: 'No project is open — open one with web_project_open.' });
    if (!backend.writable) {
      return JSON.stringify({ error: 'This project is read-only — its documents cannot be changed.' });
    }

    const loaded = await treeMod.loadProjectTree(store);
    if ('error' in loaded) return JSON.stringify(loaded);

    // Resolve the path against the tree; the pre-rework "Custom/…" spelling
    // (library-relative) keeps resolving so a caller handed the old form by
    // older docs or notes is corrected instead of refused.
    let target = treeMod.normaliseRelPath(relPath);
    let node = treeMod.nodeAtRelPath(loaded, target);
    if (!node && target !== '' && !target.startsWith('library/')) {
      const legacy = treeMod.nodeAtRelPath(loaded, `library/${target}`);
      if (legacy) { node = legacy; target = legacy.relPath; }
    }
    if (!node || (node.kind !== 'document' && node.kind !== 'file')) {
      return JSON.stringify({
        error: `No document or file at "${target}" — see web_project_tree or web_document_list. `
          + '(Folders are managed by web_project_folder.)',
      });
    }
    if (!node.writable) {
      return JSON.stringify({ error: treeMod.refusalSentence('system', target) });
    }

    // R10 — the open document is off limits in EVERY verb. Renaming or moving
    // it would leave the editor holding an identity that no longer names a
    // file, and deleting it would leave it holding one that names nothing.
    const { getActiveAssetContext } = await import('../../core/editor/active-asset-store');
    const openBase = getActiveAssetContext()?.doc.getSnapshot().base;
    const openPath = openBase?.kind === 'document' ? openBase.path : null;
    if (listing.samePath(openPath, target)) {
      return JSON.stringify({
        error: `"${target}" is the document currently open in the editor. `
          + 'Close it (web_editor_close) or save it elsewhere first.',
      });
    }

    if (verb === 'delete') {
      const row = docs.documentsOf(store.getProject()).find(d => listing.samePath(d.path, target));
      if (row) {
        const retired = await ops.retireDocument(store, row.id);
        return JSON.stringify({
          deleted: retired, relPath: target, documentId: row.id,
          recoverable: `Bytes were moved to ${ops.DOCUMENT_TRASH_FOLDER}/, not erased.`,
        });
      }
      // No manifest row — an attachment or a file nothing adopted. Deleting the
      // bytes is still the caller's intent, and `deleteBlob` treats a missing
      // file as satisfied rather than as an error.
      await backend.deleteBlob(target);
      return JSON.stringify({ deleted: true, relPath: target, documentId: null });
    }

    let verdict;
    if (verb === 'rename') {
      const name = (newName ?? '').trim();
      if (!name) return JSON.stringify({ error: 'action=rename needs newName.' });
      verdict = rules.canRenameInTree(loaded.roots, node.path!, name);
    } else {
      if (toFolder === undefined) {
        return JSON.stringify({ error: 'action=move needs toFolder ("" = project root).' });
      }
      const destRel = treeMod.normaliseRelPath(toFolder);
      const dest = treeMod.nodeAtRelPath(loaded, destRel);
      if (!dest || (dest.kind !== 'folder' && dest.kind !== 'root')) {
        return JSON.stringify({ error: `No destination folder at "${destRel}" — see web_project_tree.` });
      }
      verdict = rules.canMoveInTree(loaded.roots, node.path!, dest.path!);
    }
    if (!verdict.ok) {
      return JSON.stringify({ error: treeMod.refusalSentence(verdict.reason, target) });
    }

    const outcome = await treeMod.performTreeEdit(loaded, node, verdict);
    return JSON.stringify({
      [verb === 'rename' ? 'renamed' : 'moved']: true,
      from: verdict.from,
      relPath: verdict.to,
      documentId: node.documentId ?? null,
      manifestRowsRepointed: outcome.manifestRows,
      docsIndexRowsRepointed: outcome.docsIndexRows,
      refsRepointed: outcome.refRows,
      note: 'The document id is unchanged — references keep resolving.',
    });
  }

  @McpTool('Place a catalog component on the ground plane (planner mode; catalogId from web_catalog_list). Returns the placement id. y is IGNORED — parts drop to the ground; set height afterwards with web_layout_move (conveyor-height rules: web_help topic "layout").', { readOnly: false })
  async webLayoutPlace(
    @McpParam('catalogId', 'Catalog entry id (from web_catalog_list)') catalogId: string,
    @McpParam('x', 'X position in meters', 'number') x: number,
    @McpParam('y', 'Y position in meters. NOTE: ignored on place — parts drop to the ground plane. Set height afterwards with web_layout_move (e.g. a pallet onto the conveyor transport surface).', 'number') y: number,
    @McpParam('z', 'Z position in meters', 'number') z: number,
  ): Promise<string> {
    const planner = this._planner();
    if (!planner) return JSON.stringify({ error: 'Layout planner not available — call web_mode_set(\"planner\") first' });
    let entry: import('../layout-planner/rv-layout-store').LibraryCatalogEntry | undefined;
    for (const cat of planner.store.getSnapshot().catalogs.values()) {
      const found = cat.entries.find(e => e.id === catalogId);
      if (found) { entry = found; break; }
    }
    if (!entry) return JSON.stringify({ error: `No catalog entry "${catalogId}". Use web_catalog_list.` });
    const id = await planner.placeComponent(entry, [x, y, z]);
    return JSON.stringify({
      id, catalogId, position: [x, y, z],
      next: 'Chain connected parts with web_layout_snap_attach; heights via web_layout_move',
    });
  }

  @McpTool('Move/rotate a placement (position meters, rotation degrees XYZ). Unlike web_layout_place this DOES set the y height — use it to lift a pallet/MU onto a conveyor transport surface (height rules: web_help topic "layout"). id from web_layout_list.', { readOnly: false })
  async webLayoutMove(
    @McpParam('id', 'Placement id (from web_layout_place / web_layout_list)') id: string,
    @McpParam('x', 'X position in meters', 'number') x: number,
    @McpParam('y', 'Y position in meters', 'number') y: number,
    @McpParam('z', 'Z position in meters', 'number') z: number,
    @McpParam('rx', 'X rotation in degrees (optional)', 'number', false) rx: number,
    @McpParam('ry', 'Y rotation in degrees (optional)', 'number', false) ry: number,
    @McpParam('rz', 'Z rotation in degrees (optional)', 'number', false) rz: number,
  ): Promise<string> {
    const planner = this._planner();
    if (!planner) return JSON.stringify({ error: 'Layout planner not available — call web_mode_set(\"planner\") first' });
    const rot: [number, number, number] = [rx ?? 0, ry ?? 0, rz ?? 0];
    planner.applyTransformById(id, [x, y, z], rot, [1, 1, 1]);
    return JSON.stringify({ id, position: [x, y, z], rotation: rot });
  }

  @McpTool('Remove a placed component by id (from web_layout_list).', { readOnly: false })
  async webLayoutRemove(
    @McpParam('id', 'Placement id (from web_layout_list)') id: string,
  ): Promise<string> {
    const planner = this._planner();
    if (!planner) return JSON.stringify({ error: 'Layout planner not available — call web_mode_set(\"planner\") first' });
    planner.removePlacementById(id);
    return JSON.stringify({ id, removed: true });
  }

  @McpTool('List placed layout components: id, catalogId, label, position (m), rotation (deg), world bounds (center + size). The id source for web_layout_move / web_layout_remove / web_layout_snap_*.', { readOnly: true })
  async webLayoutList(): Promise<string> {
    const planner = this._planner();
    if (!planner) return JSON.stringify({ error: 'Layout planner not available — call web_mode_set(\"planner\") first' });
    const snap = planner.snapshotPlacements();
    const box = new Box3();
    const center = new Vector3();
    const size = new Vector3();
    const round3 = (v: Vector3): [number, number, number] => [+v.x.toFixed(3), +v.y.toFixed(3), +v.z.toFixed(3)];
    return JSON.stringify(snap.placements.map(p => {
      let bounds: { center: [number, number, number]; size: [number, number, number] } | null = null;
      const root = planner.getPlacedRootById(p.id);
      if (root) {
        box.setFromObject(root);
        if (!box.isEmpty()) {
          box.getCenter(center);
          box.getSize(size);
          bounds = { center: round3(center), size: round3(size) };
        }
      }
      return {
        id: p.id,
        catalogId: p.catalogId,
        label: p.label,
        position: p.position,
        rotation: p.rotation,
        bounds,
      };
    }));
  }

  // ─── Document write verbs ──────────────────────────────────────────────
  //
  // Since plan-716 there is one owned artefact, the GLB DOCUMENT, and "scene"
  // is not a storage concept at all. The 2026-08-19 rework finished the rename:
  // the historic `web_scene_save` / `web_scene_new` are now `web_document_save`
  // / `web_document_new` (hard rename, no aliases). Every verb is wired onto a
  // document op, which is what allowed `SceneStore.listScenes()/listBuiltins()`
  // to be deleted in Phase 6 (risk 11). Built-in SOURCES are still listed by
  // `web_document_list`; they come from the model catalogue, not the scene store.

  @McpTool('Save the current document. With name: saves a NEW named document and returns its documentId; without: saves the open one in place with compare-and-swap. Reports saveVerb (save | save-into-project | blocked with a reason), the same verb the save card shows. Reopen via web_document_open; raw planner layout JSON via web_layout_export.', { readOnly: false })
  async webDocumentSave(
    @McpParam('name', 'Document name (optional — omit to save the open document in place)', 'string', false) name: string,
  ): Promise<string> {
    const store = getSceneStore();
    if (!store) return JSON.stringify({ error: 'Scene store not available' });
    // F6 — read BEFORE the write, for the same reason as the asset half: the
    // verb describes what this save is about to do, and a first save changes
    // the answer for every save after it.
    const verb = await this._sceneSaveVerb(store);
    try {
      if (name && name.trim()) {
        // `saveAs` places a FILE plus a manifest row since Phase 3 — the id it
        // returns is a documentId, so it is reported under that name too.
        const id = await store.saveAs(name.trim());
        return JSON.stringify({ saved: true, id, documentId: id, name: name.trim(), ...verb });
      }
      await store.save();
      return JSON.stringify({ saved: true, ...verb });
    } catch (e) { return JSON.stringify({ error: String(e), ...verb }); }
  }

  /**
   * The scene lineage's save verb, through the ONE decision function.
   *
   * Mirrors `sceneDocumentView.sceneSaveDecision` clause for clause — the same
   * two facts (`open`, `transient`) handed to the same `decideSaveVerb`. Not
   * imported from that module because it is not exported there and it lives
   * behind the view seam; duplicating the two-field projection is cheaper than
   * pulling the scene card's module into the bridge, and the thing that must not
   * drift — the decision itself — is shared.
   */
  private async _sceneSaveVerb(
    store: ReturnType<typeof getSceneStore>,
  ): Promise<{ saveVerb?: string; saveReason?: string }> {
    try {
      const [{ getProjectStore }, { decideSaveVerb }] = await Promise.all([
        import('../../core/project/project-store'),
        import('../../core/editor/rv-save-document'),
      ]);
      const snap = store?.getSnapshot() ?? null;
      const d = decideSaveVerb(
        { lineage: 'scene', open: !!snap?.draft, transient: snap?.transient === true },
        getProjectStore().getBackend(),
      );
      return { saveVerb: d.verb, ...(d.reason ? { saveReason: d.reason } : {}) };
    } catch { return {}; }
  }

  @McpTool('Create a new empty DOCUMENT in the project and open it, returning its documentId and path. Optional name (default "Untitled", auto-suffixed when taken) and folder (project-relative, e.g. "parts" or "library/Machines", "" = project root; see web_project_tree — create folders first with web_project_folder). Places a file plus a manifest row, so the clean reset before building a layout survives a reload.', { readOnly: false, timeoutMs: 60_000 })
  async webDocumentNew(
    @McpParam('name', 'Document name (default "Untitled"; a taken name gets a numeric suffix).', 'string', false) name?: string,
    @McpParam('folder', 'Project-relative folder to place it in (default: the project root).', 'string', false) folder?: string,
  ): Promise<string> {
    const store = getSceneStore();
    if (!store) return JSON.stringify({ error: 'Scene store not available' });
    try {
      // Through the store's one create seam (`createEmpty` → `_createDocument`),
      // so the name probe, the create-only write and the manifest row stay
      // spelled one way. '' as folder is the project root, a real target.
      const dir = folder === undefined
        ? undefined
        : folder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').trim();
      const documentId = await store.createEmpty((name ?? '').trim() || 'Untitled', dir);
      await store.openDocument(documentId);
      const { getProjectStore } = await import('../../core/project/project-store');
      const { documentsOf } = await import('../../core/project/rv-project-documents');
      const row = documentsOf(getProjectStore().getProject()).find(d => d.id === documentId);
      return JSON.stringify({
        ok: true, documentId,
        ...(row ? { path: row.path, name: row.name } : {}),
      });
    } catch (e) { return JSON.stringify({ error: String(e) }); }
  }

  // ─── Retired names ─────────────────────────────────────────────────────
  //
  // plan-713 Phase 3 (F8) retired `web_scene_open` / `web_scene_list` as
  // duplicate pairs of the document tools. The 2026-08-19 rework retired the
  // REST of the old vocabulary outright (hard rename, no aliases):
  //
  //   web_model_list / web_scene_list → web_document_list  (absorbs the former
  //                                     web_library_assets file listing too)
  //   web_model_open / web_scene_open → web_document_open
  //   web_scene_save                  → web_document_save
  //   web_scene_new                   → web_document_new
  //   web_library_update              → web_document_update
  //   web_library_list / _describe    → web_catalog_list / web_catalog_describe
  //   web_scene_export                → web_layout_export
  //
  // All retired names are in the superseded list of
  // `rv-mcp-tool-conventions.test.ts`, so they cannot come back by accident.

  @McpTool('Export the current planner layout as raw JSON (placements + catalogs + grid) without persisting anything. Exports the planner snapshot and touches no document.', { readOnly: true })
  async webLayoutExport(): Promise<string> {
    const planner = this._planner();
    if (!planner) return JSON.stringify({ error: 'Layout planner not available — call web_mode_set(\"planner\") first' });
    return JSON.stringify(planner.snapshotAsLayoutFile('Untitled'));
  }

  @McpTool('Set config properties on an existing component (rv_extras overrides, e.g. drive TargetSpeed, source spawn interval). props = JSON object of fieldName -> value. In the asset editor prefer web_editor_set_field (undoable).', { readOnly: false })
  async webComponentSet(
    @McpParam('path', 'Full hierarchy path of the node') path: string,
    @McpParam('type', 'Component type (e.g. Drive, Source, Sensor, TransportSurface)') type: string,
    @McpParam('props', 'JSON object of fieldName -> value, e.g. {"TargetSpeed": 500}') props: string,
  ): Promise<string> {
    const editor = this.viewer?.getPlugin<RvExtrasEditorPlugin>('rv-extras-editor');
    if (!editor) return JSON.stringify({ error: 'Extras editor not available' });
    let parsed: unknown;
    try { parsed = JSON.parse(props); }
    catch { return JSON.stringify({ error: 'props must be a JSON object string, e.g. {"TargetSpeed": 500}' }); }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return JSON.stringify({ error: 'props must be a JSON object' });
    }
    const applied: Record<string, unknown> = {};
    const rejected: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (editor.updateOverlayField(path, type, field, value)) applied[field] = value;
      else rejected[field] = value;
    }
    return JSON.stringify({ path, type, applied, rejected });
  }

  // (web_component_add was removed — superseded by web_editor_add_component,
  // which adds type validation and the editor-mode guard.)

  // ── Snap-attach helpers/tools (connect a matching next component) ──

  /** Resolve a target snap from a free-snap list by name, or auto-pick the only
   *  one (helper — not an MCP tool). Mirrors the UI's free-snap derivation. */
  private _pickSnap(free: readonly SnapPoint[], name?: string):
    { snap: SnapPoint } | { error: string; available: string[] } {
    const available = free.map(s => s.object3D.name);
    if (name) {
      const s = free.find(sp => sp.object3D.name === name);
      return s ? { snap: s } : { error: `Snap "${name}" not free or not found`, available };
    }
    if (free.length === 1) return { snap: free[0] };
    if (free.length === 0) return { error: 'No free snap points on this component', available };
    return { error: 'Ambiguous — pass targetSnapName (multiple free snaps)', available };
  }

  /** Free, live snaps of a placed root (the UI's own "open ports" derivation). */
  private _freeSnaps(root: import('three').Object3D): readonly SnapPoint[] {
    const reg = this.viewer?.getPlugin<SnapPointPlugin>('snap-point')?.getRegistry();
    if (!reg) return [];
    return reg.getByOwnerRoot(root).filter(s => !s.occupied && s.object3D.parent);
  }

  @McpTool('List the free (unoccupied) snap points of a placement (id from web_layout_list): snapName, typeId, flow, axis, dirCode per open port. Feed snapName + id into web_layout_snap_attach.', { readOnly: true })
  async webLayoutSnapList(
    @McpParam('id', 'Placement id (from web_layout_place / web_layout_list)') id: string,
  ): Promise<string> {
    const planner = this._planner();
    if (!planner) return JSON.stringify({ error: 'Layout planner not available — call web_mode_set(\"planner\") first' });
    const root = planner.getPlacedRootById(id);
    if (!root) return JSON.stringify({ error: `No placement "${id}". Use web_layout_list.` });
    const reg = this.viewer?.getPlugin<SnapPointPlugin>('snap-point')?.getRegistry();
    if (!reg) return JSON.stringify({ error: 'Snap-point system not available' });
    const snaps = reg.getByOwnerRoot(root);
    const free = snaps.filter(s => !s.occupied && s.object3D.parent);
    return JSON.stringify({
      id,
      label: root.name,
      freeSnaps: free.map(s => ({
        snapName: s.object3D.name,
        typeId: s.typeId,
        flow: s.flow ?? 'bidi',
        axis: s.dir.axis,
        dirCode: s.dir.code,
      })),
      occupiedCount: snaps.filter(s => s.occupied).length,
    });
  }

  @McpTool('Suggest library components compatible with a free snap (same typeId + compatible flow). Returns [{catalogId, name, ownSnapName}] — pass catalogId into web_layout_snap_attach.', { readOnly: true })
  async webLayoutSnapSuggest(
    @McpParam('targetId', 'Placement id to attach onto') targetId: string,
    @McpParam('targetSnapName', 'Target snap node name (from web_layout_snap_list); omit to auto-pick the only free snap', 'string', false) targetSnapName: string,
  ): Promise<string> {
    const planner = this._planner();
    if (!planner) return JSON.stringify({ error: 'Layout planner not available — call web_mode_set(\"planner\") first' });
    const root = planner.getPlacedRootById(targetId);
    if (!root) return JSON.stringify({ error: `No placement "${targetId}". Use web_layout_list.` });
    const picked = this._pickSnap(this._freeSnaps(root), targetSnapName);
    if ('error' in picked) return JSON.stringify(picked);
    const target = picked.snap;
    const entries: LibraryCatalogEntry[] = [];
    for (const cat of planner.store.getSnapshot().catalogs.values()) entries.push(...cat.entries);
    const compat = await findCompatibleLibraryAssets(entries, target.typeId, oppositeDirection(target.dir), target.flow);
    return JSON.stringify({
      targetId,
      targetSnapName: target.object3D.name,
      typeId: target.typeId,
      flow: target.flow ?? 'bidi',
      suggestions: compat.map(m => ({ catalogId: m.entry.id, name: m.entry.name, ownSnapName: m.ownSnapName })),
    });
  }

  @McpTool('Attach a catalog component onto a free snap of a placement, auto-aligned — THE way to build connected conveyor lines. targetId from web_layout_list, catalogId from web_catalog_list / web_layout_snap_suggest; targetSnapName optional (defaults to the only free snap). Returns the new placement id. Planner mode.', { readOnly: false })
  async webLayoutSnapAttach(
    @McpParam('targetId', 'Placement id to attach onto') targetId: string,
    @McpParam('catalogId', 'Catalog entry id to attach (from web_catalog_list / web_layout_snap_suggest)') catalogId: string,
    @McpParam('targetSnapName', 'Target snap node name (from web_layout_snap_list); omit to auto-pick the only free snap', 'string', false) targetSnapName: string,
  ): Promise<string> {
    const planner = this._planner();
    if (!planner) return JSON.stringify({ error: 'Layout planner not available — call web_mode_set(\"planner\") first' });
    const root = planner.getPlacedRootById(targetId);
    if (!root) return JSON.stringify({ error: `No placement "${targetId}". Use web_layout_list.` });
    const picked = this._pickSnap(this._freeSnaps(root), targetSnapName);
    if ('error' in picked) return JSON.stringify(picked);
    const target = picked.snap;

    let entry: LibraryCatalogEntry | undefined;
    for (const cat of planner.store.getSnapshot().catalogs.values()) {
      const f = cat.entries.find(e => e.id === catalogId);
      if (f) { entry = f; break; }
    }
    if (!entry) return JSON.stringify({ error: `No catalog entry "${catalogId}". Use web_catalog_list.` });

    const matches = await findCompatibleLibraryAssets([entry], target.typeId, oppositeDirection(target.dir), target.flow);
    const chosen = matches.find(m => m.entry.id === catalogId);
    if (!chosen) {
      return JSON.stringify({ error: `"${catalogId}" has no snap compatible with typeId=${target.typeId}, flow=${target.flow ?? 'bidi'}` });
    }

    const newId = await planner.placeAtSnap(entry, target, chosen.ownSnapName);
    if (!newId) return JSON.stringify({ error: 'Placement rejected (snap occupied, non-uniform scale, or own-snap not found)' });
    return JSON.stringify({
      id: newId,
      catalogId,
      attachedTo: { placementId: targetId, snapName: target.object3D.name, typeId: target.typeId },
      ownSnapName: chosen.ownSnapName,
    });
  }
}
