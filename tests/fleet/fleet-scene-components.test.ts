// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * fleet-scene-components.test.ts — plan-559 §9.6 (contract, SOL #6, Lehre Bake)
 * plus the Phase-3 schema round trip and the typed scene reader.
 *
 *  1. The six fleet schemas are registered web-only with units, choices and
 *     bounds (the inspector's editors read exactly these descriptors).
 *  2. None of them is a material-flow type: next to a real `Source` and
 *     `Conveyor`, `resolveNodeMaterialFlows` (the function the DES scene
 *     binding uses for auto-connect) never yields one, so no fleet component
 *     can become an MU target.
 *  3. After the destructive bake WITHOUT any plugin the `ForkAnchor` and the
 *     `SeatNode` targets (bare nodes) still exist — claimed by the reference.
 *     Control: without the components the same bare nodes are removed.
 *  4. `readFleetScene`: defaults, PathId fallback to the node's own Path,
 *     partner rules, reference resolution through `NodeRegistry`, id order,
 *     issues; `profilesOfVehicle` stops at the instance root.
 *  5. Round trip: editor defaults (`getSchemaDefaults`) → GLB export → reload
 *     → the same model.
 */

import { describe, expect, it } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D, Scene } from 'three';
import type { RVViewer } from '../../src/core/rv-viewer';
import { scratchAssetDocument } from '../helpers/scratch-asset-document';
import '../../src/core/engine/rv-scene-loader';
import '../../src/behaviors/Source';
import '../../src/behaviors/Conveyor';
import {
  getCapabilities,
  getRegisteredSchema,
  getSchemaDefaults,
} from '../../src/core/engine/rv-component-registry';
import { getMaterialFlow, resolveNodeMaterialFlows } from '../../src/core/material-flow/registry';
import { NodeRegistry } from '../../src/core/engine/rv-node-registry';
import { prepareAndBake } from '../../src/core/engine/rv-prepare-and-bake';
import { RVUberMaterial } from '../../src/core/engine/rv-uber-material';
import { referenceBakeTargetOf } from '../../src/core/engine/rv-bake-survival';
import type { BakedAsset } from '../../src/core/engine/rv-bake-chunk';
import { exportAssetGlb } from '../../src/core/editor/rv-asset-glb-export';
import { parseGlbSubtreeWithMeta } from '../../src/core/engine/rv-glb-parse';
import { inlinePickPort } from '../fixtures/bake-fixture';
import {
  BATTERY_PROFILE_TYPE,
  CHARGER_TYPE,
  FLEET_COMPONENT_TYPES,
  FLEET_TYPE,
  FORKLIFT_PROFILE_TYPE,
  TRANSFER_STATION_TYPE,
  WAIT_POINT_TYPE,
} from '../../src/core/fleet/scene/fleet-components';
import {
  batteryConfigOf,
  profilesOfVehicle,
  readFleetScene,
  type FleetSceneModel,
} from '../../src/core/fleet/scene/fleet-scene-model';

const nodeRef = (path: string) => ({ type: 'ComponentReference', path, componentType: '' });

function box(name: string, pos: [number, number, number] = [0, 0, 0]): Mesh {
  const m = new Mesh(new BoxGeometry(0.2, 0.2, 0.2), new MeshStandardMaterial({ color: 0x888888 }));
  m.name = name;
  m.position.set(...pos);
  return m;
}

function child(parent: Object3D, name: string, rv?: Record<string, unknown>): Object3D {
  const n = new Object3D();
  n.name = name;
  if (rv) n.userData.realvirtual = rv;
  parent.add(n);
  return n;
}

const STUB_PATH = { type: 'Path', version: 1, segments: [{ kind: 'line', from: [0, 0, 0], to: [1, 0, 0] }] };

/**
 * Yard (asset root)
 *  ├─ Fleet          Fleet
 *  ├─ Source_A       Source               (material flow)
 *  ├─ Conveyor_A1    Conveyor + TransferStation(pick, PathId 'Stich_A1')
 *  ├─ Stich_P1       Path + TransferStation(storage, Floor, SeatNode → Slot_P1/Seat)
 *  ├─ Slot_P1        bare mesh, child Seat (bare mesh)
 *  ├─ Stich_L1       Path(id 'Charge_1') + Charger
 *  ├─ Stich_W        Path + WaitPoint
 *  └─ Stacker        ForkliftProfile(Lift → Stacker/Lift, ForkAnchor → Stacker/Lift/ForkAnchor) + BatteryProfile
 *      ├─ Body       mesh
 *      └─ Lift       mesh, child ForkAnchor (bare mesh)
 */
function buildYard(withFleet: boolean): Group {
  const root = new Group();
  root.name = 'Yard';
  child(root, 'Fleet', withFleet ? { Fleet: { WaitLimitSec: 30 } } : undefined);
  child(root, 'Source_A', { Source: {} });
  child(root, 'Conveyor_A1', {
    Conveyor: {},
    ...(withFleet ? { TransferStation: { StationName: 'A1', Role: 'pick', PathId: 'Stich_A1', HandlingHeightMm: 512 } } : {}),
  });
  child(root, 'Stich_P1', {
    Path: { ...STUB_PATH },
    ...(withFleet ? { TransferStation: { Role: 'storage', PartnerType: 'Floor', Group: 'Buffer', SeatNode: nodeRef('Slot_P1/Seat') } } : {}),
  });
  const slot = box('Slot_P1', [3, 0, 0]);
  slot.add(box('Seat', [0, 0.1, 0]));
  root.add(slot);
  child(root, 'Stich_L1', { Path: { ...STUB_PATH, id: 'Charge_1' }, ...(withFleet ? { Charger: { ChargeRatePerMin: 7 } } : {}) });
  child(root, 'Stich_W', { Path: { ...STUB_PATH }, ...(withFleet ? { WaitPoint: { Capacity: 2 } } : {}) });
  const stacker = new Group();
  stacker.name = 'Stacker';
  if (withFleet) {
    stacker.userData.realvirtual = {
      ForkliftProfile: { Lift: nodeRef('Stacker/Lift'), ForkAnchor: nodeRef('Stacker/Lift/ForkAnchor'), TravelHeightMm: 100 },
      BatteryProfile: { StartSoc: 70 },
    };
  }
  stacker.add(box('Body', [5, 0, 0]));
  const lift = box('Lift', [5, 0.5, 0]);
  lift.add(box('ForkAnchor', [0, 0.1, 0.3]));
  stacker.add(lift);
  root.add(stacker);
  return root;
}

function registryFor(root: Object3D): NodeRegistry {
  const reg = new NodeRegistry();
  root.traverse((n) => reg.registerNode(NodeRegistry.computeNodePath(n), n));
  return reg;
}

function findNode(root: Object3D, name: string): Object3D | null {
  let found: Object3D | null = null;
  root.traverse((n) => { if (!found && n.name === name) found = n; });
  return found;
}

let bakeSeq = 0;
async function bakeYard(withFleet: boolean): Promise<BakedAsset> {
  const baked = await prepareAndBake(buildYard(withFleet), {
    assetId: `plan-559-p3-${withFleet ? 'with' : 'without'}-${bakeSeq++}`,
    renamedNodes: new Map<Object3D, string>(),
    signatureState: 'none',
    uber: new RVUberMaterial(false),
    isWebGPU: false,
    pickPort: inlinePickPort(),
  });
  baked.template.updateMatrixWorld(true);
  return baked;
}

/** The model without node objects and registry paths — comparable across two trees. */
function plain(model: FleetSceneModel): unknown {
  const strip = (o: object): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) {
      // The id is a registry path and depends on where the root hangs (scene vs. parentless).
      if (k === 'id') continue;
      out[k] = v instanceof Object3D ? v.name : v;
    }
    return out;
  };
  return {
    fleet: model.fleet ? strip(model.fleet) : null,
    stations: model.stations.map(strip),
    chargers: model.chargers.map(strip),
    waitPoints: model.waitPoints.map(strip),
    forkliftProfiles: model.forkliftProfiles.map(strip),
    batteryProfiles: model.batteryProfiles.map(strip),
  };
}

describe('plan-559 §9.6 — fleet scene components', () => {
  it('registers the six web-only schemas with units, choices and bounds', () => {
    for (const type of FLEET_COMPONENT_TYPES) {
      expect(getRegisteredSchema(type), type).toBeDefined();
      const caps = getCapabilities(type);
      expect(caps.authorable, type).toBe(true);
      expect(caps.ui.category, type).toBe('transport');
    }
    const ts = getRegisteredSchema(TRANSFER_STATION_TYPE)!;
    expect(ts.Role).toMatchObject({ type: 'enum', default: 'both' });
    expect(Object.keys(ts.Role!.enumMap!)).toEqual(['pick', 'drop', 'storage', 'both']);
    expect(ts.PathId).toMatchObject({ type: 'string', default: '' });
    expect(ts.HandlingHeightMm).toMatchObject({ type: 'number', unit: 'mm', min: 0 });
    expect(ts.Partner).toMatchObject({ type: 'componentRef', refTarget: 'node' });
    expect(getRegisteredSchema(FLEET_TYPE)!.TargetWaitLimitSec).toMatchObject({ default: 3600, unit: 's' });
    expect(getRegisteredSchema(BATTERY_PROFILE_TYPE)!.Threshold).toMatchObject({ default: 30, unit: '%', min: 0, max: 100 });
    expect(getRegisteredSchema(FORKLIFT_PROFILE_TYPE)!.LiftSpeedLoadedMmS).toMatchObject({ default: 150, unit: 'mm/s' });
    expect(getRegisteredSchema(WAIT_POINT_TYPE)!.Capacity).toMatchObject({ default: 1, min: 1, step: 1 });
    expect(getRegisteredSchema(CHARGER_TYPE)!.ChargeRatePerMin).toMatchObject({ default: 5, unit: '%/min' });
    // Reference targets survive as nodes (merge), never as their own chunk.
    for (const [type, field] of [[TRANSFER_STATION_TYPE, 'SeatNode'], [TRANSFER_STATION_TYPE, 'Partner'],
      [FORKLIFT_PROFILE_TYPE, 'ForkAnchor'], [FORKLIFT_PROFILE_TYPE, 'Lift']] as const) {
      expect(referenceBakeTargetOf(type, field), `${type}.${field}`).toBe('merge');
    }
  });

  it('no fleet component is a material-flow type or an auto-connect candidate', () => {
    expect(getMaterialFlow('Conveyor'), 'precondition: Conveyor is a material flow').toBeDefined();
    expect(getMaterialFlow('Source'), 'precondition: Source is a material flow').toBeDefined();
    for (const type of FLEET_COMPONENT_TYPES) expect(getMaterialFlow(type), type).toBeUndefined();

    const yard = buildYard(true);
    const flowsOf = (name: string) => resolveNodeMaterialFlows(findNode(yard, name)!, '').map((d) => d.type).sort();
    expect(flowsOf('Source_A')).toEqual(['Source']);
    // The station on the conveyor reference adds nothing to the conveyor's flow.
    expect(flowsOf('Conveyor_A1')).toEqual(['Conveyor']);
    for (const name of ['Fleet', 'Stich_P1', 'Stich_L1', 'Stich_W', 'Stacker']) {
      expect(flowsOf(name), name).toEqual([]);
    }
  });

  it('ForkAnchor and SeatNode targets survive the destructive bake without a plugin', async () => {
    const withFleet = await bakeYard(true);
    for (const name of ['ForkAnchor', 'Seat', 'Fleet', 'Stich_W']) {
      expect(findNode(withFleet.template, name), `${name} survives`).not.toBeNull();
    }
    // Control: the same bare nodes have no claim without the components.
    const without = await bakeYard(false);
    expect(findNode(without.template, 'ForkAnchor')).toBeNull();
    expect(findNode(without.template, 'Seat')).toBeNull();
  });

  it('readFleetScene: defaults, stubs, partners, references, order', () => {
    const yard = buildYard(true);
    const model = readFleetScene(yard, registryFor(yard));
    expect(model.issues).toEqual([]);

    expect(model.fleet).toMatchObject({
      id: 'Fleet', enabled: true, vehicleSelection: 'nearest-feasible', charging: 'threshold-opportunity',
      waitLimitSec: 30, targetWaitLimitSec: 3600, chargeWaitLimitSec: 3600, standstillLimitSec: 120,
    });

    expect(model.stations.map((s) => s.id)).toEqual(['Conveyor_A1', 'Stich_P1']);
    const [a1, p1] = model.stations;
    expect(a1).toMatchObject({
      name: 'A1', role: 'pick', pathId: 'Stich_A1', partnerType: 'Conveyor', partnerEnd: 'tail',
      handlingHeightMm: 512, approach: 'reverse', group: '', seat: null,
    });
    // Empty Partner on a conveyor station = the station node itself (the conveyor placement).
    expect(a1!.partner).toBe(a1!.node);
    expect(p1).toMatchObject({ name: 'Stich_P1', role: 'storage', pathId: 'Stich_P1', partnerType: 'Floor', partner: null, group: 'Buffer' });
    expect(p1!.seat).toBe(findNode(yard, 'Seat'));

    expect(model.chargers).toHaveLength(1);
    expect(model.chargers[0]).toMatchObject({ id: 'Stich_L1', pathId: 'Charge_1', chargeRatePerMin: 7 });
    expect(model.waitPoints[0]).toMatchObject({ pathId: 'Stich_W', capacity: 2, precedence: 'charge-queue-first' });

    const fork = model.forkliftProfiles[0]!;
    expect(fork.lift).toBe(findNode(yard, 'Lift'));
    expect(fork.forkAnchor).toBe(findNode(yard, 'ForkAnchor'));
    expect(fork).toMatchObject({ travelHeightMm: 100, liftSpeedEmptyMmS: 300, handlingDeltaMm: 30, preLift: true, lowerAfterExit: true });
    const bat = model.batteryProfiles[0]!;
    expect(bat).toMatchObject({ startSoc: 70, threshold: 30, target: 80, travelSlack: 1.5 });
    expect(batteryConfigOf(bat, model.chargers[0]!.chargeRatePerMin)).toEqual({
      startSoc: 70, drivePerMin: 1.2, liftPerM: 0.05, idlePerMin: 0.2, chargePerMin: 7,
      threshold: 30, target: 80, reserveToCharger: 5, chargerWaitReserveSec: 600,
    });
  });

  it('readFleetScene reports issues instead of guessing', () => {
    const yard = buildYard(true);
    child(yard, 'AFleet2', { Fleet: { Enabled: false } });
    child(yard, 'Lonely', { TransferStation: { PartnerType: 'Floor', SeatNode: nodeRef('Nowhere/Seat') } });
    child(yard, 'Clamped', { Charger: { PathId: 'C9', ChargeRatePerMin: -4 }, BatteryProfile: { Threshold: 140, StartSoc: 'x' } });
    // An authored Partner that does not resolve stays null - no fallback to the station node.
    child(yard, 'BadPartner', { TransferStation: { PathId: 'S9', Role: 'pickup', Partner: nodeRef('Gone/Conveyor') } });
    const model = readFleetScene(yard, registryFor(yard));
    // Id order decides which Fleet wins, the other is reported.
    expect(model.fleet!.id).toBe('AFleet2');
    expect(model.issues.map((i) => i.code).sort()).toEqual([
      'fleet-duplicate', 'fleet-invalid-value', 'fleet-missing-path',
      'fleet-unresolved-reference', 'fleet-unresolved-reference',
    ]);
    const bad = model.stations.find((s) => s.id === 'BadPartner')!;
    expect(bad.partner).toBeNull();
    expect(bad.role).toBe('both');
    const lonely = model.stations.find((s) => s.id === 'Lonely')!;
    expect(lonely.pathId).toBeNull();
    expect(lonely.seat).toBeNull();
    expect(model.chargers.find((c) => c.id === 'Clamped')!.chargeRatePerMin).toBe(0);
    const clamped = model.batteryProfiles.find((b) => b.id === 'Clamped')!;
    expect(clamped.threshold).toBe(100);
    expect(clamped.startSoc).toBe(100);
    // Without a resolver the references stay null, nothing else changes.
    const noRefs = readFleetScene(buildYard(true));
    expect(noRefs.forkliftProfiles[0]!.forkAnchor).toBeNull();
    expect(noRefs.stations[0]!.pathId).toBe('Stich_A1');
  });

  it('profilesOfVehicle stops at the instance root', () => {
    const scene = new Group();
    scene.name = 'Scene';
    scene.userData.realvirtual = { BatteryProfile: { StartSoc: 11 } };
    const cart = child(scene, 'Cart_1', { InstanceScope: {}, ForkliftProfile: {} });
    const agv = child(cart, 'AGV', { Agv: {} });
    const loose = child(scene, 'Loose', { Agv: {} });
    const model = readFleetScene(scene);
    const inCart = profilesOfVehicle(model, agv);
    expect(inCart.forklift!.node).toBe(cart);
    // The scene-level battery profile lies OUTSIDE the cart's instance root.
    expect(inCart.battery).toBeNull();
    const outside = profilesOfVehicle(model, loose);
    expect(outside.forklift).toBeNull();
    expect(outside.battery!.startSoc).toBe(11);
  });

  it('round trip: editor add component, GLB export, reload yields the same model', async () => {
    const scene = new Scene();
    const root = new Group();
    root.name = 'RoundTrip';
    scene.add(root);
    child(root, 'Stich_V1', { Path: { ...STUB_PATH } });
    child(root, 'Stich_L1', { Path: { ...STUB_PATH } });
    child(root, 'Stich_W', { Path: { ...STUB_PATH } });
    const vehicle = new Group();
    vehicle.name = 'Vehicle';
    vehicle.add(box('Anchor'));
    root.add(vehicle);
    const registry = registryFor(root);
    const viewer = {
      scene, registry, signalStore: null, transportManager: null,
      get currentModelRoot() { return root; },
      markRenderDirty() {}, markShadowsDirty() {}, emit() {}, rebuildGroupedBvh() {},
    } as unknown as RVViewer;
    const doc = scratchAssetDocument(viewer);
    const add = async (path: string, type: string, edits: Record<string, unknown> = {}) => {
      // What the inspector writes on add: the schema defaults, then the author's edits.
      expect(doc.addComponent(path, type, { ...getSchemaDefaults(type), ...edits })).toBe(type);
      await doc.whenIdle();
    };
    await add('RoundTrip', FLEET_TYPE, { StandstillLimitSec: 90 });
    await add('RoundTrip/Stich_V1', TRANSFER_STATION_TYPE, { Role: 'drop', PartnerEnd: 'head', HandlingHeightMm: 480, SeatNode: nodeRef('Vehicle/Anchor') });
    await add('RoundTrip/Stich_L1', CHARGER_TYPE, { ChargeRatePerMin: 6 });
    await add('RoundTrip/Stich_W', WAIT_POINT_TYPE, { Precedence: 'arrival-order' });
    await add('RoundTrip/Vehicle', FORKLIFT_PROFILE_TYPE, { ForkAnchor: nodeRef('Vehicle/Anchor'), PreLift: false });
    await add('RoundTrip/Vehicle', BATTERY_PROFILE_TYPE, { Target: 85 });
    doc.dispose();

    const before = readFleetScene(root, registry);
    expect(before.issues).toEqual([]);
    expect(before.stations[0]).toMatchObject({ role: 'drop', partnerEnd: 'head', handlingHeightMm: 480, pathId: 'Stich_V1' });
    expect(before.forkliftProfiles[0]!.forkAnchor!.name).toBe('Anchor');
    expect(before.waitPoints[0]!.precedence).toBe('arrival-order');

    const bytes = await exportAssetGlb(root, 'RoundTrip');
    // The viewer's parse: it links the file identity, so address-form references resolve.
    const parsed = await parseGlbSubtreeWithMeta(bytes.slice(0));
    const top = parsed.root.name === 'RoundTrip' ? parsed.root : findNode(parsed.root, 'RoundTrip')!;
    // Register the reloaded file as the main document with its identity, as the loader does.
    const reloadedRegistry = registryFor(top);
    reloadedRegistry.registerDocument(top, '', parsed.identity);
    const after = readFleetScene(top, reloadedRegistry);
    expect(after.issues).toEqual([]);
    // Same values and the same resolved reference targets (compared by node name).
    expect(plain(after)).toEqual(plain(before));
    expect(after.forkliftProfiles[0]!.forkAnchor!.name).toBe('Anchor');
    expect(after.stations[0]!.seat!.name).toBe('Anchor');
  });
});
