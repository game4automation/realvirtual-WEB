// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-590 §9 "Save/Reload" — a renamed signal survives GLB export and loading, and the path
 * references stay intact.
 *
 * The rename writes `rv_extras.<PLC*>.Name` and never the node name (plan Entscheidungs-Log: paths
 * stay stable). So after export → parse → the REAL loader traversal:
 *
 *  - the SignalStore registers the NEW name at the SAME node path, and the old name is gone;
 *  - a by-name string field (WebSensor.SignalBool) carries the new name;
 *  - a by-PATH reference (ComponentReference) is byte-for-byte what it was and still resolves to
 *    the signal node — which now answers to the new name.
 */

import { describe, expect, it } from 'vitest';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { Object3D } from 'three';
import { exportAssetGlb } from '../src/core/editor/rv-asset-glb-export';
import {
  field, makeRenameFixture, node, plc, planIn,
} from './helpers/signal-rename-fixture';
import { makeSyncFixture } from './helpers/signal-sync-fixture';

const PATH_REF = { type: 'ComponentReference', path: 'Asset/Start', componentType: 'PLCInputBool' };

function child(root: Object3D, name: string): Object3D | null {
  let hit: Object3D | null = null;
  root.traverse((n) => { if (!hit && n.name === name) hit = n; });
  return hit;
}

describe('plan-590 — renamed signal survives save / reload', () => {
  it('export → load: new name registered at the same path, old name gone, path refs intact', async () => {
    const f = makeRenameFixture((root) => {
      node('Start', root, plc('PLCInputBool', 'DB.Start'));
      node('Sensor', root, { WebSensor: { SignalBool: 'DB.Start' } });
      node('Lamp', root, { WebVisibility: { Signal: { ...PATH_REF } } });
    }, { connectNames: ['DB.Start'] });

    const result = await f.coordinator.apply(await planIn(f, 'Asset/Start', 'DB.Go'));
    expect(result.status).toBe('committed');
    expect(field(f, 'Asset/Start', 'PLCInputBool', 'Name')).toBe('DB.Go');

    // Save.
    const glb = await exportAssetGlb(f.root, 'Asset');
    const gltf = await new GLTFLoader().parseAsync(glb, '');
    const savedRoot = child(gltf.scene, 'Asset') ?? gltf.scene;

    // Reload through the REAL loader traversal (registry + SignalStore registration).
    const r = makeSyncFixture((root) => {
      for (const c of [...savedRoot.children]) root.add(c);
    });

    expect(r.store.getPath('DB.Go')).toBe('Asset/Start');
    expect(r.store.get('DB.Go')).not.toBeUndefined();
    expect(r.store.getPath('DB.Start')).toBeUndefined();
    expect(field(r, 'Asset/Start', 'PLCInputBool', 'Name')).toBe('DB.Go');
    // By-name reference: rewritten and persisted.
    expect(field(r, 'Asset/Sensor', 'WebSensor', 'SignalBool')).toBe('DB.Go');
    // By-path reference: untouched, and it still lands on the renamed signal node.
    const ref = field(r, 'Asset/Lamp', 'WebVisibility', 'Signal') as typeof PATH_REF;
    expect(ref).toEqual(PATH_REF);
    const target = r.registry.getNode(ref.path)!;
    expect(target).toBeTruthy();
    expect((target.userData.realvirtual as Record<string, Record<string, unknown>>).PLCInputBool.Name).toBe('DB.Go');
  });
});
