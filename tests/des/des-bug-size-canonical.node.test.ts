// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
//
// A1 (DES perfection list): the bug size (`_bugSize`) of a DES MU must be a pure
// function of its SOURCE TEMPLATE. Today the scene binding measures it ONCE per
// bind from the WORLD AABB of the first live visual (des-scene-binding.ts
// `templateBugSizeFor` -> mu-reference.ts `measureMuVisualBugSize`), so whatever
// state that visual's parent chain has at that moment (render-side poses, the
// state a load left behind) leaks into every MU of the source. Two loads of the
// same scene can then carry different `_bugSize`s - the PalletYard / DemoPlanner
// snapshot-matrix drift of 2^-25 m, and through the ride times
// `ShippingMonitor.persist.last`.
//
// Deterministic: no load, no wall clock. The only difference between two worlds
// is the pose of the node the engine source spawns its clones under (RVSource:
// `destination ?? spawnParent`) when the binding takes its first measurement.
import { describe, expect, it } from 'vitest';
import { BoxGeometry, Mesh, Object3D, Scene } from 'three';
import { RVMovingUnit } from '../../src/core/engine/rv-mu';
import { registerEngineSourceForNode, RVSource } from '../../src/core/engine/rv-source';
import { measureMuVisualBugSize, muBugOffset, templateSizeOf } from '../../src/behaviors/_shared/mu-reference';
import type { MU } from '../../src/core/material-flow/material-flow-self';
import { registerMaterialFlow } from '../../src/core/material-flow/registry';
import { assertContinuation } from '../helpers/des-continuation-harness';
import { continuationWorld } from './continuation-world-fixture';
import { runnerFixture } from './runner-fixture';
import { resetDESMUCounter } from '../../src/plugins/des/rv-des-mu';

/** Own-frame size of the template part (m): x = width, y = height, z = length (forward). */
const PART: [number, number, number] = [0.8, 0.4, 1.2];
/** The template's own-frame size as its float32 geometry spans it (what `templateSizeOf` reports). */
const TEMPLATE_SIZE: [number, number, number] = (() => {
  const g = new BoxGeometry(...PART); g.computeBoundingBox();
  const b = g.boundingBox!; return [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z];
})();

/**
 * One deterministic Source -> Station -> Sink world. `carrierYaw` = pose of the node the
 * clones spawn under when the binding takes its one measurement (the first spawn,
 * inside `start`). The carrier is render-side state outside the DES model (not in the
 * fingerprinted scene), so every world has the same model and fingerprint.
 */
function world(carrierYaw: number) {
  resetDESMUCounter();
  const scene = new Scene();
  const nodes: Record<string, Object3D> = {};
  for (const [name, props] of [
    ['Source', { Interval: 10 }],
    ['Station', { ProcessingTime: 8 }],
    ['Sink', {}],
  ] as const) {
    const node = new Object3D(); node.name = name;
    node.userData.realvirtual = { [name]: props }; scene.add(node);
    nodes[name] = node;
  }
  // The node the engine source spawns its clones under. Its pose belongs to the scene
  // state, not to the DES run (a carrier / Destination, a placement's parent chain).
  const carrier = new Object3D(); carrier.name = 'Carrier';
  carrier.rotation.y = carrierYaw;
  carrier.updateMatrixWorld(true);
  scene.updateMatrixWorld(true);
  const geometry = new BoxGeometry(...PART);
  // Minimal engine source (the shape des-scene-binding uses): a real clone visual per
  // spawn, and the template size as `RVSource.templateSize()` reports it.
  const engine = {
    Enabled: true,
    spawnMU: () => {
      const node = new Mesh(geometry); node.name = 'Part_MU';
      carrier.add(node);
      return new RVMovingUnit(node, 'Source');
    },
    templateSize: (): [number, number, number] => [...TEMPLATE_SIZE],
    canSpawn: () => true,
  };
  registerEngineSourceForNode(nodes.Source, engine as unknown as RVSource);
  const f = runnerFixture(scene);
  const by = (n: string) => f.components.find(c => c.node.name === n)!;
  const [source, station, sink] = ['Source', 'Station', 'Sink'].map(by);
  source.nextComponents = [station]; station.previousComponents = [source];
  station.nextComponents = [sink]; sink.previousComponents = [station];
  // Every MU the runner creates (slots are reused, so keep the objects, not the ids).
  const created: Array<{ id: number; _bugSize?: number[] }> = [];
  const createMU = f.runner.createMU.bind(f.runner);
  f.runner.createMU = (templateId?: string) => {
    const mu = createMU(templateId);
    created.push(mu as unknown as { id: number; _bugSize?: number[] });
    return mu;
  };
  f.runner.start([], { root: scene, host: f.host });
  return { ...continuationWorld(f.runner), created };
}

describe('A1: DES MU bug size comes from the source template, not from a live visual', () => {
  // A visible turn (30 deg) and a float-noise turn (pi + 2.5e-8 rad: ~3e-8 m on the
  // 1.2 m side, the magnitude of the matrix drift).
  for (const [label, yaw] of [['30 deg', Math.PI / 6], ['pi + 2.5e-8 rad', Math.PI + 2.5e-8]] as const) {
    it(`every MU carries the template size, whatever the spawn-parent pose (${label})`, () => {
      const w = world(yaw);
      try {
        w.step(40);
        expect(w.created.length).toBeGreaterThanOrEqual(4);
        for (const mu of w.created) expect(mu._bugSize, `MU ${mu.id}`).toEqual(TEMPLATE_SIZE);
      } finally { w.dispose?.(); }
    });

    // Mode B: the saved run and the restored run are two LOADS. The restored load binds
    // with a different spawn-parent pose, re-measures at its first spawn and gives the
    // MUs spawned after the cut a different `_bugSize` than the uninterrupted run.
    it(`continuation B across two loads keeps the bug size (${label})`, async () => {
      let builds = 0;
      await assertContinuation({
        mode: 'B', T: 5, TPrime: 6, T2: 40,
        buildWorld: () => world(++builds === 3 ? yaw : 0), // 1 = reference, 2 = saved, 3 = restored
      });
    });
  }
});

describe('A1: real template measurement and clone scale', () => {
  it('real RVSource template size is exactly equal under different large translations', () => {
    const scene = new Scene();
    const library = new Object3D(); library.scale.setScalar(0.001); scene.add(library);
    const template = new Object3D(); template.name = 'Part';
    template.scale.set(1500, 750, 1250); library.add(template);
    const geometry = new BoxGeometry(...PART);
    const mesh = new Mesh(geometry);
    mesh.position.set(0.13, 0.27, -0.41);
    mesh.rotation.set(0.2, 0.4, 0.1); template.add(mesh);
    const spawnParent = new Object3D(); scene.add(spawnParent);
    spawnParent.rotation.set(-Math.PI / 2, 0, 0.3);
    spawnParent.scale.set(1.25, 0.75, 1.5);
    const source = new RVSource(template);
    (source as unknown as { sourceIsTemplate: boolean }).sourceIsTemplate = true;
    source.spawnParent = spawnParent;
    source.setTemplate(template);
    try {
      const canonical = source.templateSize();
      expect(canonical).not.toBeNull();
      for (const translation of [1e6, -1e9, 1e12]) {
        scene.position.set(translation, -translation, translation / 3);
        library.position.set(-translation / 7, translation / 11, translation);
        template.position.set(translation / 13, -translation / 5, translation / 17);
        spawnParent.position.set(translation / 2, translation / 3, -translation);
        expect(source.templateSize()).toEqual(canonical);
        expect(templateSizeOf(template, spawnParent)).toEqual(canonical);
      }
    } finally { source.dispose(); geometry.dispose(); }
  });

  it('named template under a 0.001-scaled parent presets the measured clone size', () => {
    registerMaterialFlow({
      type: 'A1NamedTemplateSource', kind: 'source', models: [],
      schema: { TemplateId: { type: 'string', default: '' } },
      muVisualTemplateProperties: ['TemplateId'], continuous: {},
    });
    const scene = new Scene();
    const library = new Object3D(); library.scale.setScalar(0.001); scene.add(library);
    const geometry = new BoxGeometry(800, 400, 1200);
    const template = new Mesh(geometry); template.name = 'MillimetrePart'; library.add(template);
    const emitter = new Object3D(); emitter.name = 'Emitter';
    emitter.userData.realvirtual = { A1NamedTemplateSource: { TemplateId: template.name } };
    scene.add(emitter);
    const f = runnerFixture(scene);
    try {
      const mu = f.runner.createMU(template.name);
      expect(mu.visual).toBeInstanceOf(RVMovingUnit);
      if (!(mu.visual instanceof RVMovingUnit)) throw new Error('Expected named-template clone');
      expect(mu.visual.node.parent).toBe(scene);
      expect(mu._bugSize).toEqual([0.8, 0.4, 1.2]);
      expect(mu._bugSize).toEqual(templateSizeOf(template, scene));
      expect(mu._bugSize).toEqual(measureMuVisualBugSize(mu.visual.node));
    } finally { f.runner.dispose(); geometry.dispose(); }
  });

  it('continuous fallback retains ancestor unit scaling without parent position or rotation', () => {
    const scene = new Scene(); scene.scale.setScalar(0.001);
    scene.position.set(1e9, -1e9, 1e9); scene.rotation.set(0.3, 0.7, 0.2);
    const carrier = new Object3D();
    carrier.position.set(-1e6, 1e6, 1e6); carrier.rotation.set(0.4, 0.8, 0.6);
    scene.add(carrier);
    const node = new Object3D();
    node.position.set(1e6, 1e6, -1e6); node.rotation.y = Math.PI / 2; carrier.add(node);
    const geometry = new BoxGeometry(800, 400, 1200); node.add(new Mesh(geometry));
    const mu = { id: 1, visual: { node } } as unknown as MU & { _bugSize?: number[] };
    try {
      expect(mu._bugSize).toBeUndefined();
      expect(muBugOffset(mu)).toBe(0.6);
      expect(mu._bugSize).toEqual([0.8, 0.4, 1.2]);
      carrier.rotation.set(0.9, 0.1, 0.5); node.rotation.y = 0;
      expect(muBugOffset(mu)).toBe(0.6);
    } finally { geometry.dispose(); }
  });
});
