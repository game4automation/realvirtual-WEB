// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * align-state.ts — the small store behind the planner Align tool (plan-779).
 *
 * Statically imported by the toolbar button and the panel host, so it stays
 * tiny: no three.js runtime, no planner import, no pick/overlay/panel import.
 * The heavy parts (`align-pick`, `align-overlay`, `align-action`, `AlignPanel`)
 * load on the first open and register themselves through the hooks below.
 */

import type { Mesh, Object3D, Vector3 } from 'three';

export type AlignSlotId = 'A' | 'B';

export interface AlignSlot {
  /** Hit mesh — the frame `cornerLocal` lives in. */
  mesh: Mesh;
  /** Exact vertex value from the mesh's position attribute (mesh-local). */
  cornerLocal: Vector3;
  /** Display name. */
  label: string;
  /** `recordRootOf(mesh)` at pick time — compared BY REFERENCE for liveness. */
  root: Object3D | null;
  /** Slot A only: the outermost record's placement id. */
  placementId?: string;
}

export interface AlignAxesState { x: boolean; y: boolean; z: boolean }
export interface AlignOffsetM { x: number; y: number; z: number }

export interface AlignSnapshot {
  open: boolean;
  armed: AlignSlotId | null;
  a: AlignSlot | null;
  b: AlignSlot | null;
  axes: AlignAxesState;
  offsetM: AlignOffsetM;
  /** Bumped whenever something outside the store may have changed liveness/preview. */
  revision: number;
}

/** Liveness check injected by the pick module (needs viewer + planner). */
export type AlignLiveness = (slot: AlignSlot) => boolean;

const DEFAULT_AXES: AlignAxesState = { x: true, y: false, z: true };
const DEFAULT_OFFSET: AlignOffsetM = { x: 0, y: 0, z: 0 };

let _snap: AlignSnapshot = {
  open: false,
  armed: null,
  a: null,
  b: null,
  axes: { ...DEFAULT_AXES },
  offsetM: { ...DEFAULT_OFFSET },
  revision: 0,
};
const _listeners = new Set<() => void>();
let _liveness: AlignLiveness | null = null;
let _onOpen: (() => void) | null = null;
let _onClose: (() => void) | null = null;

function emit(next: Partial<AlignSnapshot>): void {
  _snap = { ..._snap, ...next };
  for (const l of _listeners) l();
}

function finite(v: number): number {
  return Number.isFinite(v) ? v : 0;
}

export function subscribeAlign(cb: () => void): () => void {
  _listeners.add(cb);
  return () => { _listeners.delete(cb); };
}

export function getAlignSnapshot(): AlignSnapshot {
  return _snap;
}

/** Hooks of the lazily loaded runtime. `onOpen` runs after the store opened. */
export function setAlignHooks(hooks: { onOpen?: (() => void) | null; onClose?: (() => void) | null }): void {
  if (hooks.onOpen !== undefined) _onOpen = hooks.onOpen;
  if (hooks.onClose !== undefined) _onClose = hooks.onClose;
}

export function setAlignLiveness(cb: AlignLiveness | null): void {
  _liveness = cb;
}

/** True when the slot's object still exists, is visible and is the same record. */
export function isSlotAlive(slot: AlignSlot | null): boolean {
  if (!slot) return false;
  return _liveness ? _liveness(slot) : true;
}

export function alignOpen(): void {
  if (_snap.open) return;
  emit({ open: true, armed: 'A', a: null, b: null });
  _onOpen?.();
}

/** Idempotent: a closed tool stays closed and runs no hook. */
export function alignClose(): void {
  if (!_snap.open) return;
  emit({ open: false, armed: null, a: null, b: null });
  _onClose?.();
}

export function alignToggle(): void {
  if (_snap.open) alignClose(); else alignOpen();
}

/** Arm a slot for (re-)picking; `null` disarms. */
export function armAlignSlot(slot: AlignSlotId | null): void {
  if (!_snap.open) return;
  emit({ armed: slot });
}

/**
 * Fill a slot. Arms the next empty slot (or nothing). Setting A with a new
 * root drops a B slot that now lies inside A.
 */
export function setAlignSlot(id: AlignSlotId, slot: AlignSlot, isInside?: (node: Object3D, root: Object3D) => boolean): void {
  if (!_snap.open) return;
  if (id === 'A') {
    let b = _snap.b;
    if (b && slot.root && (b.root === slot.root || (isInside && isInside(b.mesh, slot.root)))) b = null;
    emit({ a: slot, b, armed: b ? null : 'B' });
  } else {
    emit({ b: slot, armed: _snap.a ? null : 'A' });
  }
}

export function setAlignAxes(axes: Partial<AlignAxesState>): void {
  emit({ axes: { ..._snap.axes, ...axes } });
}

export function setAlignOffsetM(offset: Partial<AlignOffsetM>): void {
  const o = { ..._snap.offsetM, ...offset };
  emit({ offsetM: { x: finite(o.x), y: finite(o.y), z: finite(o.z) } });
}

/** Signal an outside change (move, undo, removal) so subscribers re-evaluate. */
export function bumpAlignRevision(): void {
  emit({ revision: _snap.revision + 1 });
}

/** Test helper: back to the initial state without running hooks. */
export function _resetAlignStateForTests(): void {
  _snap = {
    open: false, armed: null, a: null, b: null,
    axes: { ...DEFAULT_AXES }, offsetM: { ...DEFAULT_OFFSET }, revision: 0,
  };
  _liveness = null;
  _onOpen = null;
  _onClose = null;
  _listeners.clear();
}
