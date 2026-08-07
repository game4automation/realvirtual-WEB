// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HISTORIAN_TIMEOUT_MS,
  __resetHistorianStore,
  historianStore,
} from '../src/core/hmi/historian-store';
import { setServerUrl } from '../src/core/hmi/connect-store';

describe('historian-store', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetHistorianStore();
    setServerUrl('http://connect.test:5100');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('parses compact query responses into a map by signal', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify([
      { signal: 'Speed', ts: [1_000, 2_000], values: [10, 20] },
      { signal: 'Temperature', ts: [1_500], values: [42.5] },
    ]), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    await historianStore.queryHistory(['Speed', 'Temperature'], 0, 3_000);

    const snapshot = historianStore.getSnapshot();
    expect(snapshot.results.get('Speed')?.values).toEqual([10, 20]);
    expect(snapshot.results.get('Temperature')?.ts).toEqual([1_500]);
    expect(snapshot.loading).toBe(false);
    expect(snapshot.error).toBeNull();
  });

  it('loads the { name, active } signal discovery shape', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify([
      { name: 'Current', active: true },
      { name: 'ArchivedOnly', active: false },
    ]), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    await historianStore.refreshSignals();

    expect(historianStore.getSnapshot().signals).toEqual([
      { name: 'Current', active: true },
      { name: 'ArchivedOnly', active: false },
    ]);
  });

  it('sets an error state and clears loading after an HTTP failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ error: 'InfluxDB is unavailable.' }),
      { status: 503, statusText: 'Service Unavailable', headers: { 'Content-Type': 'application/json' } },
    ));

    await historianStore.queryHistory(['Speed'], 0, 1_000);

    expect(historianStore.getSnapshot().error).toBe('InfluxDB is unavailable.');
    expect(historianStore.getSnapshot().loading).toBe(false);
    expect(historianStore.getSnapshot().results.size).toBe(0);
  });

  it('aborts a query after the 30 second timeout', async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));

    const query = historianStore.queryHistory(['Speed'], 0, 1_000);
    await vi.advanceTimersByTimeAsync(HISTORIAN_TIMEOUT_MS);
    await query;

    expect(historianStore.getSnapshot().error).toContain('timed out');
    expect(historianStore.getSnapshot().loading).toBe(false);
  });

  it('lets the newest STARTED query win when an older response resolves later', async () => {
    let resolveFirst: (response: Response) => void = () => {};
    const first = new Promise<Response>((resolve) => { resolveFirst = resolve; });
    vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => first)   // slow, superseded query
      .mockResolvedValueOnce(new Response(JSON.stringify([
        { signal: 'Speed', ts: [2_000], values: [222] },
      ]), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const slow = historianStore.queryHistory(['Speed'], 0, 1_000);
    await historianStore.queryHistory(['Speed'], 0, 2_000);
    // The stale response arrives AFTER the newer one — it must not overwrite.
    resolveFirst(new Response(JSON.stringify([
      { signal: 'Speed', ts: [1_000], values: [111] },
    ]), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    await slow;

    expect(historianStore.getSnapshot().results.get('Speed')?.values).toEqual([222]);
    expect(historianStore.getSnapshot().error).toBeNull();
  });

  it('keeps the query alert quiet when the status heartbeat fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));

    const status = await historianStore.refreshStatus();

    expect(status.connected).toBe(false);
    expect(historianStore.getSnapshot().error).toBeNull();   // heartbeat ≠ query error
  });

  it('expands lane bounds monotonically across refreshes and drops them on deselect', async () => {
    const respond = (values: number[]) => new Response(JSON.stringify([
      { signal: 'Speed', ts: values.map((_, i) => i * 1_000), values },
    ]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond([10, 30]));

    await historianStore.queryHistory(['Speed'], 0, 1_000);
    expect(historianStore.getSnapshot().laneBounds.Speed).toEqual({ min: 10, max: 30 });

    fetchMock.mockResolvedValue(respond([15, 20]));          // narrower window …
    await historianStore.queryHistory(['Speed'], 0, 2_000);
    expect(historianStore.getSnapshot().laneBounds.Speed).toEqual({ min: 10, max: 30 });  // … bounds stay sticky

    historianStore.setSelectedSignals([]);                   // deselect resets calibration
    expect(historianStore.getSnapshot().laneBounds.Speed).toBeUndefined();
  });

  it('sends the configured CONNECT API key and repeated signal parameters', async () => {
    localStorage.setItem('rv-interface-settings', JSON.stringify({ wsAuthToken: 'secret-api-key' }));
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('[]', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    await historianStore.queryHistory(['Speed', 'Pressure'], 0, 1_000);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('signal=Speed');
    expect(String(url)).toContain('signal=Pressure');
    expect(new Headers(init?.headers).get('X-API-Key')).toBe('secret-api-key');
  });
});
