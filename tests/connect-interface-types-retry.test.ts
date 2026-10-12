// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * The type catalog (`GET /interface-types`) used to be fetched exactly once per connect, and ANY
 * failure latched `availableTypes` to null for the rest of the session. Because the per-type signal
 * schema comes from that catalog, one transient hiccup silently removed manual signal authoring:
 * a fresh S7 interface then showed neither the "+" nor the add dialog, only the "use Browse or
 * Import" fallback — on a protocol that has no Browse at all.
 *
 * These tests pin the distinction the fix rests on: a 404 means "this gateway has no catalog"
 * (stop asking), everything else is transient and `ensureInterfaceTypes()` retries it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  connectToServer,
  getConnectSnapshot,
  getSignalSchema,
  ensureInterfaceTypes,
  _resetConnectStore,
} from '../src/core/hmi/connect-store';

const S7_SCHEMA = {
  supportsDiscovery: false,
  supportsManualAdd: true,
  addressValidatable: true,
  directionFromAddress: true,
  addressLabel: 'Address',
  addressHint: 'DB address or process image / flag',
  addressExamples: ['M0.1', 'DB10.DBD4'],
  dataTypes: ['Bool', 'Int', 'Real'],
};

/**
 * Gateway whose /interface-types answers with `catalogStatus` until `failTimes` calls are spent,
 * then serves the real catalog. Counts the calls so a retry is observable.
 */
function mockGateway(opts: { failTimes: number; catalogStatus: number }) {
  const calls = { catalog: 0 };

  vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    const json = (body: unknown, status = 200) =>
      Promise.resolve(new Response(JSON.stringify(body), {
        status, headers: { 'Content-Type': 'application/json' },
      }));

    if (urlStr.includes('/health')) return json({ status: 'ok' });
    if (urlStr.includes('/interface-types')) {
      calls.catalog += 1;
      if (calls.catalog <= opts.failTimes) return json({ error: 'nope' }, opts.catalogStatus);
      return json({ types: [{ type: 'S7', label: 'Siemens S7', description: '', defaults: {}, signals: S7_SCHEMA }] });
    }
    return json([{ id: 's7-1', type: 'S7', enabled: true, ipAddress: '192.168.1.50', signals: [] }]);
  });

  return calls;
}

describe('interface-type catalog retry', () => {
  beforeEach(() => {
    _resetConnectStore();
    vi.restoreAllMocks();
  });
  afterEach(() => _resetConnectStore());

  it('recovers the signal schema after a transient catalog failure', async () => {
    const calls = mockGateway({ failTimes: 1, catalogStatus: 503 });
    await connectToServer();

    // The connect-time fetch failed — no schema yet, but the session is connected.
    expect(getConnectSnapshot().state).toBe('connected');
    expect(getSignalSchema('S7')).toBeNull();

    await ensureInterfaceTypes();

    expect(calls.catalog).toBe(2);
    expect(getSignalSchema('S7')?.supportsManualAdd).toBe(true);
  });

  it('stops asking a gateway that answers 404 (older build, genuinely no catalog)', async () => {
    const calls = mockGateway({ failTimes: 99, catalogStatus: 404 });
    await connectToServer();

    await ensureInterfaceTypes();
    await ensureInterfaceTypes();

    expect(calls.catalog).toBe(1);
    expect(getConnectSnapshot().availableTypes).toBeNull();
  });

  it('is a no-op once the catalog is there', async () => {
    const calls = mockGateway({ failTimes: 0, catalogStatus: 503 });
    await connectToServer();
    expect(calls.catalog).toBe(1);

    await ensureInterfaceTypes();

    expect(calls.catalog).toBe(1);
  });
});
