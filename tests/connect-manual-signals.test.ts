// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Tests for manual signal editing in the CONNECT store: add/update/remove write through
 * PUT-full-interface, the per-type signal schema is parsed from /interface-types, address
 * validation round-trips /signals/validate (with 404 fallback for older gateways), and the
 * 409 signal-name collision body is flattened into a readable error.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  connectToServer,
  getConnectSnapshot,
  getSignalSchema,
  addSignal,
  updateSignal,
  removeSignal,
  validateSignalAddress,
  _resetConnectStore,
  type ConnectInterfaceSignal,
} from '../src/core/hmi/connect-store';

const S7_SCHEMA = {
  supportsDiscovery: false,
  supportsManualAdd: true,
  addressValidatable: true,
  directionFromAddress: true,
  addressLabel: 'Address',
  addressHint: 'DB address or process image / flag',
  addressExamples: ['M0.1', 'DB10.DBD4'],
  dataTypes: ['Bool', 'Byte', 'Word', 'Int', 'DWord', 'DInt', 'Real', 'LReal'],
};

const EXISTING_SIGNAL: ConnectInterfaceSignal = {
  name: 'Existing',
  protocolAddress: 'M0.0',
  type: 'PLCOutputBool',
  dataType: 'Bool',
  record: false,
};

/** Mock a connected gateway with one S7 interface; captures PUT bodies. */
function mockGateway(opts?: {
  putStatus?: number;
  putBodyJson?: unknown;
  validateStatus?: number;
  validateResult?: unknown;
}) {
  const putBodies: Array<{ id: string; signals: ConnectInterfaceSignal[] }> = [];
  const s7 = {
    id: 's7-1',
    type: 'S7' as const,
    enabled: true,
    ipAddress: '192.168.1.50',
    signals: [EXISTING_SIGNAL],
  };

  vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    const json = (body: unknown, status = 200) =>
      Promise.resolve(new Response(JSON.stringify(body), {
        status, headers: { 'Content-Type': 'application/json' },
      }));

    if (urlStr.includes('/health')) return json({ status: 'ok' });
    if (urlStr.includes('/interface-types')) {
      return json({ types: [{ type: 'S7', label: 'Siemens S7', description: '', defaults: {}, signals: S7_SCHEMA }] });
    }
    if (urlStr.includes('/signals/validate')) {
      if (opts?.validateStatus) return json({}, opts.validateStatus);
      return json(opts?.validateResult ?? {
        checked: true, valid: true, error: null, effectiveType: 'PLCOutputBool', normalizedAddress: 'M0.1',
      });
    }
    if (init?.method === 'PUT' && urlStr.includes('/config/interfaces/s7-1')) {
      putBodies.push(JSON.parse(init.body as string));
      if (opts?.putStatus) return json(opts.putBodyJson ?? {}, opts.putStatus);
      return json({ success: true });
    }
    // GET /config/interfaces
    return json([s7]);
  });

  return { putBodies };
}

describe('connect-store manual signals', () => {
  beforeEach(() => {
    _resetConnectStore();
    vi.restoreAllMocks();
  });
  afterEach(() => _resetConnectStore());

  it('parses the per-type signal schema from /interface-types', async () => {
    mockGateway();
    await connectToServer();

    const schema = getSignalSchema('S7');
    expect(schema).not.toBeNull();
    expect(schema!.supportsManualAdd).toBe(true);
    expect(schema!.addressExamples).toContain('DB10.DBD4');
    expect(schema!.dataTypes).toContain('Real');
    // A type the catalog does not carry a schema for → null.
    expect(getSignalSchema('OpcUa')).toBeNull();
  });

  it('addSignal appends to the interface signals and PUTs the whole interface', async () => {
    const { putBodies } = mockGateway();
    await connectToServer();

    await addSignal('s7-1', {
      name: 'Merker1', protocolAddress: 'M0.1', type: 'PLCOutputBool', dataType: 'Bool', record: false,
    });

    expect(putBodies).toHaveLength(1);
    expect(putBodies[0].id).toBe('s7-1');
    expect(putBodies[0].signals).toHaveLength(2); // existing + new
    expect(putBodies[0].signals[1]).toMatchObject({ name: 'Merker1', protocolAddress: 'M0.1' });
  });

  it('updateSignal replaces the entry identified by its original name (rename-safe)', async () => {
    const { putBodies } = mockGateway();
    await connectToServer();

    await updateSignal('s7-1', 'Existing', {
      name: 'Renamed', protocolAddress: 'M0.0', type: 'PLCOutputBool', dataType: 'Bool', record: true,
    });

    expect(putBodies).toHaveLength(1);
    expect(putBodies[0].signals).toHaveLength(1); // replaced, not duplicated
    expect(putBodies[0].signals[0]).toMatchObject({ name: 'Renamed', record: true });
  });

  it('removeSignal drops the entry from the PUT payload', async () => {
    const { putBodies } = mockGateway();
    await connectToServer();

    await removeSignal('s7-1', 'Existing');

    expect(putBodies).toHaveLength(1);
    expect(putBodies[0].signals).toHaveLength(0);
  });

  it('flattens the 409 collision body into a readable error', async () => {
    mockGateway({
      putStatus: 409,
      putBodyJson: {
        error: 'Signal name(s) already bound to another interface',
        collisions: [{ signal: 'Merker1', existingInterfaceId: 'opcua-1' }],
      },
    });
    await connectToServer();

    await expect(addSignal('s7-1', {
      name: 'Merker1', protocolAddress: 'M0.1', type: 'PLCOutputBool', record: false,
    })).rejects.toThrow(/Merker1.*opcua-1/);
  });

  it('validateSignalAddress round-trips the validation result', async () => {
    mockGateway({
      validateResult: {
        checked: true, valid: false,
        error: "DataType 'Bool' conflicts with address '%IW13' (expected a bit address)",
        effectiveType: null, normalizedAddress: null,
      },
    });
    await connectToServer();

    const r = await validateSignalAddress('S7', '%IW13', 'Bool');
    expect(r).not.toBeNull();
    expect(r!.checked).toBe(true);
    expect(r!.valid).toBe(false);
    expect(r!.error).toContain('conflicts');
  });

  it('validateSignalAddress returns null on an older gateway without the endpoint (404)', async () => {
    mockGateway({ validateStatus: 404 });
    await connectToServer();

    const r = await validateSignalAddress('S7', 'M0.1', 'Bool');
    expect(r).toBeNull();
  });
});
