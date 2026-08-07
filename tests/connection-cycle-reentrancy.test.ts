// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * connection-cycle-reentrancy.test.ts — plan-259 §9.11.
 *
 * Cyclic edges (A→B→A) and self-links (source === target): the dispatch
 * TERMINATES (re-entrancy depth guard) instead of hanging, and creating such
 * edges warns.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { RVConnectionRegistry, type RvConnection } from '../src/core/engine/rv-connection-registry';

const edge = (id: string, source: string, target: string, type = 'Ping'): RvConnection =>
  ({ id, source, target, type });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('connection cycles + re-entrancy (plan-259)', () => {
  it('warns when adding a self-link and when closing a cycle', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reg = new RVConnectionRegistry();
    reg.addConnection(edge('c1', 'A', 'A'));
    expect(warn.mock.calls.some(([m]) => String(m).includes('itself'))).toBe(true);

    warn.mockClear();
    reg.addConnection(edge('c2', 'A', 'B'));
    expect(warn).not.toHaveBeenCalled();      // plain edge — no warning
    reg.addConnection(edge('c3', 'B', 'A'));  // closes A→B→A
    expect(warn.mock.calls.some(([m]) => String(m).includes('cycle'))).toBe(true);
  });

  it('synchronously re-entrant dispatch over a cycle terminates (depth guard)', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reg = new RVConnectionRegistry();
    reg.addConnection(edge('c1', 'A', 'B'));
    reg.addConnection(edge('c2', 'B', 'A'));

    let aCalls = 0;
    let bCalls = 0;
    // Pathological endpoints that synchronously bounce the request back.
    reg.registerEndpoint('A', {
      onRequest: () => { aCalls++; reg.call('A', 'Ping', {}, null); },
    });
    reg.registerEndpoint('B', {
      onRequest: () => { bCalls++; reg.call('B', 'Ping', {}, null); },
    });

    // Must return (bounded by MAX_DISPATCH_DEPTH), not loop forever.
    reg.call('A', 'Ping', {}, null);
    expect(aCalls).toBeGreaterThan(0);
    expect(bCalls).toBeGreaterThan(0);
    expect(aCalls + bCalls).toBeLessThan(100);
  });

  it('self-link dispatch terminates too', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reg = new RVConnectionRegistry();
    reg.addConnection(edge('c1', 'A', 'A'));
    let calls = 0;
    reg.registerEndpoint('A', {
      onRequest: () => { calls++; reg.call('A', 'Ping', {}, null); },
    });
    reg.call('A', 'Ping', {}, null);
    expect(calls).toBeGreaterThan(0);
    expect(calls).toBeLessThan(100);
  });

  it('arrival dispatch respects the same depth guard', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reg = new RVConnectionRegistry();
    const e = edge('c1', 'S', 'T', 'StopOnExit');
    reg.addConnection(e);
    let arrivals = 0;
    reg.registerEndpoint('T', {
      onArrival: (mu) => { arrivals++; reg.deliverArrival(e, mu); },
    });
    reg.deliverArrival(e, { id: 1 });
    expect(arrivals).toBeGreaterThan(0);
    expect(arrivals).toBeLessThan(100);
  });
});
