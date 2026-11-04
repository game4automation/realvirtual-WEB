// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Object3D, Scene } from 'three';
import { EventEmitter } from '../../src/core/rv-events';
import type { ViewerEvents } from '../../src/core/rv-viewer-events';
import type { RVViewer } from '../../src/core/rv-viewer';
import { NodeRegistry } from '../../src/core/engine/rv-node-registry';
import { getRegisteredSchema } from '../../src/core/engine/rv-component-registry';
import { FleetAuthoringSource, designEnvelopeOf } from '../../src/core/fleet/scene/fleet-authoring-source';
import { readFleetScene } from '../../src/core/fleet/scene/fleet-scene-model';
import { resolvePathEnvelope } from '../../src/plugins/path-network/path-network-validation';
import { createPathNetworkCommandDescriptors, type PathCommandResult } from '../../src/plugins/path-network/path-network-commands';
import type { CommandContext, CommandImpl } from '../../src/core/hmi/rv-command-registry';
import { setActiveEditTarget } from '../../src/core/hmi/rv-edit-target';
import { makeRig, type Rig } from '../path/path-network-rig';
import { bindContinuous, clearShared, makeAgvRoot, makeHost } from '../helpers/agv-harness';

function child(parent: Object3D, name: string, components: Record<string, unknown> = {}): Object3D {
  const node = new Object3D();
  node.name = name;
  node.userData.realvirtual = components;
  parent.add(node);
  return node;
}

function fixture(length = 0, width = 0, offset = 0) {
  const scene = new Scene();
  const root = child(scene, 'Root');
  const fleet = child(root, 'Fleet', { Fleet: { DesignVehicleLengthMm: length, DesignVehicleWidthMm: width, DesignLoadOffsetMm: offset } });
  const registry = new NodeRegistry();
  const events = new EventEmitter<ViewerEvents>();
  const viewer = { scene, registry, on: events.on.bind(events) };
  const register = () => root.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
  register();
  return { scene, root, fleet, viewer, events, register };
}

function forklift(root: Object3D, name: string, offsetMm: number, descendant = false) {
  const profile = child(root, name, { InstanceScope: {}, ForkliftProfile: {} });
  const agv = descendant ? child(profile, 'AgvRoot', { Agv: {} }) : profile;
  agv.userData.realvirtual.Agv = {};
  const anchor = child(agv, 'ForkAnchor');
  anchor.position.set(0, 1.2, -offsetMm / 1000);
  profile.userData.realvirtual.ForkliftProfile.ForkAnchor = {
    type: 'ComponentReference', componentType: '', path: NodeRegistry.computeNodePath(anchor),
  };
  return { profile, agv, anchor };
}

let rig: Rig | undefined;
beforeEach(() => clearShared());
afterEach(() => {
  rig?.plugin.dispose();
  rig = undefined;
  setActiveEditTarget(null);
  clearShared();
});

describe('plan-636 design vehicle', () => {
  it('registers dimensions, signed fallback offset, and dock port with supported field metadata', () => {
    const schema = getRegisteredSchema('Fleet')!;
    for (const [field, max, step, label, min] of [
      ['DesignVehicleLengthMm', 20000, 10, 'Design vehicle length', 0],
      ['DesignVehicleWidthMm', 10000, 10, 'Design vehicle width', 0],
      ['DesignLoadOffsetMm', 5000, 1, 'Design load offset', -5000],
    ] as const) expect(schema[field]).toEqual({ type: 'number', default: 0, unit: 'mm', min, max, step, label });
    expect(getRegisteredSchema('TransferStation')!.DockPort).toEqual({ type: 'string', default: '', label: 'Dock port' });
  });

  it('reads complete dimensions and converts them only at the envelope boundary', () => {
    const f = fixture(1750, 860, 274);
    const model = readFleetScene(f.scene, f.viewer.registry);
    expect(model.fleet).toMatchObject({ designVehicle: { lengthMm: 1750, widthMm: 860 }, designLoadOffsetMm: 274 });
    expect(model.issues).toEqual([]);
    expect(designEnvelopeOf(model.fleet!.designVehicle!)).toEqual({ front: 0.875, rear: 0.875, width: 0.86 });
  });

  it.each([[1750, 0], [0, 860]])('reports exactly one incomplete issue for %s/%s', (length, width) => {
    const f = fixture(length, width);
    const model = readFleetScene(f.scene);
    expect(model.fleet!.designVehicle).toBeNull();
    expect(model.issues).toHaveLength(1);
    expect(model.issues[0]).toMatchObject({ code: 'fleet-design-vehicle-incomplete', node: NodeRegistry.computeNodePath(f.fleet) });
    expect(model.issues[0]!.message).toContain(`DesignVehicleLengthMm (${length})`);
    expect(model.issues[0]!.message).toContain(`DesignVehicleWidthMm (${width})`);
  });

  it('defaults absent fields and clamps dimensions and signed offsets', () => {
    const f = fixture();
    f.fleet.userData.realvirtual.Fleet = {};
    expect(readFleetScene(f.scene).fleet).toMatchObject({ designVehicle: null, designLoadOffsetMm: 0 });
    expect(readFleetScene(f.scene).issues).toEqual([]);
    f.fleet.userData.realvirtual.Fleet = { DesignVehicleLengthMm: -5, DesignVehicleWidthMm: -5, DesignLoadOffsetMm: -6000 };
    expect(readFleetScene(f.scene).fleet).toMatchObject({ designVehicle: null, designLoadOffsetMm: -5000 });
    expect(readFleetScene(f.scene).issues).toEqual([]);
    f.fleet.userData.realvirtual.Fleet = { DesignVehicleLengthMm: 30000, DesignVehicleWidthMm: 20000, DesignLoadOffsetMm: 6000 };
    expect(readFleetScene(f.scene).fleet).toMatchObject({ designVehicle: { lengthMm: 20000, widthMm: 10000 }, designLoadOffsetMm: 5000 });
    const station = child(f.root, 'Station', { TransferStation: { PathId: 'stub', DockPort: '  Snap-ZB-path  ' } });
    expect(readFleetScene(f.scene).stations[0]!.dockPort).toBe('Snap-ZB-path');
    delete station.userData.realvirtual.TransferStation.DockPort;
    expect(readFleetScene(f.scene).stations[0]!.dockPort).toBe('');
  });

  it('resolves none, explicit, and design precedence; null viewer skips design', () => {
    const f = fixture();
    const explicit = { front: 1, rear: 1, width: 1 };
    expect(resolvePathEnvelope(f.viewer)).toEqual({ env: null, source: 'none' });
    expect(resolvePathEnvelope(f.viewer, explicit)).toEqual({ env: explicit, source: 'explicit' });
    f.fleet.userData.realvirtual.Fleet = { DesignVehicleLengthMm: 1750, DesignVehicleWidthMm: 860 };
    expect(resolvePathEnvelope(f.viewer, explicit)).toEqual({ env: { front: 0.875, rear: 0.875, width: 0.86 }, source: 'design' });
    expect(resolvePathEnvelope(null, explicit)).toEqual({ env: explicit, source: 'explicit' });
    expect(resolvePathEnvelope(null)).toEqual({ env: null, source: 'none' });
  });
});

describe('fleet authoring load offset', () => {
  it.each([0, Math.PI / 2])('measures a translated vehicle in its local frame (yaw %s)', (yaw) => {
    const f = fixture(0, 0, 100);
    const v = forklift(f.root, 'A', 273.5);
    v.agv.rotation.y = yaw;
    v.agv.position.set(4, 2, 7);
    f.register();
    const result = FleetAuthoringSource.of(f.viewer).loadOffset();
    expect(result.source).toBe('vehicle');
    expect(result.mm).toBeCloseTo(273.5, 6);
    expect(result.issues).toEqual([]);
  });

  it.each([300, -300])('uses a signed design fallback without a measurable vehicle (%s)', (offset) => {
    const f = fixture(0, 0, offset);
    expect(FleetAuthoringSource.of(f.viewer).loadOffset()).toEqual({ mm: offset, source: 'design', issues: [] });
    child(f.root, 'Unmeasurable', { ForkliftProfile: {} });
    expect(FleetAuthoringSource.of(f.viewer).loadOffset()).toEqual({ mm: offset, source: 'design', issues: [] });
  });

  it('warns only when profiles exist but neither measurement nor fallback exists', () => {
    const f = fixture();
    const source = FleetAuthoringSource.of(f.viewer);
    expect(source.loadOffset()).toEqual({ mm: 0, source: 'none', issues: [] });
    child(f.root, 'A', { ForkliftProfile: { ForkAnchor: { type: 'ComponentReference', path: 'Missing', componentType: '' } } });
    f.register();
    const result = source.loadOffset();
    expect(result).toMatchObject({ mm: 0, source: 'none' });
    expect(result.issues.map((i) => i.code)).toEqual(['fleet-load-offset-missing']);
  });

  it('reports all conflicting offsets, chooses smallest id, and uses only a positive conflict override', () => {
    const f = fixture();
    forklift(f.root, 'Z', 400);
    forklift(f.root, 'A', 273.5);
    f.register();
    const source = FleetAuthoringSource.of(f.viewer);
    for (const design of [0, -350, 350]) {
      f.fleet.userData.realvirtual.Fleet.DesignLoadOffsetMm = design;
      const result = source.loadOffset();
      expect(result.source).toBe(design > 0 ? 'design' : 'vehicle');
      expect(result.mm).toBeCloseTo(design > 0 ? 350 : 273.5, 6);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0]!.code).toBe('fleet-load-offset-ambiguous');
      expect(result.issues[0]!.message).toContain('273.5');
      expect(result.issues[0]!.message).toContain('400');
    }
  });

  it('accepts agreement within 10 mm and resolves descendant Agvs without crossing instance scopes', () => {
    const f = fixture();
    const a = forklift(f.root, 'A', 273.5, true);
    forklift(f.root, 'Z', 283.5);
    // An earlier id in another instance must not win the descendant search.
    child(a.profile, '000Nested', { InstanceScope: {}, Agv: {} });
    f.register();
    const result = FleetAuthoringSource.of(f.viewer).loadOffset();
    expect(result.source).toBe('vehicle');
    expect(result.mm).toBeCloseTo(273.5, 6);
    expect(result.issues).toEqual([]);
    delete a.agv.userData.realvirtual.Agv;
    f.root.remove(f.root.getObjectByName('Z')!);
    expect(FleetAuthoringSource.of(f.viewer).loadOffset().source).toBe('none');
  });

  it('caches only while attached, invalidates lazily for relevant events, and unsubscribes', () => {
    const f = fixture(1750, 860);
    const source = FleetAuthoringSource.of(f.viewer);
    source.attach(f.viewer);
    expect(FleetAuthoringSource.of(f.viewer)).toBe(source);
    const notify = vi.fn();
    const off = source.onInvalidate(notify);
    const model = source.model();
    expect(source.model()).toBe(model);
    const offset = source.loadOffset();
    expect(source.loadOffset()).toBe(offset);
    expect(source.reads).toBe(1);
    f.fleet.userData.realvirtual.Fleet.DesignVehicleLengthMm = 1900;
    expect(source.model().fleet!.designVehicle!.lengthMm).toBe(1750);
    f.events.emit('component-field-changed', { nodePath: 'Root/Fleet', componentType: 'Path', fieldName: 'x' });
    expect(notify).not.toHaveBeenCalled();
    for (const type of ['Fleet', 'Fleet_2', 'TransferStation_1', 'ForkliftProfile']) {
      const reads = source.reads;
      f.events.emit('component-field-changed', { nodePath: 'Root/Fleet', componentType: type, fieldName: 'DesignVehicleLengthMm' });
      expect(source.reads).toBe(reads);
      expect(source.model()).not.toBe(model);
      expect(source.model().fleet!.designVehicle!.lengthMm).toBe(1900);
      expect(source.reads).toBe(reads + 1);
    }
    for (const event of ['model-loaded', 'layout-content-added', 'layout-content-removed']) {
      const reads = source.reads;
      f.events.emit(event);
      expect(source.reads).toBe(reads);
      source.model();
      expect(source.reads).toBe(reads + 1);
    }
    off();
    source.dispose();
    const count = notify.mock.calls.length;
    f.events.emit('model-loaded');
    expect(notify).toHaveBeenCalledTimes(count);
    const reads = source.reads;
    source.model();
    source.model();
    expect(source.reads).toBe(reads + 2);
    const headless = FleetAuthoringSource.of(f.viewer);
    expect(headless).not.toBe(source);
    expect(headless.model()).not.toBe(headless.model());
    expect(headless.reads).toBe(2);
  });
});

const commands = new Map(createPathNetworkCommandDescriptors().map((d) => [d.id, d.eagerImpl as CommandImpl<unknown, unknown>]));
async function run(id: string, args: Record<string, unknown> = {}): Promise<PathCommandResult & { envelopeSource?: string }> {
  const ctx: CommandContext = { viewer: rig!.stub as unknown as RVViewer, doc: null, selection: [], mode: 'planner', handle: null };
  const impl = commands.get(id)!;
  const enabled = impl.enabled(ctx, args);
  if (enabled !== true) throw new Error(enabled.reason);
  return await impl.run(ctx, args) as PathCommandResult & { envelopeSource?: string };
}

describe('design envelope command integration', () => {
  it.each([false, true])('sizes merge junctions with design vehicle = %s', async (design) => {
    rig = makeRig();
    if (design) child(rig.root, 'Fleet', { Fleet: { DesignVehicleLengthMm: 1750, DesignVehicleWidthMm: 860 } });
    expect((await run('layout.path.validate')).envelopeSource).toBe(design ? 'design' : 'none');
    await run('layout.path.place', { block: 'straight', lengthM: 10, x: 0, z: 0, headingDeg: 90 });
    const result = await run('layout.path.junction', { kind: 'merge', pathId: 'PN_S1', s: 6 });
    expect(result.mergeSizing).toBe(design ? 'sized' : 'skipped');
    if (!design) expect(result.preM).toBe(1.8);
    else expect(result.preM).toBeGreaterThanOrEqual(1);
  });

  it('gives a real registered vehicle body precedence over design and explicit envelopes', async () => {
    rig = makeRig();
    child(rig.root, 'Fleet', { Fleet: { DesignVehicleLengthMm: 1750, DesignVehicleWidthMm: 860 } });
    await run('layout.path.place', { block: 'straight', lengthM: 10, x: 0, z: 0 });
    const agv = makeAgvRoot('RealVehicle', { PathId: 'PN_S1', VehicleLength: 2400, VehicleWidth: 1000 });
    rig.root.add(agv);
    const handle = bindContinuous(agv, makeHost());
    try {
      expect(resolvePathEnvelope(rig.stub, { front: 2, rear: 2, width: 2 })).toEqual({
        source: 'fleet', env: { front: 1.2, rear: 1.2, width: 1 },
      });
    } finally { handle.dispose(); }
  });
});
