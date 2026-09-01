// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-734 F8 — the load reports what alias registration actually did.
 *
 * Until now the phase logged one line with two numbers, no timing and no
 * mention of what it threw away, and its cost fell into the NEXT profiler
 * marker. On a customer model with tens of thousands of name collisions that
 * made it impossible to say whether the phase was cheap, expensive, or quietly
 * dropping aliases over live nodes.
 *
 * `droppedAliases` is the one to watch: `registerAlias` gives up when the path
 * is already claimed, which is correct, but a dropped alias is exactly how a
 * node stops being reachable under its authored path.
 */

import { describe, it, expect } from 'vitest';
import { Scene, Object3D, Mesh, BoxGeometry, MeshBasicMaterial } from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { loadGLB, registerNodeAliases } from '../src/core/engine/rv-scene-loader';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';

function child(parent: Object3D, name: string): Object3D {
  const node = new Object3D();
  node.name = name;
  parent.add(node);
  return node;
}

function registerAll(registry: NodeRegistry, root: Object3D): void {
  root.traverse((node) => {
    const path = NodeRegistry.computeNodePath(node);
    if (path) registry.registerNode(path, node);
  });
}

describe('AliasStats (plan-734 F8)', () => {
  it('is all zeroes when nothing was renamed', () => {
    const stats = registerNodeAliases(new Map(), new NodeRegistry(), new SignalStore());
    expect(stats.nodeAliases).toBe(0);
    expect(stats.signalAliases).toBe(0);
    expect(stats.droppedAliases).toBe(0);
    expect(stats.largestSuffixBucket).toEqual({ suffix: '', count: 0 });
    expect(stats.ms).toBeGreaterThanOrEqual(0);
  });

  it('counts node aliases across the whole renamed subtree', () => {
    const scene = new Scene();
    const line = child(scene, 'Line');
    const renamed = child(line, 'Pusher_1');
    child(child(renamed, 'Grip'), 'tip');

    const registry = new NodeRegistry();
    registerAll(registry, line);
    const stats = registerNodeAliases(
      new Map([[renamed, 'Pusher']]), registry, new SignalStore(),
    );

    // Pusher + Grip + tip.
    expect(stats.nodeAliases).toBe(3);
    expect(stats.droppedAliases).toBe(0);
  });

  it('counts BOTH spellings when the raw name carries reserved characters', () => {
    const scene = new Scene();
    const line = child(scene, 'Line');
    const renamed = child(line, '-Kettenrad_2011_1');
    child(renamed, 'Volumen');

    const registry = new NodeRegistry();
    registerAll(registry, line);
    const stats = registerNodeAliases(
      new Map([[renamed, '-Kettenrad 201:1']]), registry, new SignalStore(),
    );

    // 2 nodes × 2 spellings.
    expect(stats.nodeAliases).toBe(4);
    expect(stats.droppedAliases).toBe(0);
  });

  it('counts an alias that registerAlias discarded', () => {
    // `Line/Pusher` is already a real node's canonical path, so the alias the
    // deduped sibling wants for it cannot be published.
    const scene = new Scene();
    const line = child(scene, 'Line');
    child(line, 'Pusher');
    const renamed = child(line, 'Pusher_1');

    const registry = new NodeRegistry();
    registerAll(registry, line);
    const stats = registerNodeAliases(
      new Map([[renamed, 'Pusher']]), registry, new SignalStore(),
    );

    expect(stats.nodeAliases).toBe(0);
    expect(stats.droppedAliases).toBe(1);
  });

  it('reports the most-claimed alias leaf', () => {
    const scene = new Scene();
    const line = child(scene, 'Line');
    for (const branch of ['A_1', 'B_1', 'C_1']) {
      const renamed = child(line, branch);
      child(renamed, 'Volumen');
    }
    const registry = new NodeRegistry();
    registerAll(registry, line);

    const renamedMap = new Map<Object3D, string>();
    for (const [i, branch] of ['A_1', 'B_1', 'C_1'].entries()) {
      renamedMap.set(line.children[i], branch.replace('_1', ''));
    }
    const stats = registerNodeAliases(renamedMap, registry, new SignalStore());

    // Three subtrees each contribute one `Volumen` alias.
    expect(stats.largestSuffixBucket).toEqual({ suffix: 'Volumen', count: 3 });
  });

  it('rides along on LoadResult after a real GLB load', async () => {
    const src = new Scene();
    for (const branch of ['Zweig1', 'Zweig2']) {
      const b = child(src, branch);
      const part = child(b, 'A B:1');
      const leaf = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
      leaf.name = 'Volumen';
      part.add(leaf);
    }
    const data = (await new GLTFExporter().parseAsync(src, { binary: true })) as ArrayBuffer;
    const result = await loadGLB('alias-stats.glb', new Scene(), { data });

    expect(result.aliasStats).toBeDefined();
    expect(result.aliasStats!.nodeAliases).toBeGreaterThan(0);
    expect(result.aliasStats!.ms).toBeGreaterThanOrEqual(0);
    expect(result.aliasStats!.largestSuffixBucket.count).toBeGreaterThan(0);
  });
});
