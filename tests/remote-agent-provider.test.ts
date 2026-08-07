// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
  parseBackendStatus,
  parseDefinition,
  parseRun,
} from '../../realvirtual-WebViewer-Private~/src/plugins/agents/remote-agent-provider';

const snapshot = {
  backendId: 'cloud-eu-france',
  transport: 'requesty-eu-router',
  modelProvider: 'azure',
  model: 'azure/gpt-5.4@francecentral',
  region: 'eu-france',
};

describe('remote agent provider parsers', () => {
  it('defaults legacy definitions to report and accepts reserved authoring', () => {
    const base = {
      schema: 'rv-agent/v1',
      name: 'report-agent',
      displayName: 'Report',
      description: '',
      instructions: 'Analyze.',
      tools: ['signal_read'],
      permissionTier: 'read-only',
      trigger: { type: 'manual' },
      outputFormat: 'report',
      maxTurns: 4,
      maxBudget: { tokens: 10000 },
      enabled: true,
    };

    expect(parseDefinition(base).agentClass).toBe('report');
    expect(parseDefinition({ ...base, agentClass: 'authoring' }).agentClass).toBe('authoring');
  });

  it('parses immutable run snapshots and backend status', () => {
    const run = parseRun({
      runId: 'run-1', agent: 'report-agent', idempotencyKey: 'key', status: 'done',
      createdAt: '2026-07-21T00:00:00Z', trace: [], totalTokens: 10, usageEstimated: false,
      backend: snapshot,
    });
    expect(run.backend).toEqual(snapshot);

    const status = parseBackendStatus({
      degraded: false,
      errors: [],
      backends: [{ ...snapshot, toolCalling: true, readiness: 'ready', configSource: 'builtin', verification: { status: 'unverified' } }],
      classes: [
        { agentClass: 'report', backend: snapshot },
        { agentClass: 'authoring', backend: null, error: 'agent_class_not_mapped' },
      ],
    });
    expect(status.backends[0]?.verification.status).toBe('unverified');
    expect(status.classes[1]?.error).toBe('agent_class_not_mapped');
  });
});
