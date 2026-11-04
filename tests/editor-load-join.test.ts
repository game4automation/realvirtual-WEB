// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-774 Phase 2 (§ 9.5) — the AUTHORING JOIN (`loadAuthoringModel`).
 *
 * The editor acts on a tree only after its placed references arrived, and only
 * if that tree is still the document it asked for. Pinned on a REAL viewer with
 * a gated in-memory decode (`bootNestedViewer`):
 *  - a document switch during materialisation → `superseded`, never a hang,
 *    and a recompose whose reload was superseded replays NOTHING;
 *  - budget expiry → `placementsReady: false` + `placements-still-loading`;
 *    the late settle clears it, and a gated replay holds back exactly the ops
 *    that target placed content until then;
 *  - bake error, decode error, cycle, depth, cap, unresolvable `project:` id →
 *    the join settles, the placeholder / problem is there, the editor works;
 *  - replay after the join with an instance-override op → `skipped.length === 0`;
 *  - `canDescend`: `materializing` while the instancer holds the reference,
 *    `unresolved` after a failed settle (never `materializing` forever).
 * (The test session's stop goes through the join: `in-place-test-session.test.ts`.)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Group, Object3D } from 'three';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { ModelCache } from '../src/core/engine/rv-model-cache';
import { identityIdOf } from '../src/core/engine/rv-decode-identity';
import { readOverride } from '../src/core/ops/rv-reference-guard';
import { isMissingReferencePlaceholder } from '../src/core/engine/rv-missing-reference-placeholder';
import {
  AuthoringLoadSupersededError, authoringReplayGate, isReferenceMaterializing, loadAuthoringModel, opTargetsPlacedContent,
  splitOpsAtGate,
} from '../src/core/editor/rv-authoring-load';
import { recomposeProjection, replayOntoTreeLocked } from '../src/core/ops/rv-document-projection';
import { RvDocumentStack } from '../src/core/ops/rv-document-stack';
import { RvDescendController, type RvRecomposeHost } from '../src/core/ops/rv-document-recompose';
import { exportAssetGlb } from '../src/core/editor/rv-asset-glb-export';
import { getProblems, resetProblemsForTests } from '../src/core/hmi/problems-store';
import type { RvOp } from '../src/core/ops/rv-unified-ops';
import { scratchAssetDocument } from './helpers/scratch-asset-document';
import { createStackTestViewer, TestStackDocument } from './helpers/stack-test-viewer';
import {
  INNER_URL, CYC_A_URL, DEPTH_URL, MANY_URL, CELL_REF_NODE_ID, SLIDE_NODE_ID,
  bootNestedViewer, documentBytes, findByName, makeOuter, plainBytes, sleep, type Booted,
} from './helpers/nested-placement-fixture';

let booted: Booted | null = null;
afterEach(() => {
  vi.restoreAllMocks();
  booted?.h.dispose();
  booted = null;
  resetProblemsForTests();
});

/** The OUTER Machine — own Frame + `Cell_1` → INNER — as document bytes. */
async function machineBytes(innerUrl = INNER_URL): Promise<ArrayBuffer> {
  return objectToGlb(makeOuter('Machine', [{ name: 'Cell_1', id: CELL_REF_NODE_ID, url: innerUrl, planner: true }]));
}

function byIdentity(root: Object3D, id: string): Object3D | null {
  let hit: Object3D | null = null;
  root.traverse((n) => { if (!hit && identityIdOf(n) === id) hit = n; });
  return hit;
}

function hasPlaceholder(node: Object3D): boolean {
  let found = false;
  node.traverse((n) => { if (n !== node && isMissingReferencePlaceholder(n)) found = true; });
  return found;
}

/** A setField op on the placed Slide, spelled the way the editor records it. */
function slideOp(path: string, value: number): RvOp {
  return {
    id: `op-${value}`, ts: Date.now(), origin: 'asset', kind: 'setField',
    nodePath: path, componentType: 'Drive', fieldName: 'TargetSpeed', value, prev: 200,
  } as unknown as RvOp;
}

/**
 * Wait (bounded) until `loadModel` itself has returned (no load in flight) and
 * the placements are materialising — the window the JOIN covers. A switch
 * while `loadModel` is still running is the loader's own abort
 * (`LoadAbortedError`, which `loadAuthoringModel` also answers as superseded).
 */
async function untilMaterializing(b: Booted): Promise<void> {
  const v = b.h.viewer;
  for (let i = 0; i < 400 && !(v.currentModelRoot && !v.sceneLoadGate.loading && v.placements.state === 'materializing'); i++) await sleep(5);
  expect(v.sceneLoadGate.loading).toBe(false);
  expect(v.placements.state).toBe('materializing');
}

describe('plan-774 F3 — identity check: a document switch is a supersede, never a hang', () => {
  it('a switch during materialisation answers { ok:false, reason:"superseded" }', async () => {
    booted = await bootNestedViewer({ gate: INNER_URL });
    const v = booted.h.viewer;
    const joining = loadAuthoringModel(v, 'machine.glb', { identity: {}, keepBaked: false, data: await machineBytes() });
    await untilMaterializing(booted);
    // Another document takes the viewer while the first one's placement bakes.
    await v.loadModel('plain.glb', { data: await plainBytes() });
    const result = await joining;
    expect(result).toEqual({ ok: false, reason: 'superseded' });
    booted.open();
  });

  it('a switch while the authoring loadModel itself still runs: superseded, and the scene-load gate settles', async () => {
    // Regression (found while building this file): the overtaken AUTHORING load
    // waited forever in its shader precompile — three's `compileAsync` poll
    // throws once the clear disposed the load's raw materials, its promise never
    // settles — so `sceneLoadGate` stayed "loading" and every later
    // `whenSceneReady()` hung. `clearModel()` now releases that wait.
    booted = await bootNestedViewer({ gate: INNER_URL });
    const v = booted.h.viewer;
    const joining = loadAuthoringModel(v, 'machine.glb', { identity: {}, keepBaked: false, data: await machineBytes() });
    for (let i = 0; i < 400 && !(v.currentModelRoot && v.placements.state === 'materializing'); i++) await sleep(2);
    await v.loadModel('plain.glb', { data: await plainBytes() });
    expect(await joining).toEqual({ ok: false, reason: 'superseded' });
    await sleep(50);
    expect(v.sceneLoadGate.loading).toBe(false);
    await v.whenSceneReady();
    booted.open();
  });

  it('the caller identity (activation epoch) counts too', async () => {
    booted = await bootNestedViewer();
    let current = true;
    const result = await loadAuthoringModel(booted.h.viewer, 'machine.glb', {
      identity: { isCurrent: () => current }, keepBaked: false, data: await machineBytes(),
    });
    expect(result.ok).toBe(true);
    current = false;
    const second = await loadAuthoringModel(booted.h.viewer, 'machine.glb', {
      identity: { isCurrent: () => current }, keepBaked: false, data: await machineBytes(),
    });
    expect(second).toEqual({ ok: false, reason: 'superseded' });
  });

  it('a recompose whose reload was superseded replays NOTHING and keeps the log', async () => {
    booted = await bootNestedViewer({ gate: INNER_URL });
    const v = booted.h.viewer;
    const bytes = await machineBytes();
    await v.loadModel('plain.glb', { data: await plainBytes() });
    const doc = scratchAssetDocument(v, 'Machine');
    try {
      // A log with one op (replayed into a recording executor double).
      const applied: RvOp[] = [];
      vi.spyOn(doc.document.executor, 'applyForward').mockImplementation(async (op) => { applied.push(op); });
      await doc.document.replayOps([slideOp('Machine/Cell_1/Slide', 250)]);
      applied.length = 0;
      const before = doc.document.opCount;

      const outcome = await recomposeProjection({
        doc: doc.document,
        replay: 'all',
        reload: async () => {
          const joining = loadAuthoringModel(v, 'machine.glb', { identity: {}, keepBaked: false, data: bytes });
          await untilMaterializing(booted!);
          await v.loadModel('plain.glb', { data: await plainBytes() });
          const joined = await joining;
          if (!joined.ok) throw new AuthoringLoadSupersededError('machine.glb');
          return { replayGate: authoringReplayGate(v, joined) };
        },
      });
      expect(outcome).toEqual({ status: 'superseded' });
      expect(applied).toEqual([]);
      expect(doc.document.opCount).toBe(before);
    } finally {
      booted.open();
      doc.dispose();
    }
  });
});

describe('plan-774 F3 — the budget', () => {
  it('budget expiry → placementsReady:false + placements-still-loading; the late settle clears it', async () => {
    booted = await bootNestedViewer({ gate: INNER_URL });
    const v = booted.h.viewer;
    const result = await loadAuthoringModel(v, 'machine.glb', {
      identity: { label: 'Machine' }, keepBaked: false, budgetMs: 50, data: await machineBytes(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.placementsReady).toBe(false);
    expect(result.pending).toBeGreaterThan(0);
    const entry = getProblems().find((p) => p.code === 'placements-still-loading');
    expect(entry, 'still-loading entry').toBeDefined();
    expect(entry!.title).toContain('still loading');

    booted.open();
    await expect(result.lateSettle).resolves.toBe(true);
    expect(getProblems().some((p) => p.code === 'placements-still-loading')).toBe(false);
    expect(byIdentity(findByName(v.currentModelRoot!, 'Cell_1')!, SLIDE_NODE_ID)).not.toBeNull();
  });

  it('a gated replay applies own-content ops at once and holds an op on placed content until the late settle', async () => {
    booted = await bootNestedViewer({ gate: INNER_URL });
    const v = booted.h.viewer;
    const result = await loadAuthoringModel(v, 'machine.glb', {
      identity: {}, keepBaked: false, budgetMs: 30, data: await machineBytes(),
    });
    expect(result.ok && !result.placementsReady).toBe(true);
    const gate = authoringReplayGate(v, result);
    expect(gate).toBeDefined();
    const root = v.currentModelRoot!;
    const cellPath = v.registry!.getPathForNode(findByName(root, 'Cell_1')!)!;
    const ownOp = { id: 'op-own', ts: 1, origin: 'asset', kind: 'setField', nodePath: cellPath, componentType: 'Note', fieldName: 'Text', value: 'x' } as unknown as RvOp;
    const placedOp = slideOp(`${cellPath}/Slide`, 250);
    // The predicate reads path prefixes: the reference node itself is OWN content.
    expect(opTargetsPlacedContent(ownOp, v.registry)).toBe(false);
    expect(opTargetsPlacedContent(placedOp, v.registry)).toBe(true);
    expect(splitOpsAtGate([ownOp, placedOp, ownOp], gate)).toEqual([[ownOp], [placedOp, ownOp]]);

    const doc = scratchAssetDocument(v, 'Machine');
    try {
      let settled = false;
      const replay = replayOntoTreeLocked(doc.document, [ownOp, placedOp], 'Machine', gate).then((r) => { settled = true; return r; });
      await sleep(40);
      expect(settled, 'the op on placed content waits for its content').toBe(false);
      booted.open();
      const r = await replay;
      expect(r.skipped).toEqual([]);
      expect(r.applied).toBe(2);
      const slide = byIdentity(findByName(v.currentModelRoot!, 'Cell_1')!, SLIDE_NODE_ID)!;
      expect((slide.userData.realvirtual as { Drive: { TargetSpeed: number } }).Drive.TargetSpeed).toBe(250);
    } finally {
      doc.dispose();
    }
  });
});

describe('plan-774 F3 — failures SETTLE: placeholder / problem, editor usable', () => {
  type Case = { name: string; code: string; doc: () => Promise<ArrayBuffer>; boot?: Parameters<typeof bootNestedViewer>[0]; inject?: () => void };
  const cases: Case[] = [
    { name: 'decode error (unknown file)', code: 'missing-reference', doc: () => machineBytes('blob:rv-test/p774-missing.glb') },
    { name: 'unresolvable project: id', code: 'missing-reference', doc: () => machineBytes('project:HomebotRefs/missing.glb') },
    {
      name: 'bake error', code: 'missing-reference', doc: () => machineBytes(),
      inject: () => {
        const proto = ModelCache.prototype as unknown as { _bakeTree: (...a: unknown[]) => Promise<unknown> };
        vi.spyOn(proto, '_bakeTree').mockRejectedValue(new Error('bake exploded'));
      },
    },
    { name: 'cycle', code: 'reference-cycle', doc: () => documentBytes([{ id: 'nid-a', name: 'CycA_1', url: CYC_A_URL }]) },
    { name: 'depth > 16', code: 'reference-depth', doc: () => documentBytes([{ id: 'nid-d1', name: 'Depth1_1', url: DEPTH_URL(1) }]) },
    { name: 'placement cap', code: 'placement-cap', boot: { maxPlacementsPerLoad: 3 }, doc: () => documentBytes([{ id: 'nid-many', name: 'Many_1', url: MANY_URL }]) },
  ];

  for (const c of cases) {
    it(`${c.name}: the join settles (${c.code}), the editor stays usable`, async () => {
      booted = await bootNestedViewer(c.boot);
      c.inject?.();
      const v = booted.h.viewer;
      const result = await loadAuthoringModel(v, 'doc.glb', { identity: {}, keepBaked: false, budgetMs: 20_000, data: await c.doc() });
      expect(result).toMatchObject({ ok: true, placementsReady: true });
      expect(v.placements.state).toBe('idle');
      expect(getProblems().some((p) => p.code === c.code), `problem ${c.code}`).toBe(true);
      expect(getProblems().some((p) => p.code === 'placements-still-loading')).toBe(false);
      const root = v.currentModelRoot!;
      if (c.code === 'missing-reference') expect(hasPlaceholder(findByName(root, 'Cell_1')!)).toBe(true);
      if (c.code !== 'placement-cap') {
        let any = false;
        root.traverse((n) => { if (isMissingReferencePlaceholder(n)) any = true; });
        expect(any, 'a placeholder marks the failed reference').toBe(true);
      }
      // Usable: an own-content edit lands.
      const doc = scratchAssetDocument(v, 'Doc');
      try {
        const own = root.children[0];
        own.userData.realvirtual = { ...(own.userData.realvirtual ?? {}), Note: { Text: 'a' } };
        await doc.setFieldAwaited(v.registry!.getPathForNode(own)!, 'Note', 'Text', 'b', 'a');
        expect((own.userData.realvirtual as { Note: { Text: string } }).Note.Text).toBe('b');
      } finally {
        doc.dispose();
      }
    });
  }
});

describe('plan-774 F8 — replay after the join', () => {
  it('a recompose with an instance-override op: skipped.length === 0, the op lands on the re-materialised instance', async () => {
    booted = await bootNestedViewer();
    const v = booted.h.viewer;
    const bytes = await machineBytes();
    const first = await loadAuthoringModel(v, 'machine.glb', { identity: {}, keepBaked: false, data: bytes });
    expect(first).toMatchObject({ ok: true, placementsReady: true });
    const doc = scratchAssetDocument(v, 'Machine');
    try {
      const slide = byIdentity(findByName(v.currentModelRoot!, 'Cell_1')!, SLIDE_NODE_ID)!;
      const slidePath = v.registry!.getPathForNode(slide)!;
      await doc.setFieldAwaited(slidePath, 'Drive', 'TargetSpeed', 250, 200);
      expect(doc.document.opCount).toBe(1);

      const outcome = await recomposeProjection({
        doc: doc.document,
        replay: 'all',
        reload: async () => {
          const joined = await loadAuthoringModel(v, 'machine.glb', { identity: {}, keepBaked: false, data: bytes });
          if (!joined.ok) throw new AuthoringLoadSupersededError('machine.glb');
          return { replayGate: authoringReplayGate(v, joined) };
        },
      });
      expect(outcome.status).toBe('ok');
      if (outcome.status !== 'ok') return;
      expect(outcome.replay.skipped).toEqual([]);
      expect(outcome.replay.applied).toBe(1);
      const cell = findByName(v.currentModelRoot!, 'Cell_1')!;
      const fresh = byIdentity(cell, SLIDE_NODE_ID)!;
      expect(fresh).not.toBe(slide);
      expect((fresh.userData.realvirtual as { Drive: { TargetSpeed: number } }).Drive.TargetSpeed).toBe(250);
      expect((readOverride(cell, `#${SLIDE_NODE_ID}`) as { Drive?: { TargetSpeed?: number } } | null)?.Drive?.TargetSpeed).toBe(250);
      expect(doc.document.opCount).toBe(1);
      // And the save carries it (F1 + F5 on the deferred load).
      const saved = await exportAssetGlb(v.currentModelRoot!, 'Machine');
      expect(saved.byteLength).toBeGreaterThan(0);
    } finally {
      doc.dispose();
    }
  });

  it('an op that throws is reported as skipped (kind + nodePath)', async () => {
    booted = await bootNestedViewer();
    const v = booted.h.viewer;
    await loadAuthoringModel(v, 'machine.glb', { identity: {}, keepBaked: false, data: await machineBytes() });
    const doc = scratchAssetDocument(v, 'Machine');
    try {
      vi.spyOn(doc.document.executor, 'applyForward').mockRejectedValue(new Error('no such node'));
      // Own content (Phase 4: a MISSING target inside placed content is skipped
      // before it is applied, flagged `placed` — reference-target-baked-away.test.ts).
      const r = await replayOntoTreeLocked(doc.document, [slideOp('Machine/Frame', 1)], 'Machine');
      expect(r).toEqual({ applied: 0, skipped: [{ kind: 'setField', nodePath: 'Machine/Frame' }] });
    } finally {
      doc.dispose();
    }
  });
});

describe('plan-774 F10 — canDescend: materializing → ok / unresolved, never materializing forever', () => {
  function controllerOn(v: Booted['h']['viewer']): RvDescendController {
    const stack = new RvDocumentStack({ viewer: createStackTestViewer(), projectId: 'p' });
    stack.pushRoot({ doc: new TestStackDocument('doc-root', 'Machine'), assetId: 'machine', name: 'Machine' });
    const host: RvRecomposeHost = {
      openChild: async () => { throw new Error('not used'); },
      reloadFrame: async () => ({ isolatedRoots: [] }),
      isMaterializing: (ref) => isReferenceMaterializing(v.placements, ref),
    };
    return new RvDescendController(stack, host);
  }

  it('a gated placement is materializing, then descendable once it arrived', async () => {
    booted = await bootNestedViewer({ gate: INNER_URL });
    const v = booted.h.viewer;
    const joining = loadAuthoringModel(v, 'machine.glb', { identity: {}, keepBaked: false, data: await machineBytes() });
    await untilMaterializing(booted);
    const ctrl = controllerOn(v);
    const cell = findByName(v.currentModelRoot!, 'Cell_1')!;
    expect(ctrl.canDescend(cell)).toEqual({ ok: false, reason: 'materializing' });
    booted.open();
    await joining;
    expect(ctrl.canDescend(cell)).toMatchObject({ ok: true, referenceNodeId: CELL_REF_NODE_ID });
  });

  it('a placement that FAILED is unresolved after the settle', async () => {
    booted = await bootNestedViewer();
    const v = booted.h.viewer;
    await loadAuthoringModel(v, 'machine.glb', { identity: {}, keepBaked: false, data: await machineBytes('blob:rv-test/p774-missing.glb') });
    const ctrl = controllerOn(v);
    const cell = findByName(v.currentModelRoot!, 'Cell_1')!;
    expect(isReferenceMaterializing(v.placements, cell)).toBe(false);
    expect(ctrl.canDescend(cell)).toEqual({ ok: false, reason: 'unresolved' });
  });
});

void Group;
