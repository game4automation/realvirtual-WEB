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
 * Renders nothing at all when the list is empty — a permanently docked "0
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

import { useSyncExternalStore, useState, useCallback } from 'react';
import { Box, IconButton, Tooltip, Typography } from '@mui/material';
import { ErrorOutlineRounded, WarningAmberRounded, InfoOutlined, ExpandMore, ChevronRight } from '@mui/icons-material';
import {
  getProblems,
  subscribeProblems,
  type ProblemEntry,
  type ProblemSeverity,
} from './problems-store';
import { uiBlur } from './rv-ui-blur';

/** Shared Warning Amber (DESIGN.md §2) — the one colour a rejection may take. */
const AMBER = '#ffa726';

export function useProblems(): ProblemEntry[] {
  return useSyncExternalStore(subscribeProblems, getProblems, getProblems);
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
            wordBreak: 'break-all',
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
      </Box>
    </Box>
  );
}

export function ProblemsPanel() {
  const problems = useProblems();
  const [collapsed, setCollapsed] = useState(false);
  const toggle = useCallback(() => setCollapsed(c => !c), []);

  if (problems.length === 0) return null;

  return (
    <Box
      data-testid="problems-panel"
      role="region"
      aria-label="Problems"
      sx={{
        position: 'absolute',
        left: 8,
        bottom: 8,
        zIndex: 6,
        maxWidth: 420,
        maxHeight: '40%',
        overflowY: 'auto',
        // Glass Floating — brightest tier, blur instead of shadow (DESIGN.md §2).
        bgcolor: 'rgba(30,30,30,0.6)',
        // `uiBlur`, never a literal: the `Fast` visual preset scales every
        // backdrop blur through one CSS variable, and an inline radius is the
        // one surface that would keep blurring on a machine that asked not to.
        backdropFilter: uiBlur(16),
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: '4px',
        px: 1.25,
        py: 0.75,
        pointerEvents: 'auto',
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
        <IconButton
          size="small"
          aria-label={collapsed ? 'Expand problems' : 'Collapse problems'}
          onClick={toggle}
          sx={{ p: 0, color: 'rgba(255,255,255,0.7)' }}
        >
          {collapsed ? <ChevronRight sx={{ fontSize: 14 }} /> : <ExpandMore sx={{ fontSize: 14 }} />}
        </IconButton>
        <Typography
          sx={{ fontSize: 11, fontWeight: 500, letterSpacing: 0.4, color: 'rgba(255,255,255,0.7)' }}
        >
          {`PROBLEMS (${problems.length})`}
        </Typography>
      </Box>
      {!collapsed && problems.map(entry => <ProblemRow key={entry.id} entry={entry} />)}
    </Box>
  );
}
