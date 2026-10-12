// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-543 live acceptance (2026-10-03) — a scene-ROOT node that carries
 * nothing but a `WebOperatorPanel` (no mesh, no children) survives the
 * destructive bake like its sibling `ConnectionMode` node: through the recipe
 * (`prepareAndBake`) and through the real `loadGLB`, on a synthetic tree and on
 * the shipped LaserWeldingAssemblyStation.glb. Guard for the diagnosis that the
 * panel missing live was NOT a bake/survival defect (it was a stale document
 * draft body shadowing the file — see plan-543).
 */
import { describe, it, expect } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D, Scene } from 'three';
import { loadGLB } from '../src/core/engine/rv-scene-loader';
import { BakeRegistry } from '../src/core/engine/rv-bake-registry';
import { createPickBuildPort } from '../src/core/engine/rv-pick-build-port';
import '../src/core/engine/rv-connection-mode';
import '../src/core/engine/rv-web-operator-panel';
import { gltfLoader } from '../src/core/engine/rv-glb-parse';
import { objectToGlb, sceneMirroringLoad } from '../src/core/import/rv-import-object';
import { prepareAndBake } from '../src/core/engine/rv-prepare-and-bake';
import { RVUberMaterial } from '../src/core/engine/rv-uber-material';
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

function station(): Group {
  const root = new Group();
  root.name = 'Station';
  const frame = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ color: 0x777777 }));
  frame.name = 'Frame';
  root.add(frame);
  const mode = new Object3D();
  mode.name = 'ConnectionMode';
  mode.userData.realvirtual = { ConnectionMode: { StartMode: 'Simulation' } };
  root.add(mode);
  const panel = new Object3D();
  panel.name = 'OperatorPanel';
  panel.userData.realvirtual = {
    WebOperatorPanel: {
      Title: 'Operator panel',
      Config: JSON.stringify({ version: 1, id: 'p', title: 'P', buttons: [] }),
      Dock: 'top-left',
      StartCollapsed: false,
    },
  };
  root.add(panel);
  return root;
}

describe('WebOperatorPanel on an empty scene-root node survives the bake (plan-543)', () => {
  it('synthetic: both empty root nodes survive', async () => {
    const bytes = await objectToGlb(sceneMirroringLoad(station()));
    const tmp = (await gltfLoader.parseAsync(bytes.slice(0), '')).scene;
    const asset = await prepareAndBake(tmp, ctxOf('wop-synthetic'));
    const n = names(asset.template);
    expect(n).toContain('ConnectionMode');
    expect(n).toContain('OperatorPanel');
    asset.dispose();
  });

  it('LaserWeldingAssemblyStation.glb: OperatorPanel survives', async () => {
    const res = await fetch('/demo-realvirtual/LaserWeldingAssemblyStation.glb');
    if (!res.ok) return; // demo asset not served in this checkout
    const bytes = await res.arrayBuffer();
    const tmp = (await gltfLoader.parseAsync(bytes, '')).scene;
    const asset = await prepareAndBake(tmp, ctxOf('wop-laser'));
    const n = names(asset.template);
    expect(n).toContain('ConnectionMode');
    expect(n).toContain('OperatorPanel');
    asset.dispose();
  }, 120_000);

  it('LaserWeldingAssemblyStation.glb through loadGLB: OperatorPanel node + component', async () => {
    const res = await fetch('/demo-realvirtual/LaserWeldingAssemblyStation.glb');
    if (!res.ok) return;
    const data = await res.arrayBuffer();
    const scene = new Scene();
    await loadGLB('LaserWeldingAssemblyStation.glb', scene, {
      data, loadKinematicsSidecar: false,
      bakeRegistry: new BakeRegistry(),
      bakePickPort: createPickBuildPort({ createWorker: () => null }),
    });
    const all: Object3D[] = [];
    scene.traverse((n) => all.push(n));
    expect(all.some((n) => n.name === 'ConnectionMode')).toBe(true);
    expect(all.some((n) => n.name === 'OperatorPanel')).toBe(true);
  }, 120_000);
});
