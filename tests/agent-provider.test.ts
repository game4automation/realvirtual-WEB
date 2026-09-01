// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { createDefaultAgentDefinition, FakeAgentProvider } from '../../realvirtual-WebViewer-Private~/src/plugins/agents/agent-provider';
import { pollAgentRun } from '../../realvirtual-WebViewer-Private~/src/plugins/agents/agent-store';

describe('FakeAgentProvider contract', () => {
  it('supports CRUD, run, and terminal polling', async () => {
    const provider = new FakeAgentProvider();
    const definition = createDefaultAgentDefinition('oee-report');
    definition.displayName = 'OEE report';
    definition.instructions = 'Analyze the line.';

    await provider.saveAgent(definition);
    expect((await provider.getBackendStatus()).classes[0]?.backend?.backendId).toBe('fake-local');
    expect(await provider.listAgents()).toHaveLength(1);
    expect((await provider.getAgent('oee-report'))?.displayName).toBe('OEE report');

    const started = await provider.runAgent('oee-report', { idempotencyKey: 'test-run' });
    expect(started.status).toBe('queued');
    expect(started.backend?.backendId).toBe('fake-local');
    const completed = await pollAgentRun(provider, started.runId, {
      intervalMs: 0,
      delay: async () => undefined,
    });
    expect(completed.status).toBe('done');
    expect(completed.result?.markdown).toContain('OEE report');
    expect(await provider.listRuns('oee-report')).toHaveLength(1);

    expect(await provider.deleteAgent('oee-report')).toBe(true);
    expect(await provider.getAgent('oee-report')).toBeNull();
  });
});
