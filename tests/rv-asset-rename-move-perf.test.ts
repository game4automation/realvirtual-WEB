// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-610 Phase 2 — performance of the reference-safe rename / batch move.
 *
 *  1. Mauser size (~12 600 registered nodes, a few hundred referrers): the
 *     rewrite PLANNING plus the end-of-composite FLUSH plus the foreign-referrer
 *     SCAN of one rename stay under the plan's budget of 150 ms (§2.4).
 *  2. `reparentNodesBatch` with 434 moves on a 4 493-node assembly (the
 *     plan-359 measurement case, 21 ms before plan-610), every moved node
 *     referenced: still ONE `editor-structure-changed` event, a bounded number
 *     of forced matrix refreshes of the target, and a runtime in the order of
 *     the old one plus the scan. The numbers are logged as `[perf-610]` lines
 *     for the Phase 2 report.
 */
import { describe, it, expect } from 'vitest';
import type { Object3D } from 'three';
import { scratchAssetDocument } from './helpers/scratch-asset-document';
import { makeSpikeViewer, ref, HOLDER } from './helpers/spike-610-ref-fixture';

const DRIVE_T = 'realvirtual.Drive';

/** Wrap a private method of `obj` to accumulate its wall time. */
function timeMethod(obj: object, name: string): { ms: number; calls: number; restore(): void } {
  const target = obj as Record<string, (...a: unknown[]) => unknown>;
  const orig = target[name];
  const acc = { ms: 0, calls: 0, restore: () => { target[name] = orig; } };
  target[name] = function (this: unknown, ...a: unknown[]) {
    const t0 = performance.now();
    try { return orig.apply(this, a); } finally { acc.ms += performance.now() - t0; acc.calls++; }
  };
  return acc;
}

describe('plan-610 perf — Mauser-size rename', () => {
  it('planning + flush + foreign scan of one rename < 150 ms at ~12 600 nodes', async () => {
    const f = makeSpikeViewer();
    // 126 cells × (1 + 99) nodes = 12 600 registered nodes under the model.
    const cells: Object3D[] = [];
    for (let c = 0; c < 126; c++) {
      const cell = f.add(f.model, `Cell${c}`);
      cells.push(cell);
      let parent = cell;
      for (let i = 0; i < 99; i++) {
        const n = f.add(i % 10 === 0 ? cell : parent, `N${c}_${i}`);
        parent = n;
      }
    }
    const referrersRoot = f.add(f.model, 'Referrers');
    const referrerNodes: Object3D[] = [];
    for (let r = 0; r < 300; r++) referrerNodes.push(f.add(referrersRoot, `R${r}`));
    f.register();
    // One drive per cell, 300 referrers spread over the cells (2–3 per cell).
    for (const cell of cells) f.drive(cell.children[0]);
    referrerNodes.forEach((node, r) => {
      const c = r % 126;
      const target = cells[c].children[0];
      f.component(node, HOLDER, { DriveA: ref(`Cell${c}/${target.name}`, DRIVE_T) });
    });
    let registered = 0;
    f.registry.forEachNode(() => { registered++; });
    expect(registered).toBeGreaterThanOrEqual(12_600);

    const doc = scratchAssetDocument(f.viewer);
    const plan = timeMethod(doc, '_planRename');
    const flush = timeMethod(doc.executor, '_closeRefRebind');
    const t0 = performance.now();
    const res = await doc.renameNodeAwaited('Asset/Cell7', 'Station7');
    const total = performance.now() - t0;
    plan.restore();
    flush.restore();
    expect(res.referencesRewritten).toBeGreaterThan(0);
    const budget = plan.ms + flush.ms;
    console.info(`[perf-610] rename @${registered} nodes: plan ${plan.ms.toFixed(1)} ms + flush/scan ${flush.ms.toFixed(1)} ms = ${budget.toFixed(1)} ms (total apply ${total.toFixed(1)} ms, ${res.referencesRewritten} refs)`);
    expect(budget).toBeLessThan(150);
    doc.dispose();
  });
});

describe('plan-610 perf — 434 moves on a 4 493-node assembly', () => {
  it('one structure event, bounded matrix flushes, runtime logged', async () => {
    const f = makeSpikeViewer();
    // 434 movable parts × (1 + 9) nodes = 4 340, plus 153 static nodes = 4 493.
    const parts: Object3D[] = [];
    const assembly = f.add(f.model, 'Assembly');
    for (let p = 0; p < 434; p++) {
      const part = f.add(assembly, `Part${p}`);
      parts.push(part);
      for (let i = 0; i < 9; i++) f.add(part, `Sub${p}_${i}`);
    }
    const statics = f.add(f.model, 'Static');
    for (let s = 0; s < 150; s++) f.add(statics, `S${s}`);
    const target = f.add(f.model, 'Target');
    const panel = f.add(f.model, 'Panel');
    f.register();
    // Every moved part is referenced (by one array field — one setField step).
    for (const part of parts) f.drive(part.children[0]);
    f.component(panel, HOLDER, {
      Tools: parts.map((part) => ref(`Assembly/${part.name}/${part.children[0].name}`, DRIVE_T)),
    });
    let registered = 0;
    f.registry.forEachNode(() => { registered++; });
    expect(registered).toBeGreaterThanOrEqual(4_493);

    let targetFlushes = 0;
    const origUpdate = target.updateMatrixWorld.bind(target);
    target.updateMatrixWorld = (force?: boolean) => { if (force) targetFlushes++; origUpdate(force); };

    const doc = scratchAssetDocument(f.viewer);
    const eventsBefore = f.events.filter((e) => e.name === 'editor-structure-changed').length;
    const t0 = performance.now();
    const res = await doc.reparentNodesBatchDetailed(parts.map((p) => `Asset/Assembly/${p.name}`), 'Asset/Target');
    const ms = performance.now() - t0;
    const structureEvents = f.events.filter((e) => e.name === 'editor-structure-changed').length - eventsBefore;

    expect(res.moved).toHaveLength(434);
    expect(res.referencesRewritten).toBe(434);
    expect(doc.ops).toHaveLength(1);
    expect(structureEvents).toBe(1);
    // Planner pre-refresh + the batch's own end flush (+ the drain before the
    // deferred re-apply) — never one per moved node.
    expect(targetFlushes).toBeLessThanOrEqual(4);
    console.info(`[perf-610] batch 434 moves @${registered} nodes: ${ms.toFixed(1)} ms, ${structureEvents} structure event(s), ${targetFlushes} forced target matrix refresh(es), ${res.referencesRewritten} refs rewritten`);
    // Order of magnitude of plan-359's 21 ms plus the scan — generous for CI noise.
    expect(ms).toBeLessThan(1000);
    doc.dispose();
  });
});
