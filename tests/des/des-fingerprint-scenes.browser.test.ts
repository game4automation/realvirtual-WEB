// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { describe, expect, it } from 'vitest';
import { clearProblemsOfCode, getProblems } from '../../src/core/hmi/problems-store';
import { Group, Object3D } from 'three';
import { registerAllBehaviors } from '../../src/core/behaviors';
import { objectToGlb } from '../../src/core/import/rv-import-object';
import { setAssetReference, setPlacementMeta } from '../../src/core/engine/rv-asset-reference';
import { setNodeId } from '../../src/core/engine/rv-node-id';
import { whenDocumentHashesSettled } from '../../src/core/engine/rv-model-content-ledger';
import { modelEditEpoch } from '../../src/core/engine/rv-model-edit-epoch';
import { RvDocument } from '../../src/core/ops/rv-document';
import { RvUnifiedExecutor } from '../../src/core/ops/rv-unified-executors';
import { SnapPointPlugin } from '../../src/plugins/snap-point';
import { PalletYardPlugin } from '../../src/plugins/models/PalletYard';
import type { DesHandoverBackend } from '../../src/plugins/des/fleet/des-handover';
import type { DESRunner } from '../../src/plugins/des/des-runner';
import { buildDesFingerprint, type FingerprintResult } from '../../src/plugins/des/rv-des-fingerprint';
import { collectFingerprintInput } from '../../src/plugins/des/rv-des-model-input';
import type { DESEventQueue } from '../../src/plugins/des/rv-des-event-queue';
import { ACTION_INDEX } from '../../src/plugins/des/rv-des-named-actions';
import { resetDESMUCounter } from '../../src/plugins/des/rv-des-mu';
import { WebComponentPlugin } from '../../src/plugins/web-component-plugin';
import { createParityHost } from '../helpers/parity-harness';
import { clearShared } from '../helpers/agv-harness';
import { assertContinuation, type ContinuationEvent, type ContinuationWorld } from '../helpers/des-continuation-harness';

// The standard demo is also the explicit Unity-export acceptance case (all
// public demo GLBs originate in Unity). No synthetic replacement for these files.
const SCENES = ['PalletYard', 'DemoRealvirtualWeb', 'LaserWeldingAssemblyStation', 'AGVDemo', 'TwoPlacements'] as const;
type Scene = typeof SCENES[number];
const urlOf = (name: string) => `/demo-realvirtual/${name}.glb`;

async function bytesOf(name: string): Promise<ArrayBuffer> {
  const response = await fetch(urlOf(name));
  expect(response.ok, `${name}: HTTP ${response.status}`).toBe(true);
  const bytes = await response.arrayBuffer();
  expect(new TextDecoder().decode(new Uint8Array(bytes, 0, 4)), `${name}: real GLB, not HTML/LFS`).toBe('glTF');
  return bytes;
}

// Build ONCE: fixed ids and identical layout bytes on the two loads. Both
// references use the SAME asset URL, exercising ModelCache and occurrence ids.
async function layoutBytes(): Promise<ArrayBuffer> {
  const root = new Group(); root.name = 'FingerprintLayout';
  for (let i = 0; i < 2; i++) {
    const ref = new Object3D(); ref.name = `Demo_${i + 1}`;
    ref.position.x = i * 30;
    setNodeId(ref, `fingerprint-demo-${i + 1}`);
    setAssetReference(ref, { assetId: 'cat:fingerprint-demo', path: urlOf('DemoRealvirtualWeb') });
    setPlacementMeta(ref, {});
    root.add(ref);
  }
  return objectToGlb(root);
}

function hash(result: FingerprintResult): string {
  if (!result.ok) throw new Error(`Incomplete fingerprint: ${result.reasons.join('; ')}`);
  return result.fingerprint.modelHash;
}

async function boot(name: Scene, bytes: ArrayBuffer) {
  clearShared(); resetDESMUCounter();
  // createParityHost uses createTestViewer + the real GLTFLoader/ModelCache,
  // inline pick building, script wiring, and a paused viewer loop.
  const host = await createParityHost();
  const v = host.viewer;
  const blob = URL.createObjectURL(new Blob([bytes], { type: 'model/gltf-binary' }));
  try {
    registerAllBehaviors(v.behaviors);
    v.use(new SnapPointPlugin());
    const yard = name === 'PalletYard' ? new PalletYardPlugin() : null;
    if (yard) v.use(yard);
    await v.loadModel(blob, { modelName: `${name}.glb`, identityUrl: urlOf(name) });
    await v.whenSceneReady();
    await v.getPlugin<WebComponentPlugin>('web-component')?.whenWired();
    v.scene.updateMatrixWorld(true);
    v.simulationKernel!.setMode('des');
    await Promise.resolve();
    await whenDocumentHashesSettled();
    await Promise.resolve(); // publish an asynchronously settled bind fingerprint
    const runner = v.simulationKernel!.desControl() as unknown as DESRunner;
    expect(runner, `${name}: DES runner`).toBeTruthy();
    const input = () => collectFingerprintInput(v, runner, { mainDocumentKey: v.mainDocumentKey });
    const step = (toT: number) => {
      const m = runner.getManager();
      // Headless event processing; a short animated settle at each observation
      // writes active drive / AGV / overhead poses, so rest-pose checks are live.
      runner.setSubMode('fastforward');
      for (let t = Math.floor(m.currentTime) + 1; t <= toT; t++) {
        if (yard) {
          expect(yard.runtime?.adapters.kind).toBe('des');
          (yard.runtime!.adapters as DesHandoverBackend).clock.schedule(t, () => {});
        }
        const result = m.processUpTo(t, 100_000);
        expect(result.hitBudget, `${name}: event budget at ${t}`).toBe(false);
        yard?.runtime?.frame();
      }
      runner.setSubMode('animated');
      runner.tick(0.25);
      runner.lateTick(0.25);
      v.scene.updateMatrixWorld(true);
    };
    return { v, runner, input, step, dispose() { host.dispose(); URL.revokeObjectURL(blob); clearShared(); } };
  } catch (error) {
    host.dispose(); URL.revokeObjectURL(blob); clearShared(); throw error;
  }
}

type World = Awaited<ReturnType<typeof boot>>;

async function editVisual(w: World): Promise<void> {
  const { v, runner } = w;
  const forbidden = new Set<Object3D>(v.drives.map(d => d.node));
  for (const i of runner.liveInstances) {
    forbidden.add(i.adapter.node);
    for (const node of i.bindPoses.keys()) forbidden.add(node);
  }
  let target: { path: string; node: Object3D } | undefined;
  v.registry!.forEachNode((path, node) => {
    if (!target && !forbidden.has(node) && v.registry!.getAddressForNode(node)) target = { path, node };
  });
  if (!target) throw new Error('No addressed visual node without a DES component');
  const { path, node } = target;
  const before = hash(buildDesFingerprint(w.input()));
  const epoch = modelEditEpoch();
  const doc = new RvDocument({ id: 'fingerprint-edit', name: 'Visual edit', mode: 'scene',
    executor: new RvUnifiedExecutor(v, 'scene') });
  const position = node.position.toArray();
  const quaternion = node.quaternion.toArray();
  await doc.applyOp({ id: 'visual-move', ts: Date.now(), schemaV: 1, kind: 'transformNode', nodePath: path,
    prev: { position, quaternion },
    transform: { position: [position[0] + 0.125, position[1], position[2]], quaternion } });
  expect(node.position.x).toBe(position[0] + 0.125); // executor really found and moved the node
  expect(modelEditEpoch()).toBeGreaterThan(epoch);
  expect(hash(buildDesFingerprint(w.input()))).not.toBe(before);
  const refused = runner.fingerprintNow();
  expect(refused.ok).toBe(false);
  if (!refused.ok) expect(refused.reasons.join('; ')).toContain('changed since run start');
}

describe('plan-2059 C5: R4 collector in real scenes', () => {
  for (const scene of SCENES) {
    it(`${scene}: reload, moving rest poses, visual edit, settled hashes and signal addresses`, async ctx => {
      const bytes = scene === 'TwoPlacements' ? await layoutBytes() : await bytesOf(scene);
      let firstHash = '';
      let firstAddresses: string[] = [];
      for (let load = 0; load < 2; load++) {
        const w = await boot(scene, bytes);
        try {
          if (w.runner.liveInstances.length === 0) {
            console.info(`FINGERPRINT_SCENE ${JSON.stringify({ scene, skipped: 'No DES components in the loaded scene' })}`);
            ctx.skip(); return;
          }
          const addresses = w.input().scene.map(row => row.address).sort();
          expect(w.input().documents.length, 'loaded bytes participate in the fingerprint').toBeGreaterThan(0);
          expect(w.input().documents.every(document => document.hash.state === 'ready'),
            'no pending or unavailable document after the settle join').toBe(true);
          expect(addresses.length).toBeGreaterThan(0);
          expect(new Set(addresses).size).toBe(addresses.length);
          const bound = w.runner.fingerprintAtBind();
          if ('pending' in bound) throw new Error(`${scene}: bind still pending after hashes settled`);
          const boundHash = hash(bound);
          expect(hash(w.runner.fingerprintNow())).toBe(boundHash);
          if (scene === 'TwoPlacements') {
            const documents = w.input().documents;
            expect(documents).toHaveLength(3);
            expect(new Set(documents.map(d => d.occurrence)).size).toBe(3);
            const placed = documents.filter(d => d.occurrence !== "");
            expect(placed).toHaveLength(2);
            expect(placed[0].hash).toEqual(placed[1].hash);
          }
          if (load === 0) { firstHash = boundHash; firstAddresses = addresses; }
          else {
            expect(boundHash, 'new blob URL, identical model').toBe(firstHash);
            // Includes every generated signal with an address; unaddressed
            // generated nodes intentionally do not contribute scene rows.
            expect(addresses, 'generated and authored addresses reload stably').toEqual(firstAddresses);
          }
          const movers = new Map<Object3D, { type: string; pose: string }>();
          const pose = (node: Object3D) => JSON.stringify([node.position.toArray(), node.quaternion.toArray()]);
          for (const drive of w.v.drives) movers.set(drive.node, { type: 'Drive', pose: pose(drive.node) });
          for (const instance of w.runner.liveInstances) {
            for (const node of instance.bindPoses.keys()) movers.set(node, { type: instance.def.type, pose: pose(node) });
          }
          const movedTypes = new Set<string>();
          // Check model identity independently of snapshot capture.
          for (const T of [3, 120]) {
            w.step(T);
            for (const [node, before] of movers) if (pose(node) !== before.pose) movedTypes.add(before.type);
            const started = performance.now();
            const now = w.runner.fingerprintNow();
            const ms = performance.now() - started;
            console.info(`FINGERPRINT_TIMING ${JSON.stringify({ scene, load, T, ms, nodes: addresses.length,
              components: w.runner.liveInstances.length, bytes: bytes.byteLength })}`);
            expect(hash(now), `${scene} at T=${T}`).toBe(boundHash);
            expect(ms, `${scene}: collector + hash <= 100 ms`).toBeLessThanOrEqual(100);
          }
          if (scene === 'AGVDemo' || scene === 'PalletYard') {
            expect([...movedTypes], 'AGVs really moved; collector checks include moving AGVs').toContain('Agv');
          }
          if (load === 1) await editVisual(w);
          console.info(`FINGERPRINT_SCENE ${JSON.stringify({ scene, load, modelHash: boundHash,
            movedTypes: [...movedTypes].sort(), result: 'passed' })}`);
        } finally { w.dispose(); }
      }
    }, 60_000);
  }

  it('Unity standard demo: Mode A + B continuation or explicit LogicStep refusal', async () => {
    const bytes = await bytesOf('DemoRealvirtualWeb');
    const probe = await boot('DemoRealvirtualWeb', bytes);
    try {
      expect(probe.runner.liveInstances.length).toBeGreaterThan(0);
      probe.step(3);
      try { probe.runner.fullSnapshot(); }
      catch (error) {
        const code = 'des-snapshot-unsupported-component';
        expect(error).toMatchObject({ code });
        expect(String(error)).toMatch(/core: LogicStep /);
        expect(getProblems().some(p => p.code === code)).toBe(true);
        clearProblemsOfCode(code);
        expect(() => probe.runner.restoreFull({})).toThrow(code);
        expect(getProblems().some(p => p.code === code)).toBe(true);
        return;
      }
    } finally { probe.dispose(); }
    for (const mode of ['A', 'B'] as const) {
      await assertContinuation({ mode, T: 3, TPrime: 12, T2: 20,
        buildWorld: async (): Promise<ContinuationWorld> => {
          const w = await boot('DemoRealvirtualWeb', bytes);
          const m = w.runner.getManager();
          const events: ContinuationEvent[] = [];
          return { runner: w.runner, dispose: () => w.dispose(), trace: () => events,
            kpis: () => Object.fromEntries(w.runner.liveInstances.map(i => [i.desId!, i.adapter.getStatistics()])),
            step(toT) {
              // Restore swaps the queue. Attach the browser factory's recorder
              // afresh on every step, never to a stale queue or a production hook.
              const queue = (m as unknown as { queue: DESEventQueue }).queue;
              const dequeue = queue.dequeue;
              const names = new Map([...ACTION_INDEX].map(([name, index]) => [index, name]));
              const owners = new Map(w.runner.liveInstances.map(i => [i.adapter.entityId, i.desId!]));
              queue.dequeue = function () {
                const event = dequeue.call(this);
                if (event) events.push({ time: event.time, action: names.get(event.actionIndex)!,
                  componentId: owners.get(event.entityId) ?? null, muId: event.muId });
                return event;
              };
              try {
                while (m.currentTime < toT) {
                  const before = m.currentTime;
                  const dt = Math.min(0.25, toT - before);
                  // Deterministic event-clock stepping (the viewer loop is paused in this host).
                  m.processAnimated(dt);
                  if (m.currentTime === before) throw new Error(`Demo stopped before ${toT}`);
                }
              } finally { queue.dequeue = dequeue; }
            },
          };
        },
      });
    }
  }, 90_000);
});
