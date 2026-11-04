// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it, vi } from 'vitest';
import type { RVViewer } from '../src/core/rv-viewer';
import { CommandRegistry } from '../src/core/hmi/rv-command-registry';
import {
  AI_CANCEL_COMMAND,
  AI_PROMPT_COMMAND,
  registerAiPromptCommands,
  type AiPromptCommandDependencies,
} from '../../realvirtual-WebViewer-Private~/src/plugins/ai-prompt/ai-prompt-commands';
import {
  initialAiPromptState,
  type AiPromptState,
} from '../../realvirtual-WebViewer-Private~/src/plugins/ai-prompt/ai-prompt-parser';
import { createAiPromptStore } from '../../realvirtual-WebViewer-Private~/src/plugins/ai-prompt/ai-prompt-store';
import type { AiPromptHealth } from '../../realvirtual-WebViewer-Private~/src/plugins/ai-prompt/ai-prompt-health';
import type { RunAiPromptStreamOptions } from '../../realvirtual-WebViewer-Private~/src/plugins/ai-prompt/ai-prompt-stream';

const viewer = { modes: { activeMode: 'hmi' } } as unknown as RVViewer;

function fixture() {
  let state: AiPromptState = { ...initialAiPromptState(), status: 'idle' };
  const store = {
    getSnapshot: () => state,
    submit: vi.fn(async (prompt: string) => {
      state = { ...state, status: 'running', entries: [...state.entries, { kind: 'user', text: prompt }] };
      state = { ...state, status: 'idle' };
    }),
    cancel: vi.fn(() => { state = { ...state, status: 'idle' }; }),
  };
  const deps: AiPromptCommandDependencies = {
    store,
    openPanel: vi.fn(),
    refreshAiPromptHealth: vi.fn(async () => healthy()),
  };
  return {
    store, deps,
    setState: (next: AiPromptState) => { state = next; },
  };
}

function healthy(overrides: Partial<AiPromptHealth> = {}): AiPromptHealth {
  return {
    available: true,
    reason: null,
    workspaceKey: 'workspace',
    backends: {
      claude: { available: true, reason: null },
      codex: { available: true, reason: null },
    },
    ...overrides,
  };
}

describe('ai-prompt commands', () => {
  it('registers build-available commands without MCP mirrors', () => {
    const registry = new CommandRegistry();
    const { deps } = fixture();
    registerAiPromptCommands(registry, deps);

    expect(registry.get(AI_PROMPT_COMMAND)).toMatchObject({
      available: true, readOnly: false, scope: 'none', argsSchema: { prompt: 'string', backend: 'string' },
    });
    expect(registry.get(AI_CANCEL_COMMAND)).toMatchObject({
      available: true, readOnly: false, scope: 'none', argsSchema: {},
    });
    expect(registry.get(AI_PROMPT_COMMAND)?.mcp).toBeUndefined();
    expect(registry.get(AI_CANCEL_COMMAND)?.mcp).toBeUndefined();
  });

  it('starts on a cold health state by refreshing inside run', async () => {
    const registry = new CommandRegistry();
    const { deps, store } = fixture();
    store.submit.mockImplementationOnce(() => new Promise<void>(() => {}));
    registerAiPromptCommands(registry, deps);

    expect(registry.enabled(AI_PROMPT_COMMAND, { prompt: 'Kinematize this model' }, viewer)).toBe(true);
    const result = await registry.execute(AI_PROMPT_COMMAND, { prompt: 'Kinematize this model' }, {
      origin: 'ui', viewer,
    });

    expect(result).toEqual({ ok: true, value: { started: true } });
    expect(deps.refreshAiPromptHealth).toHaveBeenCalledOnce();
    expect(deps.openPanel).toHaveBeenCalledOnce();
    expect(store.submit).toHaveBeenCalledWith('Kinematize this model', undefined);
  });

  it('cancels a running store run', async () => {
    const registry = new CommandRegistry();
    const { deps, store, setState } = fixture();
    setState({ ...initialAiPromptState(), status: 'running' });
    registerAiPromptCommands(registry, deps);

    const result = await registry.execute(AI_CANCEL_COMMAND, {}, { origin: 'ui', viewer });

    expect(result).toEqual({ ok: true, value: { cancelled: true } });
    expect(store.cancel).toHaveBeenCalledOnce();
  });

  it('returns the fresh health reason when /health has no aiPrompt capability', async () => {
    const registry = new CommandRegistry();
    const { deps, store } = fixture();
    vi.mocked(deps.refreshAiPromptHealth).mockResolvedValueOnce(healthy({
      available: false,
      reason: 'not-supported',
      backends: {
        claude: { available: false, reason: 'not-supported' },
        codex: { available: false, reason: 'not-supported' },
      },
    }));
    registerAiPromptCommands(registry, deps);

    const result = await registry.execute(AI_PROMPT_COMMAND, { prompt: 'x' }, { origin: 'ui', viewer });

    expect(result).toMatchObject({
      ok: false, kind: 'threw', reason: 'This CONNECT version does not support AI prompts',
      details: { reason: 'not-supported', backend: 'claude' },
    });
    expect(deps.openPanel).not.toHaveBeenCalled();
    expect(store.submit).not.toHaveBeenCalled();
  });

  it('rejects a recursive prompt as busy without aborting the active run', async () => {
    const registry = new CommandRegistry();
    let firstAborted = false;
    const runStream = vi.fn(({ signal }: { signal: AbortSignal }) => new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => {
        firstAborted = true;
        resolve();
      }, { once: true });
    }));
    const store = createAiPromptStore({ runStream });
    const deps: AiPromptCommandDependencies = {
      store,
      openPanel: vi.fn(),
      refreshAiPromptHealth: vi.fn(async () => healthy()),
    };
    registerAiPromptCommands(registry, deps);

    const first = await registry.execute(AI_PROMPT_COMMAND, { prompt: 'first' }, { origin: 'ui', viewer });
    await store.submit('direct recursive submit');
    const second = await registry.execute(AI_PROMPT_COMMAND, { prompt: 'second' }, { origin: 'ui', viewer });

    expect(first).toEqual({ ok: true, value: { started: true } });
    expect(second).toEqual({ ok: false, kind: 'disabled', reason: 'busy' });
    expect(runStream).toHaveBeenCalledOnce();
    expect(firstAborted).toBe(false);
    store.cancel();
    expect(firstAborted).toBe(true);
  });

  it('rechecks busy after the asynchronous health refresh', async () => {
    const registry = new CommandRegistry();
    const { deps, store, setState } = fixture();
    let finishHealth!: () => void;
    vi.mocked(deps.refreshAiPromptHealth).mockImplementationOnce(() => new Promise((resolve) => {
      finishHealth = () => resolve(healthy());
    }));
    registerAiPromptCommands(registry, deps);

    const pending = registry.execute(AI_PROMPT_COMMAND, { prompt: 'race' }, { origin: 'ui', viewer });
    setState({ ...initialAiPromptState(), status: 'running' });
    finishHealth();

    await expect(pending).resolves.toMatchObject({
      ok: false, kind: 'threw', reason: 'busy', details: { reason: 'busy' },
    });
    expect(deps.openPanel).not.toHaveBeenCalled();
    expect(store.submit).not.toHaveBeenCalled();
  });

  it('passes an explicit Codex backend through ai.prompt', async () => {
    const registry = new CommandRegistry();
    const { deps, store } = fixture();
    registerAiPromptCommands(registry, deps);

    await registry.execute(AI_PROMPT_COMMAND, { prompt: 'Inspect', backend: 'codex' }, { origin: 'ui', viewer });

    expect(store.submit).toHaveBeenCalledWith('Inspect', 'codex');
  });

  it("applies ai.prompt's Codex backend before handling /clear locally", async () => {
    const runStream = (options: RunAiPromptStreamOptions): Promise<void> => {
      if (options.backend === 'codex') {
        options.onLine(JSON.stringify({ type: 'thread.started', thread_id: 'codex-session' }));
        options.onLine(JSON.stringify({ type: 'turn.completed' }));
      } else {
        options.onLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-session' }));
        options.onLine(JSON.stringify({ type: 'result', is_error: false, session_id: 'claude-session' }));
      }
      options.onLine(JSON.stringify({ type: 'connect_exit', code: 0 }));
      return Promise.resolve();
    };
    const currentHealth = healthy();
    const store = createAiPromptStore({
      runStream,
      storage: { getItem: () => null, setItem: () => undefined },
      getHealth: () => currentHealth,
      subscribeHealth: () => () => undefined,
      refreshHealth: async () => currentHealth,
    });
    await store.submit('Seed Codex', 'codex');
    store.setBackend('claude');
    const registry = new CommandRegistry();
    registerAiPromptCommands(registry, {
      store,
      openPanel: vi.fn(),
      refreshAiPromptHealth: vi.fn(async () => currentHealth),
    });

    await registry.execute(AI_PROMPT_COMMAND, { prompt: '/clear', backend: 'codex' }, { origin: 'ui', viewer });

    expect(store.getSnapshot()).toMatchObject({ backend: 'codex', sessionId: null, entries: [] });
  });
});
