// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { getLocalStorage, readLocalStorage, writeLocalStorage } from '../rv-safe-storage';

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

import { useSyncExternalStore, useCallback, useState } from 'react';
import { Box, Button, IconButton, Snackbar, Tooltip, Typography } from '@mui/material';
import { CloseRounded, ErrorOutlineRounded, WarningAmberRounded, InfoOutlined } from '@mui/icons-material';
import {
  getProblems,
  getProblemsAnnouncement,
  subscribeProblems,
  subscribeProblemsAnnouncement,
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
// the floating tool strip (2026-10-12).
//
// The panel opens on NEWS, nothing else (2026-10-18). Closing it acknowledges
// every entry currently listed — by fingerprint (id + severity + title), kept
// across page reloads. It comes back up only when an entry appears that has not
// been acknowledged: a new problem, or an existing one whose headline changed.
// An identical set re-reported by a reload, a model re-opened under a fresh blob
// url, or a problem that flickers out and back in does not count as news. The
// ActivityBar entry and its count stay visible throughout, so a closed panel is
// always one click away.

const ACKED_KEY = 'rv-problems-acked';
const ACKED_MAX = 1000;

function fingerprint(e: ProblemEntry): string {
  return `${e.id}|${e.severity}|${e.title}`;
}

function loadAcked(): string[] {
  try {
    // The per-model close list it replaces; its keys cannot be mapped to entries.
    getLocalStorage()!.removeItem('rv-problems-dismissed');
    const raw = readLocalStorage(ACKED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

const _acked = new Set<string>(loadAcked());

function saveAcked(): void {
  try {
    // Oldest first (insertion order), so the cap drops the longest-acknowledged entries.
    writeLocalStorage(ACKED_KEY, JSON.stringify([..._acked].slice(-ACKED_MAX)));
  } catch { /* private window / blocked storage: the acknowledgement holds for this session only */ }
}

function hasNews(): boolean {
  // plan-628 8.11g: a `quiet` entry (its marker sits in the view) is never news.
  return getProblems().some(e => !e.quiet && !_acked.has(fingerprint(e)));
}

let _open = hasNews();
const _openListeners = new Set<() => void>();

function setProblemsPanelOpenInternal(open: boolean): void {
  if (_open === open) return;
  _open = open;
  for (const l of _openListeners) l();
}

subscribeProblems(() => {
  if (!_open && hasNews()) setProblemsPanelOpenInternal(true);
});

// ── Code filter (plan-778 §2.7) ────────────────────────────────────────────
// "Show" on a summary line opens the panel filtered to that line's problems
// ("2 libraries unavailable — Show"). Closing the panel drops the filter, so
// the next open is the whole list again.

let _codeFilter: string | null = null;
const _filterListeners = new Set<() => void>();

function setCodeFilter(code: string | null): void {
  if (_codeFilter === code) return;
  _codeFilter = code;
  for (const l of _filterListeners) l();
}
function subscribeProblemsFilter(l: () => void): () => void {
  _filterListeners.add(l);
  return () => { _filterListeners.delete(l); };
}
const getProblemsFilter = () => _codeFilter;
/** Test seam: the active code filter without React. */
export const getProblemsFilterForTests = getProblemsFilter;
export function useProblemsFilter(): string | null {
  return useSyncExternalStore(subscribeProblemsFilter, getProblemsFilter, getProblemsFilter);
}

/** Open the panel — filtered to one problem `code` when given, the whole list otherwise. */
export function showProblems(opts: { code?: string | null } = {}): void {
  setCodeFilter(opts.code ?? null);
  setByUser(true);
}

/** User intent: closing acknowledges everything currently listed; opening just opens. */
function setByUser(open: boolean): void {
  if (!open) {
    setCodeFilter(null);
    for (const e of getProblems()) {
      const fp = fingerprint(e);
      _acked.delete(fp); // re-insert so it counts as most recent
      _acked.add(fp);
    }
    saveAcked();
  }
  setProblemsPanelOpenInternal(open);
}

export function setProblemsPanelOpen(open: boolean): void { setByUser(open); }
export function toggleProblemsPanel(): void { setByUser(!_open); }
function subscribeProblemsPanelOpen(l: () => void): () => void {
  _openListeners.add(l);
  return () => { _openListeners.delete(l); };
}
const getProblemsPanelOpen = () => _open;
/** Test seam: the open flag without React. */
export const getProblemsPanelOpenForTests = getProblemsPanelOpen;
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

/**
 * The summary line of quiet problems (plan-778 §2.7): one sentence and **Show**,
 * which opens this panel filtered to them. Dismissing it hides that one
 * announcement; a new one (another project, another count) shows again.
 */
function ProblemsAnnouncementLine() {
  const announcement = useSyncExternalStore(
    subscribeProblemsAnnouncement, getProblemsAnnouncement, getProblemsAnnouncement);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const token = announcement ? `${announcement.key}|${announcement.seq ?? announcement.message}` : null;
  const open = !!announcement && dismissed !== token;
  const show = useCallback(() => {
    if (!announcement) return;
    setDismissed(token);
    showProblems({ code: announcement.code });
  }, [announcement, token]);
  return (
    <Snackbar
      open={open}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      message={<span data-testid="problems-announcement">{announcement?.message ?? ''}</span>}
      action={(
        <>
          <Button size="small" onClick={show} data-testid="problems-announcement-show" sx={{ textTransform: 'none' }}>
            Show
          </Button>
          <IconButton size="small" aria-label="Dismiss" onClick={() => setDismissed(token)}>
            <CloseRounded sx={{ fontSize: 16 }} />
          </IconButton>
        </>
      )}
    />
  );
}

export function ProblemsPanel() {
  const problems = useProblems();
  const open = useProblemsPanelOpen();
  const filter = useProblemsFilter();
  const close = useCallback(() => setProblemsPanelOpen(false), []);
  const showAll = useCallback(() => setCodeFilter(null), []);
  // A filter whose problems are all gone shows the whole list rather than nothing.
  const filtered = filter ? problems.filter(p => p.code === filter) : problems;
  const shown = filtered.length > 0 ? filtered : problems;
  const isFiltered = shown.length !== problems.length;

  // The standard window (drag via title bar, resize via corner, Escape closes,
  // geometry remembered under `rv-panel-geo:problems`). Opened from the
  // ActivityBar it anchors next to the icon; on its own it starts bottom-left,
  // right of the bar.
  return (
    <>
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
        {isFiltered && (
          <Box data-testid="problems-filter" sx={{ display: 'flex', alignItems: 'center', gap: 0.75, pb: 0.5 }}>
            <Typography sx={{ fontSize: 11, color: 'rgba(255,255,255,0.6)' }}>
              Showing {shown.length} of {problems.length}
            </Typography>
            <Button size="small" onClick={showAll} sx={{ fontSize: 11, textTransform: 'none', minWidth: 0, py: 0, px: 0.75 }}>
              Show all
            </Button>
          </Box>
        )}
        {shown.map(entry => <ProblemRow key={entry.id} entry={entry} />)}
      </Box>
    </FloatingPanel>
    <ProblemsAnnouncementLine />
    </>
  );
}
