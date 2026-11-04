// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import {
  initialAiPromptState,
  reduceLine,
  reduceLineWithImages,
  reduceStreamEnd,
} from '../../realvirtual-WebViewer-Private~/src/plugins/ai-prompt/ai-prompt-parser';
import claudeFixture from './fixtures/ai-prompt/claude-stream.ndjson?raw';

const delta = (text: string): string => JSON.stringify({
  type: 'stream_event',
  event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
});

describe('ai-prompt-parser', () => {
  it('takes the session id from system/init', () => {
    const state = reduceLine(
      initialAiPromptState(),
      '{"type":"system","subtype":"init","session_id":"3f2c"}',
    );
    expect(state.sessionId).toBe('3f2c');
  });

  it('appends text deltas to one assistant entry', () => {
    let state = reduceLine(initialAiPromptState(), delta('Hello '));
    state = reduceLine(state, delta('world'));
    expect(state.entries).toEqual([{ kind: 'assistant', text: 'Hello world' }]);
  });

  it('adds compact tool rows and marks them done without retaining tool_result content', () => {
    const longPath = `C:/${'folder/'.repeat(20)}pump.step`;
    let state = reduceLine(initialAiPromptState(), JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'web_import_step', input: { path: longPath } }] },
    }));
    expect(state.entries[0]).toMatchObject({ kind: 'tool', toolUseId: 'tool-1', done: false });
    expect(state.entries[0]!.text).toMatch(/^web_import_step  C:\//);
    expect(state.entries[0]!.text.length).toBeLessThan(110);

    const secretResult = 'large-result-content-that-must-not-be-kept';
    state = reduceLine(state, JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: secretResult }] },
    }));
    expect(state.entries[0]).toMatchObject({ kind: 'tool', done: true });
    expect(JSON.stringify(state)).not.toContain(secretResult);
  });

  it('keeps the run active after result until connect_exit and reports a non-zero exit as an error', () => {
    let state = reduceLine(initialAiPromptState(), JSON.stringify({
      type: 'result', is_error: false, duration_ms: 42000, session_id: 'session-2',
    }));
    // The answer is done, the CLI process is not: no idle before CONNECT confirms the exit.
    expect(state).toMatchObject({ status: 'running', answerComplete: true, sessionId: 'session-2', error: null });
    expect(state.entries.at(-1)).toEqual({ kind: 'result', text: 'Done · 42 s' });
    state = reduceLine(state, delta('late background note'));
    expect(state.status).toBe('running');

    state = reduceLine(state, '{"type":"connect_exit","code":7}');
    expect(state.status).toBe('error');
    expect(state.error).toContain('code 7');
  });

  it('finishes idle only on a clean connect_exit after the result', () => {
    const answered = reduceLine(initialAiPromptState(), '{"type":"result","is_error":false}');
    const exited = reduceLine(answered, '{"type":"connect_exit","code":0}');
    expect(exited).toMatchObject({ status: 'idle', answerComplete: true, error: null });
    expect(exited.entries.filter((entry) => entry.kind === 'result')).toHaveLength(1);
  });

  it('treats result.is_error as an error with the result text, ending the run on exit', () => {
    let state = reduceLine(
      initialAiPromptState(),
      '{"type":"result","is_error":true,"result":"Permission denied"}',
    );
    expect(state).toMatchObject({ status: 'running', answerComplete: true, error: 'Permission denied' });
    expect(state.entries.at(-1)).toEqual({ kind: 'error', text: 'Permission denied' });

    state = reduceLine(state, '{"type":"connect_exit","code":0}');
    expect(state).toMatchObject({ status: 'error', error: 'Permission denied' });
    expect(state.entries.filter((entry) => entry.kind === 'error')).toHaveLength(1);
  });

  it('treats connect_exit 0 without a result as an error', () => {
    const state = reduceLine(initialAiPromptState(), '{"type":"connect_exit","code":0}');
    expect(state).toMatchObject({ status: 'error', error: 'ended without result' });
    expect(reduceStreamEnd(state)).toBe(state);
  });

  it('requires connect_exit before stream end, even when a result arrived', () => {
    const result = reduceLine(initialAiPromptState(), '{"type":"result","is_error":false}');
    expect(result.status).toBe('running');
    expect(reduceStreamEnd(result)).toMatchObject({
      status: 'error', error: 'connection lost',
    });

    const exited = reduceLine(result, '{"type":"connect_exit","code":0}');
    expect(reduceStreamEnd(exited)).toBe(exited);
    expect(exited.status).toBe('idle');
  });

  it('ignores unknown and malformed lines', () => {
    const initial = initialAiPromptState();
    expect(reduceLine(initial, '{"type":"rate_limit_event"}')).toBe(initial);
    expect(reduceLine(initial, 'not json')).toBe(initial);
  });

  it('reduces the sanitized Claude fixture and returns image blocks as pure data', () => {
    let state = initialAiPromptState('claude');
    const images = [];
    for (const line of claudeFixture.trim().split(/\r?\n/)) {
      const reduction = reduceLineWithImages(state, line);
      state = reduction.state;
      images.push(...reduction.images);
    }

    expect(state).toMatchObject({
      status: 'idle', backend: 'claude', sessionId: 'fixture-claude-session', error: null,
    });
    expect(state.entries.find((entry) => entry.toolUseId === 'tool-shot')).toMatchObject({
      kind: 'tool', done: true, imageIds: ['tool-shot-image-1'],
    });
    expect(images).toEqual([{
      id: 'tool-shot-image-1', mediaType: 'image/png',
      base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    }]);
    expect(images[0]).not.toHaveProperty('url');
  });
});
