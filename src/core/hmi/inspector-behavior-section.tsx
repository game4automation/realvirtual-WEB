// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * inspector-behavior-section — live read-out for a placed behavior LayoutObject
 * (Conveyor, Turntable, ChainTransfer, …), surfaced as an ephemeral READ-ONLY
 * "virtual component" that flows through the SAME `ComponentSection` pipeline as
 * a real Drive/LayoutObject section (same header, collapse, color, row optics).
 *
 * The virtual component carries two field groups as read-only rows:
 *   • STATES   — Running / Occupied / Part Count from the scoped `Flow.*` signals
 *   • HARDWARE — Drive live speed/direction + Sensor clear/occupied
 *
 * Signals are read by the dot-symbol the behavior publishes (`${rootName}.Flow.*`).
 * The data is collected fresh on each inspector render; the section re-renders on
 * the inspector's existing `useSignalTick` cadence — no extra pump.
 */

import type { Object3D } from 'three';
import { isPlacedLibraryAsset } from './layout-root-utils';
import { runtimeRow, type RuntimeRowSpec } from './rv-component-section';
import { LIVE, OCCUPIED } from './shared-sx';

/** Accent color for "hot" (active / occupied) read-only values. */
const LIVE_STATE_COLOR = LIVE;
/** Accent color for an occupied sensor (amber, matches snap occupied). */
const OCCUPIED_COLOR = OCCUPIED;

// ─── Minimal viewer-shape contracts (tested without a real viewer) ──────
export interface BehaviorViewerSnapshot {
  drives: ReadonlyArray<{ name: string; node: Object3D }>;
  transportManager: { sensors: ReadonlyArray<{ node: Object3D }> } | null;
  signalStore: { getAll(): ReadonlyMap<string, boolean | number> } | null;
  getPlugin?<T>(id: string): T | undefined;
}

export interface BehaviorDriveInfo {
  name: string;
  /** Live speed in mm/s or deg/s (0 when stopped or unknown). */
  speed: number;
  direction: 'forward' | 'backward' | 'idle';
}

export interface BehaviorSensorInfo {
  name: string;
  occupied: boolean;
}

export interface BehaviorRowData {
  /** Scoped `Flow.*` state signals → { Running, Occupied, PartCount }. */
  running: boolean | undefined;
  occupied: boolean | undefined;
  partCount: number | undefined;
  drives: BehaviorDriveInfo[];
  sensors: BehaviorSensorInfo[];
}

// ─── Pure data collection (testable) ────────────────────────────────────

function ancestorOrSelfIs(node: Object3D | null, target: Object3D): boolean {
  let cur: Object3D | null = node;
  while (cur) {
    if (cur === target) return true;
    cur = cur.parent;
  }
  return false;
}

export function collectBehaviorData(viewer: BehaviorViewerSnapshot, root: Object3D): BehaviorRowData {
  const out: BehaviorRowData = {
    running: undefined, occupied: undefined, partCount: undefined,
    drives: [], sensors: [],
  };

  // STATES — read the scoped `Flow.*` dot-symbols this behavior publishes.
  const signals = viewer.signalStore?.getAll();
  if (signals) {
    const running = signals.get(`${root.name}.Flow.Running`);
    const occupied = signals.get(`${root.name}.Flow.Occupied`);
    const partCount = signals.get(`${root.name}.Flow.PartCount`);
    if (typeof running === 'boolean') out.running = running;
    if (typeof occupied === 'boolean') out.occupied = occupied;
    if (typeof partCount === 'number') out.partCount = partCount;
  }

  // HARDWARE — live drives in the subtree (current speed + direction).
  for (const d of viewer.drives) {
    if (!ancestorOrSelfIs(d.node, root)) continue;
    const live = d as { name: string; jogForward?: boolean; jogBackward?: boolean; currentSpeed?: number };
    out.drives.push({
      name: live.name,
      speed: live.currentSpeed ?? 0,
      direction: live.jogForward ? 'forward' : live.jogBackward ? 'backward' : 'idle',
    });
  }

  // HARDWARE — sensors in the subtree (clear / occupied).
  for (const s of viewer.transportManager?.sensors ?? []) {
    if (!ancestorOrSelfIs(s.node, root)) continue;
    const occ = (s as { occupied?: boolean }).occupied === true;
    out.sensors.push({ name: s.node.name || '<sensor>', occupied: occ });
  }

  return out;
}

// ─── Display-name derivation ────────────────────────────────────────────

/**
 * Human-readable header for a behavior marker type.
 * Strips a trailing `Behavior` suffix and space-splits camelCase words, so
 * `ConveyorBehavior` → "Conveyor", `ChainTransferBehavior` → "Chain Transfer".
 */
export function behaviorDisplayName(markerType: string): string {
  const stripped = markerType.replace(/Behavior$/, '');
  const spaced = stripped.replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim();
  return (spaced || stripped || markerType).toUpperCase();
}

// ─── Virtual-component builder ──────────────────────────────────────────

/** A "virtual component" injected into the inspector section list at render
 *  time — same `{ type, data }` shape a real component carries, but rendered in
 *  the read-only-live ComponentSection mode. `data` holds pre-formatted rows. */
export interface VirtualComponent {
  type: string;
  data: Record<string, unknown>;
}

/**
 * Build the read-only-live virtual component for a placed behavior LayoutObject,
 * or null when the root is not a placed library asset / carries no live data.
 * `markerType` is the stamped marker (e.g. `ConveyorBehavior`) and supplies the
 * header name; `data` is collected fresh from the viewer snapshot.
 */
export function buildBehaviorVirtualComponent(
  viewer: BehaviorViewerSnapshot,
  root: Object3D,
  markerType: string,
): VirtualComponent | null {
  if (!isPlacedLibraryAsset(root)) return null;

  const d = collectBehaviorData(viewer, root);
  const hasStates = d.running !== undefined || d.occupied !== undefined || d.partCount !== undefined;
  const hasHardware = d.drives.length > 0 || d.sensors.length > 0;
  if (!hasStates && !hasHardware) return null;

  const fields: Record<string, RuntimeRowSpec> = {};

  // STATES
  if (d.running !== undefined) {
    fields['Running'] = runtimeRow(d.running ? 'true' : 'false', { color: d.running ? LIVE_STATE_COLOR : undefined });
  }
  if (d.occupied !== undefined) {
    fields['Occupied'] = runtimeRow(d.occupied ? 'true' : 'false', { color: d.occupied ? LIVE_STATE_COLOR : undefined });
  }
  if (d.partCount !== undefined) {
    fields['Part Count'] = runtimeRow(String(d.partCount));
  }

  // HARDWARE — drives (direction arrow + live speed)
  for (const drv of d.drives) {
    const arrow = drv.direction === 'forward' ? '►' : drv.direction === 'backward' ? '◄' : '·';
    fields[drv.name] = runtimeRow(`${arrow}  ${drv.speed.toFixed(0)} mm/s`, {
      color: drv.direction !== 'idle' ? LIVE_STATE_COLOR : undefined,
    });
  }

  // HARDWARE — sensors (clear / occupied)
  for (const s of d.sensors) {
    fields[s.name] = runtimeRow(s.occupied ? 'Occupied' : 'Clear', { color: s.occupied ? OCCUPIED_COLOR : undefined });
  }

  return { type: behaviorDisplayName(markerType), data: fields };
}
