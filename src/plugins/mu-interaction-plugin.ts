// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * mu-interaction-plugin — take a workpiece carrier (MU) off the line by hand,
 * or put it somewhere else, in the Commissioning workspace (plan-567).
 *
 * What a commissioning engineer does at the real line: lift a carrier off the
 * belt, or set it down at another place — while the line runs or while it is
 * paused. Three views, one engine (`core/engine/rv-mu-manipulation.ts`):
 *
 * | Action         | UI view                                          | MCP tool        |
 * |----------------|--------------------------------------------------|-----------------|
 * | `mu.delete`    | Delete key on a selected carrier, context menu   | `web_mu_delete` |
 * | `mu.move`      | drag a carrier onto a transport surface          | `web_mu_move`   |
 *
 * Both are registry commands (plan-499): the one rule — {@link muManipulationGuard}
 * plus the engine's refusals — answers the context-menu hint, the drag hint and
 * the tool `{error}` alike, and it runs again immediately before the mutation
 * (SOL #10). The drag commits through the same engine primitive the command
 * runs, but not through `execute()`: a gesture is a pointer stream with a
 * synchronous cancel, not a one-shot dispatch (SOL R2-2, documented exception).
 *
 * Selectable carriers: pre-placed ones are pickable under their document path
 * already; spawned clone carriers are registered by a planner-independent
 * {@link MuReconciler} (synthetic `__mu#<n>` path + aux raycast targets).
 * Pooled (instanced) carriers are not manipulable (SOL #6/7) — the drag answers
 * with a hint. The Layout Planner has its own reconciler and its own Delete
 * handling; the two never run together (this plugin is `modes: ['commissioning']`),
 * so there is no second raycast allow filter (non-functional requirement).
 *
 * Lifetime of a delete (SOL #11): until the next simulation reset, workspace
 * switch or model reload — a pre-placed carrier comes back from its snapshot.
 */

import {
  BoxGeometry, EdgesGeometry, LineBasicMaterial, LineSegments, Plane, Raycaster, Vector2, Vector3,
} from 'three';
import type { Intersection, Mesh, Object3D } from 'three';
import type { RVViewer } from '../core/rv-viewer';
import type { RVViewerPlugin } from '../core/rv-plugin';
import type { ModeId } from '../core/rv-mode-manager';
import type { LoadResult } from '../core/engine/rv-scene-loader';
import type { RVMovingUnit, InstancedMovingUnit } from '../core/engine/rv-mu';
import type { RVTransportManager } from '../core/engine/rv-transport-manager';
import type { RVTransportSurface } from '../core/engine/rv-transport-surface';
import type { ContextMenuTarget } from '../core/hmi/context-menu-store';
import { keyEventBelongsToViewer } from '../core/engine/rv-selection-manager';
import {
  commandRegistry,
  CommandError,
  type CommandArgType,
  type CommandContext,
  type CommandDescriptor,
  type CommandImpl,
  type CommandMcpMirror,
  type CommandRegistry,
} from '../core/hmi/rv-command-registry';
import {
  REASON_GONE,
  REASON_POOLED,
  beginUserDrag,
  cancelUserDrag,
  carrierOf,
  commitUserDrag,
  deleteMU,
  heldReason,
  placeMUOnSurface,
  previewUserDrag,
  resolveCarrierById,
  type MuDragSession,
} from '../core/engine/rv-mu-manipulation';
import { MuReconciler } from './layout-planner/mu-reconciler';

type AnyMU = RVMovingUnit | InstancedMovingUnit;

// ─── The one rule (UI + MCP) ────────────────────────────────────────────

export const REASON_MODE = 'Workpiece carriers can be removed or moved only in the Commissioning workspace';
export const REASON_DES = 'Not available while the DES kernel runs the simulation';
export const REASON_MULTIUSER = 'Not available in a multiuser client session — the server owns the carriers';
export const REASON_NO_TRANSPORT = 'No transport simulation loaded';
export const muNotFound = (id: number): string =>
  `No carrier with id ${id} — ids come from web_transport_status (mus[].id)`;

/**
 * The shared guard of every manipulation (SOL #10): the Commissioning
 * workspace, the continuous kernel, no multiuser client role, a loaded
 * transport simulation. Null = allowed. Checked before a gesture starts, by
 * `enabled()`, and again immediately before the mutation.
 */
export function muManipulationGuard(viewer: RVViewer | null | undefined): string | null {
  const tm = viewer?.transportManager ?? null;
  if (!viewer || !tm) return REASON_NO_TRANSPORT;
  if ((viewer.modes?.activeMode ?? null) !== 'commissioning') return REASON_MODE;
  if (viewer.simulationKernel?.mode === 'des') return REASON_DES;
  // Set by the multiuser plugin on the first server MU sync (plan-516 guard).
  if (tm.preplacedActivationBlocked) return REASON_MULTIUSER;
  return null;
}

/**
 * The carrier a picked node belongs to: walk up to the node of a registered
 * carrier (`_muRef`, both reconcilers) or of a pre-placed MU, then to the
 * carrier of a passive load (SOL #2). Null when the node is no carrier.
 */
export function resolveMuFromNode(tm: RVTransportManager | null | undefined, node: Object3D | null | undefined): RVMovingUnit | null {
  if (!tm || !node) return null;
  for (let cur: Object3D | null = node; cur; cur = cur.parent) {
    const ref = cur.userData?._muRef as RVMovingUnit | undefined;
    if (ref && !ref.isInstanced) return carrierOf(ref);
    for (const mu of tm.preplacedMUs) if (mu.node === cur) return carrierOf(mu);
  }
  return null;
}

// ─── Commands ───────────────────────────────────────────────────────────

export interface MuDeleteArgs { readonly id: number }
export interface MuMoveArgs {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Surface node name or registry path; omitted = the surface under (x, z) whose top is nearest y. */
  readonly surface?: string | null;
}

export const MU_DELETE_COMMAND = 'mu.delete';
export const MU_MOVE_COMMAND = 'mu.move';

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function liveCarrier(ctx: CommandContext, id: unknown): AnyMU | string {
  const guard = muManipulationGuard(ctx.viewer);
  if (guard) return guard;
  if (!finite(id)) return 'id is required (a number from web_transport_status mus[].id)';
  const mu = resolveCarrierById(ctx.viewer.transportManager as RVTransportManager, id);
  if (!mu) return muNotFound(id);
  if (mu.isInstanced) return REASON_POOLED;
  return mu;
}

/** Selection paths that point into `node`'s subtree (cleanup after a delete). */
function dropSelectionUnder(viewer: RVViewer, node: Object3D): void {
  const sm = viewer.selectionManager;
  const reg = viewer.registry;
  if (!sm || !reg) return;
  const sel = sm.getSnapshot().selectedPaths;
  const keep = sel.filter((p) => {
    for (let n: Object3D | null = reg.getNode(p) ?? null; n; n = n.parent) if (n === node) return false;
    return true;
  });
  if (keep.length !== sel.length) sm.selectPaths(keep);
}

function resolveSurface(tm: RVTransportManager, viewer: RVViewer, name: string): RVTransportSurface | null {
  for (const s of tm.surfaces) {
    if (s.node.name === name) return s;
    if (viewer.registry?.getPathForNode(s.node) === name) return s;
  }
  return null;
}

/** Among the surfaces under (x, z): the one whose top is nearest `y` (stacked levels). */
function surfaceNearY(tm: RVTransportManager, x: number, y: number, z: number): RVTransportSurface | null {
  let best: RVTransportSurface | null = null;
  let bestD = Infinity;
  for (const s of tm.surfaces) {
    s.aabb.update();
    const a = s.aabb;
    if (x < a.min.x || x > a.max.x || z < a.min.z || z > a.max.z) continue;
    const d = Math.abs(a.max.y - y);
    if (d < bestD) { bestD = d; best = s; }
  }
  return best;
}

const muDelete: CommandImpl<MuDeleteArgs, Record<string, unknown>> = {
  enabled: (ctx, a) => {
    const mu = liveCarrier(ctx, a?.id);
    return typeof mu === 'string' ? { reason: mu } : true;
  },
  run: (ctx, a) => {
    // Re-check immediately before the mutation (SOL #10).
    const mu = liveCarrier(ctx, a.id);
    if (typeof mu === 'string') throw new CommandError(mu);
    const node = mu.node;
    const r = deleteMU(ctx.viewer.transportManager as RVTransportManager, mu);
    if (!r.ok) throw new CommandError(r.reason);
    dropSelectionUnder(ctx.viewer, node);
    ctx.viewer.markRenderDirty?.();
    return {
      id: r.id,
      name: r.name,
      removed: r.removed,
      preplaced: r.preplaced,
      releasedHold: r.releasedHold,
      ...(r.preplaced ? { note: 'Authored carrier — a simulation reset brings it back' } : {}),
    };
  },
};

const _movePoint = new Vector3();

const muMove: CommandImpl<MuMoveArgs, Record<string, unknown>> = {
  enabled: (ctx, a) => {
    const mu = liveCarrier(ctx, a?.id);
    if (typeof mu === 'string') return { reason: mu };
    if (!finite(a.x) || !finite(a.y) || !finite(a.z)) return { reason: 'x, y and z are required (world metres)' };
    if (a.surface) {
      const tm = ctx.viewer.transportManager as RVTransportManager;
      if (!resolveSurface(tm, ctx.viewer, a.surface)) return { reason: `Transport surface "${a.surface}" not found` };
    }
    const held = (mu as RVMovingUnit).heldBy;
    return held ? { reason: heldReason(held) } : true;
  },
  run: (ctx, a) => {
    const mu = liveCarrier(ctx, a.id);
    if (typeof mu === 'string') throw new CommandError(mu);
    const tm = ctx.viewer.transportManager as RVTransportManager;
    const surface = a.surface ? resolveSurface(tm, ctx.viewer, a.surface) : surfaceNearY(tm, a.x, a.y, a.z);
    const r = placeMUOnSurface(tm, mu, _movePoint.set(a.x, a.y, a.z), {
      surface, collision: ctx.viewer.collisionManager ?? null,
    });
    if (!r.ok) throw new CommandError(r.reason);
    ctx.viewer.markRenderDirty?.();
    return { id: r.id, name: r.name, surface: r.surface, position: r.position.map((v) => +v.toFixed(4)) };
  },
};

type P = CommandMcpMirror['params'][number];
const req = (name: string, type = 'string'): P => ({ name, type, required: true });
const opt = (name: string, type = 'string'): P => ({ name, type, required: false });

/** Build the two carrier commands (testable seam: no registry side effect). */
export function createMuCommandDescriptors(): CommandDescriptor<never, unknown>[] {
  const del: CommandDescriptor<MuDeleteArgs, Record<string, unknown>> = {
    id: MU_DELETE_COMMAND,
    label: 'Remove workpiece carrier',
    shortcut: 'Delete',
    readOnly: false,
    // Not `destructive`: the hint is kept for tools that can destroy what the
    // caller did not name (rv-mcp-tool-conventions) — this removes the named
    // carrier, simulation state that a reset restores for authored carriers.
    scope: 'none',
    available: true,
    unavailableReason: 'Not available',
    buttonKey: (a) => `mu.delete:${a?.id ?? ''}`,
    mcp: { tool: 'web_mu_delete', params: [req('id', 'number')] },
    argsSchema: { id: 'number' } as Readonly<Record<string, CommandArgType>>,
    eagerImpl: muDelete,
    impl: () => Promise.resolve(muDelete),
  };
  const move: CommandDescriptor<MuMoveArgs, Record<string, unknown>> = {
    id: MU_MOVE_COMMAND,
    label: 'Move workpiece carrier',
    readOnly: false,
    scope: 'none',
    available: true,
    unavailableReason: 'Not available',
    buttonKey: (a) => `mu.move:${a?.id ?? ''}`,
    mcp: {
      tool: 'web_mu_move',
      params: [req('id', 'number'), req('x', 'number'), req('y', 'number'), req('z', 'number'), opt('surface')],
    },
    argsSchema: { id: 'number', x: 'number', y: 'number', z: 'number', surface: 'string' },
    eagerImpl: muMove,
    impl: () => Promise.resolve(muMove),
  };
  return [del as unknown as CommandDescriptor<never, unknown>, move as unknown as CommandDescriptor<never, unknown>];
}

const registered = new WeakSet<CommandRegistry>();

/** Idempotent eager registration of the carrier commands. */
export function ensureMuCommandsRegistered(registry: CommandRegistry = commandRegistry): void {
  if (registered.has(registry)) return;
  registered.add(registry);
  for (const d of createMuCommandDescriptors()) registry.register(d);
}

// ─── Plugin ─────────────────────────────────────────────────────────────

/** Screen pixels the pointer may travel before a press on a carrier becomes a drag. */
const DRAG_THRESHOLD_PX = 4;
const HINT_MS = 2200;
const COLOR_OK = 0x2ecc71;
const COLOR_BAD = 0xe74c3c;

interface PendingPress {
  readonly mu: RVMovingUnit;
  readonly path: string;
  readonly pointerId: number;
  readonly x: number;
  readonly y: number;
  readonly additive: boolean;
}

interface ActiveDrag {
  readonly session: MuDragSession;
  readonly pointerId: number;
  readonly model: Object3D | null;
  readonly planes: Mesh[];
  readonly grabPlane: Plane;
  /** Last preview: drop point + surface (null = off every surface). */
  readonly point: Vector3;
  surface: RVTransportSurface | null;
  valid: boolean;
  prevControls: boolean;
}

export class MuInteractionPlugin implements RVViewerPlugin {
  readonly id = 'mu-interaction';
  readonly modes: ModeId[] = ['commissioning'];

  private viewer: RVViewer | null = null;
  private reconciler: MuReconciler | null = null;
  private active = false;
  private press: PendingPress | null = null;
  private drag: ActiveDrag | null = null;
  private outline: LineSegments | null = null;
  private hintEl: HTMLDivElement | null = null;
  private hintTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly unsubs: Array<() => void> = [];

  // Pre-allocated pointer scratch (no GC per move).
  private readonly raycaster = new Raycaster();
  private readonly ndc = new Vector2();
  private readonly hits: Intersection[] = [];
  private readonly planeHit = new Vector3();

  init(viewer: RVViewer): void {
    this.viewer = viewer;
    ensureMuCommandsRegistered();
    this.unsubs.push(
      viewer.on('simulation-reset', () => this.abortDrag()),
      viewer.on('mode-changing', () => this.abortDrag()),
    );
  }

  onModelLoaded(_result: LoadResult, _viewer: RVViewer): void {
    this.abortDrag();
  }

  onModelCleared(): void {
    this.abortDrag();
    this.reconciler?.disposeAll();
  }

  onModeActivate(_mode: ModeId, viewer: RVViewer): void {
    this.viewer = viewer;
    if (this.active) return;
    this.active = true;
    this.reconciler = new MuReconciler({
      viewer,
      getMUs: () => viewer.transportManager?.mus ?? [],
      onSelectionDropped: () => viewer.selectionManager?.refreshHighlight?.(),
    });
    this.registerContextMenu(viewer);
    window.addEventListener('pointerdown', this.onPointerDown, true);
    window.addEventListener('pointermove', this.onPointerMove, true);
    window.addEventListener('pointerup', this.onPointerUp, true);
    window.addEventListener('pointercancel', this.onPointerCancel, true);
    window.addEventListener('keydown', this.onKeyDown, true);
    viewer.renderer?.domElement?.addEventListener('lostpointercapture', this.onLostCapture);
  }

  onModeDeactivate(_mode: ModeId | null, viewer: RVViewer): void {
    if (!this.active) return;
    this.active = false;
    this.abortDrag();
    this.press = null;
    window.removeEventListener('pointerdown', this.onPointerDown, true);
    window.removeEventListener('pointermove', this.onPointerMove, true);
    window.removeEventListener('pointerup', this.onPointerUp, true);
    window.removeEventListener('pointercancel', this.onPointerCancel, true);
    window.removeEventListener('keydown', this.onKeyDown, true);
    viewer.renderer?.domElement?.removeEventListener('lostpointercapture', this.onLostCapture);
    viewer.contextMenu?.unregister(this.id);
    this.reconciler?.disposeAll();
    this.reconciler = null;
    this.hideHint();
    this.disposeOutline();
  }

  onRender(): void {
    if (this.active) this.reconciler?.reconcile();
  }

  dispose(): void {
    if (this.viewer && this.active) this.onModeDeactivate(null, this.viewer);
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.hintEl?.remove();
    this.hintEl = null;
  }

  /** True while a drag gesture holds a carrier (tests, diagnostics). */
  get dragging(): boolean { return this.drag !== null; }

  // ── Context menu ──────────────────────────────────────────────────────

  private registerContextMenu(viewer: RVViewer): void {
    const muOf = (t: ContextMenuTarget): RVMovingUnit | null => resolveMuFromNode(viewer.transportManager, t.node);
    viewer.contextMenu.register({
      pluginId: this.id,
      items: [
        {
          id: 'mu.remove',
          label: 'Remove workpiece carrier',
          order: 20,
          danger: true,
          shortcut: 'Del',
          condition: (t) => muManipulationGuard(viewer) === null && muOf(t) !== null,
          command: { id: MU_DELETE_COMMAND, args: (t) => ({ id: muOf(t)?.id ?? -1 }) },
        },
        {
          // F9: in DES / a multiuser client the entry stays visible with the reason.
          id: 'mu.remove-unavailable',
          label: () => `Remove workpiece carrier — ${muManipulationGuard(viewer) ?? ''}`,
          order: 20,
          condition: (t) => {
            const g = muManipulationGuard(viewer);
            return g !== null && g !== REASON_MODE && muOf(t) !== null;
          },
          action: () => { /* informational: the reason is the label */ },
        },
      ],
    });
  }

  // ── Delete key ────────────────────────────────────────────────────────

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && this.drag) {
      e.stopImmediatePropagation();
      e.preventDefault();
      this.abortDrag();
      return;
    }
    if (e.key !== 'Delete') return;
    const viewer = this.viewer;
    if (!viewer || !this.active || this.drag) return;
    if (!keyEventBelongsToViewer(e, viewer.keyboardScope, viewer.keyboardScopeIsPrimary)) return;
    const t = e.target as HTMLElement | null;
    const tag = t?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable) return;
    const mus = this.selectedCarriers();
    if (mus.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    void this.deleteCarriers(mus, 'shortcut');
  };

  /** The distinct carriers of the current selection. */
  selectedCarriers(): RVMovingUnit[] {
    const viewer = this.viewer;
    const tm = viewer?.transportManager;
    if (!viewer || !tm) return [];
    const out: RVMovingUnit[] = [];
    for (const p of viewer.selectionManager?.getSnapshot().selectedPaths ?? []) {
      const mu = resolveMuFromNode(tm, viewer.registry?.getNode(p) ?? null);
      if (mu && !out.includes(mu)) out.push(mu);
    }
    return out;
  }

  /**
   * Delete `mus` through the registry command (one dispatch each). Several
   * carriers ask for a confirmation first — the action has no undo (it is
   * simulation state, not a document edit).
   */
  async deleteCarriers(mus: readonly RVMovingUnit[], origin: 'ui' | 'shortcut' = 'ui'): Promise<number> {
    const viewer = this.viewer;
    if (!viewer || mus.length === 0) return 0;
    const guard = muManipulationGuard(viewer);
    if (guard) { this.showHintAtCanvas(guard); return 0; }
    if (mus.length > 1 && typeof window !== 'undefined' && typeof window.confirm === 'function'
      && !window.confirm(`Remove ${mus.length} workpiece carriers? This cannot be undone (a simulation reset restores authored carriers).`)) {
      return 0;
    }
    let n = 0;
    for (const mu of mus) {
      const r = await commandRegistry.execute(MU_DELETE_COMMAND, { id: mu.id }, { origin, viewer });
      if (r.ok) n++;
      else this.showHintAtCanvas(r.reason);
    }
    return n;
  }

  // ── Drag gesture ──────────────────────────────────────────────────────

  private readonly onPointerDown = (e: PointerEvent): void => {
    const viewer = this.viewer;
    if (!viewer || !this.active || e.button !== 0 || this.drag) return;
    const canvas = viewer.renderer?.domElement;
    if (!canvas || e.target !== canvas) return;
    const hit = viewer.raycastManager?.raycastForRVNodeDetailed(e) ?? null;
    if (!hit) return;
    if (hit.instancedMU) { this.showHint(e, REASON_POOLED); return; }
    const mu = resolveMuFromNode(viewer.transportManager, viewer.registry?.getNode(hit.path) ?? null);
    if (!mu) return;
    // Claim the press: no orbit, no marquee, no click-select by the viewer —
    // a click without travel selects the carrier below (onPointerUp).
    e.stopImmediatePropagation();
    e.preventDefault();
    this.press = {
      mu, path: viewer.registry?.getPathForNode(mu.node) ?? hit.path, pointerId: e.pointerId,
      x: e.clientX, y: e.clientY, additive: e.shiftKey || e.ctrlKey || e.metaKey,
    };
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    const press = this.press;
    if (press && !this.drag && e.pointerId === press.pointerId) {
      const dx = e.clientX - press.x;
      const dy = e.clientY - press.y;
      if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;
      this.press = null;
      e.stopImmediatePropagation();
      this.startDrag(press.mu, e);
      return;
    }
    const drag = this.drag;
    if (!drag || e.pointerId !== drag.pointerId) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    this.updateDrag(e);
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    const press = this.press;
    if (press && e.pointerId === press.pointerId) {
      this.press = null;
      e.stopImmediatePropagation();
      const sm = this.viewer?.selectionManager;
      if (sm) {
        if (press.additive) sm.toggle(press.path);
        else sm.select(press.path);
      }
      return;
    }
    const drag = this.drag;
    if (!drag || e.pointerId !== drag.pointerId || e.button !== 0) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    this.finishDrag(e);
  };

  private readonly onPointerCancel = (e: PointerEvent): void => {
    if (this.press?.pointerId === e.pointerId) this.press = null;
    if (this.drag?.pointerId === e.pointerId) this.abortDrag();
  };

  private readonly onLostCapture = (e: PointerEvent): void => {
    if (this.drag?.pointerId === e.pointerId) this.abortDrag();
  };

  /**
   * Take `mu` with the pointer (public for tests). Refused — with a hint and
   * nothing changed — by the guard and by the engine (held, physics, gone).
   */
  startDrag(mu: RVMovingUnit, e: { clientX: number; clientY: number; pointerId: number }): boolean {
    const viewer = this.viewer;
    const tm = viewer?.transportManager;
    if (!viewer || !tm) return false;
    const guard = muManipulationGuard(viewer);
    if (guard) { this.showHint(e, guard); return false; }
    const session = beginUserDrag(tm, mu, viewer.collisionManager ?? null);
    if ('ok' in session) { this.showHint(e, session.reason); return false; }

    // One drop plane per surface, built once per gesture (raycast candidates only).
    const planes: Mesh[] = [];
    for (const s of tm.surfaces) {
      const p = s.createDropPlane();
      if (p) planes.push(p);
    }
    mu.updateAABB();
    const drag: ActiveDrag = {
      session,
      pointerId: e.pointerId,
      model: viewer.currentModelRoot ?? null,
      planes,
      grabPlane: new Plane(new Vector3(0, 1, 0), -mu.aabb.min.y),
      point: new Vector3(),
      surface: null,
      valid: false,
      prevControls: viewer.controls?.enabled ?? true,
    };
    this.drag = drag;
    if (viewer.controls) viewer.controls.enabled = false;
    const canvas = viewer.renderer?.domElement;
    if (canvas) {
      canvas.style.cursor = 'grabbing';
      try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    }
    this.ensureOutline(viewer);
    this.updateDrag(e);
    return true;
  }

  /** Pointer moved during a drag: ray → drop plane (or the grab height) → preview. */
  updateDrag(e: { clientX: number; clientY: number }): void {
    const viewer = this.viewer;
    const drag = this.drag;
    const tm = viewer?.transportManager;
    if (!viewer || !drag || !tm) return;
    const canvas = viewer.renderer?.domElement;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const w = rect.width || 1;
    const h = rect.height || 1;
    this.ndc.set(((e.clientX - rect.left) / w) * 2 - 1, -((e.clientY - rect.top) / h) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, viewer.camera);
    this.hits.length = 0;
    this.raycaster.intersectObjects(drag.planes, false, this.hits);
    let surface: RVTransportSurface | null = null;
    if (this.hits.length > 0) {
      drag.point.copy(this.hits[0].point);
      surface = (this.hits[0].object.userData?._rvDropSurfaceInstance as RVTransportSurface | undefined) ?? null;
    } else if (this.raycaster.ray.intersectPlane(drag.grabPlane, this.planeHit)) {
      drag.point.copy(this.planeHit);
    } else {
      return;
    }
    const check = previewUserDrag(tm, drag.session, drag.point, surface);
    drag.surface = check.surface;
    drag.valid = check.ok;
    this.updateOutline(drag.session.mu, check.ok);
    if (check.ok) this.hideHint();
    else if (check.reason) this.showHint(e, check.reason);
    viewer.markRenderDirty?.();
  }

  /** Release: commit through the engine (re-checked), or put the carrier back. */
  finishDrag(e: { clientX: number; clientY: number }): void {
    const viewer = this.viewer;
    const drag = this.drag;
    const tm = viewer?.transportManager;
    if (!viewer || !drag || !tm) return;
    const collision = viewer.collisionManager ?? null;
    // Re-check the guard and the model right before the mutation (SOL #10).
    const guard = muManipulationGuard(viewer)
      ?? ((viewer.currentModelRoot ?? null) !== drag.model ? REASON_GONE : null);
    if (guard || !drag.valid) {
      cancelUserDrag(tm, drag.session, collision);
      if (guard) this.showHint(e, guard);
    } else {
      const r = commitUserDrag(tm, drag.session, drag.point, drag.surface, collision);
      if (!r.ok) this.showHint(e, r.reason);
      else this.hideHint();
    }
    this.endDrag();
  }

  /** Cancel a running gesture (Esc, pointercancel, capture loss, reset, mode or model change). */
  abortDrag(): void {
    this.press = null;
    const drag = this.drag;
    if (!drag) return;
    const tm = this.viewer?.transportManager;
    if (tm) cancelUserDrag(tm, drag.session, this.viewer?.collisionManager ?? null);
    this.endDrag();
  }

  private endDrag(): void {
    const drag = this.drag;
    const viewer = this.viewer;
    this.drag = null;
    if (!drag || !viewer) return;
    if (viewer.controls) viewer.controls.enabled = drag.prevControls;
    const canvas = viewer.renderer?.domElement;
    if (canvas) {
      canvas.style.cursor = '';
      try { canvas.releasePointerCapture(drag.pointerId); } catch { /* not captured */ }
    }
    if (this.outline) this.outline.removeFromParent();
    viewer.markRenderDirty?.();
  }

  // ── Preview outline + hint ────────────────────────────────────────────

  private ensureOutline(viewer: RVViewer): void {
    if (!this.outline) {
      const box = new BoxGeometry(1, 1, 1);
      const edges = new EdgesGeometry(box);
      box.dispose();
      this.outline = new LineSegments(edges, new LineBasicMaterial({ color: COLOR_OK, depthTest: false }));
      this.outline.renderOrder = 999;
      this.outline.userData._isGhostOverlay = true;
      this.outline.raycast = () => { /* never pickable */ };
    }
    if (this.outline.parent !== viewer.scene) viewer.scene.add(this.outline);
  }

  private updateOutline(mu: RVMovingUnit, ok: boolean): void {
    const o = this.outline;
    if (!o) return;
    const a = mu.aabb;
    o.position.copy(a.center);
    o.scale.set(Math.max(a.halfSize.x * 2, 1e-3), Math.max(a.halfSize.y * 2, 1e-3), Math.max(a.halfSize.z * 2, 1e-3));
    (o.material as LineBasicMaterial).color.setHex(ok ? COLOR_OK : COLOR_BAD);
    o.updateMatrixWorld(true);
  }

  private disposeOutline(): void {
    const o = this.outline;
    if (!o) return;
    o.removeFromParent();
    o.geometry.dispose();
    (o.material as LineBasicMaterial).dispose();
    this.outline = null;
  }

  /** The text of the hint currently shown (tests, diagnostics); null when hidden. */
  get hintText(): string | null {
    return this.hintEl && this.hintEl.style.display !== 'none' ? this.hintEl.textContent : null;
  }

  private showHintAtCanvas(text: string): void {
    const rect = this.viewer?.renderer?.domElement?.getBoundingClientRect();
    this.showHint({ clientX: (rect?.left ?? 0) + 24, clientY: (rect?.top ?? 0) + 24 }, text);
  }

  private showHint(e: { clientX: number; clientY: number }, text: string): void {
    if (typeof document === 'undefined') return;
    let el = this.hintEl;
    if (!el) {
      el = document.createElement('div');
      el.setAttribute('data-testid', 'mu-interaction-hint');
      Object.assign(el.style, {
        position: 'fixed', zIndex: '2000', pointerEvents: 'none', padding: '4px 8px',
        borderRadius: '4px', background: 'rgba(20,20,20,0.85)', color: '#fff',
        font: '12px/1.4 system-ui, sans-serif', maxWidth: '320px',
      } as Partial<CSSStyleDeclaration>);
      document.body.appendChild(el);
      this.hintEl = el;
    }
    el.textContent = text;
    el.style.left = `${e.clientX + 14}px`;
    el.style.top = `${e.clientY + 14}px`;
    el.style.display = 'block';
    if (this.hintTimer) clearTimeout(this.hintTimer);
    this.hintTimer = setTimeout(() => this.hideHint(), HINT_MS);
  }

  private hideHint(): void {
    if (this.hintTimer) { clearTimeout(this.hintTimer); this.hintTimer = null; }
    if (this.hintEl) this.hintEl.style.display = 'none';
  }
}
