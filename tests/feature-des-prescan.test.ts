// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-652 Phase 3 §9.5 — the component pre-scan in `loadGLB`.
 *
 * An on-demand feature declared with `component:<type>` must be ACTIVE before the
 * loader builds components (construction is synchronous). The fixture feature
 * registers its component factory only in `activate` — exactly what the DES body
 * does — so a constructed component proves the order. Covered: destructive path,
 * authoring path (`preserveHierarchy`), type only in the overlay, a model without
 * the type (no load), an activation failure (load discarded, scene untouched, retry
 * works) and an abort during the activation.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Scene } from 'three';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { loadGLB, LoadAbortedError, type LoadGLBOptions, type LoadResult } from '../src/core/engine/rv-scene-loader';
import { BakeRegistry } from '../src/core/engine/rv-bake-registry';
import { createPickBuildPort } from '../src/core/engine/rv-pick-build-port';
import { getRegisteredFactories, registerComponent } from '../src/core/engine/rv-component-registry';
import { FeatureLoader } from '../src/core/rv-feature-loader';
import type { RVViewer } from '../src/core/rv-viewer';

const TYPE = 'Plan652LazyStation';
const created: string[] = [];

function plant(withType: boolean): Group {
  const root = new Group();
  root.name = 'Plant';
  const frame = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial());
  frame.name = 'Frame';
  root.add(frame);
  const cell = new Group();
  cell.name = 'Cell';
  if (withType) cell.userData.realvirtual = { [TYPE]: { ProcessingTime: 2 } };
  const body = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial());
  body.name = 'Body';
  body.position.set(3, 0, 0);
  cell.add(body);
  root.add(cell);
  return root;
}

function registerFixtureFactory(): void {
  if (getRegisteredFactories().has(TYPE)) return;
  registerComponent({
    type: TYPE,
    schema: { ProcessingTime: { type: 'number', default: 1 } },
    create: (node) => { created.push(node.name); return { node } as never; },
  });
}

function loader(activate: () => void = registerFixtureFactory) {
  const fl = new FeatureLoader({} as unknown as RVViewer);
  const load = vi.fn(async () => ({ activate }));
  fl.define({ id: 'fixture-des', label: 'Fixture DES', origin: 'internal', activation: [`component:${TYPE}`], load });
  return { fl, load };
}

let withType: ArrayBuffer;
let without: ArrayBuffer;
beforeAll(async () => {
  withType = await objectToGlb(plant(true));
  without = await objectToGlb(plant(false));
});

function load(scene: Scene, bytes: ArrayBuffer, opts: Partial<LoadGLBOptions> = {}): Promise<LoadResult> {
  return loadGLB('plant.glb', scene, {
    data: bytes.slice(0),
    loadKinematicsSidecar: false,
    bakeRegistry: new BakeRegistry(),
    bakePickPort: createPickBuildPort({ createWorker: () => null }),
    ...opts,
  });
}

describe('component pre-scan in loadGLB (plan-652 Phase 3)', () => {
  it('activates the feature before the build (destructive path) and the component exists', async () => {
    // A fresh type name per file — the registry is module-global.
    expect(getRegisteredFactories().has(TYPE)).toBe(false);
    created.length = 0;
    const { fl, load: bodyLoad } = loader();
    await load(new Scene(), withType, { features: fl });
    expect(bodyLoad).toHaveBeenCalledTimes(1);
    expect(fl.isActive('fixture-des')).toBe(true);
    expect(created).toEqual(['Cell']);
  });

  it('works on the authoring path (preserveHierarchy) too', async () => {
    created.length = 0;
    const { fl } = loader();
    await load(new Scene(), withType, { features: fl, preserveHierarchy: true, bakeRegistry: undefined });
    expect(fl.isActive('fixture-des')).toBe(true);
    expect(created).toEqual(['Cell']);
  });

  it('a type only in the overlay activates the feature as well', async () => {
    const { fl, load: bodyLoad } = loader();
    await load(new Scene(), without, {
      features: fl,
      overlay: { $schema: 'rv-extras-overlay/1.0', $source: 'test', nodes: { 'Plant/Cell': { [TYPE]: { ProcessingTime: 4 } } } },
    });
    expect(bodyLoad).toHaveBeenCalledTimes(1);
  });

  it('a model without the type loads nothing', async () => {
    const { fl, load: bodyLoad } = loader();
    await load(new Scene(), without, { features: fl });
    expect(bodyLoad).not.toHaveBeenCalled();
    expect(fl.isActive('fixture-des')).toBe(false);
  });

  it('an activation failure discards the load, leaves the scene untouched, a retry works', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let fail = true;
    const { fl } = loader(() => { if (fail) throw new Error('activate exploded'); registerFixtureFactory(); });
    const scene = new Scene();
    const before = scene.children.length;
    await expect(load(scene, withType, { features: fl })).rejects.toThrow('activate exploded');
    expect(scene.children.length).toBe(before);
    fail = false;
    const result = await load(scene, withType, { features: fl });
    expect(result).toBeTruthy();
    expect(fl.isActive('fixture-des')).toBe(true);
    vi.restoreAllMocks();
  });

  it('an abort during the activation is a LoadAbortedError; the feature stays active', async () => {
    let aborted = false;
    const { fl } = loader(() => { aborted = true; registerFixtureFactory(); });
    const scene = new Scene();
    const before = scene.children.length;
    await expect(load(scene, withType, { features: fl, shouldAbort: () => aborted })).rejects.toBeInstanceOf(LoadAbortedError);
    expect(scene.children.length).toBe(before);
    expect(fl.isActive('fixture-des')).toBe(true);
  });
});
