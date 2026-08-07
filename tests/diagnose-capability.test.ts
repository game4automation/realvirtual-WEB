// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * diagnose-capability.test.ts — CONNECT `/health` diagnose capability probe
 * (plan-283 §8, @rv-private). NEVER performs real network calls — a FetchLike
 * mock is injected.
 */

import { describe, it, expect } from 'vitest';
import {
  checkConnectDiagnoseCapability,
  type FetchLike,
} from '@rv-private/plugins/diagnose/diagnose-capability';

function healthFetch(body: unknown, ok = true, status = 200): FetchLike {
  return async () => ({ ok, status, json: async () => body });
}

describe('checkConnectDiagnoseCapability', () => {
  it('{reachable:true, diagnose:true} when /health answers diagnose:true', async () => {
    const cap = await checkConnectDiagnoseCapability(
      'http://localhost:5100',
      1500,
      healthFetch({ status: 'ok', diagnose: true }),
    );
    expect(cap).toEqual({ reachable: true, diagnose: true });
  });

  it('probes {baseUrl}/health with trailing slashes trimmed', async () => {
    const urls: string[] = [];
    const f: FetchLike = async (url) => {
      urls.push(url);
      return { ok: true, status: 200, json: async () => ({ status: 'ok', diagnose: true }) };
    };
    await checkConnectDiagnoseCapability('http://localhost:5100/', 1500, f);
    expect(urls).toEqual(['http://localhost:5100/health']);
  });

  it('{reachable:true, diagnose:false} when diagnose:false', async () => {
    const cap = await checkConnectDiagnoseCapability(
      'http://localhost:5100',
      1500,
      healthFetch({ status: 'ok', diagnose: false }),
    );
    expect(cap).toEqual({ reachable: true, diagnose: false });
  });

  it('{reachable:true, diagnose:false} when the diagnose flag is missing entirely', async () => {
    const cap = await checkConnectDiagnoseCapability(
      'http://localhost:5100',
      1500,
      healthFetch({ status: 'ok' }),
    );
    expect(cap).toEqual({ reachable: true, diagnose: false });
  });

  it('{reachable:false, diagnose:false} on network error', async () => {
    const f: FetchLike = async () => { throw new TypeError('Failed to fetch'); };
    const cap = await checkConnectDiagnoseCapability('http://localhost:5100', 1500, f);
    expect(cap).toEqual({ reachable: false, diagnose: false });
  });

  it('{reachable:false, diagnose:false} on non-ok response', async () => {
    const cap = await checkConnectDiagnoseCapability(
      'http://localhost:5100',
      1500,
      healthFetch({}, false, 500),
    );
    expect(cap).toEqual({ reachable: false, diagnose: false });
  });

  it('{reachable:false, diagnose:false} on timeout', async () => {
    // Fetch that never resolves but honors the abort signal — the 10 ms
    // probe timeout must turn it into a clean negative capability.
    const f: FetchLike = (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
    const cap = await checkConnectDiagnoseCapability('http://localhost:5100', 10, f);
    expect(cap).toEqual({ reachable: false, diagnose: false });
  });
});
