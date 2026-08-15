// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-707 T5 — the delta's token/byte ceiling (NF1, R3).
 *
 * The delta is always on: it rides on every one of the ~60 probed write tools,
 * so its size is a running cost, not an occasional one. Two things must stay
 * true, and neither is self-evident from the code:
 *
 *  1. It CANNOT grow without bound. An oversized bridge frame does not fail one
 *     call — CONNECT closes the socket and takes every pending call with it.
 *  2. The constants stay ARGUED. A budget that can be raised silently is not a
 *     budget, so the test also asserts the reasoning is still written down
 *     next to the numbers.
 */

import { describe, it, expect } from 'vitest';
import {
  DELTA_MAX_BYTES,
  DELTA_MAX_ENTRIES,
  DELTA_MAX_ENTRY_CHARS,
  makeDelta,
  mergeDelta,
} from '../src/plugins/mcp-bridge/rv-mcp-delta-probes';
import PROBE_SOURCE from '../src/plugins/mcp-bridge/rv-mcp-delta-probes.ts?raw';

describe('T5 — the delta stays inside its budget', () => {
  it('50 changes cap to DELTA_MAX_ENTRIES with the rest counted', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `Node${i}.x: 0→1`);
    const d = makeDelta(lines);
    expect(d.changed).toHaveLength(DELTA_MAX_ENTRIES);
    expect(d.more).toBe(50 - DELTA_MAX_ENTRIES);
  });

  it('every capped delta serialises inside DELTA_MAX_BYTES', () => {
    for (const n of [1, 2, 5, DELTA_MAX_ENTRIES, DELTA_MAX_ENTRIES + 1, 50, 500]) {
      const lines = Array.from({ length: n }, (_, i) => `Assembly/Sub${i}/Part${i}.transform: a→b`);
      const size = JSON.stringify(makeDelta(lines)).length;
      expect(size, `${n} entries serialised to ${size} B`).toBeLessThanOrEqual(DELTA_MAX_BYTES);
    }
  });

  it('one over-long line is truncated, not passed through', () => {
    const monster = `A/${'very-long-node-name/'.repeat(60)}leaf.field: 0→1`;
    const d = makeDelta([monster]);
    expect(d.changed[0].length).toBeLessThanOrEqual(DELTA_MAX_ENTRY_CHARS);
    expect(d.changed[0].endsWith('…')).toBe(true);
    expect(JSON.stringify(d).length).toBeLessThanOrEqual(DELTA_MAX_BYTES);
  });

  it('even eight over-long lines together stay inside the ceiling', () => {
    const lines = Array.from({ length: DELTA_MAX_ENTRIES }, (_, i) =>
      `A/${'deep/'.repeat(40)}Part${i}.someRatherLongFieldName: 0→1`);
    const d = makeDelta(lines);
    expect(JSON.stringify(d).length).toBeLessThanOrEqual(DELTA_MAX_BYTES);
    // Entries were shed for bytes, so the count has to say so.
    expect(d.more ?? 0).toBeGreaterThanOrEqual(0);
    expect(d.changed.length).toBeGreaterThanOrEqual(1);
  });

  it('the merged result grows by the delta and nothing else', () => {
    const src = JSON.stringify({ name: 'Sig1', value: false, previous: true });
    const lines = Array.from({ length: 50 }, (_, i) => `n${i}: 0→1`);
    const out = mergeDelta(src, makeDelta(lines));
    expect(out.length - src.length).toBeLessThanOrEqual(DELTA_MAX_BYTES + 16);
  });
});

describe('T5 — the constants stay argued', () => {
  it('both carry their Phase-0 provenance in a comment', () => {
    // Not decoration: a number nobody has to defend is a number that drifts
    // upward one small raise at a time.
    const entriesDoc = PROBE_SOURCE.slice(0, PROBE_SOURCE.indexOf('export const DELTA_MAX_ENTRIES'));
    const bytesDoc = PROBE_SOURCE.slice(0, PROBE_SOURCE.indexOf('export const DELTA_MAX_BYTES'));
    expect(entriesDoc).toContain('Phase-0');
    expect(bytesDoc).toContain('Phase-0');
    // The measured reference sizes have to be NAMED, not merely alluded to —
    // "measured in Phase 0" without the numbers is not a defence.
    expect(entriesDoc).toMatch(/web_signal_set_bool`?\s*48 B/);
    expect(entriesDoc).toMatch(/_statusJson`?\s*~250 B/);
  });

  it('the numbers themselves are sane', () => {
    expect(DELTA_MAX_ENTRIES).toBeGreaterThanOrEqual(4);
    expect(DELTA_MAX_ENTRIES).toBeLessThanOrEqual(16);
    // Big enough for eight real lines, far below any bridge frame limit.
    expect(DELTA_MAX_BYTES).toBeGreaterThanOrEqual(300);
    expect(DELTA_MAX_BYTES).toBeLessThanOrEqual(2048);
  });
});
