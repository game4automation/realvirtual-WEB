// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, type TestContext } from 'vitest';
import { Object3D } from 'three';
import { RvDocument } from '../../src/core/ops/rv-document';
import { RvUnifiedExecutor } from '../../src/core/ops/rv-unified-executors';
import { clearProblemsOfCode, getProblems } from '../../src/core/hmi/problems-store';
import { assertContinuation, canonicalJson, ContinuationMismatch } from '../helpers/des-continuation-harness';
import { assertLogicRefusal } from './continuation-matrix-helpers';
import { sceneWorld, type Scene, type SceneWorld } from './continuation-scene-world';

async function withWorld(scene: Scene, ctx: TestContext, run: (w: SceneWorld) => void | Promise<void>) {
  const w = await sceneWorld(scene);
  try {
    if (!w.runner.liveInstances.length) {
      console.info(`MATRIX_SCENE ${JSON.stringify({ scene, skipped: 'No DES components in the loaded scene' })}`);
      ctx.skip(); return;
    }
    w.step(60);
    await run(w);
  } finally { w.dispose(); }
}

function refused(action: () => void, code: string) {
  clearProblemsOfCode(code);
  expect(action).toThrow(code);
  expect(getProblems().some(p => p.code === code), `Problems store: ${code}`).toBe(true);
}

async function editVisual(w: SceneWorld) {
  const forbidden = new Set<Object3D>(w.v.drives.map(d => d.node));
  for (const i of w.runner.liveInstances) {
    forbidden.add(i.adapter.node);
    for (const node of i.bindPoses.keys()) forbidden.add(node);
  }
  let target: { path: string; node: Object3D } | undefined;
  w.v.registry!.forEachNode((path, node) => {
    if (!target && !forbidden.has(node) && w.v.registry!.getAddressForNode(node)) target = { path, node };
  });
  if (!target) throw new Error('No addressed visual node without a DES component');
  const { path, node } = target;
  const position = node.position.toArray();
  const quaternion = node.quaternion.toArray();
  const doc = new RvDocument({ id: 'matrix-edit', name: 'Visual edit', mode: 'scene',
    executor: new RvUnifiedExecutor(w.v, 'scene') });
  await doc.applyOp({ id: 'matrix-visual-move', ts: 1, schemaV: 1, kind: 'transformNode', nodePath: path,
    prev: { position, quaternion },
    transform: { position: [position[0] + 0.125, position[1], position[2]], quaternion } });
  expect(node.position.x).toBe(position[0] + 0.125);
}

describe('P8-2: real scene negative controls', () => {
  for (const scene of ['Test-DES-Turntable-Loop', 'PalletYard'] as const) {
    it(`${scene}: undeclared adapter field is reported`, async ctx => {
      await withWorld(scene, ctx, w => {
        const adapter = w.runner.liveInstances[0].adapter;
        Object.assign(adapter, { hiddenCounter: 1 });
        try { refused(() => w.runner.fullSnapshot(), 'des-state-not-declared'); }
        finally { Reflect.deleteProperty(adapter, 'hiddenCounter'); }
      });
    }, 300_000);

    it(`${scene}: a DES-owned closure refuses capture`, async ctx => {
      await withWorld(scene, ctx, w => {
        const handle = w.runner.scheduleCallback(w.runner.getManager().currentTime + 5, () => {}, {
          origin: { owner: w.runner.liveInstances[0].desId!, kind: 'replan' },
        });
        try {
          clearProblemsOfCode('des-snapshot-contract');
          expect(() => w.runner.fullSnapshot()).toThrow('callback without restorable origin');
          expect(getProblems().some(p => p.code === 'des-snapshot-contract')).toBe(true);
        } finally { w.runner.cancelCallback(handle); }
      });
    }, 300_000);

    it(`${scene}: past event and unknown part refuse atomically`, async ctx => {
      await withWorld(scene, ctx, w => {
        const saved = w.runner.fullSnapshot();
        expect(saved.eventQueue.length).toBeGreaterThan(0);
        expect(saved.parts.length).toBeGreaterThan(0);
        for (const kind of ['past-event', 'unknown-part'] as const) {
          const bad = structuredClone(saved);
          if (kind === 'past-event') bad.eventQueue[0].time = saved.simTime - 1;
          else bad.parts[0].key = 'matrix.unknown-part';
          refused(() => w.runner.restoreFull(bad), 'des-snapshot-contract');
          expect(canonicalJson(w.runner.fullSnapshot()), kind).toBe(canonicalJson(saved));
        }
      });
    }, 300_000);

    it(`${scene}: a document visual edit invalidates capture`, async ctx => {
      await withWorld(scene, ctx, async w => {
        w.runner.fullSnapshot();
        await editVisual(w);
        refused(() => w.runner.fullSnapshot(), 'des-snapshot-fingerprint');
      });
    }, 300_000);

    it(`${scene}: the harness detects hidden world driver state`, async ctx => {
      // Check scene eligibility before the harness starts its independent worlds.
      await withWorld(scene, ctx, () => {});
      await expect(assertContinuation({ buildWorld: () => sceneWorld(scene, { hidden: true }),
        mode: 'B', T: 3, TPrime: 6, T2: 30 })).rejects.toBeInstanceOf(ContinuationMismatch);
    }, 300_000);
  }
});

it('DemoRealvirtualWeb: LogicStep refusal', () => assertLogicRefusal('DemoRealvirtualWeb'), 300_000);
