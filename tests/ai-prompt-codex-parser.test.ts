// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { initialAiPromptState } from '../../realvirtual-WebViewer-Private~/src/plugins/ai-prompt/ai-prompt-parser';
import {
  reduceCodexLine,
  reduceCodexLineWithImages,
  reduceCodexStreamEnd,
} from '../../realvirtual-WebViewer-Private~/src/plugins/ai-prompt/ai-prompt-codex-parser';
import codexFixture from './fixtures/ai-prompt/codex-stream.ndjson?raw';

describe('ai-prompt-codex-parser', () => {
  it('reduces the sanitized Golden fixture including MCP images', () => {
    let state = initialAiPromptState('codex');
    const images = [];
    for (const line of codexFixture.trim().split(/\r?\n/)) {
      const reduction = reduceCodexLineWithImages(state, line);
      state = reduction.state;
      images.push(...reduction.images);
    }

    expect(state).toMatchObject({
      status: 'idle', backend: 'codex', sessionId: 'fixture-codex-thread', error: null,
    });
    expect(state.entries.filter((entry) => entry.kind === 'assistant').map((entry) => entry.text))
      .toEqual(['I will inspect the WebViewer.', 'WebViewer is connected, and the screenshot was captured.']);
    expect(state.entries.find((entry) => entry.toolUseId === 'item-shot')).toMatchObject({
      kind: 'tool', text: 'web_screenshot', done: true, imageIds: ['item-shot-image-1'],
    });
    expect(images).toEqual([expect.objectContaining({
      id: 'item-shot-image-1', mediaType: 'image/png',
    })]);
    expect(images[0]).not.toHaveProperty('url');
    expect(reduceCodexStreamEnd(state)).toBe(state);
  });

  it('marks completed and failed tool items done', () => {
    let state = initialAiPromptState('codex');
    state = reduceCodexLine(state, JSON.stringify({
      type: 'item.started', item: { id: 'cmd', type: 'command_execution', command: 'npm test' },
    }));
    state = reduceCodexLine(state, JSON.stringify({
      type: 'item.failed', item: { id: 'cmd', type: 'command_execution', command: 'npm test', status: 'failed' },
    }));
    expect(state.entries[0]).toMatchObject({ kind: 'tool', done: true, text: 'Command  npm test' });
  });

  it('keeps the run active after turn.completed until connect_exit', () => {
    let state = reduceCodexLine(initialAiPromptState('codex'), '{"type":"turn.completed"}');
    expect(state).toMatchObject({ status: 'running', answerComplete: true, error: null });
    expect(state.entries.at(-1)).toEqual({ kind: 'result', text: 'Done' });
    expect(reduceCodexStreamEnd(state)).toMatchObject({ status: 'error', error: 'connection lost' });

    state = reduceCodexLine(state, '{"type":"connect_exit","code":0}');
    expect(state).toMatchObject({ status: 'idle', error: null });
    expect(reduceCodexStreamEnd(state)).toBe(state);
  });

  it('reports turn failures and a clean exit without turn.completed', () => {
    let state = reduceCodexLine(
      initialAiPromptState('codex'),
      JSON.stringify({ type: 'turn.failed', message: 'model unavailable' }),
    );
    expect(state).toMatchObject({ status: 'running', answerComplete: true, error: 'model unavailable' });
    state = reduceCodexLine(state, '{"type":"connect_exit","code":0}');
    expect(state).toMatchObject({ status: 'error', error: 'model unavailable' });
    expect(state.entries.filter((entry) => entry.kind === 'error')).toHaveLength(1);
    expect(reduceCodexStreamEnd(state)).toBe(state);

    state = reduceCodexLine(initialAiPromptState('codex'), '{"type":"connect_exit","code":0}');
    expect(state).toMatchObject({ status: 'error', error: 'ended without turn.completed' });
    expect(reduceCodexStreamEnd(state)).toBe(state);
  });

  it('ignores unknown and malformed events', () => {
    const initial = initialAiPromptState('codex');
    expect(reduceCodexLine(initial, '{"type":"future.event"}')).toBe(initial);
    expect(reduceCodexLine(initial, 'not json')).toBe(initial);
  });
});
