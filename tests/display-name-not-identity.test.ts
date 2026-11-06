// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * contract-node-identity rule 13 — a display name is never identity.
 *
 * A document's display name ("Autonox DELTA RL5-1900-6kg (Kinematics)") is a
 * label. The editor's test run exported the scene under it, so the root of the
 * reloaded scene was renamed and every path below it moved: the restore found
 * none of its captured paths (Autonox demo, 6.7.1, 2026-11-06).
 *
 * Guarded here on the real exporter and the real loader: an export may write
 * the display name as the scene name (a label the planner shows), but node ids
 * and the paths below the root do not change with it; a round trip of the SAME
 * scene (`sceneName`) keeps the exact root name, wrapper names included. The
 * test run's restore itself is guarded in `in-place-test-session.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import { Object3D, Scene } from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { loadGLB } from '../src/core/engine/rv-scene-loader';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { identityIdOf } from '../src/core/engine/rv-decode-identity';
import { exportAssetGlb } from '../src/core/editor/rv-asset-glb-export';

/** A display name like the delivered demos carry: spaces, brackets, a different spelling. */
const DISPLAY_NAME = 'Delta Robot RL5 (Kinematics)';

async function toGlb(src: Scene): Promise<ArrayBuffer> {
  return (await new GLTFExporter().parseAsync(src, { binary: true })) as ArrayBuffer;
}

async function load(data: ArrayBuffer): Promise<Object3D> {
  const scene = new Scene();
  const result = await loadGLB('display-name.glb', scene, { data, preserveHierarchy: true });
  return result.root;
}

function sceneNameOf(buf: ArrayBuffer): string | undefined {
  const len = new DataView(buf).getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, len))) as { scenes: { name?: string }[] };
  return json.scenes[0].name;
}

function child(parent: Object3D, name: string): Object3D {
  const n = new Object3D();
  n.name = name;
  parent.add(n);
  return n;
}

/** Several top-level nodes, like the Autonox file: the loader keeps the glTF scene as the root. */
function deltaScene(name: string): Scene {
  const s = new Scene();
  s.name = name;
  const arm = child(s, 'AxisArm_000');
  child(arm, 'Link');
  child(s, 'DeltaMechanism').userData.realvirtual = { RuntimeMetadata: { annotation: 'mech' } };
  child(s, 'DeltaPaths');
  return s;
}

/** path below the root → node id, for every node. */
function pathsAndIds(root: Object3D): Map<string, string | null> {
  const out = new Map<string, string | null>();
  const rootPath = NodeRegistry.computeNodePath(root);
  root.traverse((n) => {
    if (n === root) return;
    out.set(NodeRegistry.computeNodePath(n).slice(rootPath.length + 1), identityIdOf(n));
  });
  return out;
}

describe('contract-node-identity rule 13 — a display name is never identity', () => {
  it('an export under a display name labels the scene, and no id or path below the root moves', async () => {
    const original = await load(await toGlb(deltaScene('Autonox-DELTA-RL5')));
    expect(original.name).toBe('Autonox-DELTA-RL5');
    const before = pathsAndIds(original);

    const bytes = await exportAssetGlb(original, DISPLAY_NAME);
    expect(sceneNameOf(bytes), 'the planner labels a placement by the scene name').toBe(DISPLAY_NAME);

    const reloaded = await load(bytes);
    expect(pathsAndIds(reloaded)).toEqual(before);
  });

  it('a round trip of the same scene keeps a real root name verbatim, whatever display name is passed', async () => {
    const original = await load(await toGlb(deltaScene('Autonox-DELTA-RL5')));
    const bytes = await exportAssetGlb(original, DISPLAY_NAME, undefined, undefined, { sceneName: original.name });
    expect(sceneNameOf(bytes)).toBe('Autonox-DELTA-RL5');
    const reloaded = await load(bytes);
    expect(reloaded.name).toBe('Autonox-DELTA-RL5');
    expect(pathsAndIds(reloaded)).toEqual(pathsAndIds(original));
  });

  it('a round trip of the same scene writes a wrapper-shaped root name verbatim too', async () => {
    const original = await load(await toGlb(deltaScene('AuxScene')));
    const bytes = await exportAssetGlb(original, DISPLAY_NAME, undefined, undefined, { sceneName: original.name });
    expect(sceneNameOf(bytes)).toBe(original.name);
    const reloaded = await load(bytes);
    expect(reloaded.name).toBe(original.name);
    expect(pathsAndIds(reloaded)).toEqual(pathsAndIds(original));
  });

  it('the caller names the scene; without a name a wrapper-shaped root falls back to Asset', async () => {
    const original = await load(await toGlb(deltaScene('AuxScene')));
    expect(sceneNameOf(await exportAssetGlb(original, 'Cell'))).toBe('Cell');
    expect(sceneNameOf(await exportAssetGlb(original))).toBe('Asset');
  });
});
