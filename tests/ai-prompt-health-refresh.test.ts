// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  connectRestFetch: vi.fn(),
  getConnectSnapshot: vi.fn(() => ({ serverUrl: 'http://localhost:5100/' })),
}));

vi.mock('../src/core/hmi/connect-rest', () => ({ connectRestFetch: mocks.connectRestFetch }));
vi.mock('../src/core/hmi/connect-store', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/hmi/connect-store')>(),
  getConnectSnapshot: mocks.getConnectSnapshot,
}));

import {
  getAiPromptHealthSnapshot,
  refreshAiPromptHealth,
  subscribeAiPromptHealth,
} from '../../realvirtual-WebViewer-Private~/src/plugins/ai-prompt/ai-prompt-health';

describe('ai-prompt-health refresh store', () => {
  beforeEach(() => vi.clearAllMocks());

  it('publishes a cold refresh and subsequent backend changes without reload', async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeAiPromptHealth(listener);
    mocks.connectRestFetch.mockResolvedValueOnce(new Response(JSON.stringify({ aiPrompt: {
      available: true,
      workspaceKey: 'workspace',
      backends: {
        claude: { available: false, reason: 'no-cli' },
        codex: { available: true, reason: null },
      },
    } }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    await refreshAiPromptHealth();
    expect(getAiPromptHealthSnapshot().backends.codex.available).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);

    mocks.connectRestFetch.mockResolvedValueOnce(new Response(JSON.stringify({ aiPrompt: {
      available: true,
      workspaceKey: 'workspace',
      backends: {
        claude: { available: true, reason: null },
        codex: { available: false, reason: 'unauthenticated' },
      },
    } }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    await refreshAiPromptHealth();

    expect(getAiPromptHealthSnapshot().backends).toEqual({
      claude: { available: true, reason: null },
      codex: { available: false, reason: 'unauthenticated' },
    });
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it('discards a delayed response after the CONNECT base URL changes', async () => {
    let serverUrl = 'http://connect-a:5100/';
    mocks.getConnectSnapshot.mockImplementation(() => ({ serverUrl }));
    let resolveA!: (response: Response) => void;
    let resolveB!: (response: Response) => void;
    mocks.connectRestFetch.mockImplementation((url: string) => new Promise<Response>((resolve) => {
      if (url.startsWith('http://connect-a:5100')) resolveA = resolve;
      else resolveB = resolve;
    }));

    const first = refreshAiPromptHealth();
    serverUrl = 'http://connect-b:5100/';
    const second = refreshAiPromptHealth();

    resolveA(new Response(JSON.stringify({ aiPrompt: {
      available: true,
      workspaceKey: 'workspace-a',
      backends: { claude: { available: true }, codex: { available: false, reason: 'no-cli' } },
    } }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    await Promise.resolve();
    expect(getAiPromptHealthSnapshot().workspaceKey).not.toBe('workspace-a');

    resolveB(new Response(JSON.stringify({ aiPrompt: {
      available: true,
      workspaceKey: 'workspace-b',
      backends: { claude: { available: false, reason: 'no-cli' }, codex: { available: true } },
    } }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ workspaceKey: 'workspace-b' }),
      expect.objectContaining({ workspaceKey: 'workspace-b' }),
    ]);
    expect(getAiPromptHealthSnapshot()).toMatchObject({
      workspaceKey: 'workspace-b',
      backends: { codex: { available: true } },
    });
  });
});
