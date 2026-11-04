// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { Vector3, type Object3D } from 'three';
import { FleetAuthoringSource, type FleetLoadOffset } from '../../core/fleet/scene/fleet-authoring-source';
import type { FleetSceneModel } from '../../core/fleet/scene/fleet-scene-model';
import type { SnapPoint, SnapPointRegistry } from '../../core/engine/rv-snap-point-registry';
import type { StationDockCheck } from '../../core/engine/rv-path-stub-dock';
import { placementSnapOutwardWorld } from '../snap-point/path-snap-source';
import type { SnapshotViewer } from './path-network-scene';

type DockViewer = SnapshotViewer & { getPlugin?: (id: string) => unknown };
export type StationDockResolution = { reason: string; detail: string } | {
  station: Object3D;
  transferStation: Record<string, unknown>;
  componentType: string;
  ports: SnapPoint[];
  port: SnapPoint;
  seatPosition: [number, number, number];
  seat: [number, number];
  portDir: [number, number];
  loadOffset: FleetLoadOffset;
};
type StationPortResolution = { reason: string; detail: string }
  | Omit<Extract<StationDockResolution, { station: Object3D }>, 'loadOffset'>;
const lookups = new WeakMap<FleetSceneModel, Map<Object3D, SnapPoint[]>>();

export function inSubtree(node: Object3D, root: Object3D): boolean {
  for (let n: Object3D | null = node; n; n = n.parent) if (n === root) return true;
  return false;
}

/** Port membership is cached only for the lifetime of the authoring model. */
function portsOf(model: FleetSceneModel, station: Object3D, registry: SnapPointRegistry): SnapPoint[] {
  let cache = lookups.get(model);
  if (!cache) { cache = new Map(); lookups.set(model, cache); }
  let ports = cache.get(station);
  if (!ports) {
    ports = registry.getAll().filter(p => p.typeId === 'path' && !p.id.startsWith('path-snap:') && inSubtree(p.object3D, station));
    cache.set(station, ports);
  }
  // Orientation can change without a model invalidation.
  return ports.filter(p => {
    const normal = placementSnapOutwardWorld(p);
    return Math.hypot(normal.x, normal.z) >= 1e-6;
  });
}

/** The same eligible ports as the dock command, including ambiguous choices. */
export function listStationDockPorts(viewer: DockViewer, station: Object3D): SnapPoint[] {
  const registry = (viewer.getPlugin?.('snap-point') as { getRegistry?: () => SnapPointRegistry | null } | undefined)?.getRegistry?.();
  return registry ? portsOf(FleetAuthoringSource.of(viewer).model(), station, registry) : [];
}

function resolveStationPort(viewer: DockViewer, model: FleetSceneModel, stationNode: Object3D, opts: { port?: string }): StationPortResolution {
  const rv = stationNode.userData.realvirtual as Record<string, Record<string, unknown>> | undefined;
  const componentType = Object.keys(rv ?? {}).find(k => /^TransferStation(?:_\d+)?$/.test(k) && !!rv![k]);
  const refuse = (reason: string, detail: string) => ({ reason, detail } as const);
  if (!componentType) return refuse('no-transfer-station', 'The node has no TransferStation.');
  const transferStation = rv![componentType];
  const registry = (viewer.getPlugin?.('snap-point') as { getRegistry?: () => SnapPointRegistry | null } | undefined)?.getRegistry?.();
  if (!registry) return refuse('dock-snaps-unavailable', 'The snap registry is unavailable.');
  const ports = portsOf(model, stationNode, registry);
  const names = ports.map(p => p.object3D.name);
  if (new Set(names).size !== names.length) return refuse('dock-port-ambiguous', `Duplicate path port names: ${names.join(', ')}.`);
  const chosen = String(transferStation.DockPort ?? '').trim() || opts.port;
  const port = chosen ? ports.find(p => p.object3D.name === chosen) : ports.length === 1 ? ports[0] : undefined;
  if (chosen && !port) return refuse('dock-port-unknown', `No path port named ${chosen}.`);
  if (!ports.length) return refuse('dock-port-missing', 'The station has no horizontal path port.');
  if (!port) return refuse('dock-port-ambiguous', `Choose a path port: ${names.join(', ')}.`);
  const station = model.stations.find(s => s.node === stationNode);
  const seatNode = station?.seat ?? port.object3D;
  const position = seatNode.getWorldPosition(new Vector3());
  const normal = placementSnapOutwardWorld(port);
  const length = Math.hypot(normal.x, normal.z);
  return { station: stationNode, transferStation, componentType, ports, port,
    seatPosition: [position.x, position.y, position.z] as [number, number, number],
    seat: [position.x, position.z] as [number, number],
    portDir: [normal.x / length, normal.z / length] as [number, number] };
}

export function resolveStationDock(viewer: DockViewer, stationNode: Object3D, opts: { port?: string } = {}): StationDockResolution {
  const source = FleetAuthoringSource.of(viewer);
  const port = resolveStationPort(viewer, source.model(), stationNode, opts);
  return 'reason' in port ? port : { ...port, loadOffset: source.loadOffset() };
}

/** Called at the 500 ms authoring poll, never on every render frame. */
export function dockSignature(viewer: DockViewer): string {
  const parts: string[] = [];
  const model = FleetAuthoringSource.of(viewer).model();
  for (const station of model.stations) {
    const dock = resolveStationPort(viewer, model, station.node, {});
    if ('reason' in dock) continue;
    const p = dock.port.object3D.getWorldPosition(new Vector3());
    parts.push(`${station.id}:${dock.port.id}:${[p.x, p.y, p.z, ...dock.seatPosition].map(v => Math.round(v * 1000)).join(',')}:${Math.round(Math.atan2(dock.portDir[1], dock.portDir[0]) * 1800 / Math.PI)}`);
  }
  return parts.join('|');
}

export function collectStationDockChecks(viewer: DockViewer): StationDockCheck[] {
  const checks: StationDockCheck[] = [];
  for (const station of FleetAuthoringSource.of(viewer).model().stations) {
    const dock = resolveStationDock(viewer, station.node);
    if ('reason' in dock) continue;
    const pathId = String(dock.transferStation.PathId ?? '').trim();
    if (!pathId) continue;
    checks.push({ stationId: station.id, stubPathId: pathId,
      seat: dock.seat, portDir: dock.portDir, loadOffsetM: dock.loadOffset.mm / 1000 });
  }
  return checks;
}
