// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/** plan-520 §9.5 — Settings > AI Bridge > "Follow agent" persistence. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getAiClicks,
  setAiClicks,
  _resetAiClicksForTest,
} from '../src/core/hmi/ai-click-choreography-store';
import { ALL_RV_STORAGE_KEYS, MCP_AI_CLICKS_KEY } from '../src/core/hmi/rv-storage-keys';

describe('ai-click-choreography-store', () => {
  beforeEach(() => {
    localStorage.removeItem(MCP_AI_CLICKS_KEY);
    _resetAiClicksForTest();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.removeItem(MCP_AI_CLICKS_KEY);
    _resetAiClicksForTest();
  });

  it('defaults to on', () => {
    expect(getAiClicks()).toBe(true);
  });

  it('persists the choice under rv-mcp-ai-clicks', () => {
    expect(MCP_AI_CLICKS_KEY).toBe('rv-mcp-ai-clicks');
    setAiClicks(false);
    expect(localStorage.getItem('rv-mcp-ai-clicks')).toBe('0');
    expect(getAiClicks()).toBe(false);
    setAiClicks(true);
    expect(localStorage.getItem('rv-mcp-ai-clicks')).toBe('1');
    expect(getAiClicks()).toBe(true);
  });

  it('keeps the choice for the session when storage throws, without crashing', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    expect(getAiClicks()).toBe(true);
    expect(() => setAiClicks(false)).not.toThrow();
    expect(getAiClicks()).toBe(false);
  });

  it('is listed in ALL_RV_STORAGE_KEYS (reset clears it)', () => {
    expect((ALL_RV_STORAGE_KEYS as readonly string[]).includes('rv-mcp-ai-clicks')).toBe(true);
  });
});


it('notifies React subscribers on preference changes', async () => {
  const { renderHook, act, cleanup } = await import('@testing-library/react');
  const { useAiClicks } = await import('../src/core/hmi/ai-click-choreography-store');
  setAiClicks(true);
  const { result } = renderHook(() => useAiClicks());
  try {
    expect(result.current).toBe(true);
    act(() => setAiClicks(false));
    expect(result.current).toBe(false);
  } finally { cleanup(); setAiClicks(true); }
});
