// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/** Backend-neutral contract and test provider for CONNECT user-defined agents. */

export const AGENT_SCHEMA_V1 = 'rv-agent/v1' as const;

export const V1_AGENT_TOOLS = [
  'signal_list',
  'signal_read',
  'interfaces_status',
  'health',
  'signal_docs',
  'historian_query_aggregated',
  'rag_search',
] as const;

export type AgentToolName = typeof V1_AGENT_TOOLS[number];
export type AgentPermissionTier = 'read-only' | 'actuating';
export type AgentOutputFormat = 'report' | 'chat' | 'json';
export type AgentClass = 'report' | 'authoring';
export type AgentRunStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'limit_reached'
  | 'interrupted';

export interface AgentDefinition {
  schema: typeof AGENT_SCHEMA_V1;
  name: string;
  displayName: string;
  description: string;
  instructions: string;
  tools: string[];
  permissionTier: AgentPermissionTier;
  trigger: { type: 'manual'; cron?: string; tz?: string };
  outputFormat: AgentOutputFormat;
  maxTurns: number;
  maxBudget: { tokens: number };
  enabled: boolean;
  agentClass: AgentClass;
}

export interface AgentBackendSnapshot {
  backendId: string;
  transport: string;
  modelProvider: string;
  model: string;
  region: string;
}

export interface AgentBackendVerificationStatus {
  status: 'unverified' | 'verified' | 'failed';
  verifiedAt?: string;
  expiresAt?: string;
  error?: string;
}

export interface AgentBackendStatusItem extends AgentBackendSnapshot {
  toolCalling: boolean;
  readiness: string;
  configSource: string;
  verification: AgentBackendVerificationStatus;
}

export interface AgentClassBackendStatus {
  agentClass: AgentClass;
  backend?: AgentBackendSnapshot;
  error?: string;
}

export interface AgentBackendsStatus {
  degraded: boolean;
  errors: string[];
  backends: AgentBackendStatusItem[];
  classes: AgentClassBackendStatus[];
}

export interface AgentRunTrace {
  turn: number;
  tool: string;
  args: Record<string, unknown>;
  resultChars: number;
}

/** A source ID is server-issued. Free-form report text cannot create one. */
export interface AgentReportSource {
  id: string;
  title?: string;
  /** Optional server-resolved URL; the renderer still accepts http/https only. */
  url?: string;
}

export interface AgentRunResult {
  markdown: string;
  charts: unknown[];
  sources: AgentReportSource[];
}

export interface AgentRunRecord {
  runId: string;
  agent: string;
  idempotencyKey: string;
  status: AgentRunStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  trace: AgentRunTrace[];
  result?: AgentRunResult;
  error?: string;
  totalTokens: number;
  usageEstimated: boolean;
  backend?: AgentBackendSnapshot;
}

export interface AgentRequestOptions {
  signal?: AbortSignal;
}

export interface RunAgentOptions extends AgentRequestOptions {
  idempotencyKey?: string;
}

export interface AgentProvider {
  getBackendStatus(options?: AgentRequestOptions): Promise<AgentBackendsStatus>;
  listAgents(options?: AgentRequestOptions): Promise<AgentDefinition[]>;
  getAgent(name: string, options?: AgentRequestOptions): Promise<AgentDefinition | null>;
  saveAgent(definition: AgentDefinition, options?: AgentRequestOptions): Promise<AgentDefinition>;
  deleteAgent(name: string, options?: AgentRequestOptions): Promise<boolean>;
  runAgent(name: string, options?: RunAgentOptions): Promise<AgentRunRecord>;
  getRun(runId: string, options?: AgentRequestOptions): Promise<AgentRunRecord | null>;
  cancelRun(runId: string, options?: AgentRequestOptions): Promise<AgentRunRecord | null>;
  approveRun(runId: string, options?: AgentRequestOptions): Promise<AgentRunRecord | null>;
  rejectRun(runId: string, options?: AgentRequestOptions): Promise<AgentRunRecord | null>;
  listRuns(agent?: string, options?: AgentRequestOptions): Promise<AgentRunRecord[]>;
}

export function createDefaultAgentDefinition(name = 'new-agent'): AgentDefinition {
  return {
    schema: AGENT_SCHEMA_V1,
    name,
    displayName: 'New agent',
    description: '',
    instructions: '',
    tools: ['signal_list', 'signal_read'],
    permissionTier: 'read-only',
    trigger: { type: 'manual' },
    outputFormat: 'report',
    maxTurns: 8,
    maxBudget: { tokens: 200_000 },
    enabled: true,
    agentClass: 'report',
  };
}

export function isTerminalAgentRunStatus(status: AgentRunStatus): boolean {
  return status === 'done'
    || status === 'failed'
    || status === 'cancelled'
    || status === 'limit_reached'
    || status === 'interrupted';
}

/** In-memory provider with deterministic queued -> running -> done polling. */
export class FakeAgentProvider implements AgentProvider {
  private readonly agents = new Map<string, AgentDefinition>();
  private readonly runs = new Map<string, AgentRunRecord>();
  private readonly polls = new Map<string, number>();
  private nextRun = 1;

  constructor(initialAgents: AgentDefinition[] = []) {
    for (const definition of initialAgents) this.agents.set(definition.name, cloneDefinition(definition));
  }

  async getBackendStatus(): Promise<AgentBackendsStatus> {
    const backend: AgentBackendStatusItem = {
      backendId: 'fake-local',
      transport: 'requesty-eu-router',
      modelProvider: 'azure',
      model: 'fake/tool-capable',
      region: 'eu-test',
      toolCalling: true,
      readiness: 'ready',
      configSource: 'fake',
      verification: { status: 'verified' },
    };
    return {
      degraded: false,
      errors: [],
      backends: [backend],
      classes: [
        { agentClass: 'report', backend },
        { agentClass: 'authoring', error: 'agent_class_not_mapped' },
      ],
    };
  }

  async listAgents(): Promise<AgentDefinition[]> {
    return [...this.agents.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(cloneDefinition);
  }

  async getAgent(name: string): Promise<AgentDefinition | null> {
    const definition = this.agents.get(name);
    return definition ? cloneDefinition(definition) : null;
  }

  async saveAgent(definition: AgentDefinition): Promise<AgentDefinition> {
    const saved = cloneDefinition(definition);
    this.agents.set(saved.name, saved);
    return cloneDefinition(saved);
  }

  async deleteAgent(name: string): Promise<boolean> {
    return this.agents.delete(name);
  }

  async runAgent(name: string, options?: RunAgentOptions): Promise<AgentRunRecord> {
    const definition = this.agents.get(name);
    if (!definition) throw new Error(`Agent not found: ${name}`);
    if (!definition.enabled) throw new Error(`Agent is disabled: ${name}`);
    const runId = `fake-${String(this.nextRun++).padStart(4, '0')}`;
    const record: AgentRunRecord = {
      runId,
      agent: name,
      idempotencyKey: options?.idempotencyKey ?? runId,
      status: 'queued',
      createdAt: new Date().toISOString(),
      trace: [],
      totalTokens: 0,
      usageEstimated: false,
      backend: (await this.getBackendStatus()).classes.find(item => item.agentClass === definition.agentClass)?.backend,
    };
    this.runs.set(runId, record);
    this.polls.set(runId, 0);
    return cloneRun(record);
  }

  async getRun(runId: string): Promise<AgentRunRecord | null> {
    const current = this.runs.get(runId);
    if (!current) return null;
    const polls = (this.polls.get(runId) ?? 0) + 1;
    this.polls.set(runId, polls);
    if (current.status === 'queued') {
      current.status = 'running';
      current.startedAt = new Date().toISOString();
    } else if (current.status === 'running') {
      current.status = 'done';
      current.finishedAt = new Date().toISOString();
      current.result = {
        markdown: `# ${this.agents.get(current.agent)?.displayName ?? current.agent}\n\nFake agent run completed.`,
        charts: [],
        sources: [],
      };
    }
    return cloneRun(current);
  }

  async cancelRun(runId: string): Promise<AgentRunRecord | null> {
    const run = this.runs.get(runId);
    if (!run) return null;
    if (!isTerminalAgentRunStatus(run.status)) {
      run.status = 'cancelled';
      run.finishedAt = new Date().toISOString();
    }
    return cloneRun(run);
  }

  async approveRun(runId: string): Promise<AgentRunRecord | null> {
    const run = this.runs.get(runId);
    if (!run) return null;
    if (run.status === 'waiting_approval') run.status = 'running';
    return cloneRun(run);
  }

  async rejectRun(runId: string): Promise<AgentRunRecord | null> {
    return this.cancelRun(runId);
  }

  async listRuns(agent?: string): Promise<AgentRunRecord[]> {
    return [...this.runs.values()]
      .filter((run) => !agent || run.agent === agent)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(cloneRun);
  }
}

function cloneDefinition(value: AgentDefinition): AgentDefinition {
  return {
    ...value,
    tools: [...value.tools],
    trigger: { ...value.trigger },
    maxBudget: { ...value.maxBudget },
  };
}

function cloneRun(value: AgentRunRecord): AgentRunRecord {
  return {
    ...value,
    backend: value.backend ? { ...value.backend } : undefined,
    trace: value.trace.map((entry) => ({ ...entry, args: { ...entry.args } })),
    result: value.result ? {
      markdown: value.result.markdown,
      charts: [...value.result.charts],
      sources: value.result.sources.map((source) => ({ ...source })),
    } : undefined,
  };
}
