// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** Activity-bar handoff and private Claude Code panel integration (plan-2040). */

import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import { ActivityBar } from '../src/core/hmi/ActivityBar';
import {
  getAiEntryHandler,
  getAiEntryOpen,
  setAiEntryHandler,
  setAiEntryOpen,
} from '../src/core/hmi/ai-entry-store';
import { grantAiBridgeConsent, revokeAiBridgeConsent } from '../src/core/hmi/ai-consent-store';
import { connectRestFetch } from '../src/core/hmi/connect-rest';
import { commandRegistry } from '../src/core/hmi/rv-command-registry';
import { clearRequestedSettingsTab, getRequestedSettingsTab } from '../src/core/hmi/settings-tab-store';
import { AI_PROMPT_BACKEND_KEY, AI_PROMPT_SESSIONS_KEY } from '../src/core/hmi/rv-storage-keys';
import { rvDarkTheme } from '../src/core/hmi/theme';
import { LeftPanelManager } from '../src/core/hmi/left-panel-manager';
import { UIPluginRegistry } from '../src/core/rv-ui-registry';
import { RVViewerProvider } from '../src/hooks/use-viewer';
import type { McpBridgeSnapshot } from '../src/plugins/mcp-bridge-plugin';
import { modeManagerDouble } from './fixtures/mode-manager-double';
import { AiPromptPanel } from '../../realvirtual-WebViewer-Private~/src/plugins/ai-prompt/AiPromptPanel';
import { AiPromptPlugin } from '../../realvirtual-WebViewer-Private~/src/plugins/ai-prompt/ai-prompt-plugin';
import { createAiPromptStore } from '../../realvirtual-WebViewer-Private~/src/plugins/ai-prompt/ai-prompt-store';
import { createAiPromptImageResources } from '../../realvirtual-WebViewer-Private~/src/plugins/ai-prompt/ai-prompt-images';
import { refreshAiPromptHealth } from '../../realvirtual-WebViewer-Private~/src/plugins/ai-prompt/ai-prompt-health';

const layout = vi.hoisted(() => ({ mobile: false }));
const health = vi.hoisted(() => ({
  available: false,
  reason: 'disabled' as string | null,
  claude: false,
  codex: false,
  workspaceKey: 'workspace-test',
}));

vi.mock('../src/hooks/use-mobile-layout', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/hooks/use-mobile-layout')>(),
  useMobileLayout: () => layout.mobile,
}));

vi.mock('../src/core/hmi/scene/scene-store-singleton', () => ({
  getSceneStore: () => ({}),
}));

vi.mock('../src/core/hmi/ButtonPanel', () => ({
  ButtonPanel: () => <div />,
  LogoBadge: () => <button type="button" title="About" aria-label="About">realvirtual</button>,
}));

vi.mock('../src/core/hmi/connect-rest', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/hmi/connect-rest')>(),
  connectRestFetch: vi.fn(async () => new Response(JSON.stringify({
    status: 'ok',
    aiPrompt: {
      available: health.available,
      reason: health.reason,
      workspaceKey: health.workspaceKey,
      backends: {
        claude: { available: health.claude, reason: health.claude ? null : 'no-cli' },
        codex: { available: health.codex, reason: health.codex ? null : 'no-cli' },
      },
    },
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })),
}));

function createViewer(mcp?: Partial<McpBridgeSnapshot>) {
  const editorSnapshot = { panelOpen: false, settingsOpen: false };
  const editorPlugin = {
    subscribe: () => () => undefined,
    getSnapshot: () => editorSnapshot,
    togglePanel: vi.fn(),
    setSettingsOpen: vi.fn(),
  };
  const mcpBridgePlugin = mcp
    ? {
        getSnapshot: () => ({
          connected: false, port: '5100', toolCount: 0, toolNames: [],
          enabled: false, reconnectAttempt: 0, reconnectDelay: 0, serverStatus: null,
          target: 'ws://localhost:5100/webviewer', failure: 'none',
          ...mcp,
        }),
      }
    : { getSnapshot: undefined };
  return {
    leftPanelManager: new LeftPanelManager(),
    uiRegistry: new UIPluginRegistry(),
    modes: modeManagerDouble(),
    applyVisualSettings: vi.fn(),
    clearModel: vi.fn(),
    renderBackend: 'three',
    hasRenderBackend: () => false,
    onRenderBackendChange: () => () => undefined,
    setRenderBackend: vi.fn(),
    getPlugin: (id: string) => {
      if (id === 'rv-extras-editor') return editorPlugin;
      if (id === 'mcp-bridge') return mcpBridgePlugin;
      return null;
    },
    on: () => () => undefined,
    editorPlugin,
  };
}

function renderWithViewer(node: ReactNode, viewer = createViewer()) {
  return {
    viewer,
    ...render(
      <ThemeProvider theme={rvDarkTheme}>
        <RVViewerProvider value={viewer as never}>{node}</RVViewerProvider>
      </ThemeProvider>,
    ),
  };
}

const aiButton = () => screen.getByRole('button', { name: /^AI control/ });

beforeEach(() => {
  vi.clearAllMocks();
  layout.mobile = false;
  health.available = false;
  health.reason = 'disabled';
  health.claude = false;
  health.codex = false;
  health.workspaceKey = 'workspace-test';
  setAiEntryHandler(null);
  setAiEntryOpen(false);
  localStorage.removeItem(AI_PROMPT_BACKEND_KEY);
  localStorage.removeItem(AI_PROMPT_SESSIONS_KEY);
  revokeAiBridgeConsent();
  clearRequestedSettingsTab();
});

afterEach(() => {
  cleanup();
  setAiEntryHandler(null);
  setAiEntryOpen(false);
  revokeAiBridgeConsent();
  clearRequestedSettingsTab();
  vi.restoreAllMocks();
});

describe('AI activity-bar prompt handoff', () => {
  it('stops after a private handler accepts the click', async () => {
    const handler = vi.fn(async () => true);
    setAiEntryHandler(handler);
    const { viewer } = renderWithViewer(<ActivityBar />);

    fireEvent.click(aiButton());

    await waitFor(() => expect(handler).toHaveBeenCalledOnce());
    expect(viewer.editorPlugin.setSettingsOpen).not.toHaveBeenCalled();
    expect(getRequestedSettingsTab()).toBeNull();
  });

  it.each(['false', 'exception'] as const)('keeps the existing Settings route after handler %s', async (outcome) => {
    setAiEntryHandler(outcome === 'false'
      ? async () => false
      : async () => { throw new Error('private handler failed'); });
    const { viewer } = renderWithViewer(<ActivityBar />);

    fireEvent.click(aiButton());

    await waitFor(() => expect(getRequestedSettingsTab()).toBe(5));
    expect(viewer.editorPlugin.setSettingsOpen).toHaveBeenCalledWith(true);
  });

  it('sees CONNECT health change from unavailable to available without a reload', async () => {
    const plugin = new AiPromptPlugin();
    plugin.init();
    const { viewer } = renderWithViewer(<ActivityBar />);

    fireEvent.click(aiButton());
    await waitFor(() => expect(viewer.editorPlugin.setSettingsOpen).toHaveBeenCalledTimes(1));
    expect(vi.mocked(connectRestFetch)).toHaveBeenCalledTimes(2);

    health.available = true;
    health.reason = null;
    health.claude = true;
    fireEvent.click(aiButton());

    await waitFor(() => expect(vi.mocked(connectRestFetch)).toHaveBeenCalledTimes(3));
    expect(viewer.editorPlugin.setSettingsOpen).toHaveBeenCalledTimes(1);
    plugin.dispose();
    expect(getAiEntryHandler()).toBeNull();
    expect(commandRegistry.get('ai.prompt')).toBeUndefined();
    expect(commandRegistry.get('ai.cancel')).toBeUndefined();
  });

  it('toggles the prompt window and keeps the activity entry active while it is open', async () => {
    health.available = true;
    health.reason = null;
    health.claude = true;
    const plugin = new AiPromptPlugin();
    plugin.init();
    renderWithViewer(<ActivityBar />);

    fireEvent.click(aiButton());
    await waitFor(() => expect(getAiEntryOpen()).toBe(true));
    expect(aiButton()).toHaveClass('MuiIconButton-colorPrimary');

    fireEvent.click(aiButton());
    await waitFor(() => expect(getAiEntryOpen()).toBe(false));
    expect(aiButton()).not.toHaveClass('MuiIconButton-colorPrimary');
    plugin.dispose();
  });
});

describe('AI prompt panel', () => {
  it('moves idle to running to idle and disables Send while running', async () => {
    grantAiBridgeConsent();
    let finishRun!: () => void;
    const store = createAiPromptStore({
      runStream: ({ onLine }) => new Promise<void>((resolve) => {
        finishRun = () => {
          onLine(JSON.stringify({ type: 'result', duration_ms: 48_000, session_id: 'session-1' }));
          onLine(JSON.stringify({ type: 'connect_exit', code: 0 }));
          resolve();
        };
      }),
    });
    renderWithViewer(<AiPromptPanel open onClose={vi.fn()} store={store} />, createViewer({ connected: true, enabled: true, aiEnabled: true }));

    const panel = document.querySelector('[data-rv-ai="panel"]');
    const input = screen.getByRole('textbox', { name: 'AI prompt' });
    const send = screen.getByRole('button', { name: 'Send' });
    expect(panel).toHaveAttribute('data-rv-ai-state', 'idle');
    const recordingInput = document.querySelector('[data-rv-ai="input"]');
    expect(recordingInput).toBeInstanceOf(HTMLTextAreaElement);
    expect(document.querySelector('[data-rv-ai="cancel"]')).toBeInTheDocument();

    fireEvent.change(recordingInput!, { target: { value: 'Inspect the active scene' } });
    expect(input).toHaveValue('Inspect the active scene');
    fireEvent.click(send);

    await waitFor(() => expect(panel).toHaveAttribute('data-rv-ai-state', 'running'));
    expect(send).toBeDisabled();
    expect(screen.getByText('Running…')).toBeInTheDocument();

    finishRun();
    await waitFor(() => expect(panel).toHaveAttribute('data-rv-ai-state', 'idle'));
    expect(screen.getAllByText('Done · 48 s').length).toBeGreaterThan(0);
  });

  it('keeps Shift+Enter in the input and uses Escape to cancel without closing the panel', async () => {
    grantAiBridgeConsent();
    const onClose = vi.fn();
    const store = createAiPromptStore({
      runStream: ({ signal }) => new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      }),
    });
    renderWithViewer(<AiPromptPanel open onClose={onClose} store={store} />, createViewer({ connected: true, enabled: true, aiEnabled: true }));
    const panel = document.querySelector('[data-rv-ai="panel"]');
    const input = screen.getByRole('textbox', { name: 'AI prompt' });

    fireEvent.change(input, { target: { value: 'First line' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(panel).toHaveAttribute('data-rv-ai-state', 'idle');

    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(panel).toHaveAttribute('data-rv-ai-state', 'running'));
    fireEvent.keyDown(input, { key: 'Escape' });

    await waitFor(() => expect(panel).toHaveAttribute('data-rv-ai-state', 'idle'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('holds a scene prompt back while the AI cannot reach the scene and offers to enable it', async () => {
    const submit = vi.fn();
    const store = createAiPromptStore({ runPrompt: async () => undefined } as never);
    store.submit = submit as never;
    renderWithViewer(<AiPromptPanel open onClose={vi.fn()} store={store} />);

    expect(screen.getByText('Scene access off')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'AI prompt' }), { target: { value: 'Inspect the scene' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(submit).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Enable and send' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'AI prompt' })).toHaveValue('Inspect the scene');

    fireEvent.click(screen.getByRole('button', { name: 'Send without scene access' }));
    expect(submit).toHaveBeenCalledWith('Inspect the scene');
  });

  it('shows the AI title, available backends and the settings shortcut', async () => {
    health.available = true;
    health.reason = null;
    health.codex = true;
    await refreshAiPromptHealth();
    await refreshAiPromptHealth();
    const store = createAiPromptStore({ runStream: async () => undefined });
    const { viewer } = renderWithViewer(<AiPromptPanel open onClose={vi.fn()} store={store} />);

    expect(screen.getByText('AI')).toBeInTheDocument();
    const backend = await screen.findByRole('combobox', { name: 'AI backend' });
    await waitFor(() => expect(backend).toHaveTextContent('Codex'));
    expect(document.querySelector('[data-rv-ai="backend"]')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Recent sessions' })).toBeInTheDocument();

    fireEvent.click(document.querySelector('[data-rv-ai="settings"]')!);
    expect(viewer.editorPlugin.setSettingsOpen).toHaveBeenCalledWith(true);
    expect(getRequestedSettingsTab()).toBe(5);
    expect(document.querySelector('[data-rv-ai="settings"]')).toBeInTheDocument();
    store.dispose();
  });

  it('resumes a recent workspace session and shows its time and title', async () => {
    health.available = true;
    health.reason = null;
    health.claude = true;
    await refreshAiPromptHealth();
    await refreshAiPromptHealth();
    localStorage.setItem(AI_PROMPT_SESSIONS_KEY, JSON.stringify([{
      backend: 'claude',
      sessionId: 'recent-session',
      startedAt: '2026-10-30T08:15:00.000Z',
      title: 'Previous task',
      workspaceKey: health.workspaceKey,
    }]));
    const store = createAiPromptStore({ runStream: async () => undefined });
    renderWithViewer(<AiPromptPanel open onClose={vi.fn()} store={store} />);

    const recent = screen.getByRole('combobox', { name: 'Recent sessions' });
    fireEvent.mouseDown(recent);
    fireEvent.click(await screen.findByRole('option', { name: /Previous task/ }));
    expect(screen.getByText(/^Continuing session from .+ — Previous task$/)).toBeInTheDocument();
    store.dispose();
  });

  it('renders live and historical selection chips and enlarges tool images', async () => {
    grantAiBridgeConsent();
    health.available = true;
    health.reason = null;
    health.claude = true;
    await refreshAiPromptHealth();
    await refreshAiPromptHealth();
    const revokeObjectURL = vi.fn();
    const imageResources = createAiPromptImageResources({
      createObjectURL: () => 'blob:ai-prompt-image',
      revokeObjectURL,
    });
    const store = createAiPromptStore({
      imageResources,
      runStream: async ({ onLine }) => {
        onLine(JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'tool_use', id: 'shot', name: 'web_screenshot', input: {} }] },
        }));
        onLine(JSON.stringify({
          type: 'user',
          message: {
            content: [{
              type: 'tool_result',
              tool_use_id: 'shot',
              content: [{
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
                },
              }],
            }],
          },
        }));
        onLine(JSON.stringify({ type: 'result', duration_ms: 1000, session_id: 'session-image' }));
        onLine(JSON.stringify({ type: 'connect_exit', code: 0 }));
      },
    });
    let selectedPaths = ['Cell/Cylinder'];
    let selectionListener: () => void = () => {};
    store.attachViewer({
      selectionManager: {
        subscribe: (listener) => { selectionListener = listener; return () => undefined; },
        getSnapshot: () => ({
          selectedPaths,
          nodes: selectedPaths.map(() => ({})),
          primaryPath: selectedPaths[0] ?? null,
        }),
      },
      registry: {
        getNode: () => null,
        getComponentTypes: () => [],
      },
    });
    renderWithViewer(<AiPromptPanel open onClose={vi.fn()} store={store} />, createViewer({ connected: true, enabled: true, aiEnabled: true }));

    expect(screen.getByText('◎ Cell/Cylinder')).toBeInTheDocument();
    expect(document.querySelector('[data-rv-ai="selection"]')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'AI prompt' }), { target: { value: 'Inspect selection' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    const thumbnail = await screen.findByRole('img', { name: 'Preview from web_screenshot' });
    expect(screen.getAllByText('◎ Cell/Cylinder')).toHaveLength(2);
    selectedPaths = ['Cell/Other'];
    act(() => selectionListener());
    expect(screen.getByText('◎ Cell/Other')).toBeInTheDocument();
    expect(screen.getByText('◎ Cell/Cylinder')).toBeInTheDocument();

    fireEvent.click(thumbnail);
    expect(screen.getByRole('dialog', { name: 'AI image' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Enlarged AI tool result' })).toHaveAttribute('src', 'blob:ai-prompt-image');

    fireEvent.click(screen.getByRole('button', { name: 'New session', hidden: true }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'AI image' })).not.toBeInTheDocument());
    expect(screen.queryByRole('img', { name: 'Preview from web_screenshot' })).not.toBeInTheDocument();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:ai-prompt-image');
    store.dispose();
  });
});
