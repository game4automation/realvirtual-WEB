// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-562 §9.7 — "Read only, don't ask again" is remembered per GATEWAY and
 * interface.
 *
 * The key is `serverUrl|interfaceId` for one reason: the same interface id on
 * another CONNECT is another machine. An answer given for the lab gateway must
 * never silence the prompt for the one standing next to the real line — that is
 * the whole failure mode a default-deny write gate exists to prevent.
 *
 * And a browser that refuses localStorage (private mode, disabled site data)
 * must still honour the answer for the session: re-opening the overlay on every
 * render pass would be worse than not persisting it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearWriteGateReadOnly,
  dismissWriteGateNotice,
  isWriteGateDismissed,
  isWriteGateReadOnly,
  markWriteGateReadOnly,
  writeGateKey,
  _resetWriteGateStore,
} from '../src/core/hmi/connect-write-gate-store';
import { CONNECT_WRITE_GATE_READONLY_KEY } from '../src/core/hmi/rv-storage-keys';

const LAB = 'http://lab-gateway.test:5100';
const LINE = 'http://line-gateway.test:5100';

beforeEach(() => {
  localStorage.clear();
  _resetWriteGateStore();
});

afterEach(() => {
  vi.restoreAllMocks();
  _resetWriteGateStore();
  localStorage.clear();
});

describe('connect-write-gate-store — the read-only decision (plan-562 §9.7)', () => {
  it('persists per serverUrl + interfaceId and survives a reload', () => {
    expect(isWriteGateReadOnly(LAB, 'PLCSIM_1')).toBe(false);
    markWriteGateReadOnly(LAB, 'PLCSIM_1');
    expect(isWriteGateReadOnly(LAB, 'PLCSIM_1')).toBe(true);

    const stored = JSON.parse(localStorage.getItem(CONNECT_WRITE_GATE_READONLY_KEY) ?? '{}') as
      Record<string, boolean>;
    expect(stored[writeGateKey(LAB, 'PLCSIM_1')]).toBe(true);
  });

  it('leaves another gateway with the same interface id untouched', () => {
    markWriteGateReadOnly(LAB, 'PLCSIM_1');
    expect(isWriteGateReadOnly(LINE, 'PLCSIM_1')).toBe(false);
    // …and another interface on the same gateway stays unanswered too.
    expect(isWriteGateReadOnly(LAB, 'PLCSIM_2')).toBe(false);
  });

  it('keeps the answer for the session when storage refuses the write', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError');
    });
    markWriteGateReadOnly(LAB, 'PLCSIM_1');
    expect(setItem).toHaveBeenCalled();
    // Nothing persisted…
    expect(localStorage.getItem(CONNECT_WRITE_GATE_READONLY_KEY)).toBeNull();
    // …but the user answered, so the answer holds.
    expect(isWriteGateReadOnly(LAB, 'PLCSIM_1')).toBe(true);
  });

  it('survives an unreadable storage without claiming a decision', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('SecurityError');
    });
    expect(isWriteGateReadOnly(LAB, 'PLCSIM_1')).toBe(false);
  });

  it('ignores a corrupt stored value instead of throwing', () => {
    localStorage.setItem(CONNECT_WRITE_GATE_READONLY_KEY, 'not json');
    expect(isWriteGateReadOnly(LAB, 'PLCSIM_1')).toBe(false);
  });

  it('clears the decision again — the chip is the way back', () => {
    markWriteGateReadOnly(LAB, 'PLCSIM_1');
    clearWriteGateReadOnly(LAB, 'PLCSIM_1');
    expect(isWriteGateReadOnly(LAB, 'PLCSIM_1')).toBe(false);
    const stored = JSON.parse(localStorage.getItem(CONNECT_WRITE_GATE_READONLY_KEY) ?? '{}') as
      Record<string, boolean>;
    expect(stored[writeGateKey(LAB, 'PLCSIM_1')]).toBeUndefined();
  });

  it('keeps "closed for now" apart from "read only": the ✕ persists nothing', () => {
    dismissWriteGateNotice(LAB, 'PLCSIM_1');
    expect(isWriteGateDismissed(LAB, 'PLCSIM_1')).toBe(true);
    expect(isWriteGateReadOnly(LAB, 'PLCSIM_1')).toBe(false);
    expect(localStorage.getItem(CONNECT_WRITE_GATE_READONLY_KEY)).toBeNull();
    // Per gateway + interface, like the durable answer.
    expect(isWriteGateDismissed(LINE, 'PLCSIM_1')).toBe(false);
  });
});
