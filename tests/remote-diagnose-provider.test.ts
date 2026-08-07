// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * remote-diagnose-provider.test.ts — RemoteDiagnoseProvider against a mocked
 * fetch (plan-253, §9.4). NEVER performs real network calls.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  RemoteDiagnoseProvider,
  __resetRemoteDiagnoseWarnings,
} from '@rv-private/plugins/diagnose/remote-diagnose-provider';
import { parseDiagnoseResult } from '../src/plugins/diagnose/diagnose-provider';

const REQ = { nodePath: 'A/B', errorCode: 320, docFilter: 'crx', errorId: 'SYST-320' };

function mockFetchOnce(response: Partial<Response> & { json?: () => Promise<unknown> }) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(response as Response);
}

function statusResponse(chatTimeoutSeconds = 30): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ chatTimeoutSeconds }),
  } as Response;
}

describe('RemoteDiagnoseProvider', () => {
  beforeEach(() => {
    __resetRemoteDiagnoseWarnings();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('POSTs the request to {baseUrl}/diagnose and parses the result', async () => {
    const fetchSpy = mockFetchOnce({
      ok: true,
      json: async () => ({
        cause: 'Axis 2 overload',
        remedy: 'Reduce payload',
        sources: [{ title: 'Manual', url: 'http://x/m.pdf', page: 42, snippet: 'S' }],
        model: 'glm-5.2',
      }),
    });
    const provider = new RemoteDiagnoseProvider('http://connect:5100/');   // trailing slash trimmed
    const result = await provider.diagnose(REQ);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0][0]).toBe('http://connect:5100/diagnose/status');
    const [url, init] = fetchSpy.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('http://connect:5100/diagnose');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toMatchObject(REQ);

    expect(result.cause).toBe('Axis 2 overload');
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].page).toBe(42);
    expect(result.model).toBe('glm-5.2');
  });

  it('missing URL → warn-once + rejects WITHOUT any fetch call', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const provider = new RemoteDiagnoseProvider('');

    await expect(provider.diagnose(REQ)).rejects.toThrow(/not configured/);
    await expect(provider.diagnose(REQ)).rejects.toThrow(/not configured/);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);   // warn-once
  });

  it('HTTP error status → rejects with error state (no crash)', async () => {
    mockFetchOnce({ ok: false, status: 503 });
    const provider = new RemoteDiagnoseProvider('http://connect');
    await expect(provider.diagnose(REQ)).rejects.toThrow(/503/);
  });

  it('malformed JSON → controlled error, no crash', async () => {
    mockFetchOnce({ ok: true, json: async () => { throw new SyntaxError('bad json'); } });
    const provider = new RemoteDiagnoseProvider('http://connect');
    await expect(provider.diagnose(REQ)).rejects.toThrow(/malformed JSON/);
  });

  it('missing sources / wrong shapes → defensive defaults (sources ?? [])', async () => {
    mockFetchOnce({ ok: true, json: async () => ({ cause: 42, remedy: null }) });
    const provider = new RemoteDiagnoseProvider('http://connect');
    const result = await provider.diagnose(REQ);
    expect(result.sources).toEqual([]);
    expect(result.cause).toBe('');
    expect(result.remedy).toBe('');
  });

  it('timeout aborts the request → rejects', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(statusResponse(0.02))
      .mockImplementationOnce(
        (_url, init) => new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(init.signal?.reason ?? new Error('aborted')));
        }),
      );
    const provider = new RemoteDiagnoseProvider('http://connect');
    await expect(provider.diagnose(REQ)).rejects.toThrow();
  });

  it('external AbortSignal cancels the request', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(statusResponse())
      .mockImplementationOnce(
        (_url, init) => new Promise<Response>((_resolve, reject) => {
          if (init?.signal?.aborted) {
            reject(init.signal.reason ?? new Error('aborted'));
            return;
          }
          init?.signal?.addEventListener('abort', () =>
            reject(init.signal?.reason ?? new Error('aborted')));
        }),
      );
    const provider = new RemoteDiagnoseProvider('http://connect');
    const controller = new AbortController();
    const promise = provider.diagnose(REQ, { signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toThrow();
  });

  it('owns the timeout through one cached /diagnose/status fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(statusResponse(45))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ cause: 'first', remedy: '', sources: [] }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ cause: 'second', remedy: '', sources: [] }),
      } as Response);
    const provider = new RemoteDiagnoseProvider('http://connect');

    await provider.diagnose(REQ);
    await provider.diagnose(REQ);

    expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual([
      'http://connect/diagnose/status',
      'http://connect/diagnose',
      'http://connect/diagnose',
    ]);
  });

  it.each([401, 404])('falls back to the legacy timeout when status returns %s', async (status) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: false, status } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ cause: 'fallback', remedy: '', sources: [] }),
      } as Response);
    const provider = new RemoteDiagnoseProvider('http://connect');

    await expect(provider.diagnose(REQ)).resolves.toMatchObject({ cause: 'fallback' });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  describe('relative source url resolution (plan-283 F11)', () => {
    it('resolves relative source.url ("docs/x.pdf") against baseUrl', async () => {
      mockFetchOnce({
        ok: true,
        json: async () => ({
          cause: 'c', remedy: 'r',
          sources: [{ title: 'Manual', url: 'docs/x.pdf', page: 3 }],
        }),
      });
      const provider = new RemoteDiagnoseProvider('http://connect:5100');
      const result = await provider.diagnose(REQ);
      expect(result.sources[0].url).toBe('http://connect:5100/docs/x.pdf');
    });

    it('resolves against origin AND path of the diagnose base URL', async () => {
      mockFetchOnce({
        ok: true,
        json: async () => ({
          cause: 'c', remedy: 'r',
          sources: [{ title: 'Manual', url: 'docs/x.pdf' }],
        }),
      });
      const provider = new RemoteDiagnoseProvider('http://connect:5100/api/');   // trailing slash trimmed
      const result = await provider.diagnose(REQ);
      expect(result.sources[0].url).toBe('http://connect:5100/api/docs/x.pdf');
    });

    it('leaves absolute source.url unchanged', async () => {
      mockFetchOnce({
        ok: true,
        json: async () => ({
          cause: 'c', remedy: 'r',
          sources: [
            { title: 'A', url: 'http://other-host/m.pdf', page: 1 },
            { title: 'B', url: 'HTTPS://secure-host/n.pdf' },
          ],
        }),
      });
      const provider = new RemoteDiagnoseProvider('http://connect:5100');
      const result = await provider.diagnose(REQ);
      expect(result.sources[0].url).toBe('http://other-host/m.pdf');
      expect(result.sources[1].url).toBe('HTTPS://secure-host/n.pdf');
    });

    it('sources without url stay untouched', async () => {
      mockFetchOnce({
        ok: true,
        json: async () => ({ cause: 'c', remedy: 'r', sources: [{ title: 'No file' }] }),
      });
      const provider = new RemoteDiagnoseProvider('http://connect:5100');
      const result = await provider.diagnose(REQ);
      expect(result.sources[0].url).toBeUndefined();
    });

    it('resolves relative urls recursively in comparison.sources', async () => {
      mockFetchOnce({
        ok: true,
        json: async () => ({
          cause: 'primary', remedy: '', sources: [{ title: 'P', url: 'docs/p.pdf' }],
          comparison: {
            cause: 'secondary', remedy: '', sources: [{ title: 'C', url: 'docs/c.pdf' }],
          },
        }),
      });
      const provider = new RemoteDiagnoseProvider('http://connect:5100');
      const result = await provider.diagnose(REQ);
      expect(result.sources[0].url).toBe('http://connect:5100/docs/p.pdf');
      expect(result.comparison?.sources[0].url).toBe('http://connect:5100/docs/c.pdf');
    });
  });

  describe('parseDiagnoseResult (defensive parsing)', () => {
    it('never throws on garbage', () => {
      for (const garbage of [null, undefined, 42, 'x', [], { sources: 'nope' }, { sources: [null, 7, { page: 'x' }] }]) {
        const r = parseDiagnoseResult(garbage);
        expect(Array.isArray(r.sources)).toBe(true);
        expect(typeof r.cause).toBe('string');
        expect(typeof r.remedy).toBe('string');
      }
    });
  });
});
