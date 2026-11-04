// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/** plan-520 §9.5 — Settings > AI Bridge > "Follow agent" persistence. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getFollowAgent,
  setFollowAgent,
  _resetFollowAgentForTest,
} from '../src/core/hmi/follow-agent-store';
import { ALL_RV_STORAGE_KEYS, MCP_FOLLOW_AGENT_KEY } from '../src/core/hmi/rv-storage-keys';

describe('follow-agent-store', () => {
  beforeEach(() => {
    localStorage.removeItem(MCP_FOLLOW_AGENT_KEY);
    _resetFollowAgentForTest();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.removeItem(MCP_FOLLOW_AGENT_KEY);
    _resetFollowAgentForTest();
  });

  it('defaults to on', () => {
    expect(getFollowAgent()).toBe(true);
  });

  it('persists the choice under rv-mcp-follow-agent', () => {
    expect(MCP_FOLLOW_AGENT_KEY).toBe('rv-mcp-follow-agent');
    setFollowAgent(false);
    expect(localStorage.getItem('rv-mcp-follow-agent')).toBe('0');
    expect(getFollowAgent()).toBe(false);
    setFollowAgent(true);
    expect(localStorage.getItem('rv-mcp-follow-agent')).toBe('1');
    expect(getFollowAgent()).toBe(true);
  });

  it('keeps the choice for the session when storage throws, without crashing', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    expect(getFollowAgent()).toBe(true);
    expect(() => setFollowAgent(false)).not.toThrow();
    expect(getFollowAgent()).toBe(false);
  });

  it('keeps the session choice when only the write fails', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    setFollowAgent(false);
    expect(getFollowAgent()).toBe(false);
    expect(localStorage.getItem(MCP_FOLLOW_AGENT_KEY)).toBeNull();
  });

  it('is listed in ALL_RV_STORAGE_KEYS (reset clears it)', () => {
    expect((ALL_RV_STORAGE_KEYS as readonly string[]).includes('rv-mcp-follow-agent')).toBe(true);
  });
});
