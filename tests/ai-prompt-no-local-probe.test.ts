// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * A hosted page (the public demo on web.realvirtual.io) must not touch a local gateway on page load:
 * `fetch('http://localhost:5100/health')` from a public origin raises Chrome's Local Network Access
 * prompt for every visitor. The AI prompt plugin did exactly that in its `init()`. A loopback page
 * (CONNECT-served tab, local dev, agent tabs) keeps probing at once.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({
  loopback: false,
  serverUrl: 'http://localhost:5100',
  state: 'disconnected' as string,
  listeners: new Set<() => void>(),
}));
const fetchMock = vi.hoisted(() => vi.fn(async () => new Response(JSON.stringify({ status: 'ok' }), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
})));

vi.mock('../src/core/hmi/connect-rest', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/hmi/connect-rest')>(),
  connectRestFetch: fetchMock,
}));

vi.mock('../src/core/hmi/connect-store', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/hmi/connect-store')>(),
  isLoopbackOrigin: () => env.loopback,
  getConnectSnapshot: () => ({ serverUrl: env.serverUrl, state: env.state }),
  subscribeConnectStore: (listener: () => void) => {
    env.listeners.add(listener);
    return () => env.listeners.delete(listener);
  },
}));

import { AiPromptPlugin } from '../../realvirtual-WebViewer-Private~/src/plugins/ai-prompt/ai-prompt-plugin';
import {
  mayProbeAiPromptHealthSilently,
  refreshAiPromptHealth,
} from '../../realvirtual-WebViewer-Private~/src/plugins/ai-prompt/ai-prompt-health';

function localCalls(): string[] {
  return fetchMock.mock.calls
    .map((call) => String((call as unknown[])[0]))
    .filter((url) => /^https?:\/\/(localhost|127\.|\[::1\]|10\.|192\.168\.)/.test(url));
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('AI prompt: no local-network probe on a hosted origin', () => {
  let plugin: AiPromptPlugin;

  beforeEach(async () => {
    env.loopback = false;
    env.serverUrl = 'http://localhost:5100';
    env.state = 'disconnected';
    env.listeners.clear();
    // Drain a refresh a previous test left in flight: callers of the same URL share one request.
    await refreshAiPromptHealth();
    fetchMock.mockClear();
    plugin = new AiPromptPlugin();
  });

  afterEach(() => plugin.dispose());

  it('Test_Init_HostedOriginLocalGateway_NoLocalRequest', async () => {
    plugin.init();
    await flush();
    expect(mayProbeAiPromptHealthSilently()).toBe(false);
    expect(localCalls()).toEqual([]);
  });

  it('Test_Init_LoopbackOrigin_ProbesAtOnce', async () => {
    env.loopback = true;
    plugin.init();
    await vi.waitFor(() => expect(localCalls()).toEqual(['http://localhost:5100/health']));
  });

  it('Test_ConnectTransition_HostedOrigin_ProbesAfterExplicitConnect', async () => {
    plugin.init();
    await flush();
    expect(localCalls()).toEqual([]);
    env.state = 'connected';
    for (const listener of env.listeners) listener();
    await vi.waitFor(() => expect(localCalls()).toEqual(['http://localhost:5100/health']));
  });

  it('Test_SilentRules_PublicGatewayOrConnected_Allowed', () => {
    env.serverUrl = 'https://gateway.example.com';
    expect(mayProbeAiPromptHealthSilently()).toBe(true);
    env.serverUrl = 'http://192.168.1.20:5100';
    expect(mayProbeAiPromptHealthSilently()).toBe(false);
    env.state = 'connected';
    expect(mayProbeAiPromptHealthSilently()).toBe(true);
  });

  it('Test_ExplicitRefresh_HostedOrigin_StillProbes', async () => {
    // Opening the AI panel / an AI command is an explicit user action — the browser may ask then.
    await refreshAiPromptHealth();
    expect(localCalls()).toEqual(['http://localhost:5100/health']);
  });
});
