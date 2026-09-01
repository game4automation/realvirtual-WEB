// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it, vi } from 'vitest';
import type { AgentRunRecord } from '../../realvirtual-WebViewer-Private~/src/plugins/agents/agent-provider';
import { FakeAgentProvider } from '../../realvirtual-WebViewer-Private~/src/plugins/agents/agent-provider';
import { pollAgentRun } from '../../realvirtual-WebViewer-Private~/src/plugins/agents/agent-store';

function run(status: AgentRunRecord['status']): AgentRunRecord {
  return {
    runId: 'run', agent: 'agent', idempotencyKey: 'key', status,
    createdAt: '2026-07-21T00:00:00Z', trace: [], totalTokens: 0, usageEstimated: false,
  };
}

describe('agent run polling', () => {
  it('reports transitions and stops at limit_reached', async () => {
    const provider = new FakeAgentProvider();
    provider.getRun = vi.fn()
      .mockResolvedValueOnce(run('queued'))
      .mockResolvedValueOnce(run('running'))
      .mockResolvedValueOnce(run('waiting_approval'))
      .mockResolvedValueOnce(run('limit_reached'));
    const updates: string[] = [];
    const delay = vi.fn(async () => undefined);
    const result = await pollAgentRun(provider, 'run', { delay, onUpdate: (value) => updates.push(value.status) });
    expect(result.status).toBe('limit_reached');
    expect(updates).toEqual(['queued', 'running', 'waiting_approval', 'limit_reached']);
    expect(delay).toHaveBeenCalledTimes(3);
    expect(provider.getRun).toHaveBeenCalledTimes(4);
  });

  it.each(['done', 'failed', 'cancelled', 'limit_reached', 'interrupted'] as const)(
    'does not poll after terminal status %s',
    async (status) => {
      const provider = new FakeAgentProvider();
      provider.getRun = vi.fn().mockResolvedValue(run(status));
      const delay = vi.fn(async () => undefined);
      await pollAgentRun(provider, 'run', { delay });
      expect(provider.getRun).toHaveBeenCalledTimes(1);
      expect(delay).not.toHaveBeenCalled();
    },
  );
});
