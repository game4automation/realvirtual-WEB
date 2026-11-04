// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** Bind the continuous fleet adapters to the PalletYard scene and geometry. */

import { Quaternion, Vector3, type Object3D } from 'three';
import type { RVTransportManager } from '@rv/core/engine/rv-transport-manager';
import type { RVTransportSurface } from '@rv/core/engine/rv-transport-surface';
import type { RVSink } from '@rv/core/engine/rv-sink';
import { instanceScope } from '@rv/core/engine/rv-instance-scope';
import { getDefaultPathNetwork } from '@rv/core/engine/rv-path-network';
import { isUnderScope as isUnder } from '@rv/core/engine/rv-reference-resolver';
import { findByNameInSubtree as findNode, findPathInSubtree } from '@rv/core/engine/rv-traverse-utils';
import type { ContinuousLiftDrive } from '@rv/core/fleet/continuous/lift';
import { ContinuousHandover, type OutputRec, type InputRec, type VehicleRec, type SlotRec } from '@rv/core/fleet/continuous/handover';
import {
  FORK_ANCHOR_NODE_PATH, LIFT_NODE_PATH, PALLET_SEAT_M, conveyorNodeOf, readStationTag, slotNodeOf,
  type PalletYardConfig, type PalletYardStation, type StationTag,
} from './layout';
import { activeYardVehicles, boundYardVehicles, NO_ACTIVE_AGV_PROBLEM_CODE } from './active-vehicles';
import { DEFAULT_YARD } from './yard-compose';

/** What a continuous bind needs from the viewer. */
export interface ContinuousBindInput {
  root: Object3D;
  transportManager: RVTransportManager | null;
  drives: readonly { node: Object3D }[];
  /** The viewer's sim time (s) — the clock is advanced to it every tick. */
  simTime: () => number;
  /** Where `<conveyor>.Flow.Run` is written (the viewer's signal store). */
  signals: { set(name: string, value: boolean): void } | null;
  cfg?: PalletYardConfig;
  /** Where a conveyor's stich Path-Id resolves (default: the shared PathNetwork). */
  paths?: { get(id: string): unknown };
}

/**
 * Result of {@link bindContinuousYard}. `pending` = a needed placement is still an
 * empty reference node (it materialises later) — the caller retries silently.
 */
export type ContinuousBindResult =
  | { ok: true; backend: ContinuousHandover }
  | { ok: false; missing: string[]; pending: boolean };

const surfacesUnder = (tm: RVTransportManager, n: Object3D): RVTransportSurface[] => tm.surfaces.filter((s) => isUnder(s.node, n));

/** The node of station `s`: the conveyor reference TAGGED with the station (placements), else by name. */
function stationNode(root: Object3D, s: PalletYardStation): { node: Object3D | null; tag: StationTag | null } {
  let hit: Object3D | null = null;
  root.traverse((n) => { if (!hit && readStationTag(n)?.Station === s.id) hit = n; });
  if (hit) return { node: hit, tag: readStationTag(hit) };
  return { node: findNode(root, s.conveyor ?? conveyorNodeOf(s.id)), tag: null };
}

/** An empty reference node: a placement that has not materialised yet. */
const isEmptyPlacement = (n: Object3D | null): boolean => !!n && n.children.length === 0
  && !!(n.userData?.realvirtual as Record<string, unknown> | undefined)?.AssetReference;

/**
 * Bind the PalletYard continuous backend to the loaded scene: the four station
 * conveyors with their transport surfaces (outputs also their end sensor and the
 * `Pallet_<output>` source), the three vehicles (ForkAnchor + Lift drive) and the
 * six floor slots must be there — otherwise the missing names come back.
 */
export function bindContinuousYard(input: ContinuousBindInput): ContinuousBindResult {
  const cfg = input.cfg ?? DEFAULT_YARD.config;
  const { root } = input;
  const vehicleIds = activeYardVehicles(root, cfg.vehicles);
  if (!vehicleIds.length) return { ok: false, missing: [NO_ACTIVE_AGV_PROBLEM_CODE], pending: false };
  const tm = input.transportManager;
  if (!tm) return { ok: false, missing: ['transport manager'], pending: true };
  const paths = input.paths ?? getDefaultPathNetwork();
  const missing: string[] = [];
  let pending = false;
  const need = <T>(v: T | null | undefined, what: string): T | null => { if (!v) missing.push(what); return v ?? null; };
  const outputs: OutputRec[] = [];
  const inputs: InputRec[] = [];
  for (const s of cfg.stations) {
    if (s.kind !== 'pick' && s.kind !== 'drop') continue;
    const { node, tag } = stationNode(root, s);
    const conv = need(node, `${conveyorNodeOf(s.id)} (Conveyor)`);
    if (!conv) continue;
    if (isEmptyPlacement(conv)) { pending = true; missing.push(`${conveyorNodeOf(s.id)} (placement not materialised)`); continue; }
    if (tag) {
      if (tag.StichPathId !== s.pathId) missing.push(`${conveyorNodeOf(s.id)}: stich ${tag.StichPathId} != configured ${s.pathId}`);
      else if (!paths.get(tag.StichPathId)) missing.push(`${conveyorNodeOf(s.id)}: stich ${tag.StichPathId} (Path)`);
    }
    const surfaces = surfacesUnder(tm, conv);
    if (surfaces.length === 0) { missing.push(`${conv.name} (TransportSurface)`); continue; }
    if (s.kind === 'pick') {
      const sensor = need(tm.sensors.find((x) => isUnder(x.node, conv)), `${conv.name}/Sensor (Sensor)`);
      const sourceNode = findNode(root, `Pallet_${s.id}`);
      if (isEmptyPlacement(sourceNode)) { pending = true; missing.push(`Pallet_${s.id} (placement not materialised)`); continue; }
      const source = need(sourceNode ? tm.sources.find((x) => isUnder(x.node, sourceNode)) : undefined, `Pallet_${s.id} (Source)`);
      if (!sensor || !source) continue;
      outputs.push({
        id: s.id, node: conv, surfaces, sensor, source, onBelt: null, arrived: false,
        edge: 'idle', createdAtEdge: 0, waiterVehicle: null, waiterCb: null,
      });
    } else {
      const scope = instanceScope(conv);
      inputs.push({ id: s.id, node: conv, surfaces, runSignal: scope ? `${scope}.Flow.Run` : 'Flow.Run', wasFree: true, retryArmed: false });
    }
  }
  const vehicles: VehicleRec[] = [];
  const lifts = new Map<string, ContinuousLiftDrive>();
  for (const id of vehicleIds) {
    const vroot = need(findNode(root, id), id);
    if (!vroot) continue;
    if (isEmptyPlacement(vroot)) { pending = true; missing.push(`${id} (placement not materialised)`); continue; }
    const anchor = need(findPathInSubtree(vroot, FORK_ANCHOR_NODE_PATH), `${id}/${FORK_ANCHOR_NODE_PATH}`);
    const liftNode = findPathInSubtree(vroot, LIFT_NODE_PATH);
    const lift = liftNode ? input.drives.find((d) => d.node === liftNode) ?? null : null;
    need(lift, `${id}/${LIFT_NODE_PATH} (Drive)`);
    if (!anchor || !lift) continue;
    lifts.set(id, lift as unknown as ContinuousLiftDrive);
    vehicles.push({
      id, root: vroot, anchor, carried: null, gliding: false, seatTarget: new Vector3(), seatPos: new Vector3(), seatQuat: new Quaternion(),
    });
  }
  const slots: SlotRec[] = [];
  for (const s of cfg.stations) {
    if (s.kind !== 'buffer') continue;
    const name = s.slot ?? slotNodeOf(s.id);
    const n = need(findNode(root, name), name);
    if (n) slots.push({ id: s.id, node: n, mu: null });
  }
  const sinks: Array<{ input: string; sink: RVSink }> = [];
  for (const i of inputs) {
    const sinkNode = findNode(root, `Sink_${i.id}`);
    if (isEmptyPlacement(sinkNode)) { pending = true; missing.push(`Sink_${i.id} (placement not materialised)`); continue; }
    const sink = need(sinkNode ? tm.sinks.find((x) => isUnder(x.node, sinkNode)) : undefined, `Sink_${i.id} (Sink)`);
    if (sink) sinks.push({ input: i.id, sink });
  }
  if (missing.length > 0) return { ok: false, missing, pending };
  const backend = new ContinuousHandover(root, tm, input.simTime, input.signals, outputs, inputs, vehicles, lifts, slots, sinks, PALLET_SEAT_M);
  boundYardVehicles.set(backend, vehicleIds);
  return { ok: true, backend };
}

