// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>
import { describe, expect, it } from 'vitest';
import { BoxGeometry, Mesh, MeshStandardMaterial, Object3D, Vector3 } from 'three';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { setNodeId } from '../src/core/engine/rv-node-id';
import { chunkMetaOf, type BakedAsset, type BakedChunk } from '../src/core/engine/rv-bake-chunk';
import { exportRuntimeStage, type RuntimeStageInput, type RuntimeStageSnapshot } from '../src/core/usd/runtime-stage-export';
import { collectStageInput, type StageInputModel } from '../src/core/usd/collect-stage-input';
import { RVSource } from '../src/core/engine/rv-source';
import { RVMovingUnit } from '../src/core/engine/rv-mu';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import { mountPrims } from './helpers/usd-live-link-stage';
import { primIdentityAddress, primIdentityForNode } from '../src/core/usd/usd-prim-identity';

function named(name: string, id?: string): Object3D {
  const node = new Object3D(); node.name = name; if (id) setNodeId(node, id); return node;
}
function rig() {
  const root = named('Cell', 'cell'), registry = new NodeRegistry();
  const input: RuntimeStageInput = { root, registry, templates: [], exclude: new Set(), preplaced: [] };
  return { root, registry, input };
}
function address(stage: RuntimeStageSnapshot, node: Object3D): string | null {
  return stage.addresses[stage.indexOf.get(node)!];
}
function metadata(stage: RuntimeStageSnapshot, node: Object3D): string {
  return mountPrims(stage.usdz).get(stage.primPaths[stage.indexOf.get(node)!])!;
}

describe('Live-Link registry identities in the mount snapshot', () => {
  it('uses local addresses and full occurrence chains for repeated and nested placements', async () => {
    const { root, registry, input } = rig(); registry.registerDocument(root);
    const placed: Object3D[] = [];
    for (const occurrence of ['p', 'q', 'p/b']) {
      const wrapper = named('Placement'), content = named('Body', 'same-id');
      wrapper.add(content); root.add(wrapper); placed.push(content);
      registry.registerOccurrence(wrapper, occurrence, { contentRoot: content });
    }
    const stage = await exportRuntimeStage(input);
    expect(stage.addresses).toHaveLength(stage.nodes.length);
    expect(stage.identities).toHaveLength(stage.nodes.length);
    expect(address(stage, root)).toBe('#cell');
    expect(metadata(stage, root)).toContain('string address = "#cell"');
    placed.forEach((node, i) => {
      const expected = `${['p', 'q', 'p/b'][i]}#same-id`;
      expect(address(stage, node)).toBe(expected);
      expect(metadata(stage, node)).toContain(`string address = "${expected}"`);
    });
  });
  it('labels partitions and chunks from the nearest addressed boundary, preserving opaque keys', async () => {
    const { root, registry, input } = rig();
    const boundary = named('Mover', 'mover'), bridge = named('Unaddressed'), partition = named('Renamed');
    partition.userData = { _rvSynthetic: true, _rvOrigName: 'opaque/raw|key' };
    const chunk = new Mesh(new BoxGeometry(), new MeshStandardMaterial()); chunk.name = 'Chunk';
    root.add(boundary); boundary.add(bridge); bridge.add(partition); partition.add(chunk);
    registry.registerDocument(root);
    chunkMetaOf.set(chunk.geometry, { chunk: {} as BakedChunk, asset: {} as BakedAsset });
    try {
      const stage = await exportRuntimeStage(input);
      expect(address(stage, partition)).toBe('runtime:partition@#mover/opaque/raw|key');
      expect(address(stage, chunk)).toBe('runtime:chunk@#mover');
      expect(metadata(stage, partition)).toContain('string partition = "opaque/raw|key"');
      expect(metadata(stage, partition)).toContain('string runtime = "partition"');
      expect(metadata(stage, chunk)).toContain('string runtime = "chunk"');
      for (const node of [partition, chunk]) {
        expect(metadata(stage, node)).toContain('string origin = "#mover"');
        expect(metadata(stage, node)).not.toContain('string address');
      }
      expect(chunk.parent).toBe(partition); expect(partition.parent).toBe(bridge);
    } finally { chunkMetaOf.delete(chunk.geometry); }
  });
  it('keeps every template descendant free of customData while exposing template addresses in the snapshot', async () => {
    const { root, registry, input } = rig();
    const template = named('Template', 'template'), child = named('Child', 'child'), nested = named('Nested', 'nested');
    root.add(template); template.add(child); child.add(nested); template.visible = false;
    registry.registerDocument(root);
    input.templates = [template, child, named('NotExported', 'missing')];
    const stage = await exportRuntimeStage(input);
    expect(stage.templateAddresses).toEqual(['#template', '#child', null]);
    expect(stage.templates[2]).toBe('');
    for (const node of [template, child, nested]) {
      expect(address(stage, node)).toBe(`#${node.name.toLowerCase()}`);
      expect(metadata(stage, node)).not.toContain('customData');
    }
    expect(metadata(stage, root)).toContain('dictionary realvirtual');
    expect(template.visible).toBe(false);
  });
  it('marks preplaced MUs by their own address and never gives an unregistered clone its copied NodeId', async () => {
    const { root, registry, input } = rig();
    const pre = named('Pallet', 'own'), template = named('Template', 'template');
    root.add(pre, template); registry.registerDocument(root);
    const clone = template.clone(); clone.name = 'Copied'; root.add(clone);
    input.preplaced = [{ muId: 9, node: pre }];
    const stage = await exportRuntimeStage(input);
    expect(address(stage, pre)).toBe('runtime:mu@#own');
    expect(metadata(stage, pre)).toContain('string runtime = "mu"');
    expect(metadata(stage, pre)).toContain('string address = "#own"');
    expect(metadata(stage, pre)).not.toContain('string template');
    expect(address(stage, clone)).toBeNull();
    expect(primIdentityAddress(primIdentityForNode(clone, registry, {
      mu: { preplaced: false, template },
    }))).toBe('runtime:mu@#template');
    expect(metadata(stage, clone)).not.toContain('customData');
    expect(stage.preplaced).toEqual([{ muId: 9, nodeIndex: stage.indexOf.get(pre) }]);
  });
  it('passes the real model registry through collection and excludes spawned MUs with copied identity', async () => {
    const { root, registry } = rig();
    const template = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
    template.name = 'Template'; setNodeId(template, 'template'); root.add(template);
    registry.registerDocument(root);
    const clone = template.clone(); root.add(clone);
    const spawned = new RVMovingUnit(clone, '', new Vector3(1, 1, 1));
    const transportManager = new RVTransportManager();
    // The inventory is sufficient here; source marker construction needs a DOM.
    const source = new RVSource(named('Source')); source.muTemplate = template;
    transportManager.sources.push(source);
    transportManager.mus.push(spawned);
    const model: StageInputModel = { root, registry, transportManager };
    const collected = collectStageInput(model);
    expect(collected.input.registry).toBe(registry);
    const stage = await exportRuntimeStage(collected.input);
    expect(stage.indexOf.has(spawned.node)).toBe(false);
    expect(stage.templateAddresses).toEqual(['#template']);
    expect(metadata(stage, template)).not.toContain('customData');
  });
  it('does not guess missing addresses or origins and captures identity before async export', async () => {
    const { root, registry, input } = rig();
    const partition = named('Partition'); partition.userData._rvSynthetic = true; root.add(partition);
    const unresolved = await exportRuntimeStage(input);
    expect(unresolved.addresses).toEqual([null, null]);
    for (const node of unresolved.nodes) expect(metadata(unresolved, node)).not.toContain('customData');
    registry.registerDocument(root);
    const stage = await exportRuntimeStage(input, { onTreeBuilt: () => {
      partition.removeFromParent(); registry.getAddressForNode = () => '#changed-after-snapshot';
    } });
    expect(address(stage, root)).toBe('#cell');
    expect(address(stage, partition)).toBe('runtime:partition@#cell/Partition');
    expect(metadata(stage, partition)).toContain('string origin = "#cell"');
  });
});
