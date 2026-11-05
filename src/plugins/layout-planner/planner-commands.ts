// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * planner-commands — the layout planner's commands (plan-499 Phase 3).
 *
 * ADAPTERS of the planner's existing operations, never a second history: every
 * command books through the one `SceneStore` op log, and a command that is more
 * than one op wraps them in `sceneStore.withTransaction(undoLabel)` so it is
 * ONE undo step (a place with a height = add + move, a multi-delete = N
 * removes). The SceneStore's transactions are re-entrant, so a planner method
 * that opens its own transaction folds into the command's.
 *
 * | Command              | UI view                                        | MCP tool                 |
 * |----------------------|------------------------------------------------|--------------------------|
 * | `layout.place`       | Library entry (click → placement / splat place)| `web_layout_place`       |
 * | `layout.move`        | — (the gizmo drag is continuous, not a button) | `web_layout_move`        |
 * | `layout.remove`      | Planner toolbar Delete (id null = selection)   | `web_layout_remove`      |
 * | `layout.snapAttach`  | Snap picker popup entry (snap-point plugin)    | `web_layout_snap_attach` |
 * | `layout.undo/redo`   | Planner toolbar Undo / Redo                    | —                        |
 * | `layout.setParams`   | Placement inspector parameter mask (plan-650)  | — (`web_execute`)        |
 *
 * The refusal texts are the ones the tools answered before the migration, so an
 * agent sees what it saw and a button shows the same text as its tooltip.
 */

import { activeHistoryStep } from '../../core/hmi/rv-edit-target';
import { Box3, Vector3, type InstancedMesh, type Mesh, type Object3D } from 'three';
import type { GizmoBasis, RadialSector } from '../../core/engine/rv-transport-gizmo-geometry';
import {
  commandRegistry,
  CommandError,
  type CommandArgType,
  type CommandContext,
  type CommandDescriptor,
  type CommandImpl,
  type CommandMcpMirror,
  type CommandRegistry,
} from '../../core/hmi/rv-command-registry';
import { getSceneStore } from '../../core/hmi/scene/scene-store-singleton';
import { getLibrarySource, listLibrarySources } from '../../core/library/library-source-registry';
import { LIBRARY_PROJECTS_PROVIDER_ID, OPEN_PROJECT_PROVIDER_ID, resolveDocumentRef } from '../../core/library/library-origin';
import { computeSubtreeAABB } from '../../core/engine/rv-traverse-utils';
import type { SnapPoint } from '../../core/engine/rv-snap-point-registry';
import type { SnapPointPlugin } from '../snap-point';
import { flowsCompatible, oppositeDirection } from '../snap-point/snap-name-parser';
import type { LayoutPlannerPlugin } from './index';
import type { LibraryCatalogEntry } from './rv-layout-store';

// ─── Args ───────────────────────────────────────────────────────────────

export interface PlaceArgs {
  readonly catalogId: string;
  /**
   * plan-778: the library PROJECT the entry comes from. The same document id
   * may live in two libraries; with this the entry is looked up in that
   * library only (and the placement is qualified with it). Absent = today's
   * search (the planner's catalogs, then every placeable source).
   */
  readonly libraryProjectId?: string | null;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Placement id to rest the part ON (its transport-surface top); null/absent = x/y/z. */
  readonly onto?: string | null;
  /** plan-675 D4: yaw in degrees; on a curve `onto` defaults it to the tangent there. */
  readonly ry?: number | null;
}
export interface MoveArgs {
  readonly id: string;
  readonly x: number; readonly y: number; readonly z: number;
  readonly rx?: number | null; readonly ry?: number | null; readonly rz?: number | null;
}
/** `id` null = "the current selection" (the toolbar Delete button). */
export interface RemoveArgs { readonly id: string | null | undefined }
/** plan-650 Phase 5: `values` = JSON object of parameter values; `family` = family path / NodeId (optional). */
export interface SetParamsArgs {
  readonly id: string;
  readonly values: string;
  readonly family?: string | null;
}
export interface SnapAttachArgs {
  readonly targetId: string;
  readonly catalogId: string;
  /** plan-778: see {@link PlaceArgs.libraryProjectId}. */
  readonly libraryProjectId?: string | null;
  readonly targetSnapName?: string | null;
  readonly flow?: string | null;
}

// ─── Reasons ────────────────────────────────────────────────────────────

export const PLANNER_UNAVAILABLE = 'Layout planner not available — call web_execute("workspace.setMode", {mode:"planner"}) first';
export const NOTHING_TO_DELETE = 'Delete (select something first)';
export const NOTHING_TO_UNDO = 'Nothing to undo';
export const NOTHING_TO_REDO = 'Nothing to redo';
export const noPlacement = (id: string): string => `No placement "${id}". Use web_query("layout.list", {}).`;
export const noPlacementOnto = (id: string): string => `No placement "${id}" to place onto. Use web_query("layout.list", {}).`;
export const noCatalogEntry = (id: string): string =>
  `No catalog entry "${id}". Use web_query("library.catalogList", {}) or web_document_list (the document id).`;

/** plan-780 R5: deprecation hint — `project:<path>` is a lookup only, never sent or stored. */
export function legacyCatalogIdHint(catalogId: string, entry: Pick<LibraryCatalogEntry, 'id' | 'documentId'> | undefined): string | null {
  if (!catalogId.startsWith('project:') || !entry) return null;
  const id = entry.documentId ?? entry.id;
  return `"${catalogId}" is deprecated — address the document by its id "${id}".`;
}
export const noPlannerCatalogEntry = (id: string): string => `No catalog entry "${id}". Use web_query("library.catalogList", {}).`;
const PLANNER_NOT_ATTACHED =
  'Layout planner is not attached to the viewer (no model loaded and planner mode not entered yet) — call web_execute("workspace.setMode", {mode:"planner"}) or web_document_open(<document>) first, then retry';

// ─── Button keys ────────────────────────────────────────────────────────

/**
 * The library entry of a catalog id — the view of `layout.place`. With a
 * library project (plan-778) the key names both, because two libraries may
 * hold the same document id.
 */
export const libraryEntryKey = (catalogId: string, libraryProjectId?: string | null): string =>
  libraryProjectId ? `layout.library:${libraryProjectId}/${catalogId}` : `layout.library:${catalogId}`;
export const PLANNER_DELETE_KEY = 'layout.delete';
export const PLANNER_UNDO_KEY = 'layout.undo';
export const PLANNER_REDO_KEY = 'layout.redo';
/** The snap picker popup's entries (snap-point plugin) — the view of `layout.snapAttach`. */
export const SNAP_ATTACH_KEY = 'layout.snapAttach';

// ─── Helpers (shared with the read-only planner tools) ──────────────────

export function plannerOf(ctx: Pick<CommandContext, 'viewer'>): LayoutPlannerPlugin | undefined {
  return ctx.viewer.getPlugin?.<LayoutPlannerPlugin>('layout-planner');
}

/**
 * A catalog entry by id: the planner's own catalogs first, then the registry
 * sources (project documents, global library — `project:<path>` ids or the
 * manifest documentId), the same entries the library panel drags from.
 */
export function resolvePlaceEntry(
  planner: LayoutPlannerPlugin,
  catalogId: string,
  libraryProjectId?: string | null,
): LibraryCatalogEntry | undefined {
  // plan-778: a named library is asked alone — and only when it is placeable
  // (a direct library of this project, Decision 4 / C).
  if (libraryProjectId) {
    const source = getLibrarySource(LIBRARY_PROJECTS_PROVIDER_ID, libraryProjectId);
    if (!source || source.hidden === true) return undefined;
    try { return source.getEntry(catalogId) ?? undefined; } catch { return undefined; }
  }
  const own = findPlannerEntry(planner, catalogId);
  if (own) return own;
  // plan-780 R5: `project:<path>` lookup shim via THE resolver (one row, never guessed).
  if (catalogId.startsWith('project:')) {
    const r = resolveDocumentRef({ catalogId }, null);
    return 'hit' in r && r.hit.registered.providerId === OPEN_PROJECT_PROVIDER_ID ? r.hit.entry : undefined;
  }
  for (const { providerId, source } of listLibrarySources()) {
    // A library project that is only resolvable (transitive, or the built-in
    // realvirtual library the project does not list) is not placeable.
    if (providerId === LIBRARY_PROJECTS_PROVIDER_ID && source.hidden === true) continue;
    let entries: LibraryCatalogEntry[];
    try { entries = source.listEntries(); } catch { continue; }
    const found = entries.find((e) => e.id === catalogId || e.documentId === catalogId);
    if (found) return found;
  }
  return undefined;
}

/** A catalog entry from the planner's own catalogs only (what snap-attach accepts). */
export function findPlannerEntry(planner: LayoutPlannerPlugin, catalogId: string): LibraryCatalogEntry | undefined {
  for (const cat of planner.store.getSnapshot().catalogs.values()) {
    const found = cat.entries.find((e) => e.id === catalogId);
    if (found) return found;
  }
  return undefined;
}

/**
 * Where a part resting ON a placement goes: the top of its TransportSurface
 * nodes (the roller/belt plane — NOT the bounding-box top, which includes side
 * frames and makes a pallet float), centred on the placement. Falls back to the
 * bounding-box top when the placement has no surface.
 */
/** What {@link transportSurfaceTop} needs from a radial TransportSurface (an `RVTransportSurface` satisfies it). */
export interface RadialSurfaceLike {
  readonly Radial: boolean;
  getRadialSector(): (RadialSector & { basis: GizmoBasis; worldScale: number }) | null;
}

/**
 * plan-675 D4 — the resting point on a CURVE: the mid radius at the middle of
 * the arc, and the yaw that lines the part's +X up with the tangent there.
 * Null when the node's sector cannot be measured.
 */
function radialRestPoint(node: Object3D, surface: RadialSurfaceLike): { x: number; z: number; ry: number } | null {
  const sector = surface.getRadialSector();
  if (!sector || sector.full) return null;
  const { basis, worldScale } = sector;
  const rMid = (sector.rMin + sector.rMax) / 2 / worldScale; // node-local units
  const theta = sector.thetaStart + sector.thetaLength / 2;
  // Canonical angle convention (rv-transport-gizmo-geometry): atan2(−cw, cu).
  const cu = rMid * Math.cos(theta);
  const cw = -rMid * Math.sin(theta);
  const local = new Vector3().addScaledVector(basis.u, cu).addScaledVector(basis.w, cw);
  const world = node.localToWorld(local.clone());
  const tangentLocal = new Vector3().addScaledVector(basis.u, -Math.sin(theta)).addScaledVector(basis.w, -Math.cos(theta));
  const tangent = tangentLocal.transformDirection(node.matrixWorld);
  // Yaw about +Y that maps +X onto the horizontal tangent.
  const ry = Math.atan2(-tangent.z, tangent.x) * 180 / Math.PI;
  return { x: world.x, z: world.z, ry };
}

export function transportSurfaceTop(
  root: Object3D,
  surfaceOf?: (node: Object3D) => RadialSurfaceLike | null,
): { x: number; y: number; z: number; source: string; ry?: number } {
  root.updateMatrixWorld(true);
  const all = computeSubtreeAABB(root, new Box3());
  // plan-653 fix-up: the centre must not follow a selection overlay either.
  const allGeom = geometryBoundsOf(root, new Box3());
  if (!allGeom.isEmpty()) allGeom.getCenter(all.center);
  const surfaces = new Box3();
  const surfaceNodes: Object3D[] = [];
  root.traverse((n) => {
    const rv = (n.userData as { realvirtual?: Record<string, unknown> } | undefined)?.realvirtual;
    if (!rv || rv.TransportSurface === undefined) return;
    surfaceNodes.push(n);
    // Mesh-less surface nodes would answer with computeSubtreeAABB's 0.1 m
    // placeholder box — not a surface height. Overlay meshes (the selection
    // arrow a selected surface parents under its node) are not geometry: on a
    // SolidCraft body (local Z up, mm) that arrow stands upright and lifted the
    // reported top by ~0.23 m (plan-653 fix-up).
    surfaces.union(geometryBoundsOf(n, new Box3()));
  });
  const r3 = (v: number): number => +v.toFixed(4);
  if (!surfaces.isEmpty()) {
    // plan-675 D4: ONE curve → mid radius at the middle of the arc, tangential.
    const radial = surfaceNodes
      .map((n) => ({ n, s: surfaceOf?.(n) ?? null }))
      .filter((e) => e.s?.Radial);
    if (radial.length === 1) {
      const p = radialRestPoint(radial[0].n, radial[0].s!);
      if (p) return { x: r3(p.x), y: r3(surfaces.max.y), z: r3(p.z), source: 'TransportSurface radial', ry: +p.ry.toFixed(2) };
    }
    // Straight belt: the middle of the belt itself (its centre line), not of
    // the whole placement — side frames / a drive box must not pull it off.
    const c = surfaces.getCenter(new Vector3());
    return { x: r3(c.x), y: r3(surfaces.max.y), z: r3(c.z), source: 'TransportSurface' };
  }
  return { x: r3(all.center.x), y: r3(all.box.isEmpty() ? 0 : all.box.max.y), z: r3(all.center.z), source: 'bounds-top' };
}

/** World bounds of the real meshes under `node`, skipping highlight/selection
 *  overlays (`userData._highlightOverlay`) and everything below them. Empty when
 *  the subtree has no such mesh. Matrices must be current (caller updates). */
function geometryBoundsOf(node: Object3D, out: Box3): Box3 {
  out.makeEmpty();
  const tmp = new Box3();
  const visit = (o: Object3D): void => {
    if ((o.userData as { _highlightOverlay?: boolean } | undefined)?._highlightOverlay) return;
    const mesh = o as Mesh;
    if (mesh.isMesh && mesh.geometry) {
      const inst = o as InstancedMesh;
      if (inst.isInstancedMesh) {
        if (inst.boundingBox === null) inst.computeBoundingBox();
        tmp.copy(inst.boundingBox as Box3);
      } else {
        if (mesh.geometry.boundingBox === null) mesh.geometry.computeBoundingBox();
        tmp.copy(mesh.geometry.boundingBox as Box3);
      }
      if (!tmp.isEmpty()) out.union(tmp.applyMatrix4(mesh.matrixWorld));
    }
    for (const c of o.children) visit(c);
  };
  visit(node);
  return out;
}

/** Free, live snaps of a placed root (the UI's own "open ports" derivation). */
export function freeSnapsOf(ctx: Pick<CommandContext, 'viewer'>, root: Object3D): readonly SnapPoint[] {
  const reg = ctx.viewer.getPlugin?.<SnapPointPlugin>('snap-point')?.getRegistry();
  if (!reg) return [];
  return reg.getByOwnerRoot(root).filter((s) => !s.occupied && s.object3D.parent);
}

/** Resolve a target snap by name, or auto-pick the only free one. */
export function pickSnap(free: readonly SnapPoint[], name?: string | null):
  { snap: SnapPoint } | { error: string; available: string[] } {
  const available = free.map((s) => s.object3D.name);
  if (name) {
    const s = free.find((sp) => sp.object3D.name === name);
    return s ? { snap: s } : { error: `Snap "${name}" not free or not found`, available };
  }
  if (free.length === 1) return { snap: free[0] };
  if (free.length === 0) return { error: 'No free snap points on this component', available };
  return { error: 'Ambiguous — pass targetSnapName (multiple free snaps)', available };
}

/** Run `fn` as ONE undo step (no SceneStore yet — boot/test — runs it plainly). */
async function asOneStep<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const store = getSceneStore();
  return store ? store.withTransaction(label, fn) : fn();
}

const present = (v: unknown): boolean => v !== undefined && v !== null;

// ─── Implementations ────────────────────────────────────────────────────

const place: CommandImpl<PlaceArgs, Record<string, unknown>> = {
  enabled: (ctx, a) => {
    const planner = plannerOf(ctx);
    if (!planner) return { reason: PLANNER_UNAVAILABLE };
    if (!resolvePlaceEntry(planner, String(a?.catalogId ?? ''), a?.libraryProjectId)) return { reason: noCatalogEntry(String(a?.catalogId ?? '')) };
    if (a.onto && !planner.getPlacedRootById(a.onto)) return { reason: noPlacementOnto(a.onto) };
    return true;
  },
  run: async (ctx, a) => {
    const planner = plannerOf(ctx) as LayoutPlannerPlugin;
    const entry = resolvePlaceEntry(planner, a.catalogId, a.libraryProjectId) as LibraryCatalogEntry;
    let [x, y, z] = [Number(a.x ?? 0), Number(a.y ?? 0), Number(a.z ?? 0)];
    let surface: { x: number; y: number; z: number; source: string; ry?: number } | null = null;
    if (a.onto) {
      const surfaces = (ctx.viewer as { transportManager?: { surfaces: ReadonlyArray<RadialSurfaceLike & { node: Object3D }> } | null })
        .transportManager?.surfaces ?? [];
      surface = transportSurfaceTop(
        planner.getPlacedRootById(a.onto) as Object3D,
        (n) => surfaces.find((s) => s.node === n) ?? null,
      );
      ({ x, y, z } = surface);
    }
    // An explicit yaw wins over the curve tangent.
    const ry = present(a.ry) ? Number(a.ry) : (surface?.ry ?? 0);
    const t0 = performance.now();
    // Add + (height) move are ONE undo step.
    const id = await asOneStep(`Place ${entry.name}`, async () => {
      let placed: string;
      try {
        placed = await planner.placeComponent(entry, [x, y, z]);
      } catch (e) {
        // The planner exists but was never attached to the viewer.
        if (e instanceof Error && /Viewer not initialized/.test(e.message)) throw new CommandError(PLANNER_NOT_ATTACHED);
        throw e;
      }
      // `placeComponent` floor-aligns the part (y = 0); a requested height is
      // a booked move on top, so it survives the save like a gizmo drag would.
      if (y !== 0 || ry !== 0) await planner.moveById(placed, [x, y, z], [0, ry, 0]);
      return placed;
    });
    const deprecated = legacyCatalogIdHint(a.catalogId, entry);
    return {
      id, catalogId: deprecated ? (entry.documentId ?? entry.id) : a.catalogId, position: [x, y, z], placeMs: Math.round(performance.now() - t0),
      ...(deprecated ? { deprecation: deprecated } : {}),
      ...(entry.libraryOrigin ? { libraryProjectId: entry.libraryOrigin.sourceId } : {}),
      ...(ry !== 0 ? { rotation: [0, ry, 0] } : {}),
      ...(surface ? { onto: a.onto, surfaceHeight: y, surfaceSource: surface.source } : {}),
    };
  },
};

const move: CommandImpl<MoveArgs, Record<string, unknown>> = {
  enabled: (ctx, a) => {
    const planner = plannerOf(ctx);
    if (!planner) return { reason: PLANNER_UNAVAILABLE };
    if (!planner.snapshotPlacements().placements.some((p) => p.id === a?.id)) return { reason: noPlacement(String(a?.id ?? '')) };
    return true;
  },
  run: async (ctx, a) => {
    const planner = plannerOf(ctx) as LayoutPlannerPlugin;
    const cur = planner.snapshotPlacements().placements.find((p) => p.id === a.id);
    if (!cur) throw new CommandError(noPlacement(a.id));
    const rot: [number, number, number] = [
      present(a.rx) ? Number(a.rx) : cur.rotation[0],
      present(a.ry) ? Number(a.ry) : cur.rotation[1],
      present(a.rz) ? Number(a.rz) : cur.rotation[2],
    ];
    const pos: [number, number, number] = [Number(a.x), Number(a.y), Number(a.z)];
    await asOneStep(`Move ${cur.label ?? a.id}`, () => planner.moveById(a.id, pos, rot));
    return { id: a.id, position: pos, rotation: rot, persisted: true };
  },
};

/** Ids the Delete button would remove now (layout placements + spawned MUs count as "something"). */
function selectionCount(ctx: CommandContext): number {
  return ctx.viewer.selectionManager?.getSnapshot?.().selectedPaths.length ?? 0;
}

const remove: CommandImpl<RemoveArgs, { removed: string[]; selection: boolean }> = {
  enabled: (ctx, a) => {
    const planner = plannerOf(ctx);
    if (!planner) return { reason: PLANNER_UNAVAILABLE };
    if (!present(a?.id)) {
      return selectionCount(ctx) > 0 || planner.store.selectedId ? true : { reason: NOTHING_TO_DELETE };
    }
    return planner.getPlacedRootById(String(a.id)) ? true : { reason: noPlacement(String(a.id)) };
  },
  run: async (ctx, a) => {
    const planner = plannerOf(ctx) as LayoutPlannerPlugin;
    if (!present(a?.id)) {
      // The toolbar/keyboard semantics: the whole selection, layout placements
      // AND spawned MUs, as ONE undo step (the planner opens the transaction).
      const before = new Set(planner.snapshotPlacements().placements.map((p) => p.id));
      await planner.removeSelected();
      const after = new Set(planner.snapshotPlacements().placements.map((p) => p.id));
      return { removed: [...before].filter((id) => !after.has(id)), selection: true };
    }
    const removed = await planner.removeByIds([String(a.id)]);
    if (removed.length === 0) throw new CommandError(noPlacement(String(a.id)));
    return { removed, selection: false };
  },
};

const snapAttach: CommandImpl<SnapAttachArgs, Record<string, unknown>> = {
  enabled: (ctx, a) => {
    const planner = plannerOf(ctx);
    if (!planner) return { reason: PLANNER_UNAVAILABLE };
    const root = planner.getPlacedRootById(String(a?.targetId ?? ''));
    if (!root) return { reason: noPlacement(String(a?.targetId ?? '')) };
    const picked = pickSnap(freeSnapsOf(ctx, root), a.targetSnapName);
    if ('error' in picked) return { reason: picked.error, details: { available: picked.available } };
    const wantFlow = String(a.flow ?? '').trim().toLowerCase();
    if (wantFlow && wantFlow !== 'in' && wantFlow !== 'out') return { reason: 'flow must be "in" or "out"' };
    // plan-655 F4: the same resolution as layout.place — catalog entries AND
    // project parts (`project:<path>` or the documentId).
    if (!resolvePlaceEntry(planner, String(a.catalogId ?? ''), a.libraryProjectId)) return { reason: noCatalogEntry(String(a.catalogId ?? '')) };
    return true;
  },
  run: async (ctx, a) => {
    const planner = plannerOf(ctx) as LayoutPlannerPlugin;
    const root = planner.getPlacedRootById(a.targetId) as Object3D;
    const picked = pickSnap(freeSnapsOf(ctx, root), a.targetSnapName);
    if ('error' in picked) throw new CommandError(picked.error, { available: picked.available });
    const target = picked.snap;
    const wantFlow = String(a.flow ?? '').trim().toLowerCase();
    const entry = resolvePlaceEntry(planner, a.catalogId, a.libraryProjectId) as LibraryCatalogEntry;
    // The asset snap index is heavy — loaded on first attach, never eagerly.
    const { findCompatibleLibraryAssets, ensureEntryIndex } = await import('../snap-point/library-snap-index');
    const matches = await findCompatibleLibraryAssets([entry], target.typeId, oppositeDirection(target.dir), target.flow);
    // Compared with the RESOLVED entry: a documentId argument names the same
    // entry under its `project:<path>` id (SOL R1-1).
    const chosen = matches.find((m) => m.entry.id === entry.id);
    if (!chosen) {
      throw new CommandError(`"${a.catalogId}" has no snap compatible with typeId=${target.typeId}, flow=${target.flow ?? 'bidi'}`);
    }
    // The natural match favours the same-axis-opposite snap, which on a bidi
    // target (turntable side) always yields an OUTGOING conveyor. `flow` picks
    // the new part's own snap by ITS flow instead: feeding in = its output.
    let ownSnapName = chosen.ownSnapName;
    let ownFlow: string | undefined;
    {
      let idx: Awaited<ReturnType<typeof ensureEntryIndex>> | null = null;
      try { idx = await ensureEntryIndex(entry); } catch { /* index unavailable — keep the natural match */ }
      if (idx) {
        const fits = idx.snaps.filter((sn) => sn.typeId === target.typeId && flowsCompatible(target.flow, sn.flow));
        if (wantFlow) {
          const need = wantFlow === 'in' ? 'out' : 'in';
          const own = fits.find((sn) => sn.flow === need) ?? fits.find((sn) => (sn.flow ?? 'bidi') === 'bidi');
          if (!own) {
            throw new CommandError(
              `"${a.catalogId}" cannot attach with flow=${wantFlow} onto ${target.object3D.name} (flow=${target.flow ?? 'bidi'})`,
              { ownSnaps: fits.map((sn) => ({ snapName: sn.nodeName, flow: sn.flow ?? 'bidi' })) },
            );
          }
          ownSnapName = own.nodeName;
        }
        ownFlow = idx.snaps.find((sn) => sn.nodeName === ownSnapName)?.flow ?? 'bidi';
      }
    }
    const newId = await asOneStep(`Attach ${entry.name}`, () => planner.placeAtSnap(entry, target, ownSnapName));
    if (!newId) throw new CommandError('Placement rejected (snap occupied, non-uniform scale, or own-snap not found)');
    return {
      id: newId,
      catalogId: entry.id,
      attachedTo: { placementId: a.targetId, snapName: target.object3D.name, typeId: target.typeId },
      ownSnapName,
      // What the NEW part does relative to the target.
      ...(ownFlow ? { flow: ownFlow === 'out' ? 'in' : ownFlow === 'in' ? 'out' : 'bidi' } : {}),
    };
  },
};

const setParams: CommandImpl<SetParamsArgs, Record<string, unknown>> = {
  enabled: (ctx, a) => {
    const planner = plannerOf(ctx);
    if (!planner) return { reason: PLANNER_UNAVAILABLE };
    if (!planner.getPlacedRootById(String(a?.id ?? ''))) return { reason: noPlacement(String(a?.id ?? '')) };
    return true;
  },
  run: async (ctx, a) => {
    const planner = plannerOf(ctx) as LayoutPlannerPlugin;
    let values: unknown;
    try {
      values = typeof a.values === 'string' ? JSON.parse(a.values) : a.values;
    } catch {
      throw new CommandError('values must be a JSON object, e.g. {"ML": 2160}');
    }
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
      throw new CommandError('values must be a JSON object, e.g. {"ML": 2160}');
    }
    // The variant machinery loads on first use only.
    const { setPlacementParams } = await import('./planner-parametric');
    try {
      return { ...(await setPlacementParams(ctx.viewer, planner, a.id, values as Record<string, unknown>, a.family)) };
    } catch (e) {
      throw new CommandError(e instanceof Error ? e.message : String(e));
    }
  },
};

function history(kind: 'undo' | 'redo'): CommandImpl<Record<string, never>, { canUndo: boolean; canRedo: boolean }> {
  return {
    enabled: () => {
      const store = getSceneStore();
      const can = kind === 'undo' ? store?.canUndo() : store?.canRedo();
      return can ? true : { reason: kind === 'undo' ? NOTHING_TO_UNDO : NOTHING_TO_REDO };
    },
    run: async () => {
      const store = getSceneStore();
      if (!store) throw new CommandError(kind === 'undo' ? NOTHING_TO_UNDO : NOTHING_TO_REDO);
      const own = activeHistoryStep(kind);   // plan-2013: the variant in the scene has its own history
      if (own) await own; else await (kind === 'undo' ? store.undo() : store.redo());
      return { canUndo: store.canUndo(), canRedo: store.canRedo() };
    },
  };
}

// ─── Descriptors ────────────────────────────────────────────────────────

type P = CommandMcpMirror['params'][number];
const req = (name: string, type = 'string'): P => ({ name, type, required: true });
const opt = (name: string, type = 'string'): P => ({ name, type, required: false });

interface Spec {
  readonly id: string;
  readonly label: string | ((args: never) => string);
  readonly argsSchema: Readonly<Record<string, CommandArgType>>;
  readonly buttonKey?: (args: never) => string;
  readonly undoLabel?: string;
  readonly destructive?: boolean;
  readonly shortcut?: string;
  readonly mcp?: CommandMcpMirror;
  readonly impl: CommandImpl<never, unknown>;
}

const SPECS: readonly Spec[] = [
  {
    id: 'layout.place', label: 'Place component', undoLabel: 'Place component',
    argsSchema: { catalogId: 'string', x: 'number', y: 'number', z: 'number', onto: 'string', ry: 'number', libraryProjectId: 'string' },
    buttonKey: (a: PlaceArgs) => libraryEntryKey(String(a?.catalogId ?? ''), a?.libraryProjectId),
    mcp: {
      tool: 'web_layout_place',
      params: [req('catalogId'), req('x', 'number'), req('y', 'number'), req('z', 'number'), opt('onto'), opt('ry', 'number'), opt('libraryProjectId')],
    },
    impl: place as CommandImpl<never, unknown>,
  },
  {
    id: 'layout.move', label: 'Move placement', undoLabel: 'Move placement',
    argsSchema: { id: 'string', x: 'number', y: 'number', z: 'number', rx: 'number', ry: 'number', rz: 'number' },
    mcp: {
      tool: 'web_layout_move',
      params: [req('id'), req('x', 'number'), req('y', 'number'), req('z', 'number'),
        opt('rx', 'number'), opt('ry', 'number'), opt('rz', 'number')],
    },
    impl: move as CommandImpl<never, unknown>,
  },
  {
    id: 'layout.remove', label: 'Delete', undoLabel: 'Delete item', shortcut: 'Delete',
    argsSchema: { id: 'string' },
    buttonKey: () => PLANNER_DELETE_KEY,
    mcp: { tool: 'web_layout_remove', params: [req('id')] },
    impl: remove as CommandImpl<never, unknown>,
  },
  {
    id: 'layout.snapAttach', label: 'Attach at snap', undoLabel: 'Attach at snap',
    argsSchema: { targetId: 'string', catalogId: 'string', targetSnapName: 'string', flow: 'string', libraryProjectId: 'string' },
    buttonKey: () => SNAP_ATTACH_KEY,
    mcp: {
      tool: 'web_layout_snap_attach',
      params: [req('targetId'), req('catalogId'), opt('targetSnapName'), opt('flow'), opt('libraryProjectId')],
    },
    impl: snapAttach as CommandImpl<never, unknown>,
  },
  {
    // plan-650 Phase 5 (F17): no MCP mirror by design — reached through web_execute.
    id: 'layout.setParams', label: 'Set placement parameters', undoLabel: 'Set placement parameters',
    argsSchema: { id: 'string', values: 'string', family: 'string' },
    impl: setParams as CommandImpl<never, unknown>,
  },
  {
    id: 'layout.undo', label: 'Undo', argsSchema: {}, shortcut: 'Ctrl+Z',
    buttonKey: () => PLANNER_UNDO_KEY,
    impl: history('undo') as CommandImpl<never, unknown>,
  },
  {
    id: 'layout.redo', label: 'Redo', argsSchema: {}, shortcut: 'Ctrl+Y',
    buttonKey: () => PLANNER_REDO_KEY,
    impl: history('redo') as CommandImpl<never, unknown>,
  },
];

/** Every planner command id (preload, tests). */
export const PLANNER_COMMAND_IDS: readonly string[] = [...SPECS.map((s) => s.id), 'layout.list', 'layout.export', 'layout.snapList', 'layout.snapSuggest'];

/** Build the planner descriptors (testable seam: no registry side effect). */
export function createPlannerCommandDescriptors(): CommandDescriptor<never, unknown>[] {
  return [
    {
      id: 'layout.list', label: 'layout.list', readOnly: true, scope: 'none',
      available: true, unavailableReason: 'Not available',
      argsSchema: {},
      impl: async () => {
        const { McpSceneTools } = await import('../mcp-bridge/rv-mcp-scene-tools');
        const impl: CommandImpl<{}, unknown> = {
          enabled: () => true,
          run: async (ctx) => JSON.parse(await new McpSceneTools(() => ctx.viewer).queryLayoutList()),
        };
        return impl;
      },
    },
    {
      id: 'layout.export', label: 'layout.export', readOnly: true, scope: 'none',
      available: true, unavailableReason: 'Not available',
      argsSchema: {},
      impl: async () => {
        const { McpSceneTools } = await import('../mcp-bridge/rv-mcp-scene-tools');
        const impl: CommandImpl<{}, unknown> = {
          enabled: () => true,
          run: async (ctx) => JSON.parse(await new McpSceneTools(() => ctx.viewer).queryLayoutExport()),
        };
        return impl;
      },
    },
    {
      id: 'layout.snapList', label: 'layout.snapList', readOnly: true, scope: 'none',
      available: true, unavailableReason: 'Not available',
      argsSchema: { id: 'string' },
      impl: async () => {
        const { McpSceneTools } = await import('../mcp-bridge/rv-mcp-scene-tools');
        const impl: CommandImpl<{ id: string }, unknown> = {
          enabled: () => true,
          run: async (ctx, a) => JSON.parse(await new McpSceneTools(() => ctx.viewer).queryLayoutSnapList(a.id)),
        };
        return impl;
      },
    },
    {
      id: 'layout.snapSuggest', label: 'layout.snapSuggest', readOnly: true, scope: 'none',
      available: true, unavailableReason: 'Not available',
      argsSchema: { targetId: 'string', targetSnapName: 'string' },
      impl: async () => {
        const { McpSceneTools } = await import('../mcp-bridge/rv-mcp-scene-tools');
        const impl: CommandImpl<{ targetId: string; targetSnapName?: string }, unknown> = {
          enabled: () => true,
          run: async (ctx, a) => JSON.parse(await new McpSceneTools(() => ctx.viewer).queryLayoutSnapSuggest(a.targetId, a?.targetSnapName)),
        };
        return impl;
      },
    },
    ...SPECS.map((s): CommandDescriptor<never, unknown> => ({
    id: s.id,
    label: s.label,
    readOnly: false,
    ...(s.destructive ? { destructive: true } : {}),
    ...(s.shortcut ? { shortcut: s.shortcut } : {}),
    ...(s.undoLabel ? { undoLabel: s.undoLabel } : {}),
    scope: 'none',
    available: true,
    unavailableReason: PLANNER_UNAVAILABLE,
    ...(s.buttonKey ? { buttonKey: s.buttonKey } : {}),
    ...(s.mcp ? { mcp: s.mcp } : {}),
    argsSchema: s.argsSchema,
    eagerImpl: s.impl,
    impl: () => Promise.resolve(s.impl),
  })),
  ] as CommandDescriptor<never, unknown>[];
}

const registered = new WeakSet<CommandRegistry>();

/** Idempotent eager registration of the planner commands. */
export function ensurePlannerCommandsRegistered(registry: CommandRegistry = commandRegistry): void {
  if (registered.has(registry)) return;
  registered.add(registry);
  for (const d of createPlannerCommandDescriptors()) registry.register(d);
}
