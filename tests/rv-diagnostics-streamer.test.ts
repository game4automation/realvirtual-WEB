// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { diagnosticsCollector, type DiagEntry } from '../src/core/diagnostics/rv-diagnostics-collector';
import { batchByUtf8, DiagnosticsStreamer } from '../src/core/diagnostics/rv-diagnostics-streamer';

const entry = (msg: string, stack?: string): DiagEntry => ({
  t: new Date().toISOString(), src: 'web', lvl: 'error', cat: 'window', msg, stack, tab: 'tab',
});

beforeEach(() => diagnosticsCollector.clear());

describe('DiagnosticsStreamer', () => {
  it('cuts batches by UTF-8 bytes with multibyte messages and long stacks', () => {
    const entries = Array.from({ length: 200 }, () => entry('ä'.repeat(2000), 'x'.repeat(20_000)));
    const batch = batchByUtf8(entries);
    expect(batch.length).toBeLessThan(200);
    expect(new TextEncoder().encode(JSON.stringify({ entries: batch })).byteLength).toBeLessThanOrEqual(200 * 1024);
    expect(batch[0].stack?.length).toBe(16_000);
  });

  it('halves a 413 batch and succeeds', async () => {
    let now = 1000;
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 413 }))
      .mockResolvedValueOnce(new Response('{"accepted":1}', { status: 200 }));
    const streamer = new DiagnosticsStreamer({
      fetch: fetchFn, now: () => now, servedByConnect: async () => true,
      setTimeout: (() => 1) as unknown as typeof setTimeout,
    });
    await streamer.start();
    streamer.clearQueueForTests();
    streamer.enqueue(entry('one')); streamer.enqueue(entry('two'));
    await streamer.flush();
    now += 1000;
    await streamer.flush();
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchFn.mock.calls[1][1]?.body)).entries).toHaveLength(1);
    expect(streamer.getQueueForTests()).toHaveLength(1);
  });

  it('hard-truncates a single oversized entry instead of looping', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 413 }))
      .mockResolvedValueOnce(new Response('{"accepted":1}', { status: 200 }));
    const streamer = new DiagnosticsStreamer({
      fetch: fetchFn, now: (() => { let now = 0; return () => (now += 1000); })(), servedByConnect: async () => true,
      setTimeout: (() => 1) as unknown as typeof setTimeout,
    });
    await streamer.start(); streamer.clearQueueForTests();
    streamer.enqueue(entry('m'.repeat(8000), 's'.repeat(16000)));
    await streamer.flush();
    await streamer.flush();
    const sent = JSON.parse(String(fetchFn.mock.calls[1][1]?.body)).entries[0];
    expect(sent.msg).toHaveLength(2000);
    expect(sent.stack).toHaveLength(4000);
  });

  it('backs off network failures and never uses console', async () => {
    const delays: number[] = [];
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const streamer = new DiagnosticsStreamer({
      fetch: vi.fn().mockRejectedValue(new TypeError('offline')), now: () => 1000,
      servedByConnect: async () => true,
      setTimeout: ((_: TimerHandler, delay?: number) => { delays.push(delay ?? 0); return 1; }) as unknown as typeof setTimeout,
    });
    await streamer.start(); streamer.clearQueueForTests(); streamer.enqueue(entry('offline'));
    await streamer.flush();
    expect(delays).toContain(2000);
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    error.mockRestore(); warn.mockRestore();
  });
});
