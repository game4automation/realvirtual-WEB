// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-769 — `LogicStep_Enable.Target` is a declared path field (PATH_FIELDS), like
 * `Kinematic.Parent` or the CRI targets: a Unity path is migrated on load, both saves
 * write it as `{ address }`, and the logic engine's reader (`registry.storedNode`)
 * reaches the same node through either form. Until Phase 5 it stayed a raw path
 * (an open point of plan-769).
 */

import { describe, expect, it } from 'vitest';
import { Scene } from 'three';
import { loadGLB } from '../src/core/engine/rv-scene-loader';
import { exportAssetGlb } from '../src/core/editor/rv-asset-glb-export';
import { readGlbJson } from '../src/core/engine/rv-binary-resources';
import { stampJsonIdentity } from '../src/core/engine/rv-json-identity';
import { PATH_FIELDS } from '../src/core/engine/rv-node-path-rewrite.mjs';
import { storedPositionsOf, type WrittenGltfJson } from './helpers/stored-ref-walker';
import { node, sceneToGlb } from './helpers/migrate-769-fixtures';

type Json = WrittenGltfJson & { nodes: Array<{ name?: string; extras?: { realvirtual?: Record<string, unknown> } }> };

async function build(): Promise<ArrayBuffer> {
  const scene = new Scene();
  scene.name = 'Cell';
  const lamp = node('Lamp');
  // A second Enable step on the same node is stored under the `_1` key (the dedup convention).
  scene.add(lamp, node('Steps', { LogicStep_Enable: { Target: 'Lamp', Enable: false }, LogicStep_Enable_1: { Target: 'Lamp', Enable: true } }));
  return sceneToGlb(scene);
}

const enableOf = (json: Json): Record<string, unknown> =>
  json.nodes.find((n) => n.name === 'Steps')!.extras!.realvirtual!.LogicStep_Enable as Record<string, unknown>;
const idOf = (json: Json, name: string): string =>
  json.nodes.find((n) => n.name === name)!.extras!.realvirtual!.NodeId as string;

describe('plan-769 — LogicStep_Enable.Target is a path field', () => {
  it('is declared in PATH_FIELDS and visited as a reference position', async () => {
    expect(PATH_FIELDS.some((f: { component: string; field: string }) => f.component === 'LogicStep_Enable' && f.field === 'Target')).toBe(true);
    const json = readGlbJson(await build()) as Json;
    expect(storedPositionsOf(json).filter((p) => /LogicStep_Enable(_\d+)?\.Target/.test(p.where)).map((p) => [p.form, p.path]))
      .toEqual([['path', 'Lamp'], ['path', 'Lamp']]);
  });

  it('the scene save (JSON pass) writes it as the address of its target', async () => {
    const json = readGlbJson(await build()) as Json;
    stampJsonIdentity(json as unknown as Record<string, unknown>);
    expect(enableOf(json).Target).toEqual({ address: `#${idOf(json, 'Lamp')}` });
    expect(enableOf(json).Enable).toBe(false);
    const second = json.nodes.find((n) => n.name === 'Steps')!.extras!.realvirtual!.LogicStep_Enable_1 as Record<string, unknown>;
    expect(second.Target, 'the `_1` key is the same field').toEqual({ address: `#${idOf(json, 'Lamp')}` });
  });

  it('the editor export writes it as an address; the reader reaches the same node from the path and from the address', async () => {
    const original = await build();
    const first = await loadGLB('cell.glb', new Scene(), { data: original.slice(0), preserveHierarchy: true, loadKinematicsSidecar: false });
    const steps1 = first.root.getObjectByName('Steps')!;
    const lamp1 = first.registry.storedNode(steps1, 'Lamp');
    expect(lamp1?.name).toBe('Lamp');

    const saved = await exportAssetGlb(first.root, 'Cell', undefined, undefined, { registry: first.registry });
    const json = readGlbJson(saved) as Json;
    const target = enableOf(json).Target as { address?: string };
    expect(target).toEqual({ address: `#${idOf(json, 'Lamp')}` });

    const second = await loadGLB('cell-saved.glb', new Scene(), { data: saved.slice(0), preserveHierarchy: true, loadKinematicsSidecar: false });
    const steps2 = second.root.getObjectByName('Steps')!;
    const raw = (steps2.userData.realvirtual as { LogicStep_Enable: { Target: unknown } }).LogicStep_Enable.Target;
    const lamp2 = second.registry.storedNode(steps2, raw as { address: string });
    expect(lamp2?.name).toBe('Lamp');
  });
});
