// SPDX-License-Identifier: AGPL-3.0-only
// plan-2059 O3: `Object3D.uuid` is random per load. A tie in the connection conflict rule (equal degree in a
// snap 2-cycle) used to resolve by uuid, so a freshly loaded scene wired another topology than the original.
import { expect, it } from 'vitest';
import { Object3D } from 'three';
import { RV_SEEDED_NODE_ID_KEY } from '../../src/core/engine/rv-authored-keys';
import { breakTwoCycles, type ConnectableInstance } from '../../src/plugins/des/logical-connections';
import type { DESComponent } from '../../src/plugins/des/rv-des-component';

function load(uuids: [string, string]): { names: string[]; instances: ConnectableInstance[] } {
  const mk = (name: string, id: string, uuid: string): ConnectableInstance => {
    const root = new Object3D(); root.name = name; root.uuid = uuid;
    (root.userData as Record<string, unknown>)[RV_SEEDED_NODE_ID_KEY] = id;
    const adapter = { nextComponents: [] as unknown[], previousComponents: [] as unknown[] } as unknown as DESComponent;
    return { root, adapter, kind: 'x', connectionType: 'x' };
  };
  const a = mk('A', 'id-a', uuids[0]), b = mk('B', 'id-b', uuids[1]);
  const link = (x: ConnectableInstance, y: ConnectableInstance) => {
    (x.adapter.nextComponents as unknown[]).push(y.adapter); (y.adapter.previousComponents as unknown[]).push(x.adapter);
  };
  link(a, b); link(b, a); // equal degree: a pure tie
  expect(breakTwoCycles([a, b])).toBe(1);
  const survivors = [a, b].filter(i => i.adapter.nextComponents.length === 1).map(i => i.root.name);
  return { names: survivors, instances: [a, b] };
}

it('breaks a 2-cycle tie the same way whatever the random uuids of the load are', () => {
  const first = load(['00000000-0000-4000-8000-000000000001', 'ffffffff-0000-4000-8000-000000000002']);
  const second = load(['ffffffff-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002']);
  expect(second.names).toEqual(first.names);
});

// Two placements of the same file: the file-local identities of the placed nodes repeat, the reference nodes differ.
function loadPlacements(uuids: [string, string]): string[] {
  const mk = (placement: string, uuid: string): ConnectableInstance => {
    const ref = new Object3D(); ref.name = placement;
    (ref.userData as Record<string, unknown>)[RV_SEEDED_NODE_ID_KEY] = `ref-${placement}`;
    const root = new Object3D(); root.name = 'Conveyor'; root.uuid = uuid; ref.add(root);
    (root.userData as Record<string, unknown>)[RV_SEEDED_NODE_ID_KEY] = 'same-file-local-id';
    const adapter = { nextComponents: [] as unknown[], previousComponents: [] as unknown[] } as unknown as DESComponent;
    return { root, adapter, kind: 'x', connectionType: 'x' };
  };
  const a = mk('P1', uuids[0]), b = mk('P2', uuids[1]);
  (a.adapter.nextComponents as unknown[]).push(b.adapter); (b.adapter.nextComponents as unknown[]).push(a.adapter);
  expect(breakTwoCycles([a, b])).toBe(1);
  return [a, b].filter(i => i.adapter.nextComponents.length === 1).map(i => i.root.parent!.name);
}

it('tells placements of the same file apart (equal file-local identities, reversed uuids)', () => {
  const first = loadPlacements(['00000000-0000-4000-8000-000000000001', 'ffffffff-0000-4000-8000-000000000002']);
  const second = loadPlacements(['ffffffff-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002']);
  expect(second).toEqual(first);
});
