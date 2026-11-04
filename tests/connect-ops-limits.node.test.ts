// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2025 P7 review fix 8 — CONNECT's write-core size limits, checked in the browser before the
 * per-row check and before sending: at most 10000 operations, 20000 signals per operation and a
 * 4 MiB UTF-8 body. Over a limit = a clear message, never a silent split.
 */

import { describe, expect, it } from 'vitest';
import {
  CONNECT_OPS_MAX_BODY_BYTES,
  CONNECT_OPS_MAX_OPS,
  CONNECT_OPS_MAX_SIGNALS_PER_OP,
  configOpsLimitError,
  opCountLimitError,
  utf8Bytes,
} from '../src/core/hmi/connect-ops-limits';
import type { ConnectConfigOp, ConnectInterfaceSignal } from '../src/core/hmi/connect-store';

const upsert = (i: number, comment = ''): ConnectConfigOp => ({
  op: 'signal.upsert', interfaceId: 'if1', name: `S${i}`, protocolAddress: `%Q${i}.0`, ...(comment ? { comment } : {}),
});
const sig = (i: number): ConnectInterfaceSignal => ({ name: `S${i}`, protocolAddress: '', type: 'PLCOutputBool', record: false });

describe('connect-ops-limits', () => {
  it('uses CONNECT\'s own values', () => {
    expect(CONNECT_OPS_MAX_OPS).toBe(10_000);
    expect(CONNECT_OPS_MAX_SIGNALS_PER_OP).toBe(20_000);
    expect(CONNECT_OPS_MAX_BODY_BYTES).toBe(4 * 1024 * 1024);
  });

  it('operation count: exactly 10000 is fine, 10001 is refused', () => {
    expect(configOpsLimitError(Array.from({ length: CONNECT_OPS_MAX_OPS }, (_, i) => upsert(i)))).toBeNull();
    expect(configOpsLimitError(Array.from({ length: CONNECT_OPS_MAX_OPS + 1 }, (_, i) => upsert(i))))
      .toMatch(/10001 operations — CONNECT accepts at most 10000 changes in one batch\. Nothing was sent/);
    expect(opCountLimitError(CONNECT_OPS_MAX_OPS + 5, 'rows')).toMatch(/^10005 rows/);
    expect(opCountLimitError(3)).toBeNull();
  });

  it('signals per operation: a topic or signal list over 20000 is refused, naming the operation', () => {
    const many = Array.from({ length: CONNECT_OPS_MAX_SIGNALS_PER_OP + 1 }, (_, i) => sig(i));
    expect(configOpsLimitError([{ op: 'container.replace', interfaceId: 'if1', signals: many.slice(0, CONNECT_OPS_MAX_SIGNALS_PER_OP) }]))
      .toBeNull();
    expect(configOpsLimitError([upsert(0), { op: 'container.replace', interfaceId: 'if1', topicConfig: { topic: 't', mode: 'ProcessImage', signals: many } }]))
      .toMatch(/^Operation 2 \(container\.replace\) carries 20001 signals/);
    expect(configOpsLimitError([{ op: 'interface.add', interface: { id: 'x', type: 'MQTT', topics: [{ topic: 't', mode: 'ProcessImage', signals: many }] } }]))
      .toMatch(/carries 20001 signals/);
  });

  it('body size is counted in UTF-8 bytes, not characters', () => {
    expect(utf8Bytes('ä')).toBe(2);
    // ~1000 ops with a 2200-character comment of two-byte letters: ~4.4 MB UTF-8 but only ~2.2 M characters.
    const comment = 'ä'.repeat(2200);
    const ops = Array.from({ length: 1000 }, (_, i) => upsert(i, comment));
    expect(JSON.stringify({ ops }).length).toBeLessThan(CONNECT_OPS_MAX_BODY_BYTES);
    expect(configOpsLimitError(ops)).toMatch(/MiB — CONNECT accepts at most 4\.0 MiB in one batch/);
    expect(configOpsLimitError(ops.slice(0, 500))).toBeNull();
  });
});
