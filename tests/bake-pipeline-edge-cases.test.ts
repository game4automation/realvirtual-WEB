// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-754 §9.15 — the edges of the destructive pipeline.
 *
 *  - a model with NO component at all is pruned to root + static chunk and does
 *    not crash (R14: raw CAD is worked on in the editor, which never bakes);
 *  - the registry built in `init` contains exactly the template's paths, and no
 *    path of a node the bake removed;
 *  - a plugin claim keeps a bare CAD node addressable through the prune (D17);
 *  - `release()` is idempotent, and a released instance does not take the
 *    document graph with it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D, Scene } from 'three';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { loadGLB, type LoadGLBOptions, type LoadResult } from '../src/core/engine/rv-scene-loader';
import { BakeRegistry, RV_BAKE_CHUNK_KEY } from '../src/core/engine/rv-bake-registry';
import { createPickBuildPort } from '../src/core/engine/rv-pick-build-port';
import { bakeRemovalReport, _resetBakeRemovalReportForTesting } from '../src/core/engine/rv-bake-survival';


const material = new MeshStandardMaterial({ color: 0x778899 });

function box(name: string, x: number, extras?: Record<string, unknown>): Mesh {
  const m = new Mesh(new BoxGeometry(1, 1, 1), material.clone());
  m.name = name;
  m.position.x = x;
  if (extras) m.userData.realvirtual = extras;
  return m;
}

/** Raw CAD: not one rv component anywhere. */
function buildRawCad(): Group {
  const root = new Group();
  root.name = 'RawCad';
  const sub = new Group(); sub.name = 'Assembly';
  sub.add(box('PartA', 0), box('PartB', 2));
  root.add(sub);
  root.add(box('PartC', 4));
  return root;
}

function buildMixed(): Group {
  const root = new Group();
  root.name = 'Cell';
  const cad = new Group(); cad.name = 'Cad'; cad.add(box('Bolt', 1));
  root.add(cad);
  const axis = new Group(); axis.name = 'Axis';
  axis.userData.realvirtual = { Drive: { Direction: 'LinearY' } };
  axis.add(box('Arm', 5));
  root.add(axis);
  return root;
}

let rawBytes: ArrayBuffer;
let mixedBytes: ArrayBuffer;
beforeAll(async () => {
  rawBytes = await objectToGlb(buildRawCad());
  mixedBytes = await objectToGlb(buildMixed());
});

async function load(bytes: ArrayBuffer, name: string, opts: Partial<LoadGLBOptions> = {}): Promise<LoadResult> {
  _resetBakeRemovalReportForTesting();
  const result = await loadGLB(name, new Scene(), {
    data: bytes.slice(0),
    loadKinematicsSidecar: false,
    bakeRegistry: new BakeRegistry(),
    bakePickPort: createPickBuildPort({ createWorker: () => null }),
    ...opts,
  });
  return result;
}

function names(root: Object3D): string[] {
  const out: string[] = [];
  root.traverse((n) => { if (!n.userData[RV_BAKE_CHUNK_KEY]) out.push(n.name); });
  return out;
}

describe('destructive pipeline edge cases (plan-754 §9.15)', () => {
  it('a model without ANY component: root + static chunk, no crash (R14)', async () => {
    const result = await load(rawBytes, 'raw.glb');
    expect(result.bakedAsset).toBeTruthy();
    // Exactly what D4 says, and what R14 accepts: the bake root survives
    // ('AuxScene' is the glTF scene node the exporter writes) and every node
    // under it is unclaimed, so the whole assembly becomes one static chunk.
    expect(names(result.root)).toEqual(['AuxScene']);
    let chunks = 0;
    result.root.traverse((n) => { if (n.userData[RV_BAKE_CHUNK_KEY]) chunks++; });
    expect(chunks).toBeGreaterThan(0);
    expect(result.triangleCount).toBeGreaterThan(0);
    expect(result.boundingBox.isEmpty()).toBe(false);
  });

  it('the registry holds exactly the template paths — no path of a removed node', async () => {
    const result = await load(mixedBytes, 'mixed.glb');
    const report = bakeRemovalReport[0];
    expect(report.removalTops.length).toBeGreaterThan(0);
    for (const removed of report.removalTops) {
      expect(result.registry.getNode(removed), removed).toBeNull();
    }
    // Every path the registry knows resolves to a node the plain traverse sees.
    const live = new Set<Object3D>();
    result.root.traverse((n) => live.add(n));
    result.registry.forEachNode((path, node) => {
      expect(live.has(node), path).toBe(true);
    });
  });

  it('a plugin claim keeps a bare CAD node addressable through the prune (D17)', async () => {
    const claimed = await load(mixedBytes, 'mixed.glb', {
      bakeClaims: [{ path: 'Cell/Cad/Bolt', role: 'merge' }],
    });
    expect(names(claimed.root)).toContain('Bolt');
    expect(claimed.registry.getNode('Cell/Cad/Bolt')).toBeTruthy();
    expect(bakeRemovalReport[0].unresolvedClaims).toEqual([]);

    // Without the claim the same node is gone.
    const plain = await load(mixedBytes, 'mixed.glb');
    expect(names(plain.root)).not.toContain('Bolt');
  });

  it('an unresolved claim is reported, never thrown — malformed ones too', async () => {
    const result = await load(mixedBytes, 'mixed.glb', {
      bakeClaims: [
        { path: 'Cell/DoesNotExist', role: 'chunk' },
        { path: undefined as unknown as string, role: 'merge' },
      ],
    });
    expect(result.bakedAsset).toBeTruthy();
    expect(bakeRemovalReport[0].counts.unresolvedClaims).toBe(2);
  });

  it('release is idempotent and leaves the document graph standing', async () => {
    const bakeRegistry = new BakeRegistry();
    const result = await load(mixedBytes, 'mixed.glb', { bakeRegistry });
    const instance = result.bakeInstance!;
    bakeRegistry.release(instance);
    bakeRegistry.release(instance);
    expect(names(result.root)).toContain('Axis');
    expect(bakeRegistry.pickMeshes.length).toBe(0);
  });
});
