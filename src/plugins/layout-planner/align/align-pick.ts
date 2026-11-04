// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * align-pick.ts — runtime of the planner Align tool (plan-779), loaded on the
 * first open. Owns the pointer while a slot is armed, the hover candidate,
 * the slot rules, slot liveness and the preview overlay.
 *
 * Click capture: the LEFT mouse button does not navigate in this viewer
 * (rv-navigation-controller: right = orbit, middle = pan), so a window-capture
 * listener can swallow left-button pointerdown/up on the canvas without
 * touching the camera — and every canvas listener of the planner (floor gizmo,
 * direct drag, marquee, path handles, click-select) is shielded at once. Touch
 * passes through untouched. `dblclick` right after a pick is swallowed too,
 * because the browser fires it despite the stopped pointer events and the
 * viewer would otherwise focus the camera on the object.
 */

import { Vector3, type Mesh, type Object3D } from 'three';
import { recordRootOf } from '../../../core/engine/rv-placement-instancer';
import type { RVViewer } from '../../../core/rv-viewer';
import { isLockedLayoutInstance } from '../layout-predicates';
import { pickNearestCorner } from './align-math';
import { createAlignOverlay, type AlignOverlay } from './align-overlay';
import { evaluateAlign, forceWorldMatrix, plannerOf } from './align-action';
import {
  alignClose,
  armAlignSlot,
  bumpAlignRevision,
  getAlignSnapshot,
  setAlignHooks,
  setAlignLiveness,
  setAlignSlot,
  subscribeAlign,
  type AlignSlot,
  type AlignSlotId,
} from './align-state';

/** Squared pointer travel (px²) above which a press is a drag, not a click. */
const DRAG_THRESHOLD_SQ = 16;
/** A dblclick this soon after a handled pick is swallowed. */
const DBLCLICK_GUARD_MS = 600;

interface Candidate {
  mesh: Mesh;
  vertexIndex: number;
  world: Vector3;
  root: Object3D | null;
}

const _tri: [Vector3, Vector3, Vector3] = [new Vector3(), new Vector3(), new Vector3()];
const _candidateWorld = new Vector3();

let _viewer: RVViewer | null = null;
let _stop: (() => void) | null = null;

function isAttachedTo(node: Object3D, root: Object3D): boolean {
  for (let o: Object3D | null = node; o; o = o.parent) if (o === root) return true;
  return false;
}

function isEffectivelyVisible(node: Object3D): boolean {
  for (let o: Object3D | null = node; o; o = o.parent) if (!o.visible) return false;
  return true;
}

function isInside(node: Object3D, root: Object3D): boolean {
  return isAttachedTo(node, root);
}

function displayName(node: Object3D | null): string {
  for (let o: Object3D | null = node; o; o = o.parent) {
    if (o.name && !o.name.startsWith('_')) return o.name;
  }
  return 'Geometry';
}

/** The corner under the cursor that the armed slot would accept, or null. */
function candidateAt(viewer: RVViewer, clientX: number, clientY: number, slot: AlignSlotId): Candidate | null {
  const rm = viewer.raycastManager;
  if (!rm) return null;
  const hit = rm.pickDetailed({ clientX, clientY });
  if (!hit) return null;
  const pos = hit.mesh.geometry.getAttribute('position');
  if (!pos) return null;
  forceWorldMatrix(hit.mesh); // stale right after a move otherwise (see align-action)
  const idx = [hit.face.a, hit.face.b, hit.face.c];
  for (let k = 0; k < 3; k++) _tri[k].fromBufferAttribute(pos, idx[k]).applyMatrix4(hit.mesh.matrixWorld);
  const rect = viewer.renderer.domElement.getBoundingClientRect();
  const k = pickNearestCorner(_tri, { x: clientX, y: clientY }, viewer.camera, rect);
  if (k === -1) return null;

  const root = recordRootOf(hit.mesh);
  if (slot === 'A') {
    if (!root || isLockedLayoutInstance(root)) return null;
  } else {
    const a = getAlignSnapshot().a;
    if (a?.root && (root === a.root || isInside(hit.mesh, a.root))) return null;
  }
  return { mesh: hit.mesh, vertexIndex: idx[k], world: _candidateWorld.copy(_tri[k]), root };
}

function toSlot(viewer: RVViewer, c: Candidate, slot: AlignSlotId): AlignSlot | null {
  const pos = c.mesh.geometry.getAttribute('position');
  if (!pos) return null;
  const cornerLocal = new Vector3().fromBufferAttribute(pos, c.vertexIndex);
  if (slot === 'A') {
    const id = c.root ? plannerOf(viewer)?.findPlacedIdByRoot(c.root) : null;
    if (!id) return null;
    return { mesh: c.mesh, cornerLocal, label: displayName(c.root), root: c.root, placementId: id };
  }
  return { mesh: c.mesh, cornerLocal, label: displayName(c.root ?? c.mesh), root: c.root };
}

function liveness(viewer: RVViewer): (slot: AlignSlot) => boolean {
  return (slot) => {
    if (!isAttachedTo(slot.mesh, viewer.scene) || !isEffectivelyVisible(slot.mesh)) return false;
    if (recordRootOf(slot.mesh) !== slot.root) return false;
    if (slot.placementId !== undefined) {
      if (plannerOf(viewer)?.getPlacedRootById(slot.placementId) !== slot.root) return false;
    }
    return true;
  };
}

/** Start the runtime for an open tool. Idempotent. */
function start(viewer: RVViewer): void {
  if (_stop) return;
  const canvas = viewer.renderer.domElement;
  const overlay: AlignOverlay = createAlignOverlay(viewer);
  const prevCursor = canvas.style.cursor;
  let downPos: { x: number; y: number } | null = null;
  let lastHandledUp = -Infinity;
  let hoverX = 0;
  let hoverY = 0;
  let rafId = 0;

  const armed = (): AlignSlotId | null => getAlignSnapshot().armed;

  const refreshPreview = (): void => {
    const ev = evaluateAlign(viewer);
    overlay.setPreview(ev.cornerA, ev.cornerB, ev.target);
    canvas.style.cursor = armed() ? 'crosshair' : prevCursor;
    if (!armed()) overlay.setHover(null);
  };

  const hoverTick = (): void => {
    rafId = 0;
    const slot = armed();
    if (!slot) { overlay.setHover(null); return; }
    try {
      const c = candidateAt(viewer, hoverX, hoverY, slot);
      overlay.setHover(c ? c.world : null);
    } catch (e) {
      overlay.setHover(null);
      console.warn('[align] hover pick failed:', e);
    }
  };

  const onPointerMove = (e: PointerEvent): void => {
    if (!armed() || e.pointerType !== 'mouse') return;
    hoverX = e.clientX;
    hoverY = e.clientY;
    if (!rafId) rafId = requestAnimationFrame(hoverTick);
  };

  const onPointerDown = (e: PointerEvent): void => {
    if (!armed() || e.pointerType !== 'mouse' || e.button !== 0 || e.target !== canvas) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    downPos = { x: e.clientX, y: e.clientY };
  };

  const onPointerUp = (e: PointerEvent): void => {
    if (!downPos || e.button !== 0) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const dx = e.clientX - downPos.x;
    const dy = e.clientY - downPos.y;
    downPos = null;
    lastHandledUp = performance.now();
    if (dx * dx + dy * dy > DRAG_THRESHOLD_SQ) return;
    const slot = armed();
    if (!slot) return;
    try {
      const c = candidateAt(viewer, e.clientX, e.clientY, slot);
      const s = c ? toSlot(viewer, c, slot) : null;
      if (s) setAlignSlot(slot, s, isInside);
    } catch (err) {
      console.warn('[align] pick failed:', err);
    }
  };

  const onPointerCancel = (): void => { downPos = null; };

  const onDblClick = (e: MouseEvent): void => {
    if (e.target !== canvas) return;
    if (armed() || performance.now() - lastHandledUp < DBLCLICK_GUARD_MS) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || !armed()) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    armAlignSlot(null);
  };

  window.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('pointerup', onPointerUp, true);
  window.addEventListener('dblclick', onDblClick, true);
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('blur', onPointerCancel);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointercancel', onPointerCancel);

  setAlignLiveness(liveness(viewer));
  const offStore = subscribeAlign(refreshPreview);
  const offMove = viewer.on('layout-transform-update', () => bumpAlignRevision());
  const plannerStore = (plannerOf(viewer) as { store?: { subscribe?: (l: () => void) => () => void } } | null)?.store;
  const offPlanner = plannerStore?.subscribe?.(() => bumpAlignRevision()) ?? (() => {});
  refreshPreview();

  _stop = () => {
    _stop = null;
    window.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('pointerup', onPointerUp, true);
    window.removeEventListener('dblclick', onDblClick, true);
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('blur', onPointerCancel);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointercancel', onPointerCancel);
    if (rafId) cancelAnimationFrame(rafId);
    offStore();
    offMove();
    offPlanner();
    setAlignLiveness(null);
    canvas.style.cursor = prevCursor;
    overlay.dispose();
  };
}

function stop(): void {
  _stop?.();
}

/** Wire the store hooks to this runtime (idempotent; call before `alignOpen`). */
export function ensureAlignRuntime(viewer: RVViewer): void {
  _viewer = viewer;
  setAlignHooks({
    onOpen: () => { if (_viewer) start(_viewer); },
    onClose: stop,
  });
}

/** Test seam: is the runtime currently started? */
export function isAlignRuntimeActive(): boolean {
  return _stop !== null;
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => { alignClose(); stop(); });
}
