// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** AI prompt panel run lifecycle: an answered prompt whose CLI is still alive is not "done". */

import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import { grantAiBridgeConsent, revokeAiBridgeConsent } from '../src/core/hmi/ai-consent-store';
import { AI_PROMPT_BACKEND_KEY, AI_PROMPT_SESSIONS_KEY } from '../src/core/hmi/rv-storage-keys';
import { rvDarkTheme } from '../src/core/hmi/theme';
import { LeftPanelManager } from '../src/core/hmi/left-panel-manager';
import { UIPluginRegistry } from '../src/core/rv-ui-registry';
import { RVViewerProvider } from '../src/hooks/use-viewer';
import { modeManagerDouble } from './fixtures/mode-manager-double';
import { AiPromptPanel } from '../../realvirtual-WebViewer-Private~/src/plugins/ai-prompt/AiPromptPanel';
import { createAiPromptStore } from '../../realvirtual-WebViewer-Private~/src/plugins/ai-prompt/ai-prompt-store';
import type { RunAiPromptStreamOptions } from '../../realvirtual-WebViewer-Private~/src/plugins/ai-prompt/ai-prompt-stream';
import type { AiPromptHealth } from '../../realvirtual-WebViewer-Private~/src/plugins/ai-prompt/ai-prompt-health';

vi.mock('../src/hooks/use-mobile-layout', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/hooks/use-mobile-layout')>(),
  useMobileLayout: () => false,
}));

vi.mock('../src/core/hmi/connect-rest', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/hmi/connect-rest')>(),
  connectRestFetch: vi.fn(async () => new Response(JSON.stringify({
    status: 'ok',
    aiPrompt: {
      available: true,
      reason: null,
      workspaceKey: 'workspace-test',
      backends: {
        claude: { available: true, reason: null },
        codex: { available: true, reason: null },
      },
    },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
}));

function createViewer() {
  const editorSnapshot = { panelOpen: false, settingsOpen: false };
  const editorPlugin = {
    subscribe: () => () => undefined,
    getSnapshot: () => editorSnapshot,
    togglePanel: vi.fn(),
    setSettingsOpen: vi.fn(),
  };
  const mcpBridgePlugin = {
    getSnapshot: () => ({
      connected: true, port: '5100', toolCount: 0, toolNames: [],
      enabled: true, aiEnabled: true, reconnectAttempt: 0, reconnectDelay: 0, serverStatus: null,
      target: 'ws://localhost:5100/webviewer', failure: 'none',
    }),
  };
  return {
    leftPanelManager: new LeftPanelManager(),
    uiRegistry: new UIPluginRegistry(),
    modes: modeManagerDouble(),
    getPlugin: (id: string) => {
      if (id === 'rv-extras-editor') return editorPlugin;
      if (id === 'mcp-bridge') return mcpBridgePlugin;
      return null;
    },
    on: () => () => undefined,
  };
}

function renderPanel(node: ReactNode) {
  return render(
    <ThemeProvider theme={rvDarkTheme}>
      <RVViewerProvider value={createViewer() as never}>{node}</RVViewerProvider>
    </ThemeProvider>,
  );
}

/** A run the test drives line by line; `abort` rejects like fetch does when the request is aborted. */
function controlledRun() {
  const control = {
    onLine: async (_line: string): Promise<void> => undefined,
    finish: (): void => undefined,
    aborted: false,
  };
  const runStream = vi.fn((options: RunAiPromptStreamOptions) => new Promise<void>((resolve, reject) => {
    control.onLine = (line) => act(async () => options.onLine(line));
    control.finish = resolve;
    options.signal.addEventListener('abort', () => {
      control.aborted = true;
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  }));
  return { control, runStream };
}

// Publish on the next microtask, so an async act() flushes a batch without real animation frames.
// Stable health for the store: the panel's own health refresh must not look like a workspace switch
// (which drops the run) while a test drives it line by line.
const HEALTH: AiPromptHealth = {
  available: true,
  reason: null,
  workspaceKey: 'workspace-test',
  backends: { claude: { available: true, reason: null }, codex: { available: true, reason: null } },
};
const healthDeps = {
  getHealth: () => HEALTH,
  subscribeHealth: () => () => undefined,
  refreshHealth: async () => HEALTH,
};

const microtaskFrame = (callback: FrameRequestCallback): number => {
  queueMicrotask(() => callback(0));
  return 1;
};

beforeEach(() => {
  localStorage.removeItem(AI_PROMPT_BACKEND_KEY);
  localStorage.removeItem(AI_PROMPT_SESSIONS_KEY);
  grantAiBridgeConsent();
});

afterEach(() => {
  cleanup();
  revokeAiBridgeConsent();
  vi.restoreAllMocks();
});

describe('AI prompt panel lifecycle', () => {
  it('shows "still working in the background" after the answer and keeps Send off until connect_exit', async () => {
    const { control, runStream } = controlledRun();
    const store = createAiPromptStore({ ...healthDeps, runStream, requestFrame: microtaskFrame });
    renderPanel(<AiPromptPanel open onClose={vi.fn()} store={store} />);
    const panel = document.querySelector('[data-rv-ai="panel"]');
    const input = screen.getByRole('textbox', { name: 'AI prompt' });

    fireEvent.change(input, { target: { value: 'Start the long job' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(panel).toHaveAttribute('data-rv-ai-state', 'running'));

    await control.onLine(JSON.stringify({ type: 'result', is_error: false, duration_ms: 3_000 }));
    expect(panel).toHaveAttribute('data-rv-ai-phase', 'background');
    expect(screen.getByText(/Still working in the background/)).toBeInTheDocument();
    fireEvent.change(input, { target: { value: 'Next prompt' } });
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'New session', hidden: true })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'AI backend', hidden: true })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(runStream).toHaveBeenCalledTimes(1);

    await control.onLine(JSON.stringify({ type: 'connect_exit', code: 0 }));
    await act(async () => control.finish());
    await waitFor(() => expect(panel).toHaveAttribute('data-rv-ai-state', 'idle'));
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
    expect(document.querySelector('[data-rv-ai="status"]')).toHaveTextContent('Done · 3 s');
    store.dispose();
  });

  it('Stop from the background state aborts the run and returns to idle only once the stream settled', async () => {
    let releaseAbort!: () => void;
    const runStream = vi.fn((options: RunAiPromptStreamOptions) => new Promise<void>((_resolve, reject) => {
      options.onLine(JSON.stringify({ type: 'result', is_error: false }));
      // The abort is observed now, but the stream settles later — like CONNECT killing the tree.
      options.signal.addEventListener('abort', () => {
        releaseAbort = () => reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    }));
    const store = createAiPromptStore({ ...healthDeps, runStream, requestFrame: microtaskFrame });
    renderPanel(<AiPromptPanel open onClose={vi.fn()} store={store} />);
    const panel = document.querySelector('[data-rv-ai="panel"]');

    fireEvent.change(screen.getByRole('textbox', { name: 'AI prompt' }), { target: { value: 'Long job' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(panel).toHaveAttribute('data-rv-ai-phase', 'background'));

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(panel).toHaveAttribute('data-rv-ai-phase', 'stopping');
    expect(screen.getByText('Stopping…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(document.querySelector('[data-rv-ai="cancel"]')).toBeDisabled();

    await act(async () => releaseAbort());
    await waitFor(() => expect(panel).toHaveAttribute('data-rv-ai-state', 'idle'));
    expect(screen.getByText('Stopped')).toBeInTheDocument();
    store.dispose();
  });
});


it('Show AI clicks toolbar icon executes the command and updates its pressed state', async () => {
  const { commandRegistry } = await import('../src/core/hmi/rv-command-registry');
  const { ensureViewCommandsRegistered } = await import('../src/core/hmi/view-commands');
  const { setAiClicks } = await import('../src/core/hmi/ai-click-choreography-store');
  ensureViewCommandsRegistered();
  setAiClicks(true);
  const spy = vi.spyOn(commandRegistry, 'execute');
  const { runStream } = controlledRun();
  const store = createAiPromptStore({ ...healthDeps, runStream, requestFrame: microtaskFrame });
  try {
    renderPanel(<AiPromptPanel open onClose={vi.fn()} store={store} />);
    const toggle = screen.getByRole('button', { name: 'Show AI clicks', hidden: true });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(toggle);
    expect(spy).toHaveBeenCalledWith('view.aiClicks', { on: false }, expect.objectContaining({ origin: 'ui' }));
    await waitFor(() => expect(toggle).toHaveAttribute('aria-pressed', 'false'));
  } finally { cleanup(); store.dispose(); setAiClicks(true); spy.mockRestore(); }
});
