// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
// plan-612 Phase 6 (#211) — the soak's upper-bound checks BITE:
//   - `DESManager.queuedEventCount` exists and follows enqueue / dispatch / cancel (the former
//     soak read `queuedEventCount ?? QueuedEventCount ?? -1` from a manager without either,
//     filtered the -1 away and never asserted anything);
//   - a model that schedules more events than it consumes is flagged by `checkSoakBounds`, a
//     steady one is not — measured on a REAL DESManager, not on a hand-made series;
//   - an unreadable figure (-1, NaN, undefined) is a violation, never a skipped check;
//   - absolute caps and the growth rule fire for every figure;
//   - the queue's id index holds one entry per HELD event (it used to keep one per processed
//     event — an unbounded Map over a long run — and a consumed id could cancel a live event).
import { describe, expect, it } from 'vitest';
import { DESManager } from '@rv/plugins/des/rv-des-manager';
import { DESEventQueue } from '@rv/plugins/des/rv-des-event-queue';
import { ACTION_INDEX, registerAction } from '@rv/plugins/des/rv-des-named-actions';
import type { ActionContext } from '@rv/plugins/des/rv-des-event';
import { PALLET_YARD_CAPS, checkSoakBounds, type SoakSample } from './pallet-yard-soak-bounds';

/** Per-test fan-out of the self-rescheduling action (1 = steady, 2 = leak). */
let fanOut = 1;
const ACTION = 'plan612.soakBounds.tick';
if (!ACTION_INDEX.has(ACTION)) {
  registerAction(ACTION, (ctx: ActionContext) => {
    for (let i = 0; i < fanOut; i++) (ctx.manager as DESManager).scheduleIn(1 + i * 0.25, ACTION, -1);
  });
}

const flat = (over: Partial<SoakSample> = {}): SoakSample => ({
  t: 0, queue: 20, liveMus: 10, muSlots: 12, nodes: 400, statsBytes: 17_000, heapBytes: 64 * 1024 * 1024, ...over,
});

/** Run `mgr` for `hours` sim hours, sampling the queue every `every` sim seconds. */
function sampleQueue(mgr: DESManager, hours: number, every = 600): SoakSample[] {
  const out: SoakSample[] = [];
  mgr.duration = hours * 3600;
  for (let t = every; t <= hours * 3600; t += every) {
    mgr.processUpTo(t, 10_000_000);
    out.push(flat({ t, queue: mgr.queuedEventCount }));
  }
  return out;
}

describe('plan-612 #211 — soak upper bounds bite', () => {
  it('queuedEventCount follows enqueue, dispatch and cancel', () => {
    const mgr = new DESManager(16);
    expect(mgr.queuedEventCount).toBe(0);
    fanOut = 0; // the action schedules nothing
    const a = mgr.scheduleEvent(1, ACTION, -1);
    mgr.scheduleEvent(2, ACTION, -1);
    mgr.scheduleEvent(3, ACTION, -1);
    expect(mgr.queuedEventCount).toBe(3);
    mgr.processUpTo(1.5, 100);
    expect(mgr.queuedEventCount).toBe(2);
    expect(mgr.cancelEvent(a)).toBe(false); // already consumed
    mgr.processUpTo(10, 100);
    expect(mgr.queuedEventCount).toBe(0);
    for (let i = 0; i < 40; i++) mgr.scheduleEvent(20 + i, ACTION, -1); // grows past the initial capacity
    expect(mgr.queuedEventCount).toBe(40);
  });

  it('the queue id index does not grow with processed events, and a consumed id cancels nothing', () => {
    const q = new DESEventQueue(8);
    for (let i = 0; i < 6; i++) q.enqueue(i, 0, -1, -1);
    const consumed = q.dequeue()!.id;
    for (let k = 0; k < 10_000; k++) { q.dequeue(); q.enqueue(10 + k, 0, -1, -1); }
    expect(q.count).toBe(5);
    expect(q.indexSize, 'one index entry per held event (was: one per processed event)').toBe(q.count);
    // the slot the consumed id once pointed at holds a live event now — cancelling the old id must not touch it
    expect(q.cancel(consumed)).toBe(false);
    let live = 0;
    while (q.dequeue()) live++;
    expect(live).toBe(5);
    expect(q.indexSize).toBe(0);
    // the cancelled-drain path (peekTime) keeps the index exact too
    const ids = Array.from({ length: 6 }, (_, i) => q.enqueue(i, 0, -1, -1));
    q.cancel(ids[0]); q.cancel(ids[1]);
    expect(q.peekTime).toBe(2);
    expect(q.indexSize).toBe(q.count);
  });

  it('a steady model (one event per event) stays within the queue bound', () => {
    fanOut = 1;
    const mgr = new DESManager();
    for (let i = 0; i < 8; i++) mgr.scheduleEvent(i * 0.1, ACTION, -1);
    const s = sampleQueue(mgr, 6);
    expect(s.every((x) => x.queue === 8)).toBe(true);
    expect(checkSoakBounds(s)).toEqual([]);
  });

  it('a leaking model (two events per event) is flagged — the check is not vacuous', () => {
    fanOut = 2;
    const mgr = new DESManager();
    mgr.scheduleEvent(0, ACTION, -1);
    // growth explodes exponentially; a short window is enough to see it
    const s: SoakSample[] = [];
    mgr.duration = 12;
    for (let t = 1; t <= 12; t++) { mgr.processUpTo(t, 10_000_000); s.push(flat({ t, queue: mgr.queuedEventCount })); }
    const v = checkSoakBounds(s);
    expect(v.some((x) => x.startsWith('queue:')), v.join('\n')).toBe(true);
    fanOut = 1;
  });

  it('an unreadable figure is a violation, not a skipped check (the #211 failure mode)', () => {
    const s = Array.from({ length: 9 }, (_, i) => flat({ t: i, queue: -1 }));
    expect(checkSoakBounds(s)).toContainEqual(expect.stringMatching(/^queue: unreadable sample -1/));
    const u = Array.from({ length: 9 }, (_, i) => flat({ t: i, nodes: undefined as unknown as number }));
    expect(checkSoakBounds(u)).toContainEqual(expect.stringMatching(/^nodes: unreadable/));
    const n = Array.from({ length: 9 }, (_, i) => flat({ t: i, statsBytes: Number.NaN }));
    expect(checkSoakBounds(n)).toContainEqual(expect.stringMatching(/^statsBytes: unreadable/));
    expect(checkSoakBounds([])).toEqual(['no samples']);
  });

  it('a missing heap is accepted only when the platform cannot measure it at all', () => {
    const none = Array.from({ length: 9 }, (_, i) => flat({ t: i, heapBytes: null }));
    expect(checkSoakBounds(none, PALLET_YARD_CAPS, true)).toEqual([]);
    expect(checkSoakBounds(none)).toContainEqual(expect.stringMatching(/^heapBytes: unreadable/));
    const part = none.map((x, i) => (i < 4 ? { ...x, heapBytes: 1e8 } : x));
    expect(checkSoakBounds(part, PALLET_YARD_CAPS, true)).toContainEqual(expect.stringMatching(/^heapBytes: unreadable/));
  });

  it.each(['queue', 'liveMus', 'muSlots', 'nodes', 'statsBytes', 'heapBytes'] as const)('%s: the absolute cap and the growth rule fire', (f) => {
    const cap = PALLET_YARD_CAPS[f];
    const base = flat()[f] as number;
    const steady = Array.from({ length: 12 }, (_, i) => flat({ t: i }));
    expect(checkSoakBounds(steady)).toEqual([]);
    const over = steady.map((x, i) => (i === 5 ? { ...x, [f]: cap.max + 1 } : x));
    expect(checkSoakBounds(over)).toContainEqual(expect.stringMatching(new RegExp(`^${f}: peak`)));
    const leaked = Math.ceil(base * (1 + cap.slackRel) + cap.slackAbs) + 1; // just above the allowed growth
    expect(leaked).toBeLessThanOrEqual(cap.max);                             // ... and still under the cap
    const grow = steady.map((x, i) => (i >= 8 ? { ...x, [f]: leaked } : x));
    expect(checkSoakBounds(grow)).toContainEqual(expect.stringMatching(new RegExp(`^${f}: grows`)));
  });
});
