// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-774 § 9.3 — every surviving node of a baked instance carries its
 * TEMPLATE node's identity (`identityIdOf`).
 *
 * That is what lets an instance override written by the editor
 * (`AssetOverrides.byAddress['#<id>']`, plan-774 F1) find its node again after a
 * reopen: `BakeRegistry.applyOverrides` resolves the address against the
 * instance, so an instance node whose identity differed from the template's
 * would turn every saved override into an orphan. Authored ids (`NodeId`) and
 * decode-seeded ids (nodes a Unity export leaves without one) are both covered.
 *
 * Node environment: the ModelCache decode → bake → `BakeRegistry.instantiate`
 * path runs without a renderer (fake loader, inline pick build).
 */
import { describe, it, expect } from 'vitest';
import { BoxGeometry, Mesh, MeshStandardMaterial, type Group, type Object3D } from 'three';
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import '../src/core/engine/rv-scene-loader';
import { ModelCache } from '../src/core/engine/rv-model-cache';
import { BakeRegistry } from '../src/core/engine/rv-bake-registry';
import { RVUberMaterial } from '../src/core/engine/rv-uber-material';
import { createPickBuildPort } from '../src/core/engine/rv-pick-build-port';
import { identityIdOf, seededNodeIdOf } from '../src/core/engine/rv-decode-identity';
import { setNodeId } from '../src/core/engine/rv-node-id';
import { RV_SEEDED_NODE_ID_KEY } from '../src/core/engine/rv-authored-keys';
import { group, withComponent } from './fixtures/bake-fixture';

const URL = 'blob:rv-test/p774-identity-cell.glb';
const SLIDE_ID = 'nid-slide';

/** The nested-placement INNER Cell, plus an un-id'd Drive under the Slide (a seeded identity). */
function makeCell(): Group {
  const root = group('Cell');
  const body = new Mesh(new BoxGeometry(1, 0.5, 1), new MeshStandardMaterial({ color: 0x336699 }));
  body.name = 'Body';
  root.add(body);
  const slide = withComponent(group('Slide'), 'Drive', { Direction: 'LinearX', TargetSpeed: 200 });
  setNodeId(slide, SLIDE_ID);
  const tool = new Mesh(new BoxGeometry(0.2, 0.2, 0.2), new MeshStandardMaterial({ color: 0x99cc33 }));
  tool.name = 'Tool';
  slide.add(tool);
  const pusher = withComponent(group('Pusher'), 'Drive', { Direction: 'LinearY', TargetSpeed: 50 });
  // No authored NodeId: the GLB parse seeds one from the authored path
  // (`rv-json-identity.ts`). This fake loader hands over a tree without
  // parsing, so the seed is stamped the way that parse leaves it.
  pusher.userData[RV_SEEDED_NODE_ID_KEY] = 'seed-cell-slide-pusher';
  slide.add(pusher);
  root.add(slide);
  return root;
}

function makeCache(): ModelCache {
  const uber = new RVUberMaterial(false);
  const loader = { loadAsync: async (): Promise<{ scene: Group }> => ({ scene: makeCell() }) } as unknown as GLTFLoader;
  return new ModelCache(loader, { uber: () => uber, pickPort: () => createPickBuildPort({ createWorker: () => null }) });
}

function byName(root: Object3D, name: string): Object3D | null {
  let hit: Object3D | null = null;
  root.traverse((n) => { if (!hit && n.name === name) hit = n; });
  return hit;
}

describe('plan-774 9.3 — instance identity matches the template', () => {
  it('every surviving instance node has its template node\'s identityIdOf (authored and seeded)', async () => {
    const cache = makeCache();
    const baked = await cache.getOrLoadBaked(URL);
    const registry = new BakeRegistry();
    const placementRoot = group('Cell_1');
    const instance = registry.instantiate(baked, placementRoot);

    let compared = 0;
    for (const [template, node] of instance.nodeOf) {
      // The asset root maps onto the PLACEMENT node, which is the referencing
      // file's own node and carries that file's identity.
      if (template === baked.template) continue;
      expect(identityIdOf(node), `identity of ${node.name}`).toBe(identityIdOf(template));
      expect(identityIdOf(node), `${node.name} has an identity`).toBeTruthy();
      compared++;
    }
    expect(compared, 'surviving nodes compared').toBeGreaterThanOrEqual(2);

    const slide = byName(placementRoot, 'Slide');
    const pusher = byName(placementRoot, 'Pusher');
    expect(slide && identityIdOf(slide)).toBe(SLIDE_ID);
    expect(pusher, 'the un-id\'d Drive node survives the bake').not.toBeNull();
    expect(seededNodeIdOf(pusher!), 'its identity is the decode seed').toBeTruthy();
    expect(identityIdOf(pusher!)).toBe(identityIdOf(byName(baked.template, 'Pusher')!));

    // A second instance of the same asset: the same identities, so one address
    // means the same node in every placement.
    const second = registry.instantiate(baked, group('Cell_2'));
    for (const [template, node] of second.nodeOf) {
      if (template === baked.template) continue;
      expect(identityIdOf(node)).toBe(identityIdOf(instance.nodeOf.get(template)!));
    }
  });
});
