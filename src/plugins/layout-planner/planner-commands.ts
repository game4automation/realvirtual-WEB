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
 *
 * The refusal texts are the ones the tools answered before the migration, so an
 * agent sees what it saw and a button shows the same text as its tooltip.
 */

import { Box3, type Object3D } from 'three';
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
import { listLibrarySources } from '../../core/library/library-source-registry';
import { computeSubtreeAABB } from '../../core/engine/rv-traverse-utils';
import type { SnapPoint } from '../../core/engine/rv-snap-point-registry';
import type { SnapPointPlugin } from '../snap-point';
import { flowsCompatible, oppositeDirection } from '../snap-point/snap-name-parser';
import type { LayoutPlannerPlugin } from './index';
import type { LibraryCatalogEntry } from './rv-layout-store';

// ─── Args ───────────────────────────────────────────────────────────────

export interface PlaceArgs {
  readonly catalogId: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Placement id to rest the part ON (its transport-surface top); null/absent = x/y/z. */
  readonly onto?: string | null;
}
export interface MoveArgs {
  readonly id: string;
  readonly x: number; readonly y: number; readonly z: number;
  readonly rx?: number | null; readonly ry?: number | null; readonly rz?: number | null;
}
/** `id` null = "the current selection" (the toolbar Delete button). */
export interface RemoveArgs { readonly id: string | null | undefined }
export interface SnapAttachArgs {
  readonly targetId: string;
  readonly catalogId: string;
  readonly targetSnapName?: string | null;
  readonly flow?: string | null;
}

// ─── Reasons ────────────────────────────────────────────────────────────

export const PLANNER_UNAVAILABLE = 'Layout planner not available — call web_mode_set("planner") first';
export const NOTHING_TO_DELETE = 'Delete (select something first)';
export const NOTHING_TO_UNDO = 'Nothing to undo';
export const NOTHING_TO_REDO = 'Nothing to redo';
export const noPlacement = (id: string): string => `No placement "${id}". Use web_layout_list.`;
export const noPlacementOnto = (id: string): string => `No placement "${id}" to place onto. Use web_layout_list.`;
export const noCatalogEntry = (id: string): string =>
  `No catalog entry "${id}". Use web_catalog_list or web_document_list (id or "project:<path>").`;
export const noPlannerCatalogEntry = (id: string): string => `No catalog entry "${id}". Use web_catalog_list.`;
const PLANNER_NOT_ATTACHED =
  'Layout planner is not attached to the viewer (no model loaded and planner mode not entered yet) — call web_mode_set("planner") or web_document_open(<document>) first, then retry';

// ─── Button keys ────────────────────────────────────────────────────────

/** The library entry of a catalog id — the view of `layout.place`. */
export const libraryEntryKey = (catalogId: string): string => `layout.library:${catalogId}`;
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
export function resolvePlaceEntry(planner: LayoutPlannerPlugin, catalogId: string): LibraryCatalogEntry | undefined {
  const own = findPlannerEntry(planner, catalogId);
  if (own) return own;
  for (const { source } of listLibrarySources()) {
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
export function transportSurfaceTop(root: Object3D): { x: number; y: number; z: number; source: string } {
  root.updateMatrixWorld(true);
  const all = computeSubtreeAABB(root, new Box3());
  const surfaces = new Box3();
  root.traverse((n) => {
    const rv = (n.userData as { realvirtual?: Record<string, unknown> } | undefined)?.realvirtual;
    if (!rv || rv.TransportSurface === undefined) return;
    // Mesh-less surface nodes would answer with computeSubtreeAABB's 0.1 m
    // placeholder box — not a surface height.
    let hasMesh = false;
    n.traverse((c) => { if ((c as { isMesh?: boolean }).isMesh) hasMesh = true; });
    if (!hasMesh) return;
    surfaces.union(computeSubtreeAABB(n, new Box3()).box);
  });
  const r3 = (v: number): number => +v.toFixed(4);
  if (!surfaces.isEmpty()) {
    return { x: r3(all.center.x), y: r3(surfaces.max.y), z: r3(all.center.z), source: 'TransportSurface' };
  }
  return { x: r3(all.center.x), y: r3(all.box.isEmpty() ? 0 : all.box.max.y), z: r3(all.center.z), source: 'bounds-top' };
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
    if (!resolvePlaceEntry(planner, String(a?.catalogId ?? ''))) return { reason: noCatalogEntry(String(a?.catalogId ?? '')) };
    if (a.onto && !planner.getPlacedRootById(a.onto)) return { reason: noPlacementOnto(a.onto) };
    return true;
  },
  run: async (ctx, a) => {
    const planner = plannerOf(ctx) as LayoutPlannerPlugin;
    const entry = resolvePlaceEntry(planner, a.catalogId) as LibraryCatalogEntry;
    let [x, y, z] = [Number(a.x ?? 0), Number(a.y ?? 0), Number(a.z ?? 0)];
    let surface: { x: number; y: number; z: number; source: string } | null = null;
    if (a.onto) {
      surface = transportSurfaceTop(planner.getPlacedRootById(a.onto) as Object3D);
      ({ x, y, z } = surface);
    }
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
      if (y !== 0) await planner.moveById(placed, [x, y, z], [0, 0, 0]);
      return placed;
    });
    return {
      id, catalogId: a.catalogId, position: [x, y, z], placeMs: Math.round(performance.now() - t0),
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
    if (!findPlannerEntry(planner, String(a.catalogId ?? ''))) return { reason: noPlannerCatalogEntry(String(a.catalogId ?? '')) };
    return true;
  },
  run: async (ctx, a) => {
    const planner = plannerOf(ctx) as LayoutPlannerPlugin;
    const root = planner.getPlacedRootById(a.targetId) as Object3D;
    const picked = pickSnap(freeSnapsOf(ctx, root), a.targetSnapName);
    if ('error' in picked) throw new CommandError(picked.error, { available: picked.available });
    const target = picked.snap;
    const wantFlow = String(a.flow ?? '').trim().toLowerCase();
    const entry = findPlannerEntry(planner, a.catalogId) as LibraryCatalogEntry;
    // The asset snap index is heavy — loaded on first attach, never eagerly.
    const { findCompatibleLibraryAssets, ensureAssetIndex } = await import('../snap-point/library-snap-index');
    const matches = await findCompatibleLibraryAssets([entry], target.typeId, oppositeDirection(target.dir), target.flow);
    const chosen = matches.find((m) => m.entry.id === a.catalogId);
    if (!chosen) {
      throw new CommandError(`"${a.catalogId}" has no snap compatible with typeId=${target.typeId}, flow=${target.flow ?? 'bidi'}`);
    }
    // The natural match favours the same-axis-opposite snap, which on a bidi
    // target (turntable side) always yields an OUTGOING conveyor. `flow` picks
    // the new part's own snap by ITS flow instead: feeding in = its output.
    let ownSnapName = chosen.ownSnapName;
    let ownFlow: string | undefined;
    if (entry.glbUrl) {
      let idx: Awaited<ReturnType<typeof ensureAssetIndex>> | null = null;
      try { idx = await ensureAssetIndex(entry.id, entry.glbUrl); } catch { /* index unavailable — keep the natural match */ }
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
      catalogId: a.catalogId,
      attachedTo: { placementId: a.targetId, snapName: target.object3D.name, typeId: target.typeId },
      ownSnapName,
      // What the NEW part does relative to the target.
      ...(ownFlow ? { flow: ownFlow === 'out' ? 'in' : ownFlow === 'in' ? 'out' : 'bidi' } : {}),
    };
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
      await (kind === 'undo' ? store.undo() : store.redo());
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
    argsSchema: { catalogId: 'string', x: 'number', y: 'number', z: 'number', onto: 'string' },
    buttonKey: (a: PlaceArgs) => libraryEntryKey(String(a?.catalogId ?? '')),
    mcp: {
      tool: 'web_layout_place',
      params: [req('catalogId'), req('x', 'number'), req('y', 'number'), req('z', 'number'), opt('onto')],
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
    argsSchema: { targetId: 'string', catalogId: 'string', targetSnapName: 'string', flow: 'string' },
    buttonKey: () => SNAP_ATTACH_KEY,
    mcp: {
      tool: 'web_layout_snap_attach',
      params: [req('targetId'), req('catalogId'), opt('targetSnapName'), opt('flow')],
    },
    impl: snapAttach as CommandImpl<never, unknown>,
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
export const PLANNER_COMMAND_IDS: readonly string[] = SPECS.map((s) => s.id);

/** Build the planner descriptors (testable seam: no registry side effect). */
export function createPlannerCommandDescriptors(): CommandDescriptor<never, unknown>[] {
  return SPECS.map((s): CommandDescriptor<never, unknown> => ({
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
  }));
}

const registered = new WeakSet<CommandRegistry>();

/** Idempotent eager registration of the planner commands. */
export function ensurePlannerCommandsRegistered(registry: CommandRegistry = commandRegistry): void {
  if (registered.has(registry)) return;
  registered.add(registry);
  for (const d of createPlannerCommandDescriptors()) registry.register(d);
}
