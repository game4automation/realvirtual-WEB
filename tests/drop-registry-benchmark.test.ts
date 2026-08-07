// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * drop-registry-benchmark.test.ts — plan-341 §9.9b / §2.8 (e).
 *
 * The candidate pass is the one new O(entries) operation in the drag, so it is
 * measured, not assumed: 200 entries across 3 simultaneously open surfaces,
 * `beginCandidates()` under 8 ms (median of 5 runs after a warm-up).
 *
 * The allocation half of the contract is stated EXACTLY as agreed, not as a
 * GC heuristic: `pointermove` adds no NEW allocation source (the pre-existing
 * `entryUnionRect()` still allocates one rect per fallback call and stays that
 * way), and the rule is consulted at most ONCE PER HOVER TRANSITION — measured
 * with the `__rvDropDiag.rejectCalls` counter, not inferred.
 *
 * The 3D overlay budget test does NOT cover this path: it measures scene nodes.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  createDropTargetRegistry,
  dropDiagnostics,
  type DropHandle,
} from '../src/core/hmi/drop-target-registry';

interface Payload { kind: 'bool' | 'float' }

const SURFACES = 3;
const ENTRIES_PER_SURFACE = 200 / SURFACES;
const BUDGET_MS = 8;

const teardown: Array<() => void> = [];
afterEach(() => { for (const fn of teardown.splice(0)) fn(); });

/** 200 registered entries spread over three simultaneously mounted surfaces. */
function buildSurfaces() {
  const registry = createDropTargetRegistry<Payload, { why: string }>();
  const handles: DropHandle[] = [];
  const elements: HTMLElement[] = [];
  for (let surface = 0; surface < SURFACES; surface++) {
    const host = document.createElement('div');
    host.style.position = 'fixed';
    host.style.left = `${surface * 320}px`;
    host.style.top = '0px';
    document.body.appendChild(host);
    elements.push(host);
    for (let i = 0; i < Math.ceil(ENTRIES_PER_SURFACE); i++) {
      const el = document.createElement('div');
      el.style.height = '20px';
      el.style.width = '300px';
      host.appendChild(el);
      const handle = registry.createDropTarget({
        // Alternate so half the entries become candidates and half do not.
        reject: (p) => (i % 2 === 0 && p.kind === 'bool' ? null : { why: 'type' }),
        describe: () => ({ targetId: `s${surface}-r${i}`, accessibleLabel: `Row ${i}` }),
        onDrop: () => {},
      });
      handle.attach(el);
      handles.push(handle);
    }
  }
  teardown.push(() => {
    for (const handle of handles) handle.dispose();
    for (const el of elements) el.remove();
  });
  return { registry, handles, elements };
}

describe('drop registry performance contract', () => {
  it('beginCandidates() stays under 8 ms for 200 entries across 3 surfaces', () => {
    const { registry, handles } = buildSurfaces();
    expect(handles.length).toBeGreaterThanOrEqual(200);

    registry.beginCandidates({ kind: 'bool' }); // warm-up, not measured
    registry.endDrag();

    const samples: number[] = [];
    for (let run = 0; run < 5; run++) {
      const t0 = performance.now();
      registry.beginCandidates({ kind: 'bool' });
      samples.push(performance.now() - t0);
      registry.endDrag();
    }
    samples.sort((a, b) => a - b);
    const median = samples[2];
    // eslint-disable-next-line no-console -- the measured number belongs in the log
    console.log(`[drop-registry perf] beginCandidates 200 entries: ${median.toFixed(2)} ms (median of 5)`);
    expect(median).toBeLessThan(BUDGET_MS);
  });

  it('consults the rule at most once per hover transition, never per pointermove', () => {
    const { registry, elements } = buildSurfaces();
    const first = elements[0].firstElementChild as HTMLElement;
    const rect = first.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;

    registry.beginCandidates({ kind: 'bool' });
    const afterCandidates = dropDiagnostics.rejectCalls;

    // Enter the row: exactly ONE transition, so exactly one evaluation.
    registry.updateHover(x, y, { kind: 'bool' });
    const afterEnter = dropDiagnostics.rejectCalls;
    expect(afterEnter - afterCandidates).toBe(1);

    // Twenty further moves WITHIN the same row are not transitions.
    for (let i = 0; i < 20; i++) registry.updateHover(x + (i % 3), y, { kind: 'bool' });
    expect(dropDiagnostics.rejectCalls).toBe(afterEnter);

    registry.endDrag();
  });
});
