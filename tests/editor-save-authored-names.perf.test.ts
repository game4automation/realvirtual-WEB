// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-765 9.11 — cost bound of the save's two extra walks.
 *
 * A save of a large model runs `restoreAuthoredNames` once on the export clone
 * and `countWrittenReferences` twice (live tree + clone). Both must stay small
 * against the ~95 s GLTFExporter run of a 70k-node Mauser save; the bound here
 * is 500 ms each at 50 000 nodes (median of several runs after a warm-up, the
 * pattern of `signal-rename-plan.perf.test.ts`). The `pathFieldsOf` cache in
 * `rv-reference-audit.ts` is what keeps the count linear in records rather than
 * records × table size.
 */

import { describe, expect, it } from 'vitest';
import { Object3D } from 'three';
import { countWrittenReferences } from '../src/core/engine/rv-reference-audit';
import { exportPrunePredicate, restoreAuthoredNames } from '../src/core/editor/rv-asset-glb-export';

const GROUPS = 500;
const PER_GROUP = 99; // + the group node itself = 100 per group → 50 000 nodes + root
const BUDGET_MS = 500;

/** 50k nodes: every group holds stamped leaves and leaves referencing a stamped sibling. */
function buildTree(): Object3D {
  const root = new Object3D();
  root.name = 'Asset';
  for (let g = 0; g < GROUPS; g++) {
    const group = new Object3D();
    group.name = `G${g}`;
    root.add(group);
    for (let i = 0; i < PER_GROUP; i++) {
      const n = new Object3D();
      if (i % 2 === 0) {
        // A deduplicated leaf: loader name `P<i>_1`, authored `P:<i>`.
        n.name = `P${i}_1`;
        n.userData._rvOrigName = `P:${i}`;
      } else {
        n.name = `L${i}`;
        n.userData.realvirtual = {
          RuntimeMetadata: { window: { type: 'ComponentReference', path: `G${g}/P:${i - 1}`, componentType: '' } },
          Drive_Cylinder: { Out: { type: 'ComponentReference', path: `Asset/G${g}/L${i}`, componentType: 'Sensor' } },
        };
      }
      group.add(n);
    }
  }
  return root;
}

function median(run: () => void, warmup = 2, samples = 5): number {
  for (let i = 0; i < warmup; i++) run();
  const times: number[] = [];
  for (let i = 0; i < samples; i++) {
    const t0 = performance.now();
    run();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)];
}

const origOrName = (n: Object3D): string => {
  const o = n.userData._rvOrigName;
  return typeof o === 'string' && o.length > 0 ? o : n.name;
};

describe('plan-765 9.11 — cost bound', () => {
  it(`countWrittenReferences finishes in < ${BUDGET_MS} ms at 50 000 nodes`, () => {
    const root = buildTree();
    let nodes = 0;
    root.traverse(() => { nodes++; });
    expect(nodes).toBe(GROUPS * (PER_GROUP + 1) + 1);

    let last = countWrittenReferences(root, origOrName, exportPrunePredicate);
    const ms = median(() => { last = countWrittenReferences(root, origOrName, exportPrunePredicate); });
    console.info(`[perf] countWrittenReferences @ ${nodes} nodes: median ${ms.toFixed(1)} ms`);
    // Every reference resolves in authored spelling (relative AND root-prefixed).
    expect(last.references).toBe(GROUPS * Math.floor(PER_GROUP / 2) * 2);
    expect(last.unresolved).toBe(0);
    expect(ms).toBeLessThan(BUDGET_MS);
  }, 120_000);

  it(`restoreAuthoredNames finishes in < ${BUDGET_MS} ms at 50 000 nodes`, () => {
    // A fresh tree per sample: the restore is a one-shot rename of the clone.
    const trees = Array.from({ length: 7 }, buildTree);
    let k = 0;
    const ms = median(() => { restoreAuthoredNames(trees[k++]); });
    console.info(`[perf] restoreAuthoredNames @ 50 000 nodes: median ${ms.toFixed(1)} ms`);
    expect(trees[0].children[0].children[0].name).toBe('P:0');
    expect(ms).toBeLessThan(BUDGET_MS);
  }, 120_000);
});
