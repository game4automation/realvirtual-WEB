// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-599 §9.6 — the generic runtime-visual marker `userData._rvRuntimeVisual`.
 *
 * Any node a plugin builds from extras at load time and tags with the marker
 * (here: a plane + an overlay plane under an authored empty node) is pruned by
 * the export, so save → reload → rebuild → save does not grow the file.
 * No component is involved — the marker is the whole contract.
 */
import { describe, it, expect } from 'vitest';
import { BoxGeometry, CanvasTexture, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, Object3D, PlaneGeometry } from 'three';
import { exportAssetGlb, pruneRuntimeHelpers } from '../src/core/editor/rv-asset-glb-export';
import { gltfLoader } from '../src/core/engine/rv-glb-parse';
import { parseGlbChunks } from '../src/core/persistence/rv-glb-chunks';

interface GltfJson {
  nodes?: Array<{ name?: string; mesh?: number; extras?: Record<string, unknown> }>;
  meshes?: unknown[];
  textures?: unknown[];
  images?: unknown[];
  accessors?: unknown;
  bufferViews?: unknown;
}

const EXTRAS = { Width: 0.4, Height: 0.3 };

function buildDoc(): Group {
  const root = new Group();
  root.name = 'RuntimeVisualDoc';
  const frame = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ color: 0x777777 }));
  frame.name = 'Frame';
  root.add(frame);
  const host = new Object3D();
  host.name = 'Host';
  host.position.set(0, 1, 0.5);
  host.userData.realvirtual = { SomeMarker: { ...EXTRAS } };
  root.add(host);
  return root;
}

/** What a plugin would do at load: build two runtime planes under every host. */
function buildRuntimeVisuals(root: Object3D): number {
  let built = 0;
  const hosts: Object3D[] = [];
  root.traverse((n) => { if ((n.userData.realvirtual as Record<string, unknown> | undefined)?.SomeMarker) hosts.push(n); });
  for (const h of hosts) {
    const screen = new Mesh(new PlaneGeometry(0.4, 0.3), new MeshBasicMaterial({ color: 0x00ff00 }));
    screen.name = '__runtimeScreen';
    screen.userData._rvRuntimeVisual = true;
    const canvas = document.createElement('canvas');
    canvas.width = 64; canvas.height = 48;
    const overlay = new Mesh(new PlaneGeometry(0.4, 0.3), new MeshBasicMaterial({ map: new CanvasTexture(canvas), transparent: true }));
    overlay.name = '__runtimeOverlay';
    overlay.userData._rvRuntimeVisual = true;
    screen.add(overlay);
    h.add(screen);
    built += 2;
  }
  return built;
}

function json(bytes: ArrayBuffer): GltfJson {
  return parseGlbChunks(bytes).json as GltfJson;
}

describe('generic _rvRuntimeVisual export prune (plan-599 §9.6)', () => {
  it('pruneRuntimeHelpers removes marked nodes (with their subtree) and keeps the host', () => {
    const root = buildDoc();
    expect(buildRuntimeVisuals(root)).toBe(2);
    pruneRuntimeHelpers(root);
    const names: string[] = [];
    root.traverse((n) => names.push(n.name));
    expect(names).toContain('Host');
    expect(names).not.toContain('__runtimeScreen');
    expect(names).not.toContain('__runtimeOverlay');
  });

  it('a non-true marker value is not a prune signal', () => {
    const root = buildDoc();
    const m = new Mesh(new BoxGeometry(0.1, 0.1, 0.1), new MeshBasicMaterial());
    m.name = 'Authored';
    m.userData._rvRuntimeVisual = 'yes';
    root.add(m);
    pruneRuntimeHelpers(root);
    const names: string[] = [];
    root.traverse((n) => names.push(n.name));
    expect(names).toContain('Authored');
  });

  it('save → reload → rebuild → save does not grow the file', async () => {
    const root = buildDoc();
    buildRuntimeVisuals(root);
    const first = await exportAssetGlb(root, 'RuntimeVisualDoc');
    const j1 = json(first);
    const names1 = (j1.nodes ?? []).map((n) => n.name);
    expect(names1).not.toContain('__runtimeScreen');
    expect(names1).not.toContain('__runtimeOverlay');
    expect(j1.meshes?.length ?? 0).toBe(1);
    expect(j1.textures?.length ?? 0).toBe(0);
    const host1 = (j1.nodes ?? []).find((n) => n.name === 'Host')!;
    expect((host1.extras!.realvirtual as Record<string, unknown>).SomeMarker).toMatchObject(EXTRAS);

    const reloaded = (await gltfLoader.parseAsync(first.slice(0), '')).scene;
    expect(buildRuntimeVisuals(reloaded)).toBe(2);
    const second = await exportAssetGlb(reloaded, 'RuntimeVisualDoc');
    const j2 = json(second);
    expect(j2.nodes?.length).toBe(j1.nodes?.length);
    expect(j2.meshes?.length).toBe(j1.meshes?.length);
    expect(j2.accessors).toEqual(j1.accessors);
    expect(j2.bufferViews).toEqual(j1.bufferViews);
  });
});
