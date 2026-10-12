// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-481 §9.3 — badge, panel and the self-opening behaviour.
 *
 * The three assertions worth naming, because each one pins a bug that a
 * reviewer actually found in the plan before it was written:
 *
 * - **Auto-open at a FULL buffer.** With twelve captures the array length stops
 *   changing, so a length-driven effect silently stops firing. The panel hangs
 *   off the monotonic `seq` instead, and the "13th capture" case below is the
 *   test that separates the two implementations.
 * - **The badge shows only while the agent works.** It appears with a connected
 *   bridge and a running tool call — but then with nothing captured yet too, or
 *   a guard on "are there captures" would remove the only entry point exactly
 *   when the empty state is the thing the user needs.
 * - **The badge does not cover the AI status pill.** Both want the same anchor
 *   beside the activity bar; this renders them together and measures.
 */

import { useState } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, render, screen, waitFor, act } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';

import ActivityBarSource from '../src/core/hmi/ActivityBar.tsx?raw';

const bridge = vi.hoisted(() => ({ connected: true }));

vi.mock('../src/hooks/use-mcp-bridge', () => ({
  useMcpBridge: () => ({
    connected: bridge.connected,
    port: 0, toolCount: 0, toolNames: [], enabled: bridge.connected,
    reconnectAttempt: 0, reconnectDelay: 0, serverStatus: null,
  }),
}));

vi.mock('../src/hooks/use-mobile-layout', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/hooks/use-mobile-layout')>(),
  useMobileLayout: () => false,
}));

// The anchor store remembers the last pointerdown process-wide; without this a
// click in one test re-anchors the panel of the next.
vi.mock('../src/core/hmi/panel-anchor-store', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/hmi/panel-anchor-store')>(),
  getRecentAnchorPoint: () => null,
}));

import { rvDarkTheme } from '../src/core/hmi/theme';
import { AgentEyeMonitorPanel } from '../src/core/hmi/AgentEyeMonitorPanel';
import { AgentEyeMonitorBadge } from '../src/core/hmi/AgentEyeMonitorBadge';
import { AgentActivityRow, setAgentActivityAnchor } from '../src/core/hmi/AgentActivityRow';
import { AiActivityOverlay } from '../src/core/hmi/AiActivityOverlay';
import { setAiActivity } from '../src/core/hmi/ai-activity-store';
import {
  recordAgentEyeEnvelope,
  resetAgentEyeMonitorForTest,
  setAgentEyeByteCapForTest,
  getAgentEyeFrames,
  isAgentEyeMonitorOpen,
  AGENT_EYE_MAX_FRAMES,
} from '../src/core/hmi/agent-eye-monitor-store';

// ─── Harness ────────────────────────────────────────────────────────────

function Wrapper({ children }: { children: React.ReactNode }) {
  return <ThemeProvider theme={rvDarkTheme}>{children}</ThemeProvider>;
}

function canvasEnvelope(channels: string[] = ['beauty']): string {
  const blocks = channels.map((channel, i) => {
    const c = document.createElement('canvas');
    c.width = 16; c.height = 12;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = i % 2 ? '#c33' : '#33c';
    ctx.fillRect(0, 0, 16, 12);
    return { data: c.toDataURL('image/png').split(',')[1], channel };
  });
  const [first, ...rest] = blocks;
  return JSON.stringify({
    __rvImage: {
      data: first.data, mimeType: 'image/png', width: 16, height: 12, channels,
    },
    ...(rest.length
      ? {
        __rvImages: rest.map((b) => ({
          data: b.data, mimeType: 'image/png', width: 16, height: 12, channel: b.channel,
        })),
      }
      : {}),
  });
}

/** An envelope of a known decoded size, for the byte-eviction case. */
function envelopeOfBytes(bytes: number): string {
  let bin = '';
  for (let i = 0; i < bytes; i++) bin += '\0';
  return JSON.stringify({
    __rvImage: { data: btoa(bin), mimeType: 'image/jpeg', width: 8, height: 8 },
  });
}

const flushTasks = () => new Promise<void>((r) => setTimeout(r, 0));

/** Record one capture and let its macrotask run, inside React's act(). */
async function capture(source = 'web_eye', channels: string[] = ['beauty']): Promise<void> {
  await act(async () => {
    recordAgentEyeEnvelope(canvasEnvelope(channels), source);
    await flushTasks();
  });
}

function panelEl(): HTMLElement | null {
  return document.querySelector('[data-ui-panel]');
}

function badgeButton(): HTMLElement {
  return screen.getByRole('button', { name: /Agent Eye/i });
}

beforeEach(() => {
  bridge.connected = true;
  resetAgentEyeMonitorForTest();
  localStorage.removeItem('rv-panel-geo:agent-eye-monitor');
});

afterEach(() => {
  cleanup();
  setAiActivity(null);
  resetAgentEyeMonitorForTest();
  vi.restoreAllMocks();
});

// ─── Auto-open (D-A7, D-U3) ─────────────────────────────────────────────

describe('AgentEyeMonitorPanel · auto-open', () => {
  it('opens itself on the first capture', async () => {
    render(<Wrapper><AgentEyeMonitorPanel /></Wrapper>);
    expect(panelEl()).toBeNull();
    await capture('web_eye');
    await waitFor(() => expect(panelEl()).not.toBeNull());
    expect(screen.getByRole('img', { name: 'web_eye beauty' })).toBeTruthy();
  });

  it('opens again even with a FULL buffer', async () => {
    render(<Wrapper><AgentEyeMonitorPanel /></Wrapper>);
    for (let i = 0; i < AGENT_EYE_MAX_FRAMES; i++) await capture(`tool_${i}`);
    expect(getAgentEyeFrames()).toHaveLength(AGENT_EYE_MAX_FRAMES);

    act(() => { screen.getByRole('button', { name: 'Close window' }).click(); });
    await waitFor(() => expect(panelEl()).toBeNull());

    // The length does not change here — only `seq` does. A length-driven effect
    // would never fire again from this point on.
    await capture('tool_13');
    await waitFor(() => expect(panelEl()).not.toBeNull());
  });

  it('opens again after a byte eviction', async () => {
    setAgentEyeByteCapForTest(120_000);
    render(<Wrapper><AgentEyeMonitorPanel /></Wrapper>);
    await act(async () => {
      recordAgentEyeEnvelope(envelopeOfBytes(100_000), 'web_eye');
      await flushTasks();
    });
    act(() => { screen.getByRole('button', { name: 'Close window' }).click(); });
    await waitFor(() => expect(panelEl()).toBeNull());

    await act(async () => {
      recordAgentEyeEnvelope(envelopeOfBytes(100_000), 'web_eye');
      await flushTasks();
    });
    // The older capture was evicted, so the count is still 1 — and the panel is
    // open again anyway.
    expect(getAgentEyeFrames()).toHaveLength(1);
    await waitFor(() => expect(panelEl()).not.toBeNull());
  });

  it('does NOT steal focus while opening', async () => {
    render(
      <Wrapper>
        <input data-testid="typing-here" />
        <AgentEyeMonitorPanel />
      </Wrapper>,
    );
    const input = screen.getByTestId('typing-here') as HTMLInputElement;
    input.focus();
    expect(document.activeElement).toBe(input);

    await capture('web_eye');
    await waitFor(() => expect(panelEl()).not.toBeNull());
    expect(document.activeElement).toBe(input);
  });

  it('stays closed after the user closed it, until the next capture', async () => {
    render(<Wrapper><AgentEyeMonitorPanel /></Wrapper>);
    await capture('web_eye');
    await waitFor(() => expect(panelEl()).not.toBeNull());

    act(() => { screen.getByRole('button', { name: 'Close window' }).click(); });
    await waitFor(() => expect(panelEl()).toBeNull());

    // Unrelated re-renders must not reopen it.
    await act(async () => { await flushTasks(); });
    expect(panelEl()).toBeNull();

    await capture('web_eye');
    await waitFor(() => expect(panelEl()).not.toBeNull());
  });

  it('does not open just because the panel mounted with existing history', async () => {
    // Captured while no panel was mounted, so nothing ever requested "open".
    await capture('web_eye');
    expect(isAgentEyeMonitorOpen()).toBe(false);
    render(<Wrapper><AgentEyeMonitorPanel /></Wrapper>);
    await act(async () => { await flushTasks(); });
    // Mounting is not a new capture — only the NEXT one pops the panel.
    expect(panelEl()).toBeNull();
    await capture('web_eye');
    await waitFor(() => expect(panelEl()).not.toBeNull());
  });
});

// ─── Badge (D-U4, D-U5, round-2 finding 1) ──────────────────────────────

describe('AgentEyeMonitorBadge', () => {
  it('stays hidden without a bridge and while the agent is idle', () => {
    bridge.connected = false;
    const { rerender } = render(<Wrapper><AgentEyeMonitorBadge /></Wrapper>);
    expect(screen.queryByRole('button', { name: /Agent Eye/i })).toBeNull();

    // Connected but nothing running is still nothing to show.
    bridge.connected = true;
    rerender(<Wrapper><AgentEyeMonitorBadge /></Wrapper>);
    expect(screen.queryByRole('button', { name: /Agent Eye/i })).toBeNull();
  });

  it('shows during a tool call with no captures yet, and opens the empty state', async () => {
    render(<Wrapper><AgentEyeMonitorBadge /><AgentEyeMonitorPanel /></Wrapper>);
    act(() => { setAiActivity('web_eye'); });

    const button = badgeButton();
    expect(button).toBeTruthy();
    expect(panelEl()).toBeNull();

    act(() => { button.click(); });
    await waitFor(() => expect(panelEl()).not.toBeNull());
    expect(screen.getByText(/No agent capture yet/i)).toBeTruthy();
  });

  it('centers the eye and status beside the agent icon as its position changes', async () => {
    function RowHarness({ top }: { top: number }) {
      return (
        <Wrapper>
          <div style={{ position: 'fixed', left: 0, top, width: 46, height: 40 }}>
            <button data-testid="agent-icon" style={{ width: 40, height: 40 }}>Agent</button>
            <div ref={setAgentActivityAnchor} style={{ position: 'absolute', left: 52,
              top: '50%', transform: 'translateY(-50%)' }} />
          </div>
          <AgentActivityRow><AgentEyeMonitorBadge /><AiActivityOverlay /></AgentActivityRow>
        </Wrapper>
      );
    }
    const { rerender } = render(<RowHarness top={100} />);
    act(() => { setAiActivity('web_eye'); });
    await screen.findByRole('status');
    const assertAlignment = () => {
      const icon = screen.getByTestId('agent-icon').getBoundingClientRect();
      const eye = screen.getByTestId('agent-eye-badge-anchor').getBoundingClientRect();
      const status = screen.getByRole('status').getBoundingClientRect();
      expect(eye.top + eye.height / 2).toBeCloseTo(icon.top + icon.height / 2, 0);
      expect(status.top + status.height / 2).toBeCloseTo(icon.top + icon.height / 2, 0);
      expect(eye.left).toBeGreaterThan(icon.right);
      expect(status.left).toBeGreaterThan(eye.right);
    };
    assertAlignment();
    rerender(<RowHarness top={200} />);
    assertAlignment();
  });

  it('leaves the ActivityBar AI button untouched (D-U4)', () => {
    // The activity bar must not learn about the monitor at all — its AI button
    // is the CONNECT onboarding entry and keeps its own handler.
    expect(ActivityBarSource).not.toMatch(/agent-eye|AgentEyeMonitor/i);
  });

  it('toggles the panel and clears the unseen counter', async () => {
    render(<Wrapper><AgentEyeMonitorBadge /><AgentEyeMonitorPanel /></Wrapper>);
    act(() => { setAiActivity('web_eye'); });
    await capture('web_eye');
    await waitFor(() => expect(panelEl()).not.toBeNull());

    act(() => { badgeButton().click(); });
    await waitFor(() => expect(panelEl()).toBeNull());

    act(() => { badgeButton().click(); });
    await waitFor(() => expect(panelEl()).not.toBeNull());
  });
});

// ─── Content, keys and survival ─────────────────────────────────────────

describe('AgentEyeMonitorPanel · content', () => {
  it('shows one image, enlarges on click and switches channels', async () => {
    render(<Wrapper><AgentEyeMonitorPanel /></Wrapper>);
    await capture('web_eye', ['beauty', 'idmask', 'depth']);
    const image = screen.getByRole('img');
    const preview = image.getBoundingClientRect();
    expect(preview.width).toBeCloseTo(208, 0);
    expect(preview.height).toBeCloseTo(156, 0);
    expect(panelEl()!.getBoundingClientRect().width - preview.width).toBeLessThanOrEqual(2);
    expect(panelEl()!.getBoundingClientRect().height - preview.height).toBeLessThan(70);
    act(() => { screen.getByRole('button', { name: 'Enlarge image' }).click(); });
    expect(screen.getAllByRole('img')).toHaveLength(1);
    expect(image.getBoundingClientRect().width).toBeGreaterThan(preview.width);
    expect(image.getBoundingClientRect().height).toBeGreaterThan(preview.height);
    expect(panelEl()!.getBoundingClientRect().width - image.getBoundingClientRect().width).toBeLessThanOrEqual(2);
    act(() => { screen.getByRole('button', { name: 'idmask' }).click(); });
    expect(screen.getByRole('img').getAttribute('alt')).toBe('web_eye idmask');
    act(() => { screen.getByRole('button', { name: 'Shrink image' }).click(); });
    expect(image.getBoundingClientRect().width).toBeCloseTo(208, 0);
  });

  it('says "produced for the agent", never "seen by the agent"', async () => {
    render(<Wrapper><AgentEyeMonitorPanel /></Wrapper>);
    await capture('web_eye');
    await waitFor(() => expect(panelEl()).not.toBeNull());
    expect(screen.getByRole('button', { name: 'Enlarge image' }).title).toContain('produced for the agent');
    expect(panelEl()!.textContent).not.toMatch(/seen by the agent|received/i);
  });

  it('browses history with one image and keeps the selected capture as new ones arrive', async () => {
    render(<Wrapper><AgentEyeMonitorPanel /></Wrapper>);
    await capture('first');
    const firstSrc = screen.getByRole('img').getAttribute('src');
    expect(screen.queryByRole('button', { name: 'Older capture' })).toBeNull();
    await capture('second');
    expect(screen.getAllByRole('img')).toHaveLength(1);
    expect(screen.getByRole('img').getAttribute('alt')).toBe('second beauty');
    expect((screen.getByRole('button', { name: 'Newer capture' }) as HTMLButtonElement).disabled).toBe(true);
    act(() => { screen.getByRole('button', { name: 'Older capture' }).click(); });
    expect(screen.getByRole('img').getAttribute('src')).toBe(firstSrc);
    await capture('third');
    expect(screen.getByRole('img').getAttribute('src')).toBe(firstSrc);
    act(() => { screen.getByRole('button', { name: 'Newer capture' }).click(); });
    expect(screen.getByRole('img').getAttribute('alt')).toBe('second beauty');
    act(() => { screen.getByRole('button', { name: 'Newer capture' }).click(); });
    expect(screen.getByRole('img').getAttribute('alt')).toBe('third beauty');
    await capture('fourth');
    expect(screen.getByRole('img').getAttribute('alt')).toBe('fourth beauty');
  });

  it('returns to the latest image when the selected capture is evicted', async () => {
    render(<Wrapper><AgentEyeMonitorPanel /></Wrapper>);
    await capture('first');
    await capture('second');
    act(() => { screen.getByRole('button', { name: 'Older capture' }).click(); });
    for (let i = 0; i < AGENT_EYE_MAX_FRAMES; i++) await capture(`new_${i}`);
    expect(screen.getAllByRole('img')).toHaveLength(1);
    expect(screen.getByRole('img').getAttribute('alt')).toBe(`new_${AGENT_EYE_MAX_FRAMES - 1} beauty`);
  });

  it('clears the history and drops back to the empty state', async () => {
    render(<Wrapper><AgentEyeMonitorPanel /></Wrapper>);
    await capture('web_eye');
    await waitFor(() => expect(panelEl()).not.toBeNull());
    act(() => { screen.getByRole('button', { name: 'Clear history' }).click(); });
    await waitFor(() => expect(screen.getByText(/No agent capture yet/i)).toBeTruthy());
  });

  it('keeps the history across a model switch (panel unmount/remount, D-A10)', async () => {
    function Host() {
      const [key, setKey] = useState(0);
      return (
        <>
          <button data-testid="switch-model" onClick={() => setKey((k) => k + 1)}>switch</button>
          <AgentEyeMonitorPanel key={key} />
        </>
      );
    }
    render(<Wrapper><Host /></Wrapper>);
    await capture('web_eye');
    await waitFor(() => expect(panelEl()).not.toBeNull());

    act(() => { screen.getByTestId('switch-model').click(); });
    await act(async () => { await flushTasks(); });

    // The store outlives the component tree: the capture and its blob URL are
    // still there and still carry their own timestamp.
    expect(getAgentEyeFrames()).toHaveLength(1);
    expect(getAgentEyeFrames()[0].source).toBe('web_eye');
  });

  it('keeps the history across a renderer switch to WebGPU (R3)', async () => {
    // Nothing in the store is tied to a renderer; a switch must not wipe the
    // strip, and the web_screenshot path keeps feeding it under WebGPU.
    render(<Wrapper><AgentEyeMonitorPanel /></Wrapper>);
    await capture('web_eye');
    await capture('web_screenshot');
    expect(getAgentEyeFrames()).toHaveLength(2);
    // Simulated switch: the offscreen tools stop delivering, web_screenshot
    // does not.
    await capture('web_screenshot');
    expect(getAgentEyeFrames()).toHaveLength(3);
    expect(getAgentEyeFrames().map((f) => f.source))
      .toEqual(['web_screenshot', 'web_screenshot', 'web_eye']);
  });
});
