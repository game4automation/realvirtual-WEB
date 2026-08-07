// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/** Floating run monitor with terminal-aware polling, tool trace, and safe report rendering. */

import { useEffect, useState } from 'react';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  IconButton,
  Tooltip,
  Typography,
} from '@mui/material';
import { ArrowBack, Cancel, ExpandMore } from '@mui/icons-material';
import { FloatingPanel } from '../../core/hmi/FloatingPanel';
import type { AgentProvider, AgentRunRecord, AgentRunStatus } from './agent-provider';
import { isTerminalAgentRunStatus } from './agent-provider';
import { pollAgentRun } from './agent-store';
import { AgentReportView } from './AgentReportView';

export interface AgentRunPanelProps {
  open: boolean;
  onClose: () => void;
  onBack?: () => void;
  provider: AgentProvider;
  runId: string | null;
}

export function AgentRunPanel({ open, onClose, onBack, provider, runId }: AgentRunPanelProps) {
  const [run, setRun] = useState<AgentRunRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    if (!open || !runId) return;
    const controller = new AbortController();
    setRun(null);
    setError(null);
    void pollAgentRun(provider, runId, {
      signal: controller.signal,
      onUpdate: setRun,
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => controller.abort();
  }, [open, provider, runId]);

  const cancel = async () => {
    if (!runId) return;
    setCancelling(true);
    setError(null);
    try {
      const cancelled = await provider.cancelRun(runId);
      if (cancelled) setRun(cancelled);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setCancelling(false);
    }
  };

  const toolbar = (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.25 }}>
      {onBack && (
        <Tooltip title="Back to agents">
          <IconButton size="small" aria-label="Back to agents" onClick={onBack} sx={{ p: 0.35, color: 'text.secondary' }}>
            <ArrowBack sx={{ fontSize: 16 }} />
          </IconButton>
        </Tooltip>
      )}
      {run && !isTerminalAgentRunStatus(run.status) && (
        <Tooltip title="Cancel run">
          <span>
            <IconButton size="small" aria-label="Cancel agent run" disabled={cancelling} onClick={() => void cancel()} sx={{ p: 0.35, color: 'text.secondary' }}>
              <Cancel sx={{ fontSize: 16 }} />
            </IconButton>
          </span>
        </Tooltip>
      )}
    </Box>
  );

  return (
    <FloatingPanel
      open={open}
      onClose={onClose}
      title="Agent run"
      subtitle={run?.agent}
      panelId="agents-run"
      defaultWidth={720}
      defaultHeight={620}
      minWidth={460}
      toolbar={toolbar}
    >
      <Box sx={{ height: '100%', overflow: 'auto', p: 1.5 }}>
        {error && <Alert severity="error" sx={{ mb: 1 }}>{error}</Alert>}
        {!run && !error && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, color: 'text.secondary' }}>
            <CircularProgress size={16} />
            <Typography sx={{ fontSize: 12 }}>Loading run status…</Typography>
          </Box>
        )}
        {run && (
          <>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5, flexWrap: 'wrap' }}>
              <StatusChip status={run.status} />
              {!isTerminalAgentRunStatus(run.status) && <CircularProgress size={14} />}
              <Typography sx={{ fontSize: 11, fontFamily: 'monospace', color: 'text.secondary' }}>
                {run.totalTokens.toLocaleString()} tokens{run.usageEstimated ? ' (estimated)' : ''}
              </Typography>
            </Box>
            {run.backend && (
              <Box sx={{ display: 'flex', gap: 0.75, mb: 1.5, flexWrap: 'wrap', color: 'text.secondary' }}>
                <Typography sx={{ fontSize: 10, fontFamily: 'monospace' }}>{run.backend.backendId}</Typography>
                <Typography aria-hidden sx={{ fontSize: 10 }}>·</Typography>
                <Typography sx={{ fontSize: 10, fontFamily: 'monospace' }}>{run.backend.model}</Typography>
                <Typography aria-hidden sx={{ fontSize: 10 }}>·</Typography>
                <Typography sx={{ fontSize: 10, fontFamily: 'monospace' }}>{run.backend.region}</Typography>
              </Box>
            )}

            {run.status === 'waiting_approval' && (
              <Alert severity="warning" variant="outlined" sx={{ mb: 1.5 }}>
                This run is waiting for approval. Actuating approval becomes available in Phase 5.
              </Alert>
            )}
            {run.error && <Alert severity="error" variant="outlined" sx={{ mb: 1.5 }}>{run.error}</Alert>}

            {run.trace.length > 0 && (
              <Box component="section" aria-label="Tool trace" sx={{ mb: 1.5 }}>
                <Typography sx={{ fontSize: 11, fontWeight: 600, color: 'text.secondary', mb: 0.5 }}>
                  Tools used · {run.trace.length}
                </Typography>
                {run.trace.map((entry, index) => (
                  <Accordion key={`${entry.turn}-${entry.tool}-${index}`} disableGutters elevation={0} sx={{ bgcolor: 'transparent', borderTop: '1px solid rgba(255,255,255,0.08)' }}>
                    <AccordionSummary expandIcon={<ExpandMore sx={{ fontSize: 16 }} />} sx={{ minHeight: 34, '& .MuiAccordionSummary-content': { my: 0.5 } }}>
                      <Typography sx={{ fontSize: 11, fontFamily: 'monospace' }}>
                        Turn {entry.turn} · {entry.tool} · {entry.resultChars.toLocaleString()} chars
                      </Typography>
                    </AccordionSummary>
                    <AccordionDetails sx={{ pt: 0 }}>
                      <Box component="pre" sx={{ m: 0, fontSize: 10, lineHeight: 1.45, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: 'text.secondary' }}>
                        {safeJson(entry.args)}
                      </Box>
                    </AccordionDetails>
                  </Accordion>
                ))}
              </Box>
            )}

            {run.result ? (
              <AgentReportView result={run.result} />
            ) : isTerminalAgentRunStatus(run.status) ? (
              <Alert severity="info" variant="outlined">This run finished without a report.</Alert>
            ) : (
              <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>The report appears when the run completes.</Typography>
            )}

            {!isTerminalAgentRunStatus(run.status) && (
              <Button size="small" variant="text" disabled={cancelling} onClick={() => void cancel()} sx={{ mt: 1, textTransform: 'none' }}>
                Cancel run
              </Button>
            )}
          </>
        )}
      </Box>
    </FloatingPanel>
  );
}

function StatusChip({ status }: { status: AgentRunStatus }) {
  const color = status === 'done'
    ? 'success'
    : status === 'failed' || status === 'cancelled' || status === 'interrupted'
      ? 'error'
      : status === 'waiting_approval' || status === 'limit_reached'
        ? 'warning'
        : 'info';
  return <Chip size="small" color={color} variant="outlined" label={status.replaceAll('_', ' ')} sx={{ borderRadius: '2px', fontSize: 11 }} />;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2).slice(0, 12_000);
  } catch {
    return '[unavailable]';
  }
}
