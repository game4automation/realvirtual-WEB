// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>
//
// plan-2246 (Gate R1 #7, R2 #3) — archive goldens for the runtime stage BELOW the
// split threshold. The fixture was recorded from the code BEFORE the oversized-mesh
// split existed (origin/main acdf525e / Private 964ba5b); every later change to the
// export path must keep both archives byte-identical:
// - the complete live-link mount archive (`exportRuntimeStage`, all zip bytes) plus
//   the tracker frames built from the snapshot's own node table,
// - the complete animated archive (`exportAnimatedUsdz`) whose tracks are indexed
//   through the stage's own tables (`model.indexOf`, MU ids).
// The model carries real children named `rvPart_0`, `Part_0` and `Geometry`: the
// split must not reserve or rename any runtime name (R2 #3).
//
// Fixed clock (fflate writes local zip timestamps) and a fixed object creation order
// (geometry / material ids are global counters; each test file runs in its own fork).
// Re-recording (RV_USD_GOLDEN_RECORD=1) is only valid from a commit without the split.
import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { BoxGeometry, Matrix4, Mesh, MeshStandardMaterial, Object3D, PlaneGeometry, Scene } from 'three';
import { exportRuntimeStage } from '../src/core/usd/runtime-stage-export';
import { buildStageWithMus } from '../src/core/usd/mu-export';
import { TimeSampleStore } from '../src/core/usd/time-sample-store';
import { SyncTracker } from '../src/plugins/usd-live-link/sync-tracker';
import { exportAnimatedUsdz } from '@rv-private/plugins/usd/anim/anim-usdz';

const FIXTURE = new URL('./fixtures/usd-runtime-stage-archive-golden.json', import.meta.url);
const RECORD = process.env.RV_USD_GOLDEN_RECORD === '1';

interface Golden { mount: { usdz: string; frames: string[] }; animated: { usdz: string } }

function goldenModel() {
  const scene = new Scene(), root = new Object3D(); root.name = 'Cell'; scene.add(root); root.position.set(1, 2, 3);
  const geometry = new BoxGeometry(1, 2, 3, 2, 2, 2), material = new MeshStandardMaterial({ color: 0x336699 });
  const other = new MeshStandardMaterial({ color: 0xaa5522 });
  const axis = new Object3D(); axis.name = 'Axis'; root.add(axis);
  // Real runtime children whose names look like split parts: never renamed (R2 #3).
  const realPart = new Mesh(geometry, material); realPart.name = 'rvPart_0'; axis.add(realPart);
  const part0 = new Object3D(); part0.name = 'Part_0'; axis.add(part0);
  const geo = new Mesh(new PlaneGeometry(2, 2, 3, 3), material); geo.name = 'Geometry'; axis.add(geo);
  const multi = new Mesh(new BoxGeometry(), [material, other]); multi.name = 'Multi'; root.add(multi);
  const template = new Mesh(geometry, material); template.name = 'Template'; template.visible = false; root.add(template);
  const pre = new Mesh(geometry, other); pre.name = 'Pre'; pre.position.x = 4; root.add(pre);
  const spawned = new Mesh(geometry, material); spawned.name = 'Spawned';
  return { scene, root, axis, realPart, template, pre, spawned };
}

async function mountGolden(): Promise<Golden['mount']> {
  const m = goldenModel();
  const snapshot = await exportRuntimeStage({ root: m.root, templates: [m.template], exclude: new Set(), preplaced: [{ muId: 5, node: m.pre }] });
  const frames: string[] = [];
  const tracked = snapshot.nodes.map((_, i) => i).filter((i) => i > 0);
  const tracker = new SyncTracker({
    nodes: snapshot.nodes, trackedIndices: tracked, mus: () => [],
    preplaced: new Map(snapshot.preplaced.map((p) => [p.muId, p.nodeIndex])), templateIndexOf: () => 0,
    send: (b) => frames.push(Buffer.from(b).toString('hex')),
  });
  tracker.sample(1);
  m.axis.position.x = 0.5; m.realPart.rotation.z = 0.25;
  tracker.sample(1);
  tracker.requestFull(); tracker.sample(2);
  return { usdz: Buffer.from(snapshot.usdz).toString('base64'), frames };
}

async function animatedGolden(): Promise<Golden['animated']> {
  const m = goldenModel();
  const stage = buildStageWithMus({ root: m.root, templates: [m.template], exclude: new Set(), preplaced: [{ muId: 1, node: m.pre }] }, [
    { muId: 1, node: m.pre, template: null, preplaced: true },
    { muId: 2, node: m.spawned, template: m.template, preplaced: false },
  ]);
  const store = new TimeSampleStore(30, stage.model.nodes.length);
  const move = new Matrix4();
  for (let frame = 0; frame <= 4; frame++) {
    store.beginTick(frame / 30);
    store.onNodes(stage.model.indexOf.get(m.axis)!, move.makeTranslation(frame * 0.25, 0, 0).elements);
    store.onNodes(stage.model.indexOf.get(m.realPart)!, move.makeRotationZ(frame * 0.1).elements);
    if (frame === 0) store.onMuSpawn(1, -1, new Matrix4().makeTranslation(4, 0, 0).elements);
    if (frame === 1) store.onMuSpawn(2, 0, new Matrix4().makeTranslation(0, 1, 0).elements);
    if (frame === 2) store.onMuPoses(2, new Matrix4().makeTranslation(0, 1.5, 0).elements);
    if (frame === 3) store.onMuDelete(2);
    store.endTick();
  }
  store.finish();
  const bytes = await exportAnimatedUsdz({ stage, primTracks: store.getPrimTracks(), muTracks: store.getMuTracks(), fps: 30, endFrame: store.endFrame });
  return { usdz: Buffer.from(bytes).toString('base64') };
}

const sha = (b64: string): string => createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex');

describe('plan-2246 — runtime stage archives below the split threshold are byte-identical', () => {
  it('mount archive, tracker frames and animated archive match the pre-split goldens', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, 1, 0, 0));
    try {
      const actual: Golden = { mount: await mountGolden(), animated: await animatedGolden() };
      if (RECORD) {
        if (existsSync(FIXTURE)) throw new Error('Golden exists — delete it deliberately before re-recording');
        writeFileSync(FIXTURE, JSON.stringify(actual, null, 1) + '\n');
        return;
      }
      const golden = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Golden;
      // Hash first (readable failure), then the full bytes.
      expect(sha(actual.mount.usdz)).toBe(sha(golden.mount.usdz));
      expect(actual.mount.usdz).toBe(golden.mount.usdz);
      expect(actual.mount.frames).toEqual(golden.mount.frames);
      expect(sha(actual.animated.usdz)).toBe(sha(golden.animated.usdz));
      expect(actual.animated.usdz).toBe(golden.animated.usdz);
      // The real `rvPart_0` child keeps its name in both archives (no reservation).
      const { strFromU8, unzipSync } = await import('three/examples/jsm/libs/fflate.module.js');
      for (const b64 of [actual.mount.usdz, actual.animated.usdz]) {
        const text = strFromU8(unzipSync(new Uint8Array(Buffer.from(b64, 'base64')))['model.usda']);
        expect(text).toContain('def Xform "rvPart_0"');
        expect(text).toContain('def Xform "Part_0"');
        expect(text).not.toMatch(/"rvPart_0_\d+"|"_rvP\d+_\d+"/);
      }
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
    }
  });
});
