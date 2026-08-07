// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchConnectNews,
  fetchUnseenNews,
  getNewsSnapshot,
  isNewsSeen,
  markConnectNewsSeen,
  markNewsSeen,
} from '../src/core/news-store';
import {
  connectToServer,
  _resetConnectStore,
} from '../src/core/hmi/connect-store';
import {
  newsItem,
  resetNewsStoreForTest,
  setAppConfigForTest,
  setConnectEmbedContextForTest,
  stubNewsRaw,
  stubNewsResponse,
} from './helpers/news-test-utils';

const ENABLED = {
  news: { enabled: true, apiUrl: 'https://portal.test/news/api/v1' },
} as const;

describe('news-store', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetNewsStoreForTest();
    _resetConnectStore();
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    resetNewsStoreForTest();
    _resetConnectStore();
    localStorage.clear();
  });

  it.each([
    ['missing news block', {}],
    ['disabled news', { news: { enabled: false, apiUrl: 'https://portal.test/news/api/v1' } }],
    ['missing apiUrl', { news: { enabled: true } }],
    ['non-http URL', { news: { enabled: true, apiUrl: 'file:///tmp/news.json' } }],
    ['malformed URL', { news: { enabled: true, apiUrl: 'not a url' } }],
    ['URL with an existing query', { news: { enabled: true, apiUrl: 'https://portal.test/news?x=1' } }],
  ])('sends zero requests for the fail-closed gate: %s', async (_label, config) => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    setAppConfigForTest(config);
    expect(await fetchUnseenNews('web')).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('requests the exact v1 URI with target=web', async () => {
    setAppConfigForTest(ENABLED);
    const fetchSpy = stubNewsResponse([]);
    await fetchUnseenNews('web');
    expect(String(fetchSpy.mock.calls[0][0])).toBe('https://portal.test/news/api/v1?target=web');
  });

  it('fetches public news at most once per session', async () => {
    setAppConfigForTest(ENABLED);
    const fetchSpy = stubNewsResponse([]);
    await fetchUnseenNews('web');
    await fetchUnseenNews('web');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('filters IDs already marked seen and persists new IDs', async () => {
    setAppConfigForTest(ENABLED);
    localStorage.setItem('rv-news-seen', JSON.stringify(['old']));
    stubNewsResponse([
      { id: 'old', title: 'Old', body: '' },
      { id: 'new', title: 'New', body: '' },
    ]);
    expect((await fetchUnseenNews('web')).map((item) => item.id)).toEqual(['new']);
    markNewsSeen('new');
    expect(isNewsSeen('new')).toBe(true);
    expect(JSON.parse(localStorage.getItem('rv-news-seen') ?? '[]')).toEqual(['old', 'new']);
  });

  it('returns empty silently on a network error', async () => {
    setAppConfigForTest(ENABLED);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await expect(fetchUnseenNews('web')).resolves.toEqual([]);
  });

  it('settles after 5 seconds even when fetch ignores AbortSignal', async () => {
    vi.useFakeTimers();
    setAppConfigForTest(ENABLED);
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)));
    const pending = fetchUnseenNews('web');
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(pending).resolves.toEqual([]);
  });

  it('ignores an unknown contract version', async () => {
    setAppConfigForTest(ENABLED);
    stubNewsRaw({ contract: 99, items: [] });
    expect(await fetchUnseenNews('web')).toEqual([]);
  });

  it('suppresses the portal request in CONNECT embed context', async () => {
    setAppConfigForTest(ENABLED);
    setConnectEmbedContextForTest(true);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(await fetchUnseenNews('web')).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('self-heals corrupt rv-news-seen JSON immediately', () => {
    localStorage.setItem('rv-news-seen', '{not json');
    expect(isNewsSeen('x')).toBe(false);
    expect(localStorage.getItem('rv-news-seen')).toBe('[]');
    markNewsSeen('x');
    expect(JSON.parse(localStorage.getItem('rv-news-seen') ?? '[]')).toEqual(['x']);
  });

  it('is a silent no-op when localStorage throws', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
    });
    expect(() => markNewsSeen('x')).not.toThrow();
    expect(isNewsSeen('x')).toBe(false);
  });

  it.each([
    ['HTTP 404', () => stubNewsRaw({ contract: 1, items: [] }, 404)],
    ['HTTP 500', () => stubNewsRaw({ contract: 1, items: [] }, 500)],
    ['malformed JSON', () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{bad json', { status: 200 })));
    }],
    ['missing items', () => stubNewsRaw({ contract: 1 })],
    ['non-array items', () => stubNewsRaw({ contract: 1, items: {} })],
    ['item missing id', () => stubNewsRaw({
      contract: 1,
      items: [{ ...newsItem({ id: 'x', title: 'T', body: '' }), id: undefined }],
    })],
    ['item missing title', () => stubNewsRaw({
      contract: 1,
      items: [{ ...newsItem({ id: 'x', title: 'T', body: '' }), title: undefined }],
    })],
    ['wrong field type', () => stubNewsRaw({
      contract: 1,
      items: [{ ...newsItem({ id: 'x', title: 'T', body: '' }), body: 42 }],
    })],
  ])('returns empty for structurally invalid input: %s', async (_label, arrange) => {
    setAppConfigForTest(ENABLED);
    arrange();
    expect(await fetchUnseenNews('web')).toEqual([]);
    expect(localStorage.getItem('rv-news-seen')).toBeNull();
  });

  it('processes the first 20 valid items in response order', async () => {
    setAppConfigForTest(ENABLED);
    stubNewsResponse(Array.from({ length: 25 }, (_, index) => ({
      id: `id-${index}`,
      title: `Title ${index}`,
      body: '',
    })));
    expect((await fetchUnseenNews('web')).map((item) => item.id))
      .toEqual(Array.from({ length: 20 }, (_, index) => `id-${index}`));
  });

  it('keeps the first occurrence of duplicate IDs', async () => {
    setAppConfigForTest(ENABLED);
    stubNewsResponse([
      { id: 'a', title: 'First', body: '' },
      { id: 'b', title: 'Second', body: '' },
      { id: 'a', title: 'Duplicate', body: '' },
    ]);
    const items = await fetchUnseenNews('web');
    expect(items.map((item) => item.id)).toEqual(['a', 'b']);
    expect(items[0].title).toBe('First');
  });

  it('fetches CONNECT news after a successful connect and only once across reconnects', async () => {
    let newsRequests = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/health')) return jsonResponse({ status: 'ok' });
      if (url.endsWith('/config/interfaces')) return jsonResponse([]);
      if (url.endsWith('/interface-types')) return jsonResponse({ types: [] });
      if (url.endsWith('/news')) {
        newsRequests += 1;
        return jsonResponse({ contract: 1, items: [newsItem({ id: 'connect-1', title: 'C', body: '' })] });
      }
      return new Response('', { status: 404 });
    }));

    await connectToServer();
    await vi.waitFor(() => expect(newsRequests).toBe(1));
    await connectToServer();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(newsRequests).toBe(1);
    expect(getNewsSnapshot().connectItems.map((item) => item.id)).toEqual(['connect-1']);
  });

  it('does not consume the CONNECT session guard on a failed connection', async () => {
    let healthAttempts = 0;
    let newsRequests = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/health')) {
        healthAttempts += 1;
        if (healthAttempts === 1) throw new Error('offline');
        return jsonResponse({ status: 'ok' });
      }
      if (url.endsWith('/config/interfaces')) return jsonResponse([]);
      if (url.endsWith('/interface-types')) return jsonResponse({ types: [] });
      if (url.endsWith('/news')) {
        newsRequests += 1;
        return jsonResponse({ contract: 1, items: [] });
      }
      return new Response('', { status: 404 });
    }));

    await connectToServer();
    await connectToServer();
    await vi.waitFor(() => expect(newsRequests).toBe(1));
  });

  it('acknowledges CONNECT news with POST /news/seen and exact IDs body', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/news')) {
        return jsonResponse({ contract: 1, items: [newsItem({ id: 'connect-1', title: 'C', body: '' })] });
      }
      return new Response('', { status: 204 });
    }));

    expect(await fetchConnectNews('http://localhost:5100')).toBe(true);
    await markConnectNewsSeen('connect-1');
    const seen = calls.find((call) => call.url.endsWith('/news/seen'));
    expect(seen?.init?.method).toBe('POST');
    expect(JSON.parse(String(seen?.init?.body))).toEqual({ ids: ['connect-1'] });
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
