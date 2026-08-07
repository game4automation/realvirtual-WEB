// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/** Floating definition manager for the code-free rv-agent/v1 schema. */

import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  FormControlLabel,
  FormGroup,
  IconButton,
  InputLabel,
  Menu,
  MenuItem,
  Select,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { Add, ContentCopy, Delete, Edit, MoreVert, PlayArrow, PowerSettingsNew } from '@mui/icons-material';
import { FloatingPanel } from '../../core/hmi/FloatingPanel';
import type { AgentBackendsStatus, AgentDefinition, AgentProvider } from './agent-provider';
import { AGENT_SCHEMA_V1, createDefaultAgentDefinition, V1_AGENT_TOOLS } from './agent-provider';

const TOOL_LABELS: Record<string, string> = {
  signal_list: 'List live signals',
  signal_read: 'Read live signals',
  interfaces_status: 'Read interface status',
  health: 'Read gateway health',
  signal_docs: 'Read signal documentation',
  historian_query_aggregated: 'Query aggregated history',
  rag_search: 'Search machine documentation',
};

export interface AgentManagerPanelProps {
  open: boolean;
  onClose: () => void;
  provider: AgentProvider;
  onRunStarted: (runId: string) => void;
}

export function AgentManagerPanel({ open, onClose, provider, onRunStarted }: AgentManagerPanelProps) {
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [backendStatus, setBackendStatus] = useState<AgentBackendsStatus | null>(null);
  const [draft, setDraft] = useState<AgentDefinition | null>(null);
  const [originalName, setOriginalName] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ anchor: HTMLElement; agent: AgentDefinition } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AgentDefinition | null>(null);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextAgents, nextBackendStatus] = await Promise.all([
        provider.listAgents(),
        provider.getBackendStatus(),
      ]);
      setAgents(nextAgents);
      setBackendStatus(nextBackendStatus);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) void refresh();
  }, [open, provider]);

  const validationError = useMemo(() => draft ? validateDraft(draft) : null, [draft]);

  const startRun = async (agent: AgentDefinition) => {
    setRunning(agent.name);
    setError(null);
    try {
      const run = await provider.runAgent(agent.name);
      onRunStarted(run.runId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRunning(null);
    }
  };

  const save = async () => {
    if (!draft || validationError) return;
    setSaving(true);
    setError(null);
    try {
      await provider.saveAgent(draft);
      if (originalName && originalName !== draft.name) await provider.deleteAgent(originalName);
      setDraft(null);
      setOriginalName(null);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = async (agent: AgentDefinition) => {
    setMenu(null);
    setError(null);
    try {
      await provider.saveAgent({ ...agent, enabled: !agent.enabled });
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const remove = async () => {
    if (!deleteTarget) return;
    setError(null);
    try {
      await provider.deleteAgent(deleteTarget.name);
      if (draft?.name === deleteTarget.name) setDraft(null);
      setDeleteTarget(null);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const newAgent = () => {
    const definition = createDefaultAgentDefinition(uniqueSlug('new-agent', agents));
    setDraft(definition);
    setOriginalName(null);
  };

  const edit = (agent: AgentDefinition) => {
    setMenu(null);
    setDraft(cloneAgent(agent));
    setOriginalName(agent.name);
  };

  const duplicate = (agent: AgentDefinition) => {
    setMenu(null);
    const name = uniqueSlug(`${agent.name}-copy`, agents);
    setDraft({ ...cloneAgent(agent), name, displayName: `${agent.displayName} copy`, enabled: false });
    setOriginalName(null);
  };

  return (
    <>
      <FloatingPanel
        open={open}
        onClose={onClose}
        title="Agents"
        panelId="agents-manager"
        defaultWidth={720}
        defaultHeight={620}
        minWidth={480}
      >
        <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1.5, py: 1 }}>
            <Button size="small" variant="contained" startIcon={<Add />} onClick={newAgent} sx={{ textTransform: 'none' }}>
              New agent
            </Button>
            <Typography sx={{ ml: 'auto', fontSize: 11, color: 'text.secondary', fontFamily: 'monospace' }}>
              {loading ? 'Loading…' : `${agents.length} agents`}
            </Typography>
          </Box>
          {error && <Alert severity="error" sx={{ mx: 1.5, mb: 1 }}>{error}</Alert>}
          <Divider />
          <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto', p: 1.5 }}>
            {!draft ? (
              <AgentList
                agents={agents}
                backendStatus={backendStatus}
                running={running}
                onRun={(agent) => void startRun(agent)}
                onMenu={(anchor, agent) => setMenu({ anchor, agent })}
              />
            ) : (
              <AgentEditor draft={draft} onChange={setDraft} validationError={validationError} backendStatus={backendStatus} />
            )}
          </Box>
          {draft && (
            <>
              <Divider />
              <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, px: 1.5, py: 1 }}>
                <Button size="small" onClick={() => { setDraft(null); setOriginalName(null); }} sx={{ textTransform: 'none' }}>Cancel</Button>
                <Button size="small" variant="contained" disabled={!!validationError || saving} onClick={() => void save()} sx={{ textTransform: 'none' }}>
                  {saving ? 'Saving…' : 'Save agent'}
                </Button>
              </Box>
            </>
          )}
        </Box>
      </FloatingPanel>

      <Menu anchorEl={menu?.anchor ?? null} open={!!menu} onClose={() => setMenu(null)}>
        {menu && [
          <MenuItem key="edit" sx={{ fontSize: 12, gap: 1 }} onClick={() => edit(menu.agent)}><Edit sx={{ fontSize: 14 }} /> Edit…</MenuItem>,
          <MenuItem key="duplicate" sx={{ fontSize: 12, gap: 1 }} onClick={() => duplicate(menu.agent)}><ContentCopy sx={{ fontSize: 14 }} /> Duplicate</MenuItem>,
          <MenuItem key="toggle" sx={{ fontSize: 12, gap: 1 }} onClick={() => void toggleEnabled(menu.agent)}>
            <PowerSettingsNew sx={{ fontSize: 14 }} /> {menu.agent.enabled ? 'Disable' : 'Enable'}
          </MenuItem>,
          <Divider key="divider" />,
          <MenuItem key="delete" sx={{ fontSize: 12, gap: 1, color: 'error.main' }} onClick={() => { setDeleteTarget(menu.agent); setMenu(null); }}>
            <Delete sx={{ fontSize: 14 }} /> Delete…
          </MenuItem>,
        ]}
      </Menu>

      <Dialog open={!!deleteTarget} onClose={() => setDeleteTarget(null)}>
        <DialogTitle>Delete agent?</DialogTitle>
        <DialogContent>
          <Typography sx={{ fontSize: 13 }}>
            “{deleteTarget?.displayName}” and its definition will be removed from CONNECT.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteTarget(null)}>Cancel</Button>
          <Button color="error" onClick={() => void remove()}>Delete</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

function AgentList({
  agents,
  backendStatus,
  running,
  onRun,
  onMenu,
}: {
  agents: AgentDefinition[];
  backendStatus: AgentBackendsStatus | null;
  running: string | null;
  onRun: (agent: AgentDefinition) => void;
  onMenu: (anchor: HTMLElement, agent: AgentDefinition) => void;
}) {
  if (agents.length === 0) {
    return (
      <Box sx={{ py: 5, textAlign: 'center' }}>
        <Typography sx={{ fontSize: 13, fontWeight: 600 }}>No agents yet</Typography>
        <Typography sx={{ fontSize: 12, color: 'text.secondary', mt: 0.5 }}>
          Create a code-free agent to analyze live signals, history, and machine documentation.
        </Typography>
      </Box>
    );
  }
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column' }}>
      {agents.map((agent) => (
        <Box
          key={agent.name}
          sx={{
            minHeight: 48,
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            px: 1,
            borderBottom: '1px solid rgba(255,255,255,0.08)',
          }}
        >
          <Box aria-hidden sx={{ width: 7, height: 7, borderRadius: '50%', bgcolor: agent.enabled ? 'success.main' : 'text.disabled', flexShrink: 0 }} />
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography noWrap sx={{ fontSize: 12, fontWeight: 600 }}>{agent.displayName}</Typography>
            <Typography noWrap sx={{ fontSize: 10, color: 'text.secondary', fontFamily: 'monospace' }}>
              {agent.name} · {agent.agentClass} · {resolvedBackendLabel(agent, backendStatus)} · {agent.tools.length} tools
            </Typography>
          </Box>
          <Button
            size="small"
            variant="outlined"
            startIcon={<PlayArrow sx={{ fontSize: 15 }} />}
            disabled={!agent.enabled || running === agent.name}
            onClick={() => onRun(agent)}
            sx={{ minWidth: 64, textTransform: 'none', fontSize: 11 }}
          >
            {running === agent.name ? 'Starting…' : 'Run'}
          </Button>
          <Tooltip title="Agent actions">
            <IconButton size="small" aria-label={`Actions for agent ${agent.displayName}`} onClick={(event) => onMenu(event.currentTarget, agent)} sx={{ p: 0.35, color: 'text.secondary' }}>
              <MoreVert sx={{ fontSize: 16 }} />
            </IconButton>
          </Tooltip>
        </Box>
      ))}
    </Box>
  );
}

function AgentEditor({
  draft,
  onChange,
  validationError,
  backendStatus,
}: {
  draft: AgentDefinition;
  onChange: (next: AgentDefinition) => void;
  validationError: string | null;
  backendStatus: AgentBackendsStatus | null;
}) {
  const set = <K extends keyof AgentDefinition>(key: K, value: AgentDefinition[K]) => onChange({ ...draft, [key]: value });
  const toggleTool = (tool: string, checked: boolean) => set(
    'tools',
    checked ? [...draft.tools, tool] : draft.tools.filter((candidate) => candidate !== tool),
  );
  return (
    <Box component="form" onSubmit={(event) => event.preventDefault()} sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
      <Typography sx={{ fontSize: 12, fontWeight: 600 }}>{draft.name ? 'Agent definition' : 'New agent'}</Typography>
      {validationError && <Alert severity="warning" variant="outlined" sx={{ py: 0 }}>{validationError}</Alert>}
      <Box sx={{ display: 'flex', gap: 1 }}>
        <TextField size="small" label="Schema" value={AGENT_SCHEMA_V1} disabled sx={{ width: 150 }} />
        <TextField
          size="small"
          label="Name"
          value={draft.name}
          onChange={(event) => set('name', event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
          inputProps={{ maxLength: 63, 'aria-describedby': 'agent-name-help' }}
          fullWidth
        />
      </Box>
      <Typography id="agent-name-help" sx={{ mt: -1, fontSize: 10, color: 'text.secondary' }}>Lowercase slug, 2–63 characters.</Typography>
      <TextField size="small" label="Display name" value={draft.displayName} inputProps={{ maxLength: 120 }} onChange={(event) => set('displayName', event.target.value)} fullWidth />
      <TextField size="small" label="Description" value={draft.description} inputProps={{ maxLength: 500 }} onChange={(event) => set('description', event.target.value)} fullWidth />
      <TextField
        size="small"
        label="Instructions"
        value={draft.instructions}
        onChange={(event) => set('instructions', event.target.value)}
        inputProps={{ maxLength: 16_000 }}
        minRows={5}
        multiline
        fullWidth
        helperText="The only free-form behavior field. Reports remain read-only and server-gated."
      />

      <Box component="fieldset" sx={{ m: 0, p: 1, border: '1px solid rgba(255,255,255,0.08)', borderRadius: '4px' }}>
        <Typography component="legend" sx={{ px: 0.5, fontSize: 11, fontWeight: 600, color: 'text.secondary' }}>Allowed server tools</Typography>
        <FormGroup sx={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', columnGap: 1 }}>
          {V1_AGENT_TOOLS.map((tool) => (
            <FormControlLabel
              key={tool}
              control={<Checkbox size="small" checked={draft.tools.includes(tool)} onChange={(event) => toggleTool(tool, event.target.checked)} />}
              label={<Typography sx={{ fontSize: 11 }}>{TOOL_LABELS[tool]}</Typography>}
            />
          ))}
        </FormGroup>
      </Box>

      <Box sx={{ display: 'flex', gap: 1 }}>
        <FormControl size="small" sx={{ width: 190, flexShrink: 0 }}>
          <InputLabel id="agent-class-label">Agent class</InputLabel>
          <Select
            labelId="agent-class-label"
            label="Agent class"
            value={draft.agentClass}
            onChange={(event) => set('agentClass', event.target.value as AgentDefinition['agentClass'])}
          >
            <MenuItem value="report">Report</MenuItem>
            <MenuItem value="authoring" disabled>Authoring (reserved)</MenuItem>
          </Select>
        </FormControl>
        <TextField size="small" label="Permission tier" value="read-only" disabled fullWidth helperText="Actuating tools are not available in Phase 3." />
        <TextField size="small" label="Trigger" value="manual" disabled fullWidth />
        <FormControl size="small" fullWidth>
          <InputLabel id="agent-output-label">Output</InputLabel>
          <Select labelId="agent-output-label" label="Output" value={draft.outputFormat} onChange={(event) => set('outputFormat', event.target.value as AgentDefinition['outputFormat'])}>
            <MenuItem value="report">Report</MenuItem>
            <MenuItem value="chat">Chat</MenuItem>
            <MenuItem value="json">JSON</MenuItem>
          </Select>
        </FormControl>
      </Box>
      <Typography sx={{ mt: -1, fontSize: 10, color: 'text.secondary', fontFamily: 'monospace' }}>
        Backend: {resolvedBackendLabel(draft, backendStatus)}
      </Typography>
      <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start' }}>
        <TextField size="small" type="number" label="Max turns" value={draft.maxTurns} inputProps={{ min: 1, max: 16 }} onChange={(event) => set('maxTurns', Number(event.target.value))} fullWidth />
        <TextField size="small" type="number" label="Token budget" value={draft.maxBudget.tokens} inputProps={{ min: 1024, max: 2_000_000, step: 1000 }} onChange={(event) => set('maxBudget', { tokens: Number(event.target.value) })} fullWidth />
        <FormControlLabel control={<Checkbox checked={draft.enabled} onChange={(event) => set('enabled', event.target.checked)} />} label={<Typography sx={{ fontSize: 12 }}>Enabled</Typography>} />
      </Box>
    </Box>
  );
}

function validateDraft(draft: AgentDefinition): string | null {
  if (draft.agentClass !== 'report' && draft.agentClass !== 'authoring') return 'Agent class must be report or authoring.';
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(draft.name)) return 'Name must be a lowercase slug with 2–63 characters.';
  if (!draft.displayName.trim()) return 'Display name is required.';
  if (!draft.instructions.trim()) return 'Instructions are required.';
  if (draft.tools.length === 0) return 'Select at least one server tool.';
  if (!Number.isInteger(draft.maxTurns) || draft.maxTurns < 1 || draft.maxTurns > 16) return 'Max turns must be between 1 and 16.';
  if (!Number.isInteger(draft.maxBudget.tokens) || draft.maxBudget.tokens < 1024 || draft.maxBudget.tokens > 2_000_000) return 'Token budget must be between 1,024 and 2,000,000.';
  return null;
}

function resolvedBackendLabel(agent: AgentDefinition, status: AgentBackendsStatus | null): string {
  const mapping = status?.classes.find(item => item.agentClass === agent.agentClass);
  if (mapping?.backend) return `${mapping.backend.backendId} / ${mapping.backend.model}`;
  return mapping?.error ?? 'backend unavailable';
}

function cloneAgent(agent: AgentDefinition): AgentDefinition {
  return { ...agent, tools: [...agent.tools], trigger: { ...agent.trigger }, maxBudget: { ...agent.maxBudget } };
}

function uniqueSlug(base: string, agents: AgentDefinition[]): string {
  const names = new Set(agents.map((agent) => agent.name));
  const clean = base.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 55) || 'agent';
  if (!names.has(clean)) return clean.length >= 2 ? clean : `${clean}-agent`;
  for (let index = 2; index < 100; index++) {
    const candidate = `${clean}-${index}`.slice(0, 63);
    if (!names.has(candidate)) return candidate;
  }
  return `agent-${Date.now().toString(36)}`;
}
