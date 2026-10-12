// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-498 Phase 3 — the `/fmu` REST client: routes, bodies and TYPED errors
 * (404 / 403 / 409 / 422 with the gateway's reason code), abort pass-through.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  ConnectFmuError,
  createInstance,
  fetchWorkerStatuses,
  getPackage,
  isAbortError,
  releaseLease,
  renewLease,
  revokeTrust,
  trust,
  uploadPackage,
} from '../src/core/hmi/connect-fmu';

const BASE = 'http://127.0.0.1:5199';
const SHA = 'ab'.repeat(32);

interface Call { url: string; init: RequestInit }

function stubFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return respond(url, init);
  }));
  return calls;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function caught(p: Promise<unknown>): Promise<ConnectFmuError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ConnectFmuError);
    return e as ConnectFmuError;
  }
  throw new Error('expected a rejection');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('connect-fmu routes', () => {
  it('GET /fmu/{sha}: 200 → package, 404 → null (not an error)', async () => {
    const pkg = { sha256: SHA, trusted: false, refCount: 0, meta: { modelName: 'M', guid: 'g', fmiVersion: '2.0', byteLength: 3 }, variables: [] };
    const calls = stubFetch((url) => (url.endsWith(SHA) ? json(200, pkg) : json(404, { reason: 'package-missing' })));
    expect(await getPackage(SHA, { baseUrl: BASE })).toEqual(pkg);
    expect(await getPackage('cd'.repeat(32), { baseUrl: `${BASE}/` })).toBeNull();
    expect(calls[0].url).toBe(`${BASE}/fmu/${SHA}`);
    expect(calls[1].url).toBe(`${BASE}/fmu/${'cd'.repeat(32)}`);
  });

  it('POST /fmu sends the raw bytes with the SHA in query and header', async () => {
    const calls = stubFetch(() => json(201, { sha256: SHA, created: true, trusted: false, refCount: 0, meta: {}, variables: [] }));
    const bytes = new Uint8Array([9, 8, 7, 6]);
    const res = await uploadPackage(bytes.subarray(1), SHA, 'Feed through.fmu', { baseUrl: BASE });
    expect(res.created).toBe(true);
    expect(calls[0].url).toBe(`${BASE}/fmu?sha256=${SHA}&fileName=Feed%20through.fmu`);
    expect(calls[0].init.method).toBe('POST');
    const headers = new Headers(calls[0].init.headers);
    expect(headers.get('Content-Type')).toBe('application/octet-stream');
    expect(headers.get('X-Fmu-Sha256')).toBe(SHA);
    expect(Array.from(new Uint8Array(calls[0].init.body as ArrayBuffer))).toEqual([8, 7, 6]);
  });

  it('trust / revoke use POST / DELETE on /fmu/{sha}/trust and pass extra headers (Origin for non-browser callers)', async () => {
    const calls = stubFetch(() => json(200, { trusted: true }));
    await trust(SHA, { baseUrl: BASE, headers: { Origin: BASE } });
    await revokeTrust(SHA, { baseUrl: BASE });
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      `POST ${BASE}/fmu/${SHA}/trust`,
      `DELETE ${BASE}/fmu/${SHA}/trust`,
    ]);
    expect(new Headers(calls[0].init.headers).get('Origin')).toBe(BASE);
  });

  it('instances / renew / release / status', async () => {
    const calls = stubFetch((url, init) => {
      if (url.endsWith('/fmu/instances')) return json(201, { interfaceId: 'fmu-1', leaseId: 'L1', created: true });
      if (url.endsWith('/renew')) return json(200, { leaseId: 'L1', interfaceId: 'fmu-1' });
      if (init.method === 'DELETE') return json(200, { released: true });
      return json(200, { interfaces: [{ id: 'fmu-1', status: 'Connected', error: null }, { id: 'x', status: 'Error', error: 'boom' }] });
    });
    const req = {
      instanceKey: 'doc#Hyd', sha256: SHA, allowWebToPlc: false, stepSize: 0.01, tolerance: 1e-6,
      signals: [{ name: 'Hyd.x', valueReference: 1, dataType: 'Real', direction: 'input' as const }],
    };
    expect(await createInstance(req, { baseUrl: BASE })).toEqual({ interfaceId: 'fmu-1', leaseId: 'L1', created: true });
    expect(JSON.parse(calls[0].init.body as string)).toEqual(req);
    expect((await renewLease('L1', { baseUrl: BASE })).leaseId).toBe('L1');
    await releaseLease('L1', { baseUrl: BASE });
    expect(await fetchWorkerStatuses({ baseUrl: BASE })).toEqual({
      'fmu-1': { status: 'Connected', error: null },
      x: { status: 'Error', error: 'boom' },
    });
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      `POST ${BASE}/fmu/instances`,
      `POST ${BASE}/fmu/leases/L1/renew`,
      `DELETE ${BASE}/fmu/leases/L1`,
      `GET ${BASE}/status`,
    ]);
  });
});

describe('connect-fmu error typing', () => {
  it('403 browser-origin-required', async () => {
    stubFetch(() => json(403, { reason: 'browser-origin-required', message: 'needs a trusted Origin' }));
    const e = await caught(trust(SHA, { baseUrl: BASE }));
    expect(e.status).toBe(403);
    expect(e.isForbidden).toBe(true);
    expect(e.code).toBe('browser-origin-required');
    expect(e.message).toContain('needs a trusted Origin');
  });

  it('404 lease-unknown on renew (a release treats it as done)', async () => {
    stubFetch(() => json(404, { reason: 'lease-unknown', message: 'Lease expired or unknown' }));
    const e = await caught(renewLease('L9', { baseUrl: BASE }));
    expect(e.isNotFound).toBe(true);
    expect(e.code).toBe('lease-unknown');
    await expect(releaseLease('L9', { baseUrl: BASE })).resolves.toBeUndefined();
  });

  it('409 package-referenced', async () => {
    stubFetch(() => json(409, { reason: 'package-referenced', refCount: 2, message: 'in use' }));
    const e = await caught(createInstance({ instanceKey: 'k', sha256: SHA, signals: [], allowWebToPlc: true }, { baseUrl: BASE }));
    expect(e.isConflict).toBe(true);
    expect(e.code).toBe('package-referenced');
  });

  it('422 fmu-signal-mismatch carries the per-signal details', async () => {
    const details = [{ name: 'Hyd.x', valueReference: 1, reason: 'dataType is Integer, not Real' }];
    stubFetch(() => json(422, { reason: 'fmu-signal-mismatch', message: 'Some signals do not match', details }));
    const e = await caught(createInstance({ instanceKey: 'k', sha256: SHA, signals: [], allowWebToPlc: true }, { baseUrl: BASE }));
    expect(e.isUnprocessable).toBe(true);
    expect(e.code).toBe('fmu-signal-mismatch');
    expect(e.details).toEqual(details);
  });

  it('422 upload reason, 413 problem+json code, 400 {error}, non-JSON body', async () => {
    stubFetch(() => json(422, { reason: 'fmi-version', message: 'FMI 3.0 is not supported' }));
    expect((await caught(uploadPackage(new Uint8Array(1), SHA, 'a.fmu', { baseUrl: BASE }))).code).toBe('fmi-version');
    stubFetch(() => json(413, { code: 'PAYLOAD_TOO_LARGE', detail: 'too big' }));
    const big = await caught(uploadPackage(new Uint8Array(1), SHA, 'a.fmu', { baseUrl: BASE }));
    expect([big.status, big.code]).toEqual([413, 'PAYLOAD_TOO_LARGE']);
    expect(big.message).toContain('too big');
    stubFetch(() => json(400, { error: 'instanceKey is required' }));
    const bad = await caught(createInstance({ instanceKey: '', sha256: SHA, signals: [], allowWebToPlc: true }, { baseUrl: BASE }));
    expect([bad.status, bad.code]).toEqual([400, null]);
    expect(bad.message).toContain('instanceKey is required');
    stubFetch(() => new Response('<html>', { status: 502, statusText: 'Bad Gateway' }));
    const html = await caught(getPackage(SHA, { baseUrl: BASE }));
    expect(html.status).toBe(502);
    expect(html.message).toContain('HTTP 502');
  });

  it('a network failure is status 0 / code network; an abort stays an AbortError', async () => {
    stubFetch(() => { throw new TypeError('Failed to fetch'); });
    const net = await caught(getPackage(SHA, { baseUrl: BASE }));
    expect([net.status, net.code]).toEqual([0, 'network']);

    const ctl = new AbortController();
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_res, rej) => {
      init.signal?.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); });
    })));
    const p = getPackage(SHA, { baseUrl: BASE, signal: ctl.signal });
    ctl.abort();
    await p.then(() => { throw new Error('expected abort'); }, (e) => expect(isAbortError(e)).toBe(true));
  });
});
