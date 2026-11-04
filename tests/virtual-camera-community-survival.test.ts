// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-599 §9.7 — robustness of a build that does NOT register the
 * `WebCamera` / `WebDisplay` component types (the community edition).
 *
 * A GLB carrying their extras on empty nodes loads without an error and both
 * nodes survive the destructive bake (an unknown type counts as a claim), both
 * through the recipe and through the real `loadGLB`. This file deliberately
 * imports nothing from the private tree.
 */
import { describe, it, expect } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D, Scene } from 'three';
import { loadGLB } from '../src/core/engine/rv-scene-loader';
import { BakeRegistry } from '../src/core/engine/rv-bake-registry';
import { createPickBuildPort } from '../src/core/engine/rv-pick-build-port';
import { gltfLoader } from '../src/core/engine/rv-glb-parse';
import { objectToGlb, sceneMirroringLoad } from '../src/core/import/rv-import-object';
import { prepareAndBake } from '../src/core/engine/rv-prepare-and-bake';
import { RVUberMaterial } from '../src/core/engine/rv-uber-material';
import { getRegisteredFactories } from '../src/core/engine/rv-component-registry';
import { inlinePickPort } from './fixtures/bake-fixture';

const uber = new RVUberMaterial(false);
const ctxOf = (assetId: string) => ({
  assetId, renamedNodes: new Map<Object3D, string>(), signatureState: 'none' as const,
  uber, isWebGPU: false, pickPort: inlinePickPort(),
});

function names(root: Object3D): string[] {
  const out: string[] = [];
  root.traverse((n) => out.push(n.name));
  return out;
}

const ref = (path: string, componentType: string) => ({ type: 'ComponentReference', path, componentType });

function station(): Group {
  const root = new Group();
  root.name = 'Station';
  const frame = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ color: 0x777777 }));
  frame.name = 'Frame';
  root.add(frame);
  const cam = new Object3D();
  cam.name = 'VirtualCamera_A';
  cam.position.set(0, 1, 1);
  cam.userData.realvirtual = {
    WebCamera: {
      Label: 'A Vision', Fov: 40, ResolutionX: 320, ResolutionY: 240, Near: 0.02, Far: 10,
      Trigger: ref('PLC/A/A_P_Camera.bTrigger', 'PLCOutputBool'),
      Busy: ref('PLC/A/A_P_Camera.bBusy', 'PLCInputBool'),
      LiveIntervalS: 1, HoldAfterTriggerS: 3,
    },
  };
  const disp = new Object3D();
  disp.name = 'Display_A';
  disp.position.set(1, 1.5, 0);
  disp.userData.realvirtual = {
    WebDisplay: { Cameras: [ref('Station/VirtualCamera_A', 'WebCamera')], Width: 0.4, Height: 0.3, Offset: 0.002 },
  };
  root.add(cam, disp);
  return root;
}

describe('WebCamera / WebDisplay extras without registered components (plan-599 §9.7)', () => {
  it('the types are not registered in this (public) test context', () => {
    const types = getRegisteredFactories();
    expect(types.has('WebCamera')).toBe(false);
    expect(types.has('WebDisplay')).toBe(false);
  });

  it('both empty nodes survive the bake recipe', async () => {
    const bytes = await objectToGlb(sceneMirroringLoad(station()));
    const tmp = (await gltfLoader.parseAsync(bytes.slice(0), '')).scene;
    const asset = await prepareAndBake(tmp, ctxOf('vcam-community'));
    const n = names(asset.template);
    expect(n).toContain('VirtualCamera_A');
    expect(n).toContain('Display_A');
    asset.dispose();
  });

  it('loads through loadGLB without throwing; nodes present, no runtime visuals built', async () => {
    const data = await objectToGlb(sceneMirroringLoad(station()));
    const scene = new Scene();
    await loadGLB('vcam-community.glb', scene, {
      data, loadKinematicsSidecar: false,
      bakeRegistry: new BakeRegistry(),
      bakePickPort: createPickBuildPort({ createWorker: () => null }),
    });
    const all: Object3D[] = [];
    scene.traverse((o) => all.push(o));
    const display = all.find((o) => o.name === 'Display_A');
    expect(all.some((o) => o.name === 'VirtualCamera_A')).toBe(true);
    expect(display).toBeTruthy();
    expect(all.some((o) => o.userData._rvRuntimeVisual === true)).toBe(false);
  }, 60_000);
});
