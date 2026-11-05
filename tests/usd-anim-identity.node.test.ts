// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>
import { describe, expect, it } from 'vitest';
import { BoxGeometry, Mesh, MeshStandardMaterial, Object3D, AnimationClip, VectorKeyframeTrack } from 'three';
import { USDZExporter } from 'three/examples/jsm/exporters/USDZExporter.js';
import { unzipSync, strFromU8 } from 'three/examples/jsm/libs/fflate.module.js';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { setNodeId } from '../src/core/engine/rv-node-id';
import { chunkMetaOf, type BakedAsset, type BakedChunk } from '../src/core/engine/rv-bake-chunk';
import { buildRuntimeStageTree } from '../src/core/usd/runtime-stage-export';
import { primIdentityForNode } from '../src/core/usd/usd-prim-identity';
import { postProcessModelUsda, type PrimPostData } from '../src/core/usd/usd-stage-post';

function named(name: string, id?: string): Object3D { const n = new Object3D(); n.name = name; if (id) setNodeId(n, id); return n; }

describe('USD address identity', () => {
  it('uses registry addresses, preserving the complete occurrence chain for repeated placements', () => {
    const reg = new NodeRegistry(), root = named('Cell', 'root'), own = named('Material_42', 'Material_42');
    root.add(own); reg.registerDocument(root);
    expect(primIdentityForNode(own, reg)).toEqual({ address: '#Material_42' });
    for (const occurrence of ['p', 'q', 'p/b']) {
      const wrapper = named('Placement'), content = named('Part', 'same-id'); wrapper.add(content);
      reg.registerOccurrence(wrapper, occurrence, { contentRoot: content });
      expect(primIdentityForNode(content, reg)).toEqual({ address: `${occurrence}#same-id` });
    }
    const unknown = named('Cell/Material_42', 'not-registered');
    expect(primIdentityForNode(unknown, reg)).toBeUndefined();
    expect(primIdentityForNode(own, reg, { writeAddresses: false })).toBeUndefined();
  });
  it('partitions and chunks have runtime/origin, never an identity or parsed chunk key', () => {
    const reg = new NodeRegistry(), root = named('Mover', 'mover'), partition = named('display-name');
    partition.userData = { _rvSynthetic: true, _rvOrigName: 'partition/raw|key' };
    const chunk = new Mesh(new BoxGeometry(), new MeshStandardMaterial()); root.add(partition); partition.add(chunk);
    chunkMetaOf.set(chunk.geometry, { chunk: {} as BakedChunk, asset: {} as BakedAsset });
    reg.registerDocument(root);
    expect(primIdentityForNode(partition, reg)).toEqual({ runtime: 'partition', partition: 'partition/raw|key', origin: '#mover' });
    expect(primIdentityForNode(chunk, reg)).toEqual({ runtime: 'chunk', origin: '#mover' });
    partition.removeFromParent(); expect(primIdentityForNode(partition, reg)).toBeUndefined();
    chunkMetaOf.delete(chunk.geometry);
  });
  it('spawned MUs use template address; preplaced MUs use their own address, including without a source', () => {
    const reg = new NodeRegistry(), root = named('Cell', 'root'), template = named('Template', 'template'), pre = named('Preplaced', 'own');
    root.add(template, pre); reg.registerDocument(root);
    const clone = named('Clone', 'copied-but-not-indexed');
    expect(primIdentityForNode(clone, reg, { mu: { preplaced: false, template } })).toEqual({ runtime: 'mu', template: '#template' });
    expect(primIdentityForNode(pre, reg, { mu: { preplaced: true } })).toEqual({ runtime: 'mu', address: '#own' });
    expect(primIdentityForNode(clone, reg, { mu: { preplaced: false } })).toBeUndefined();
    expect(primIdentityForNode(pre, reg, { mu: { preplaced: true }, writeAddresses: false })).toBeUndefined();
  });
});

describe('real exporter post-pass', () => {
  it('multi-material mesh, child Geometry, metadata and existing TRS samples remain in the same def block', async () => {
    const root = named('Cell', 'cell');
    const mesh = new Mesh(new BoxGeometry(), [new MeshStandardMaterial(), new MeshStandardMaterial()]); mesh.name = 'Part'; setNodeId(mesh, 'Texture_42_map');
    mesh.add(named('Geometry', 'child')); root.add(mesh);
    const reg = new NodeRegistry(); reg.registerDocument(root);
    const tree = buildRuntimeStageTree({ root, templates: [], preplaced: [], exclude: new Set() }, { primNames: 'sibling' });
    const target = tree.scene.children[0].children[0]; target.matrix.decompose(target.position, target.quaternion, target.scale);
    const clip = new AnimationClip('test', 1, [new VectorKeyframeTrack(`${target.uuid}.position`, [0, 1], [0, 0, 0, 1, 0, 0])]);
    const bytes = await new USDZExporter().parseAsync(tree.scene, { animations: [clip], animationFrameRate: 30, includeAnchoringProperties: false });
    const files = unzipSync(new Uint8Array(bytes)), raw = strFromU8(files['model.usda']);
    const prims = new Map<number, PrimPostData>(tree.nodes.map((node, i) => [i, { customData: primIdentityForNode(node, reg) }]));
    prims.get(1)!.visibilitySamples = [[0, 'invisible'], [1, 'inherited'], [30, 'invisible']];
    const opts = { finalNames: tree.finalNames!, prims };
    const post = postProcessModelUsda(raw, opts);
    expect(post.text).toBe(postProcessModelUsda(raw, opts).text);
    expect(post.renamed).toBe(3); expect(post.unmatched).toEqual([]);
    expect(post.text).toContain('def Xform "Geometry_1"'); expect(post.text).toContain('def Mesh "Geometry"');
    expect(post.text).toContain('string address = "#Texture_42_map"');
    const part = post.text.slice(post.text.indexOf('def Xform "Part"'), post.text.indexOf('def Mesh "Geometry"'));
    expect(part).toContain('xformOp:translate.timeSamples'); expect(part).toContain('visibility.timeSamples');
    expect(post.text.match(/xformOp:translate.timeSamples[\s\S]*?\}/)?.[0]).toBe(raw.match(/xformOp:translate.timeSamples[\s\S]*?\}/)?.[0]);
    expect(post.text).not.toContain('over ');
    expect(Object.keys(files).filter((k) => k.endsWith('.usda') && !k.startsWith('geometries/'))).toEqual(['model.usda']);
    expect(post.text.match(/rel material:binding[^\n]*/g)).toEqual(raw.match(/rel material:binding[^\n]*/g));
    expect(postProcessModelUsda(raw, { ...opts, writeAddresses: false }).text).not.toContain('dictionary realvirtual');
  });
  it('supports metadata/no metadata, same-line bodies, escaping, and preserves non-def occurrences', () => {
    const raw = '#usda 1.0\ndef Xform "_rvN0" (prepend references = @./geometry.usda@</Geometry>) {\n string note = "def Xform \\"_rvN1\\" {"\n def Xform "_rvN1" { }\n}\n';
    const post = postProcessModelUsda(raw, { finalNames: ['Material_42', 'Child'], prims: new Map([[0, { customData: { address: '#quote"\\\n' } }], [1, { visibility: 'invisible' }]]) });
    expect(post.text).toContain('@./geometry.usda@</Geometry>');
    expect(post.text).toContain('string address = "#quote\\"\\\\\\n"');
    expect(post.text).toContain('def Xform "Child" {\n \ttoken visibility = "invisible"');
    expect(post.text).toContain('def Xform \\"_rvN1\\"');
  });
  it('merges customData and existing realvirtual dictionaries without duplicate metadata', () => {
    const raw = 'def Xform "_rvN0" (customData = { string other = "kept" dictionary realvirtual = { string address = "#old" string extra = "kept" } }) { }';
    const post = postProcessModelUsda(raw, { finalNames: ['A'], prims: new Map([[0, { customData: { runtime: 'mu', address: '#new' } }]]) }).text;
    expect(post.match(/customData/g)).toHaveLength(1); expect(post.match(/dictionary realvirtual/g)).toHaveLength(1);
    expect(post).toContain('address = "#new"'); expect(post).toContain('runtime = "mu"'); expect(post).toContain('extra = "kept"');
    const rawOther = 'def Xform "_rvN0" (customData = { dictionary other = { string x = "kept" } }) { }';
    expect(postProcessModelUsda(rawOther, { finalNames: ['A'], prims: new Map([[0, { customData: { address: '#a' } }]]) }).text).toContain('dictionary realvirtual');
  });
  it('fails explicitly on exporter placeholder drift, duplicates, malformed blocks and invalid visibility', () => {
    expect(() => postProcessModelUsda('def Xform "_rvN0" {}', { finalNames: ['A', 'B'] })).toThrow('omitted');
    expect(() => postProcessModelUsda('def Xform "_rvN0" {} def Xform "_rvN0" {}', { finalNames: ['A'] })).toThrow('repeated');
    expect(() => postProcessModelUsda('def Xform "_rvN0" (', { finalNames: ['A'] })).toThrow('Unclosed');
    expect(() => postProcessModelUsda('def Xform "_rvN0" {}', { finalNames: ['A'], prims: new Map([[0, { visibilitySamples: [[2, 'invisible'], [1, 'inherited']] }]]) })).toThrow('visibility');
  });
});
