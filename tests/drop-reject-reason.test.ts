// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * drop-reject-reason.test.ts — plan-341 §9.1.
 *
 * The four rejection causes must be told APART (a user who is shown "not
 * compatible" learns nothing), `slotAcceptsSignal` must be a pure derivation of
 * `slotRejectReason` (no second source of truth to drift), and `unknown` must
 * follow the rule fixed in §2.8 (a): rejected, but WITH a reason.
 */
import { describe, it, expect } from 'vitest';
import {
  slotRejectReason,
  slotAcceptsSignal,
  dropRejectText,
  type RejectPayloadInput,
  type RejectSlotInput,
} from '../src/plugins/signal-bind/drop-accept';

const BOOL_OUT: RejectSlotInput = { type: 'bool', direction: 'plcOutput' };
const BOOL_IN: RejectSlotInput = { type: 'bool', direction: 'plcInput' };
const FLOAT_OUT: RejectSlotInput = { type: 'float', direction: 'plcOutput' };

const CONNECT_BOOL_OUT: RejectPayloadInput = {
  plcType: 'PLCOutputBool', direction: 'output', origin: 'connect', interfaceId: 'iface-1',
};

describe('slotRejectReason — the four causes are separate', () => {
  it('accepts a matching CONNECT signal (null = accepted)', () => {
    expect(slotRejectReason(BOOL_OUT, CONNECT_BOOL_OUT)).toBeNull();
  });

  it('names a TYPE mismatch with both sides', () => {
    expect(slotRejectReason(FLOAT_OUT, CONNECT_BOOL_OUT))
      .toEqual({ kind: 'type', expected: 'float', got: 'bool' });
  });

  it('does NOT call the Int→Float widening a mismatch', () => {
    expect(slotRejectReason(FLOAT_OUT, { ...CONNECT_BOOL_OUT, plcType: 'PLCOutputInt' })).toBeNull();
  });

  it('names a DIRECTION mismatch with the expected direction', () => {
    expect(slotRejectReason(BOOL_IN, CONNECT_BOOL_OUT))
      .toEqual({ kind: 'direction', expected: 'plcInput' });
  });

  it('names UNAVAILABLE with the slot\'s own detail, ahead of every other cause', () => {
    const slot: RejectSlotInput = { ...FLOAT_OUT, unavailableReason: 'no runtime contract' };
    // The payload ALSO mismatches the type — availability still wins, because it
    // is the more fundamental fact about the row.
    expect(slotRejectReason(slot, CONNECT_BOOL_OUT))
      .toEqual({ kind: 'unavailable', detail: 'no runtime contract' });
  });

  it('names NO-PROVIDER for a CONNECT payload that lost its interface', () => {
    expect(slotRejectReason(BOOL_OUT, { ...CONNECT_BOOL_OUT, interfaceId: undefined }))
      .toEqual({ kind: 'no-provider' });
  });

  it('treats a payload without origin as a defect, not as a silent default', () => {
    expect(slotRejectReason(BOOL_OUT, { plcType: 'PLCOutputBool', direction: 'output' }))
      .toEqual({ kind: 'no-provider' });
  });

  it('accepts an INTERNAL model signal without an interfaceId', () => {
    // The regression this pins: internal signals legitimately have no provider
    // and used to be misfiled as "no provider" (plan-341 F5).
    expect(slotRejectReason(BOOL_OUT, {
      plcType: 'PLCOutputBool', direction: 'output', origin: 'internal',
    })).toBeNull();
  });

  it('rejects an unknown TYPE with a reason, never silently', () => {
    expect(slotRejectReason(BOOL_OUT, { ...CONNECT_BOOL_OUT, plcType: 'PLCOutputWord' }))
      .toEqual({ kind: 'type', expected: 'bool', got: 'unknown' });
    expect(slotRejectReason(BOOL_OUT, { ...CONNECT_BOOL_OUT, plcType: undefined }))
      .toEqual({ kind: 'type', expected: 'bool', got: 'unknown' });
  });

  it('rejects an unknown DIRECTION with a reason', () => {
    expect(slotRejectReason(BOOL_OUT, { ...CONNECT_BOOL_OUT, direction: 'unknown' }))
      .toEqual({ kind: 'direction', expected: 'plcOutput' });
  });
});

describe('slotAcceptsSignal ⟺ slotRejectReason() === null', () => {
  const slots: RejectSlotInput[] = [
    BOOL_IN, BOOL_OUT, FLOAT_OUT,
    { type: 'int', direction: 'plcInput' },
    { type: 'bool', direction: 'plcOutput', unavailableReason: 'gone' },
  ];
  const payloads: RejectPayloadInput[] = [];
  for (const plcType of ['PLCOutputBool', 'PLCInputBool', 'PLCInputInt', 'PLCOutputFloat', 'Word', undefined]) {
    for (const direction of ['output', 'input', 'unknown'] as const) {
      for (const origin of ['connect', 'internal', undefined] as const) {
        payloads.push({ plcType, direction, origin, interfaceId: origin === 'connect' ? 'iface-1' : undefined });
      }
    }
  }

  it('holds for the full cross product (no double bookkeeping)', () => {
    for (const slot of slots) {
      for (const payload of payloads) {
        expect(slotAcceptsSignal(slot, payload)).toBe(slotRejectReason(slot, payload) === null);
      }
    }
  });
});

describe('dropRejectText', () => {
  it('produces one distinct sentence per cause', () => {
    const texts = [
      dropRejectText({ kind: 'unavailable', detail: 'no runtime contract' }),
      dropRejectText({ kind: 'no-provider' }),
      dropRejectText({ kind: 'type', expected: 'bool', got: 'float' }),
      dropRejectText({ kind: 'type', expected: 'bool', got: 'unknown' }),
      dropRejectText({ kind: 'direction', expected: 'plcInput' }),
    ];
    expect(new Set(texts).size).toBe(texts.length);
    for (const text of texts) expect(text.length).toBeGreaterThan(10);
  });
});
