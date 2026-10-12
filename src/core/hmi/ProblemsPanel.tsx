// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ProblemsPanel — the readable half of "a reference that resolved to nothing"
 * (plan-703 Phase 8, §2.8, F16).
 *
 * A wireframe box in the viewport says *something is missing here*. Only this
 * panel can say **what was looked for**, which is the difference between a
 * placeholder the user can act on and one they can only stare at.
 *
 * ## Content-driven presence
 *
 * A standard FloatingPanel, toggled from its ActivityBar entry (red count
 * badge). Renders nothing at all when the list is empty — a permanently docked "0
 * problems" panel would spend viewport on the normal case, and DESIGN.md's
 * north star is that the machine is the star. It appears when there is
 * something to say and leaves when there is not.
 *
 * ## Icon and label carry the state, amber only supports it
 *
 * DESIGN.md's State-Is-Sacred rule reserves green/amber/red for machine state,
 * and a missing file is not machine state. So the severity is spelled out by an
 * icon plus a word; the single shared Warning Amber is the sanctioned colour for
 * a rejection and is used for nothing but the icon.
 */

import { useSyncExternalStore, useCallback } from 'react';
import { Box, Button, Tooltip, Typography } from '@mui/material';
import { ErrorOutlineRounded, WarningAmberRounded, InfoOutlined } from '@mui/icons-material';
import {
  getProblems,
  subscribeProblems,
  type ProblemEntry,
  type ProblemSeverity,
} from './problems-store';
import { commandRegistry } from './rv-command-registry';
import { useOptionalViewer } from '../../hooks/use-viewer';
import { FloatingPanel } from './FloatingPanel';

/** Shared Warning Amber (DESIGN.md §2) — the one colour a rejection may take. */
const AMBER = '#ffa726';

export function useProblems(): ProblemEntry[] {
  return useSyncExternalStore(subscribeProblems, getProblems, getProblems);
}

// ── Open state ──────────────────────────────────────────────────────────────
// Shared by the panel and its ActivityBar entry, which owns the toggle: the
// panel's own collapse chevron floated over the viewport and could end up under
// the floating tool strip (2026-10-12). Open by default, and re-opened whenever
// the list goes from empty to non-empty — a new batch of problems is news; a
// user's "close" holds only while the batch they closed is still there.

let _open = true;
let _hadProblems = getProblems().length > 0;
const _openListeners = new Set<() => void>();

function setProblemsPanelOpenInternal(open: boolean): void {
  if (_open === open) return;
  _open = open;
  for (const l of _openListeners) l();
}

subscribeProblems(() => {
  const has = getProblems().length > 0;
  if (has && !_hadProblems) setProblemsPanelOpenInternal(true);
  _hadProblems = has;
});

export function setProblemsPanelOpen(open: boolean): void { setProblemsPanelOpenInternal(open); }
export function toggleProblemsPanel(): void { setProblemsPanelOpenInternal(!_open); }
function subscribeProblemsPanelOpen(l: () => void): () => void {
  _openListeners.add(l);
  return () => { _openListeners.delete(l); };
}
const getProblemsPanelOpen = () => _open;
export function useProblemsPanelOpen(): boolean {
  return useSyncExternalStore(subscribeProblemsPanelOpen, getProblemsPanelOpen, getProblemsPanelOpen);
}

function SeverityIcon({ severity }: { severity: ProblemSeverity }) {
  const sx = { fontSize: 14, color: AMBER, flexShrink: 0, mt: '2px' };
  if (severity === 'error') return <ErrorOutlineRounded sx={sx} />;
  if (severity === 'warning') return <WarningAmberRounded sx={sx} />;
  return <InfoOutlined sx={{ ...sx, color: 'rgba(255,255,255,0.5)' }} />;
}

/** Word form of the severity — the label half of "icon + label, never colour alone". */
function severityWord(severity: ProblemSeverity): string {
  return severity === 'error' ? 'Error' : severity === 'warning' ? 'Warning' : 'Info';
}

/**
 * The repair offer of a problem, when it carries one (plan-589 §2.7).
 *
 * It dispatches the command and nothing else: whatever the fix is lives in the command, so this
 * button, the ConnectPanel's own button and the MCP tool are three views of one rule and cannot
 * drift apart. A failure is swallowed here — the command itself reports it (toast / Problems), and
 * a throwing click handler would take the panel down with it.
 */
function ProblemAction({ action }: { action: NonNullable<ProblemEntry['action']> }) {
  // Optional on purpose: the panel floats over the viewport but is also rendered in tests and in
  // shells without a provider, and an absent viewer lets the registry fall back to the attached one.
  const viewer = useOptionalViewer();
  const run = useCallback(() => {
    void commandRegistry
      .execute(action.commandId, action.args, { origin: 'ui', ...(viewer ? { viewer } : {}) })
      .catch(() => { /* reported by the command */ });
  }, [action.commandId, action.args, viewer]);
  return (
    <Button
      size="small"
      data-testid="problem-action"
      data-problem-command={action.commandId}
      onClick={run}
      sx={{ mt: 0.25, fontSize: 11, textTransform: 'none', minWidth: 0, py: 0, px: 0.75 }}
    >
      {action.label}
    </Button>
  );
}

function ProblemRow({ entry }: { entry: ProblemEntry }) {
  return (
    <Box
      data-problem-id={entry.id}
      data-problem-code={entry.code}
      sx={{ display: 'flex', gap: 0.75, py: 0.5, alignItems: 'flex-start' }}
    >
      <Tooltip title={severityWord(entry.severity)} placement="left">
        <Box sx={{ display: 'flex' }} aria-label={severityWord(entry.severity)}>
          <SeverityIcon severity={entry.severity} />
        </Box>
      </Tooltip>
      <Box sx={{ minWidth: 0 }}>
        <Typography sx={{ fontSize: 12, fontWeight: 500, color: 'rgba(255,255,255,0.92)', lineHeight: 1.35 }}>
          {entry.title}
        </Typography>
        {/* The point of the whole panel (F16): what was searched for. Monospace,
            because an assetId and a path are data, not prose. */}
        <Typography
          sx={{
            fontSize: 11,
            fontFamily: 'monospace',
            color: 'rgba(255,255,255,0.7)',
            lineHeight: 1.35,
            // Break at the ", " between names, mid-name only when one is wider than the window.
            overflowWrap: 'anywhere',
          }}
        >
          {entry.detail}
        </Typography>
        {entry.nodePath && (
          <Typography
            sx={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', lineHeight: 1.3, wordBreak: 'break-all' }}
          >
            {entry.nodePath}
          </Typography>
        )}
        {entry.action && <ProblemAction action={entry.action} />}
      </Box>
    </Box>
  );
}

export function ProblemsPanel() {
  const problems = useProblems();
  const open = useProblemsPanelOpen();
  const close = useCallback(() => setProblemsPanelOpen(false), []);

  // The standard window (drag via title bar, resize via corner, Escape closes,
  // geometry remembered under `rv-panel-geo:problems`). Opened from the
  // ActivityBar it anchors next to the icon; on its own it starts bottom-left,
  // right of the bar.
  return (
    <FloatingPanel
      open={open && problems.length > 0}
      onClose={close}
      title={`Problems (${problems.length})`}
      titleColor={AMBER}
      panelId="problems"
      role="region"
      aria-label="Problems"
      defaultWidth={440}
      defaultHeight={320}
      minWidth={320}
    >
      <Box data-testid="problems-panel" sx={{ flex: 1, minHeight: 0, overflowY: 'auto', px: 1.25, py: 0.75 }}>
        {problems.map(entry => <ProblemRow key={entry.id} entry={entry} />)}
      </Box>
    </FloatingPanel>
  );
}
