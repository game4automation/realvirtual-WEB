// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * The AASX index has three outcomes, not two (plan-373 F2).
 *
 * `loadIndex()` collapses everything that is not a usable index to `{}`, which
 * cannot tell "this deployment never shipped the AASX payload" (hide the AAS UI)
 * from "the index is there but broken" (show the error, so a broken deploy is not
 * masked). `loadIndexResult()` keeps them apart; `loadIndex()` stays a wrapper on
 * the SAME cached promise so no caller pays a second round-trip and the parser
 * contract in rv-aas-link-parser.test.ts is untouched.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadIndex, loadIndexResult, resetIndex, resetCache } from '../src/plugins/aas-link-parser';

const VALID_INDEX = { 'urn:test:001': { file: 'test.aasx', idShort: 'TestProduct' } };

function mockFetchOnce(response: Response | Error): void {
  const spy = vi.spyOn(globalThis, 'fetch');
  if (response instanceof Error) spy.mockRejectedValueOnce(response);
  else spy.mockResolvedValueOnce(response);
}

describe('loadIndexResult — index state classification', () => {
  beforeEach(() => {
    resetIndex();
    resetCache();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('classifies 200 + valid JSON as available', async () => {
    mockFetchOnce(new Response(JSON.stringify(VALID_INDEX), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    expect(await loadIndexResult()).toEqual({ kind: 'available', index: VALID_INDEX });
  });

  it('classifies 404 as missing — the AASX payload was not shipped', async () => {
    mockFetchOnce(new Response(null, { status: 404 }));
    expect(await loadIndexResult()).toEqual({ kind: 'missing' });
  });

  it('classifies an SPA history-fallback HTML page as missing, not as broken JSON', async () => {
    mockFetchOnce(new Response('<!DOCTYPE html><html></html>', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    }));
    expect(await loadIndexResult()).toEqual({ kind: 'missing' });
  });

  it('accepts valid JSON served without a JSON content-type (plain static hosts)', async () => {
    // Regression guard for rv-aas-link-parser.test.ts:330-335 — a content-type
    // check that demanded application/json would break every such deployment.
    mockFetchOnce(new Response(JSON.stringify(VALID_INDEX), { status: 200 }));
    expect(await loadIndexResult()).toEqual({ kind: 'available', index: VALID_INDEX });
  });

  it('classifies a network failure as error — a broken deploy must stay visible', async () => {
    mockFetchOnce(new TypeError('Failed to fetch'));
    const result = await loadIndexResult();
    expect(result.kind).toBe('error');
  });

  it('classifies 500 as error', async () => {
    mockFetchOnce(new Response(null, { status: 500 }));
    const result = await loadIndexResult();
    expect(result).toMatchObject({ kind: 'error' });
  });

  it('classifies malformed JSON as error', async () => {
    mockFetchOnce(new Response('{ not json', { status: 200 }));
    const result = await loadIndexResult();
    expect(result.kind).toBe('error');
  });

  it('classifies a JSON array as error — the index must be an object map', async () => {
    mockFetchOnce(new Response('[]', { status: 200 }));
    expect((await loadIndexResult()).kind).toBe('error');
  });

  it('caches per basePath and fetches once', async () => {
    mockFetchOnce(new Response(JSON.stringify(VALID_INDEX), { status: 200 }));
    await loadIndexResult();
    await loadIndexResult();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('shares its cached promise with loadIndex — no second round-trip', async () => {
    mockFetchOnce(new Response(JSON.stringify(VALID_INDEX), { status: 200 }));
    await loadIndexResult();
    expect(await loadIndex()).toEqual(VALID_INDEX);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('loadIndex legacy wrapper — unchanged contract', () => {
  beforeEach(() => {
    resetIndex();
    resetCache();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('still returns {} for a missing index (404)', async () => {
    mockFetchOnce(new Response(null, { status: 404 }));
    expect(await loadIndex()).toEqual({});
  });

  it('still returns {} for a network error', async () => {
    mockFetchOnce(new TypeError('Failed to fetch'));
    expect(await loadIndex()).toEqual({});
  });
});
