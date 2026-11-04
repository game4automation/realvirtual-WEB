// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  connectRestFetch: vi.fn(),
  getConnectSnapshot: vi.fn(() => ({ serverUrl: 'http://localhost:5100/' })),
  getViewerMode: vi.fn(() => 'hmi'),
}));

vi.mock('../src/core/hmi/connect-rest', () => ({ connectRestFetch: mocks.connectRestFetch }));
vi.mock('../src/core/hmi/connect-store', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/hmi/connect-store')>(),
  getConnectSnapshot: mocks.getConnectSnapshot,
  getViewerMode: mocks.getViewerMode,
}));

import {
  MAX_AI_PROMPT_LINE_BYTES,
  runAiPromptStream,
} from '../../realvirtual-WebViewer-Private~/src/plugins/ai-prompt/ai-prompt-stream';
import { createAiPromptStore } from '../../realvirtual-WebViewer-Private~/src/plugins/ai-prompt/ai-prompt-store';
import { setBridgeTabKey } from '../src/plugins/mcp-bridge/rv-mcp-tab-key';

function chunkedResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } });
}

describe('ai-prompt-stream', () => {
  it('reassembles lines split across chunk boundaries and sends the session', async () => {
    mocks.connectRestFetch.mockResolvedValueOnce(chunkedResponse([
      '{"type":"system","sub',
      'type":"init"}\n{"type":"result"}\r',
      '\n{"type":"connect_exit","code":0}',
    ]));
    const lines: string[] = [];
    const controller = new AbortController();

    await runAiPromptStream({
      prompt: 'Build the cell', sessionId: 'session-1', backend: 'claude', signal: controller.signal,
      onLine: (line) => lines.push(line),
    });

    expect(lines).toEqual([
      '{"type":"system","subtype":"init"}',
      '{"type":"result"}',
      '{"type":"connect_exit","code":0}',
    ]);
    expect(mocks.connectRestFetch).toHaveBeenLastCalledWith('http://localhost:5100/ai/prompt', expect.objectContaining({
      method: 'POST',
      signal: controller.signal,
      body: JSON.stringify({ prompt: 'Build the cell', sessionId: 'session-1', backend: 'claude' }),
    }));
  });

  it.each([
    [403, {}, 'origin-not-allowed'],
    [409, { error: 'busy' }, 'busy'],
    [503, { error: 'disabled' }, 'disabled'],
    [400, { error: 'prompt-too-long' }, 'prompt-too-long'],
  ] as const)('maps HTTP %i to a typed error', async (status, body, reason) => {
    mocks.connectRestFetch.mockResolvedValueOnce(new Response(JSON.stringify(body), {
      status, headers: { 'Content-Type': 'application/json' },
    }));
    const pending = runAiPromptStream({
      prompt: 'x', sessionId: null, backend: 'codex', signal: new AbortController().signal, onLine: vi.fn(),
    });
    await expect(pending).rejects.toMatchObject({ status, reason });
  });

  it.each(['claude', 'codex'] as const)('serializes the %s backend', async (backend) => {
    mocks.connectRestFetch.mockResolvedValueOnce(chunkedResponse(['{"type":"connect_exit","code":0}']));
    await runAiPromptStream({
      prompt: 'x', sessionId: null, backend, signal: new AbortController().signal, onLine: vi.fn(),
    });
    const init = mocks.connectRestFetch.mock.calls.at(-1)?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ prompt: 'x', backend });
  });

  it("presents this tab's CONNECT key (plan-2220) so only the owner tab's own opt-ins count", async () => {
    setBridgeTabKey('tab-key-123');
    try {
      mocks.connectRestFetch.mockResolvedValueOnce(chunkedResponse(['{"type":"connect_exit","code":0}\n']));
      await runAiPromptStream({
        prompt: 'Model a bracket', sessionId: null, backend: 'claude', signal: new AbortController().signal,
        onLine: () => undefined,
      });
      expect(mocks.connectRestFetch).toHaveBeenLastCalledWith('http://localhost:5100/ai/prompt', expect.objectContaining({
        body: JSON.stringify({ prompt: 'Model a bracket', backend: 'claude', tabKey: 'tab-key-123' }),
      }));
    } finally {
      setBridgeTabKey(null);
    }
  });

  it('drops an oversized chunked line without retaining more than eight MB and continues', async () => {
    const chunk = 'x'.repeat(256 * 1024);
    const chunks = Array.from({ length: 33 }, () => chunk);
    chunks.push('\n{"type":"turn.completed"}\n');
    mocks.connectRestFetch.mockResolvedValueOnce(chunkedResponse(chunks));
    const lines: string[] = [];
    let maximumBuffered = 0;

    await runAiPromptStream({
      prompt: 'x', sessionId: null, backend: 'codex', signal: new AbortController().signal,
      onLine: (line) => lines.push(line),
      onBufferedBytes: (bytes) => { maximumBuffered = Math.max(maximumBuffered, bytes); },
    });

    expect(maximumBuffered).toBeLessThanOrEqual(MAX_AI_PROMPT_LINE_BYTES);
    expect(JSON.parse(lines[0]!)).toEqual({ type: 'connect_line_dropped', bytes: 33 * chunk.length });
    expect(lines[1]).toBe('{"type":"turn.completed"}');
  });

  it('drops an aborted older generation without creating a ghost error', async () => {
    const runStream = vi.fn((options: Parameters<typeof runAiPromptStream>[0]) => {
      if (options.prompt === 'first') {
        return new Promise<void>((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        });
      }
      options.onLine('{"type":"result","is_error":false}');
      options.onLine('{"type":"connect_exit","code":0}');
      return Promise.resolve();
    });
    let nextFrame = 0;
    const queued = new Map<number, FrameRequestCallback>();
    const store = createAiPromptStore({
      runStream,
      requestFrame: (callback) => { const id = ++nextFrame; queued.set(id, callback); return id; },
      cancelFrame: (id) => { queued.delete(id); },
    });

    const first = store.submit('first');
    await Promise.resolve();
    store.cancel();
    // A run stays "stopping" until its stream has settled, so the next prompt waits for that.
    await first;
    await store.submit('second');

    const state = store.getSnapshot();
    expect(state.status).toBe('idle');
    expect(state.error).toBeNull();
    expect(state.entries.filter((entry) => entry.kind === 'error')).toEqual([]);
    expect(state.entries.filter((entry) => entry.kind === 'user').map((entry) => entry.text))
      .toEqual(['first', 'second']);
  });
});
