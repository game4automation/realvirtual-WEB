// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { AI_PROMPT_SESSIONS_KEY } from '../src/core/hmi/rv-storage-keys';
import {
  loadAiRecentSessions,
  upsertAiRecentSession,
} from '../../realvirtual-WebViewer-Private~/src/plugins/ai-prompt/ai-prompt-sessions';

function memoryStorage(initial = '[]') {
  let value = initial;
  return {
    getItem: (_key: string) => value,
    setItem: (_key: string, next: string) => { value = next; },
    value: () => value,
  };
}

describe('ai-prompt-sessions', () => {
  it('keeps twenty newest records and partitions them by workspace', () => {
    const storage = memoryStorage();
    for (let index = 0; index < 22; index++) {
      upsertAiRecentSession({
        backend: 'claude', sessionId: `s-${index}`, workspaceKey: 'workspace-a', prompt: `Prompt ${index}`,
        startedAt: new Date(2026, 0, index + 1).toISOString(),
      }, storage);
    }
    upsertAiRecentSession({
      backend: 'codex', sessionId: 'foreign', workspaceKey: 'workspace-b', prompt: 'Foreign',
      startedAt: new Date(2027, 0, 1).toISOString(),
    }, storage);

    const stored = JSON.parse(storage.value()) as unknown[];
    expect(stored).toHaveLength(20);
    expect(loadAiRecentSessions('workspace-a', storage).every((session) => session.workspaceKey === 'workspace-a')).toBe(true);
    expect(loadAiRecentSessions('workspace-b', storage)).toEqual([expect.objectContaining({ sessionId: 'foreign' })]);
    expect(loadAiRecentSessions(null, storage)).toEqual([]);
  });

  it('updates an existing session without duplicating or replacing its first title', () => {
    const storage = memoryStorage();
    upsertAiRecentSession({
      backend: 'codex', sessionId: 'thread', workspaceKey: 'workspace', prompt: 'First prompt',
      startedAt: '2026-01-01T00:00:00.000Z',
    }, storage);
    upsertAiRecentSession({
      backend: 'codex', sessionId: 'thread', workspaceKey: 'workspace', prompt: 'Follow-up prompt',
      startedAt: '2026-01-02T00:00:00.000Z',
    }, storage);

    expect(loadAiRecentSessions('workspace', storage)).toEqual([{
      backend: 'codex', sessionId: 'thread', workspaceKey: 'workspace',
      title: 'First prompt', startedAt: '2026-01-02T00:00:00.000Z',
    }]);
  });

  it('returns an empty list when localStorage throws', () => {
    const throwing = {
      getItem: (_key: string) => { throw new Error('blocked'); },
      setItem: (_key: string, _value: string) => { throw new Error('blocked'); },
    };
    expect(loadAiRecentSessions('workspace', throwing)).toEqual([]);
    expect(upsertAiRecentSession({
      backend: 'claude', sessionId: 's', workspaceKey: 'workspace', prompt: 'x',
    }, throwing)).toBeNull();
  });

  it('uses the registered storage key', () => {
    expect(AI_PROMPT_SESSIONS_KEY).toBe('rv-ai-prompt-sessions');
  });
});
