// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-734 — the core proof: a node that Three.js BOTH deduplicated AND
 * sanitized must stay resolvable under its authored glTF path.
 *
 * `detectRenamedNodes()` used to record the SANITIZED spelling of the original
 * name in `renamedNodes` for the dedup case. `registerNodeAliases()` builds its
 * alias path from exactly that value, so the alias for
 * `.../-Kettenrad 201-201-026-STD-005333:1/Volumenkoerper1` was published as
 * `.../-Kettenrad_201-201-026-STD-0053331/Volumenkoerper1` — a spelling nobody
 * ever queries. The authored path stayed unresolvable and `highlightStep()` /
 * `reveal()` silently did nothing.
 *
 * A hand-built `renamedNodes` map (as in `rv-node-path-aliases.test.ts:20-63`)
 * does NOT reproduce this: the bug lives in what the loader PUTS in the map.
 * The fixture therefore goes through real GLB bytes —
 * `GLTFExporter().parseAsync(src, { binary: true })` → `loadGLB(label, scene,
 * { data })` — which triggers Three.js' file-global dedup for real.
 * Vorlage: `tests/kinematic-fixture.ts:21-23`,
 * `tests/rv-authoring-hierarchy-invariant.test.ts:44-56`.
 */

import { describe, it, expect } from 'vitest';
import { Scene, Object3D, Mesh, BoxGeometry, MeshBasicMaterial } from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { loadGLB } from '../src/core/engine/rv-scene-loader';
import type { NodeRegistry } from '../src/core/engine/rv-node-registry';

async function toGlb(src: Scene): Promise<ArrayBuffer> {
  return (await new GLTFExporter().parseAsync(src, { binary: true })) as ArrayBuffer;
}

/** Export the authored scene to GLB bytes and load them back through `loadGLB`. */
async function roundtrip(src: Scene): Promise<{ registry: NodeRegistry; scene: Scene }> {
  const data = await toGlb(src);
  const scene = new Scene();
  const result = await loadGLB('dedup-alias.glb', scene, { data });
  return { registry: result.registry, scene };
}

/**
 * Two branches, each carrying a part whose RAW name contains a space AND a `:`
 * plus one leaf below it. Three.js sanitizes both to the same string, so the
 * second one additionally gets a `_1` dedup suffix.
 */
function buildCollidingScene(partName: string, leafName: string): Scene {
  const src = new Scene();
  for (const branch of ['Zweig1', 'Zweig2']) {
    const b = new Object3D();
    b.name = branch;
    const part = new Object3D();
    part.name = partName;
    const leaf = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
    leaf.name = leafName;
    part.add(leaf);
    b.add(part);
    src.add(b);
  }
  return src;
}

describe('GLB name dedup + sanitize (plan-734)', () => {
  it('resolves the authored path of a deduped AND sanitized node', async () => {
    const { registry } = await roundtrip(buildCollidingScene('A B:1', 'Volumen'));

    // Zweig1 wins the clean name (pure sanitization → restored in place).
    const first = registry.getNode('Zweig1/A B:1/Volumen');
    expect(first).not.toBeNull();

    // Zweig2 carries the `_1` dedup suffix and depends on the alias.
    const second = registry.getNode('Zweig2/A B:1/Volumen');
    expect(second).not.toBeNull();

    // …and the two must not collapse onto the same object.
    expect(first).not.toBe(second);
  });

  it('resolves the deduped node itself, not just its leaf', async () => {
    const { registry } = await roundtrip(buildCollidingScene('A B:1', 'Volumen'));
    const a = registry.getNode('Zweig1/A B:1');
    const b = registry.getNode('Zweig2/A B:1');
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toBe(b);
  });

  it('handles a raw name that already ends in a dedup-looking suffix', async () => {
    // Unity's AmbiguousReferenceNameFixer emits `_rv1`/`_rv2` suffixes that LOOK
    // like a Three.js dedup artefact but are part of the original name
    // (three.js issue #20843). Both branches carry the identical raw name, so
    // Three appends its own `_1` on top of the `_rv1`.
    const { registry } = await roundtrip(buildCollidingScene('Teil X:1_rv1', 'Volumen'));

    const first = registry.getNode('Zweig1/Teil X:1_rv1/Volumen');
    const second = registry.getNode('Zweig2/Teil X:1_rv1/Volumen');
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first).not.toBe(second);
  });

  it('the sanitized spelling stays resolvable too (both spellings aliased)', async () => {
    // Already-delivered content and internal callers may address either
    // spelling — F3 requires both to be registered.
    const { registry } = await roundtrip(buildCollidingScene('A B:1', 'Volumen'));
    expect(registry.getNode('Zweig1/A_B1/Volumen')).not.toBeNull();
    expect(registry.getNode('Zweig2/A_B1/Volumen')).not.toBeNull();
  });
});
