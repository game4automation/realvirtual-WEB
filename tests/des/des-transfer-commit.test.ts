// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import type { MU } from '../../src/core/material-flow/material-flow-self';
import { flow, transferFixture } from './phase2-transfer-fixture';

describe('9.7 transfer commit', () => {
  it('a: rolls back three hook refusals without retry loops, KPI or metadata changes', () => {
    let calls = 0;
    const f = transferFixture([
      { type: flow() },
      { type: flow({ des: {
        canAccept: () => true,
        onAccept() {
          // Fail promptly if rollback starts a synchronous retry loop.
          if (++calls > 3) throw new Error('onAccept retried without independent ready');
          return false;
        },
      } }) },
    ]);
    const [sender, target] = f.parts;
    const mu = f.runner.createMU();
    sender.acceptMU(mu);
    const before = {
      entryTime: mu.entryTime, componentsVisited: mu.componentsVisited,
      totalProcessed: target.totalProcessed, currentLoad: target.currentLoad,
    };
    f.advance(7); // A mistaken target add must visibly change entryTime.
    expect(target.canAccept(mu)).toBe(true);
    for (let attempt = 1; attempt <= 3; attempt++) {
      expect(() => {
        if (attempt === 1) sender.self.transfer(mu as unknown as MU);
        else sender.onDownstreamReady(target); // independent external readiness
      }).not.toThrow();
      expect.soft(calls, `attempt ${attempt}`).toBe(attempt);
      expect.soft(sender.self.mus).toEqual([mu]);
      expect.soft(mu.currentComponent).toBe(sender);
      expect.soft(sender.totalProcessed).toBe(0);
      expect.soft(target.self.mus).toHaveLength(0);
      expect.soft({
        entryTime: mu.entryTime, componentsVisited: mu.componentsVisited,
        totalProcessed: target.totalProcessed, currentLoad: target.currentLoad,
      }).toEqual(before);
      f.advance(7 + attempt);
      expect.soft(calls, 'advancing time is not an independent ready').toBe(attempt);
    }
  });

  it('b: immediate Sink consumption leaves no owner and counts exactly one sender output', () => {
    const consumed: MU[] = [];
    const f = transferFixture([
      { type: flow() },
      { type: flow({ kind: 'sink', des: { onAccept(_self, mu) {
        consumed.push(mu);
        return true;
      } } }) },
    ]);
    const [sender, sink] = f.parts;
    const mu = f.runner.createMU();
    sender.acceptMU(mu);
    const consumedAtCommit: boolean[] = [];
    sender.onMUExit = () => { consumedAtCommit.push(consumed.includes(mu as unknown as MU)); };
    expect(() => sender.self.transfer(mu as unknown as MU)).not.toThrow();
    expect(consumed).toEqual([mu]);
    expect(mu.currentComponent).toBeNull();
    expect(sender.self.mus).toHaveLength(0);
    expect(sink.self.mus).toHaveLength(0);
    expect(sender.totalProcessed).toBe(1);
    expect(sink.totalProcessed).toBe(1);
    // A consuming target must finish acceptance before the sender commits, too.
    expect(consumedAtCommit).toEqual([true]);
  });

  it('c: synchronous Sink wake-ups in a Source/Storage chain conserve every MU', () => {
    const consumed: MU[] = [];
    const f = transferFixture([
      { type: 'Source', props: { Interval: 100 } },
      { type: 'Storage', props: { AutoRelease: true, AutoReleaseDelay: 1, MaxCapacity: 1 } },
      { type: flow({ kind: 'sink', des: { onAccept(_self, mu) {
        consumed.push(mu);
        // Bound the old recursive wake-up path, not elapsed simulation time.
        if (consumed.length > 20) throw new Error('recursive zero-time Storage discharge');
        return true;
      } } }) },
    ]);
    const [source, storage, sink] = f.parts;
    expect(() => f.advance(2)).not.toThrow();
    expect(consumed.length).toBeGreaterThan(0);
    const accounted = [...consumed, ...source.self.mus, ...storage.self.mus, ...sink.self.mus];
    // Source keeps a back-pressured spawn in local.pending rather than self.mus.
    const pending = source.self.local.pending as MU | null;
    if (pending && !accounted.includes(pending)) accounted.push(pending);
    // plan-2212: a consumed MU retires at the end of its consuming event (its slot
    // is freed then), so the registered MUs are exactly the ones not consumed.
    const registered = Array.from({ length: f.manager.muCount }, (_, id) => f.manager.getMU(id)).filter(m => m !== null);
    expect(new Set(accounted).size).toBe(accounted.length);
    expect(consumed.every(m => (m as unknown as { retired: boolean }).retired)).toBe(true);
    expect(new Set(accounted.filter(m => !consumed.includes(m)))).toEqual(new Set(registered));
    expect(source.totalProcessed).toBe(consumed.length + storage.currentLoad);
    expect(storage.totalProcessed).toBe(consumed.length);
    expect(sink.totalProcessed).toBe(consumed.length);
  });

  it('d: notifies upstream only after target acceptance and sender commit', () => {
    const order: string[] = [];
    const f = transferFixture([
      { type: flow({ des: { onDownstreamReady() { order.push('upstream-ready'); } } }) },
      { type: flow() },
      { type: flow({ des: { onAccept() { order.push('target-accept'); return true; } } }) },
    ]);
    const [upstream, sender, target] = f.parts;
    const mu = f.runner.createMU();
    sender.acceptMU(mu);
    sender.onMUExit = () => { order.push('sender-exit'); };
    const ready = upstream.onDownstreamReady.bind(upstream);
    upstream.onDownstreamReady = from => {
      expect.soft(sender.self.mus).toHaveLength(0);
      expect.soft(sender.totalProcessed).toBe(1);
      expect.soft(target.self.mus).toEqual([mu]);
      expect.soft(mu.currentComponent).toBe(target);
      ready(from);
    };
    sender.self.transfer(mu as unknown as MU);
    expect(order).toEqual(['target-accept', 'sender-exit', 'upstream-ready']);
    expect(mu.currentComponent).toBe(target);
  });

  it('e: clears transfer-processing records and processes a reused MU id again', () => {
    const consumed: MU[] = [];
    const f = transferFixture([
      // A DES block registers the production AttachmentComplete hook.
      { type: flow({ processingAttachmentPoint: 'transfer', des: {} }) },
      { type: flow({ kind: 'sink', des: { onAccept(_self, mu) {
        consumed.push(mu);
        return true;
      } } }) },
    ]);
    const [sender] = f.parts;
    sender.configureProcessingAttachment(2, 'test/Processing');
    const consumedAtCommit: number[] = [];
    sender.onMUExit = () => { consumedAtCommit.push(consumed.length); };
    const first = f.runner.createMU();
    sender.acceptMU(first);
    sender.self.transfer(first as unknown as MU);
    f.advance(1);
    expect(consumed).toHaveLength(0);
    f.advance(2);
    expect(consumed).toEqual([first]);
    expect(sender.self.prop.__desAttachmentProcessing).toEqual([]);
    expect(sender.self.prop.__desAttachmentReady).toEqual([]);
    expect(sender.totalProcessed).toBe(1);

    // The completed event has released its reference, so retirement frees the id.
    f.manager.retireMU(first);
    const second = f.runner.createMU();
    expect(second.id).toBe(first.id);
    expect(second.generation).toBeGreaterThan(first.generation);
    sender.acceptMU(second);
    sender.self.transfer(second as unknown as MU);
    expect(consumed).toEqual([first]);
    expect(sender.self.mus).toEqual([second]);
    f.advance(3);
    expect(consumed).toEqual([first]);
    f.advance(4);
    expect(consumed).toEqual([first, second]);
    expect(sender.self.prop.__desAttachmentProcessing).toEqual([]);
    expect(sender.self.prop.__desAttachmentReady).toEqual([]);
    expect(sender.totalProcessed).toBe(2);
    // Exercise acceptance-before-commit on the processing completion path.
    // The cleanup/id-reuse assertions above also protect the releaseMU override.
    expect(consumedAtCommit).toEqual([1, 2]);
  });
});
