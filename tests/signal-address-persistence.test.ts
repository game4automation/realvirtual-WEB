// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-769 9.17 — signal mappings are STORED by address (F15, Phase 3b).
 *
 * In memory a `SignalMapping` names its component by `componentPath` (relative to the
 * bind target); stored — layout file / autosave, the scene GLB's `PlacementMeta`, a
 * node's `SignalLinks.Mappings` — it names it by `componentAddress`:
 *  - carrier node: `#<id>` of the component node in the carrier's document, `'.'` → the carrier's id;
 *  - placement: `#<id>` in the placement's ASSET (its content occurrence), `'.'` → the asset root id;
 *  - an internal source additionally carries `sourceAddress` (its signal node), the name stays;
 *  - reading back restores `componentPath`; external signal names are untouched (D12).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Object3D, Scene } from 'three';
import { loadGLB } from '../src/core/engine/rv-scene-loader';
import {
  componentAddressOf, fromStoredMapping, setStoredSignalMappingConverter, toStoredMapping,
} from '../src/core/engine/rv-signal-mapping-address';
import { serializeLayout, type PlacedComponent, type SignalMapping } from '../src/plugins/layout-planner/rv-layout-store';
import { identityIdOf } from '../src/core/engine/rv-decode-identity';
import { RV_SEEDED_NODE_ID_KEY } from '../src/core/engine/rv-authored-keys';
import { bakeIntoGlb } from '../src/core/hmi/scene/rv-scene-glb-bake';
import { materialise } from '../src/core/hmi/scene/rv-scene-edits';
import { readGlbJson } from '../src/core/engine/rv-binary-resources';
import type { SignalStore } from '../src/core/engine/rv-signal-store';
import { node, sceneToGlb } from './helpers/migrate-769-fixtures';

const MAPPING = (componentPath: string, extra?: Partial<SignalMapping>): SignalMapping => ({
  slot: 'Forward', componentPath, signal: 'PLC.Run', direction: 'plcInput', enabled: true, ...extra,
});

async function plant() {
  const scene = new Scene();
  scene.name = 'Plant';
  const carrier = node('Carrier');
  carrier.add(node('Motor', { Drive: { Direction: 'LinearX' } }));
  scene.add(carrier, node('Lamp', { PLCOutputBool: { Name: 'Lamp.On' } }));
  const loaded = await loadGLB('plant.glb', new Scene(), { data: await sceneToGlb(scene), preserveHierarchy: true, loadKinematicsSidecar: false });
  const find = (name: string): Object3D => { let hit: Object3D | null = null; loaded.root.traverse((n) => { if (n.name === name) hit = n; }); return hit!; };
  return { ...loaded, find };
}

/** A live placement: a reference node with content registered under its own occurrence. */
function placeMachine(registry: Awaited<ReturnType<typeof plant>>['registry'], root: Object3D): { machine: Object3D; axis: Object3D } {
  const machine = new Object3D();
  machine.name = 'Machine_1';
  machine.userData._layoutId = 'pl-1';
  machine.userData[RV_SEEDED_NODE_ID_KEY] = 'pl-1';
  const axis = new Object3D();
  axis.name = 'Axis';
  axis.userData[RV_SEEDED_NODE_ID_KEY] = 'b0000000-0000-5000-8000-000000000001';
  machine.add(axis);
  root.add(machine);
  const rootPath = registry.getPathForNode(root);
  registry.registerNode(rootPath ? `${rootPath}/Machine_1` : 'Machine_1', machine);
  registry.registerNode(rootPath ? `${rootPath}/Machine_1/Axis` : 'Machine_1/Axis', axis);
  registry.registerNodeIdInParentDocument(machine);
  registry.registerOccurrence(machine, 'pl-1', { contentRootId: 'b0000000-0000-5000-8000-0000000000ff' });
  return { machine, axis };
}

describe('plan-769 9.17 — signal mappings are stored by address', () => {
  afterEach(() => setStoredSignalMappingConverter(null));

  it('carrier node: componentPath → #<id> and back; "." → the carrier itself', async () => {
    const { registry, find } = await plant();
    const carrier = find('Carrier');
    const motor = find('Motor');
    const stored = toStoredMapping(MAPPING('Motor'), carrier, registry);
    expect(stored.componentPath).toBeUndefined();
    expect(stored.componentAddress).toBe(`#${identityIdOf(motor)}`);
    expect(stored.signal).toBe('PLC.Run'); // the external name stays a name (D12)
    expect(fromStoredMapping(stored, carrier, registry).componentPath).toBe('Motor');
    const self = toStoredMapping(MAPPING('.'), carrier, registry);
    expect(self.componentAddress).toBe(`#${identityIdOf(carrier)}`);
    expect(fromStoredMapping(self, carrier, registry).componentPath).toBe('.');
  });

  it('placement: the address is relative to the placement\'s asset; "." → the asset root id', async () => {
    const { registry, root } = await plant();
    const { machine, axis } = placeMachine(registry, root);
    expect(componentAddressOf(registry, machine, axis)).toBe('#b0000000-0000-5000-8000-000000000001');
    const stored = toStoredMapping(MAPPING('Axis'), machine, registry);
    expect(stored).toMatchObject({ componentAddress: '#b0000000-0000-5000-8000-000000000001' });
    expect(fromStoredMapping(stored, machine, registry).componentPath).toBe('Axis');
    const self = toStoredMapping(MAPPING('.'), machine, registry);
    expect(self.componentAddress).toBe('#b0000000-0000-5000-8000-0000000000ff');
    expect(fromStoredMapping(self, machine, registry).componentPath).toBe('.');
  });

  it('an internal source gets sourceAddress; reading it back takes the node\'s CURRENT signal name', async () => {
    const { registry, find, root } = await plant();
    const lamp = find('Lamp');
    const lampPath = registry.getPathForNode(lamp)!;
    let name = 'Lamp.On';
    const store = {
      getPath: (n: string) => (n === name ? lampPath : undefined),
      exactNameForPath: (p: string) => (p === lampPath ? name : undefined),
    } as unknown as SignalStore;
    const stored = toStoredMapping(MAPPING('Motor', { sourceKind: 'internal', signal: 'Lamp.On' }), find('Carrier'), registry, store);
    expect(stored.sourceAddress).toBe(`#${identityIdOf(lamp)}`);
    name = 'Lamp.Renamed';
    expect(fromStoredMapping(stored, find('Carrier'), registry, store).signal).toBe('Lamp.Renamed');
    void root;
  });

  it('a component the address cannot name keeps its componentPath (nothing lost)', async () => {
    const { registry, find } = await plant();
    const stored = toStoredMapping(MAPPING('NoSuchChild'), find('Carrier'), registry);
    expect(stored.componentPath).toBe('NoSuchChild');
    expect(stored.componentAddress).toBeUndefined();
  });

  it('the layout file and the scene GLB store componentAddress (installed converter)', async () => {
    const { registry, root } = await plant();
    const { machine } = placeMachine(registry, root);
    setStoredSignalMappingConverter((id, m) => toStoredMapping(m, id === 'pl-1' ? machine : null, registry));
    const placed = {
      id: 'pl-1', catalogId: 'machine', label: 'Machine_1', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
      signalMappings: [MAPPING('Axis')],
    } as unknown as PlacedComponent;
    const file = serializeLayout('x', [placed], [], 100);
    expect(file.components[0]!.signalMappings![0]).toMatchObject({ componentAddress: '#b0000000-0000-5000-8000-000000000001' });
    expect(file.components[0]!.signalMappings![0]!.componentPath).toBeUndefined();
    expect(placed.signalMappings![0]!.componentPath).toBe('Axis'); // the in-memory record is untouched

    const empty = new Scene();
    empty.name = 'Layout';
    empty.add(node('Floor'));
    const edits = materialise([{
      id: 'op1', ts: 0, schemaV: 1, kind: 'addPlacement', placement: placed,
    } as never]);
    const baked = await bakeIntoGlb(await sceneToGlb(empty), edits, { locate: () => null });
    const json = readGlbJson(baked.glb) as { nodes: Array<{ name?: string; extras?: { realvirtual?: Record<string, Record<string, unknown>> } }> };
    const meta = json.nodes.find((n) => n.name === 'Machine_1')!.extras!.realvirtual!.PlacementMeta!;
    expect((meta.signalMappings as SignalMapping[])[0]).toMatchObject({ componentAddress: '#b0000000-0000-5000-8000-000000000001' });
  });
});
