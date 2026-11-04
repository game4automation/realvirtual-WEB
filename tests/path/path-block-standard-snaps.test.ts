// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-628 §9.9b (Phase 8.2/8.3) — path-block ends are STANDARD snaps:
 *  - every block kind reports exactly one free snap per free end (`typeId`
 *    `path`, the same registry entry shape as a GLB port); a connected end is
 *    `occupied` and carries no free snap — and is freed again when unlinked;
 *  - the marker renderer draws path-end snaps with the same marker style as a
 *    GLB-authored snap (G1/E34: "white" = the standard marker, not a colour);
 *  - hovering a path line reveals its free ends (pointer-owner resolver, G4);
 *  - a straight snaps TANGENTIALLY to a `path`-typed placement port — an
 *    emitting conveyor-like port (block starts there) and a consuming station
 *    port (block ends there): position <= 5 mm, heading <= 2°, from the port's
 *    exact world frame (rotated owner, not the cardinal axis code; G2/G5).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Object3D, Vector3 } from 'three';
import { RVPathComponent, type PathSegmentSpec } from '../../src/core/engine/rv-path';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { getDefaultZoneRegistry } from '../../src/core/engine/rv-zone-registry';
import { SnapPointRegistry } from '../../src/core/engine/rv-snap-point-registry';
import { scanAndRegisterSnaps } from '../../src/core/connect/snap-scanner';
import { computeProximityPairings, SNAP_PAIR_EPS_M } from '../../src/core/connect/snap-pairing';
import {
  PathSnapSource,
  pathSnapId,
  pathPlacementPorts,
  PATH_END_SNAP_TYPE_ID,
} from '../../src/plugins/snap-point/path-snap-source';
import { SnapMarkerRenderer } from '../../src/plugins/snap-point/snap-marker-renderer';
import { SnapPointController } from '../../src/plugins/snap-point/snap-point-controller';
import { placeBlock, placeJunction, type NetworkInput, type PathGraphEntry } from '../../src/core/engine/rv-path-network-ops';
import { foldEdit } from '../../src/plugins/path-network/path-network-scene';
import { ghostPlacement, placeArgsFor, type FreePort } from '../../src/plugins/path-network/path-network-ui-model';
import { specEnds, headingOf, type PathBlockSpec } from '../../src/core/engine/rv-path-blocks';
import { tangentAngleDeg } from '../../src/core/connect/path-link-tolerance';
import type { RVViewer } from '../../src/core/rv-viewer';

let registry: SnapPointRegistry;
let source: PathSnapSource;
const comps: RVPathComponent[] = [];

beforeEach(() => {
  getDefaultPathNetwork().clear();
  getDefaultZoneRegistry().clear();
  registry = new SnapPointRegistry();
  source = new PathSnapSource(registry);
});

afterEach(() => {
  for (const c of comps.splice(0)) c.dispose();
  source.dispose();
  getDefaultPathNetwork().clear();
});

/** Register every path of a snapshot as a live `RVPathComponent` (what the loader does). */
function mount(net: NetworkInput): void {
  for (const p of net.paths) {
    const n = new Object3D();
    n.name = p.nodeName || p.id;
    n.userData.realvirtual = { Path: { id: p.id, segments: JSON.parse(JSON.stringify(p.segments)), successors: [...p.successors] } };
    const c = new RVPathComponent(n);
    c.init({} as never);
    comps.push(c);
  }
  getDefaultPathNetwork().resolveGraph?.();
  source.syncAll();
}

/** Free ends of a snapshot: [position, flow] — END without successor, START without predecessor. */
function freeEnds(net: NetworkInput): { pathId: string; which: 'start' | 'end'; pos: number[] }[] {
  const preds = new Set<string>();
  for (const p of net.paths) for (const s of p.successors) preds.add(s);
  const out: { pathId: string; which: 'start' | 'end'; pos: number[] }[] = [];
  for (const p of net.paths) {
    if (p.closed) continue;
    const e = specEnds(p.segments as PathSegmentSpec[]);
    if (!e) continue;
    if (p.successors.length === 0) out.push({ pathId: p.id, which: 'end', pos: e.end.position });
    if (!preds.has(p.id)) out.push({ pathId: p.id, which: 'start', pos: e.start.position });
  }
  return out;
}

const freeSnapsNear = (pos: number[]): string[] => registry.getAll()
  .filter((s) => !s.occupied && s.object3D.getWorldPosition(new Vector3()).distanceTo(new Vector3(pos[0], pos[1], pos[2])) < 1e-6)
  .map((s) => s.id);

/** Every block kind as a small network: straight → curve chain, and the three junctions on a host. */
function networks(): Record<string, NetworkInput> {
  const out: Record<string, NetworkInput> = {};
  const n0: NetworkInput = { paths: [], blocks: [] };
  const s = placeBlock(n0, { kind: 'straight', lengthM: 4 }, { x: 0, z: 0, headingDeg: 0 });
  const n1 = foldEdit(n0, s.edit);
  out.straight = n1;
  const c = placeBlock(n1, { kind: 'curve', radiusM: 1.5, degrees: 90, side: 'right' }, { pathId: 'PN_S1', end: 'end' });
  out.curve = foldEdit(n1, c.edit);
  for (const kind of ['diverge', 'merge', 'stub'] as const) {
    const hostRes = placeBlock(n0, { kind: 'straight', lengthM: 12 }, { x: 0, z: 0, headingDeg: 0 });
    const host = foldEdit(n0, hostRes.edit);
    const j = placeJunction(host, { kind, side: 'left' }, { pathId: 'PN_S1', s: 6 });
    expect(j.ok, `${kind}: ${j.reason} ${j.detail}`).toBe(true);
    out[kind] = foldEdit(host, j.edit);
  }
  return out;
}

describe('plan-628 9.9b — path-block ends are standard snaps (8.2)', () => {
  it('every block kind: exactly one free standard snap per free end; connected ends are occupied', () => {
    for (const [kind, net] of Object.entries(networks())) {
      getDefaultPathNetwork().clear();
      for (const c of comps.splice(0)) c.dispose();
      registry.clear();
      source.clear();
      mount(net);
      const ends = freeEnds(net);
      expect(ends.length, `${kind} has free ends`).toBeGreaterThan(0);
      for (const e of ends) {
        const near = freeSnapsNear(e.pos);
        expect(near, `${kind} ${e.pathId}.${e.which}`).toEqual([pathSnapId(e.pathId, e.which)]);
        expect(registry.getById(near[0])!.typeId).toBe(PATH_END_SNAP_TYPE_ID);
      }
      // Every registered end that is NOT free is occupied (no free marker).
      const freeIds = new Set(ends.map((e) => pathSnapId(e.pathId, e.which)));
      for (const sp of registry.getAll()) {
        expect(sp.occupied, `${kind} ${sp.id}`).toBe(!freeIds.has(sp.id));
      }
    }
  });

  it('linking occupies both ends; removing the link frees them again (live re-derivation)', () => {
    const net = networks().curve;
    mount(net);
    expect(registry.getById(pathSnapId('PN_S1', 'end'))!.occupied).toBe(true);
    expect(registry.getById(pathSnapId('PN_C1', 'start'))!.occupied).toBe(true);
    // Unlink: rewrite PN_S1 without successors and re-apply (what a P6 move does).
    const s1 = comps.find((c) => c.node.name === 'PN_S1')!;
    (s1.node.userData.realvirtual as { Path: { successors: string[] } }).Path.successors = [];
    s1.reapplyConfig();
    expect(registry.getById(pathSnapId('PN_S1', 'end'))!.occupied).toBe(false);
    expect(registry.getById(pathSnapId('PN_C1', 'start'))!.occupied).toBe(false);
  });

  it('the marker renderer draws a path end exactly like a GLB snap (same marker style)', () => {
    mount(networks().straight);
    const owner = new Object3D();
    owner.name = 'Conveyor';
    const port = new Object3D();
    port.name = 'Snap-XP-path';
    port.position.set(1, 0, 0);
    owner.add(port);
    scanAndRegisterSnaps(owner, registry, owner);
    const created: { node: Object3D; opts: Record<string, unknown> }[] = [];
    const viewer = {
      gizmoManager: { create: (node: Object3D, opts: Record<string, unknown>) => { created.push({ node, opts }); return { setVisible: () => {}, dispose: () => {}, update: () => {} }; } },
      markRenderDirty: () => {},
    };
    const renderer = new SnapMarkerRenderer(viewer as unknown as RVViewer, registry);
    renderer.rebuild(registry.size);
    const glb = created.find((c) => c.node === port)!;
    const pathEnd = created.find((c) => c.node === registry.getById(pathSnapId('PN_S1', 'end'))!.object3D)!;
    expect(glb && pathEnd).toBeTruthy();
    const style = (o: Record<string, unknown>): Record<string, unknown> => {
      const { spriteTexture: _t, ...rest } = o;
      return rest;
    };
    expect(style(pathEnd.opts)).toEqual(style(glb.opts));
  });

  it('holders hang under the scene container (markers attach below them and must render); removal detaches them', () => {
    source.dispose();
    const container = new Object3D();
    source = new PathSnapSource(registry, { holderParent: container });
    mount(networks().curve);
    const holder = source.holderOf('PN_C1')!;
    expect(holder.parent).toBe(container);
    expect(holder.visible).toBe(true);
    expect(registry.getById(pathSnapId('PN_C1', 'end'))!.object3D.parent).toBe(holder);
    comps.find((c) => c.node.name === 'PN_C1')!.dispose();
    source.syncAll();
    expect(holder.parent).toBeNull();
  });

  it('hovering a path line reveals its free end snaps (pointer owner = the path holder)', () => {
    mount(networks().curve);
    const shown = new Set<string>();
    const markers = { setVisibility: (id: string, on: boolean) => { if (on) shown.add(id); else shown.delete(id); }, hideActive: () => {}, showActive: () => {} };
    const viewer = { renderer: null, camera: null, markRenderDirty: () => {} };
    const ctrl = new SnapPointController(viewer as unknown as RVViewer, registry, markers as never);
    const holder = source.holderOf('PN_C1')!;
    expect(holder).toBeTruthy();
    ctrl.testPointerOwners([holder]);
    // PN_C1: start is linked (occupied, no marker), end is free.
    expect([...ctrl.getRevealedSnapIds()]).toEqual([pathSnapId('PN_C1', 'end')]);
    expect(shown.has(pathSnapId('PN_C1', 'end'))).toBe(true);
    expect(shown.has(pathSnapId('PN_C1', 'start'))).toBe(false);
    ctrl.dispose();
  });
});

describe('plan-628 9.9b — tangential snap to path-typed placement ports (8.3)', () => {
  /** An owner rotated by `yawDeg` about Y at `at`, with one port child. */
  function placement(name: string, portName: string, local: [number, number, number], at: [number, number, number], yawDeg: number): Object3D {
    const owner = new Object3D();
    owner.name = name;
    owner.position.set(...at);
    owner.rotation.y = (yawDeg * Math.PI) / 180;
    const port = new Object3D();
    port.name = portName;
    port.position.set(...local);
    owner.add(port);
    owner.updateMatrixWorld(true);
    scanAndRegisterSnaps(owner, registry, owner);
    return port;
  }

  const STRAIGHT: PathBlockSpec = { kind: 'straight', lengthM: 3 };

  it('636 T1: facing station path ports retain the existing proximity pairing rules', () => {
    const a = placement('StationA', 'Snap-ZB-path', [0, 0, 0], [0, 0, 0], 0);
    const b = placement('StationB', 'Snap-ZB-path', [0, 0, 0], [0, 0, 2], 180);
    const pairs = () => computeProximityPairings(registry.getAll().map(p => {
      const at = p.object3D.getWorldPosition(new Vector3());
      return { id: p.id, typeId: p.typeId, flow: p.flow, owner: p.ownerRoot, x: at.x, y: at.y, z: at.z };
    }), SNAP_PAIR_EPS_M);
    const before = pairs();
    expect(before).toEqual([]); // Facing ports two metres apart are not mated.
    for (const port of [a, b]) port.parent!.userData.realvirtual = { TransferStation: { DockPort: '' } };
    expect(pathPlacementPorts(registry).map(p => p.snapId).sort()).toEqual([a.uuid, b.uuid].sort());
    expect(pairs()).toEqual(before);
    // T1 adds no station-specific pairing rule: coincident bidi ports still mate.
    b.parent!.position.set(0, 0, 0);
    b.parent!.updateMatrixWorld(true);
    expect(pairs()).toEqual([{ aId: a.uuid, bId: b.uuid }]);
  });

  function placeAt(port: FreePort): PathGraphEntry {
    const g = ghostPlacement(STRAIGHT, [port.position[0] + 0.1, port.position[1], port.position[2] + 0.1], 0, [port]);
    expect(g?.mode).toBe('port');
    const args = placeArgsFor(STRAIGHT, g!);
    expect(args.atPath, 'a placement port is placed by free pose, not as a path link').toBeUndefined();
    const r = placeBlock({ paths: [], blocks: [] }, STRAIGHT, {
      x: args.x as number, z: args.z as number, y: args.y as number, headingDeg: args.headingDeg as number,
    });
    expect(r.ok).toBe(true);
    return r.edit.add[0];
  }

  it('conveyor-like emitting port (Snap-XP-path, owner yawed 30°): the block STARTS there, tangent = outward', () => {
    const port = placement('Conveyor', 'Snap-XP-path', [0.5, 0, 0], [3, 0, 2], 30);
    const ports = pathPlacementPorts(registry);
    expect(ports).toHaveLength(1);
    expect(ports[0].end).toBe('end');
    const path = placeAt(ports[0] as FreePort);
    const e = specEnds(path.segments as PathSegmentSpec[])!;
    const portPos = port.getWorldPosition(new Vector3());
    expect(new Vector3(...e.start.position).distanceTo(portPos)).toBeLessThanOrEqual(0.005);
    // Outward of +X under a 30° yaw about +Y: (cos30, 0, -sin30).
    const outward = new Vector3(1, 0, 0).applyAxisAngle(new Vector3(0, 1, 0), (30 * Math.PI) / 180);
    expect(tangentAngleDeg(new Vector3(...e.start.tangent), outward)).toBeLessThanOrEqual(2);
    expect(Math.abs(headingOf(e.start.tangent) - ports[0].headingDeg)).toBeLessThan(1e-3);
  });

  it('station consuming port (Snap-ZN-path, owner yawed -50°): the block ENDS there, travelling into the port', () => {
    const port = placement('Station', 'Snap-ZN-path', [0, 0, -0.8], [-4, 0, 5], -50);
    const ports = pathPlacementPorts(registry);
    expect(ports).toHaveLength(1);
    expect(ports[0].end).toBe('start');
    const path = placeAt(ports[0] as FreePort);
    const e = specEnds(path.segments as PathSegmentSpec[])!;
    const portPos = port.getWorldPosition(new Vector3());
    expect(new Vector3(...e.end.position).distanceTo(portPos)).toBeLessThanOrEqual(0.005);
    // Outward of -Z under the yaw; travel INTO the port is the opposite.
    const outward = new Vector3(0, 0, -1).applyAxisAngle(new Vector3(0, 1, 0), (-50 * Math.PI) / 180);
    expect(tangentAngleDeg(new Vector3(...e.end.tangent), outward.clone().negate())).toBeLessThanOrEqual(2);
  });

  it('occupied placement ports and path ends themselves are not listed as placement ports', () => {
    mount(networks().straight);
    placement('Conveyor', 'Snap-XP-path', [0.5, 0, 0], [3, 0, 2], 0);
    placement('Other', 'Snap-XP-pallet', [0.5, 0, 0], [6, 0, 2], 0);
    const ports = pathPlacementPorts(registry);
    expect(ports.map((p) => registry.getById(p.snapId)!.ownerRoot.name)).toEqual(['Conveyor']);
    registry.getById(ports[0].snapId)!.occupied = true;
    expect(pathPlacementPorts(registry)).toEqual([]);
  });
});
