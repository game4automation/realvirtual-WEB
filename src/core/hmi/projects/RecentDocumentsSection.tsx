// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * RecentDocumentsSection — "Recently opened", above the project list
 * (plan-478 F2).
 *
 * The project list answers *which project*; this answers *what was I doing*,
 * which is the question a returning user actually has. It sits above the list
 * rather than inside it because its rows are documents, not projects, and one
 * of them may belong to a project that is not open.
 *
 * ## No timestamps, no relative time
 *
 * `openedAt` sorts the ring and is never rendered. The project list has been
 * silently sorted since the user decision of 2026-09-07, for the reason that
 * applies twice as hard here: "2 hours ago" on five rows is five pieces of
 * text that change while you read them, and the ORDER already says everything
 * they would.
 *
 * ## Nothing is probed to draw a row
 *
 * The lock icon comes from the `rowStates` map the project list has already
 * collected; no `queryPermission()` runs for a recents row, and a document
 * that has since been deleted is discovered on the CLICK (the chain forgets it
 * and says so) rather than by stat-ing ten files on every paint.
 */

import { Box, ButtonBase, IconButton, Menu, MenuItem, Stack, Tooltip, Typography } from '@mui/material';
import { Fragment, useState } from 'react';
import { DeleteSweepOutlined, LockOutlined, MoreVert } from '@mui/icons-material';
import { PROJECTS_DASHBOARD_ZINDEX } from '../layout-constants';
import { DocumentModeChip } from './DocumentModeChip';
import {
  ROW_MAX_WIDTH,
  SECTION_HEADER_HEIGHT,
  SectionAction,
  type LinkedRowState,
} from './ProjectsList';
import type { RecentDocumentEntry } from '../../project/rv-project-recents';
import { splitByRanges, type MatchRange } from '../../project/rv-search-score';

export interface RecentDocumentsViewProps {
  entries: readonly RecentDocumentEntry[];
  /** Per-PROJECT openability, shared with the project list. */
  rowStates: Map<string, LinkedRowState>;
  /** `viewer.modes.descriptor(id)?.label` — undefined for a mode this build lacks. */
  modeLabel(mode: string): string | undefined;
  /**
   * The mode a click on the entry opens it in (plan-513) — the host answers
   * from `rv-document-modes` through `effectiveOpenMode`. Absent, the row
   * falls back to the ring's own `mode` (a caller without the store).
   */
  modeOf?(entry: RecentDocumentEntry): string | null | undefined;
  /** True while a chain runs: every row is inert, none is queued (F11). */
  busy: boolean;
  onOpen(entry: RecentDocumentEntry): void;
  onForget(entry: RecentDocumentEntry): void;
}

/** A stable React key for an entry. Identity is the PAIR, never the id alone. */
export function recentKey(e: RecentDocumentEntry): string {
  return `${e.projectId}::${e.documentId}`;
}

/**
 * Which lock state a recents row shows.
 *
 * `needs-grant` and `missing` both mean "this click will cost something extra"
 * and both get the same quiet icon; `denied` is the one that already asked and
 * was refused, so it keeps its own sentence in the tooltip.
 */
function lockHintOf(state: LinkedRowState | undefined): string | null {
  if (state === 'needs-grant') return 'Opening this will ask for folder access again';
  if (state === 'denied') return 'Access to this project folder was not granted';
  if (state === 'missing') return 'This project folder was not found';
  return null;
}

/**
 * Split a project-relative path at its LAST slash (plan-482 §3.1).
 *
 * The file name is the distinguishing half — two documents in one project are
 * told apart by it far more often than by their folder — so it becomes its own
 * span and gives way last. A path with no slash is file only, and its directory
 * span renders empty rather than absent, which keeps the three-span geometry
 * identical for every row.
 */
export function splitDocumentPath(path: string): { dir: string; file: string } {
  const i = path.lastIndexOf('/');
  return i < 0 ? { dir: '', file: path } : { dir: path.slice(0, i + 1), file: path.slice(i + 1) };
}

/**
 * The shared span geometry of the secondary line.
 *
 * `minWidth: 0` is what allows a flex item to shrink below its content at all,
 * and `textOverflow` is what makes the shrinking legible instead of a hard cut.
 * The `flexShrink` factors are supplied per span and are STAGGERED (9999 / 100 /
 * 1) rather than equal: equal factors distribute the shortfall proportionally to
 * the base widths, so all three spans would truncate at once and the promised
 * order would exist only on paper. What the staggering buys is a shrink
 * PRIORITY, not three fixed breakpoints: flexbox distributes the shortfall by
 * factor x base width and re-runs after clamping, so the widths at which each
 * span gives way depend on the content and on the host's font metrics (plan-482
 * "Spike-Ergebnis" measured 560 / 480 / 400 for one path on one machine; the
 * bands can be a handful of pixels wide elsewhere). T-UI-3 therefore asserts the
 * ORDER of the thresholds against this component, not their values.
 */
const PATH_SPAN = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontSize: 11,
  color: 'text.disabled',
  lineHeight: 1.3,
} as const;

/**
 * A type-ahead match inside the name. Weight and accent, no background block:
 * the row's own selection wash already uses the background.
 */
export const MARK_SX = {
  bgcolor: 'transparent',
  color: 'primary.main',
  fontWeight: 700,
} as const;

/** Monospace for the PATH only: it keeps `0/O` and `I/l/1` apart. */
const PATH_MONO = { fontFamily: 'monospace' } as const;

/**
 * One recent document.
 *
 * Exported because the Quick-Open popover shows the same rows; two spellings of
 * "a recent document" is how a mode chip ends up in one surface and not the
 * other.
 */
export function RecentDocumentRow({
  entry,
  state,
  modeLabel,
  modeOf,
  busy,
  selected,
  compact = false,
  id,
  highlight,
  onOpen,
  onForget,
}: {
  entry: RecentDocumentEntry;
  state: LinkedRowState | undefined;
  modeLabel(mode: string): string | undefined;
  /** See {@link RecentDocumentsViewProps.modeOf}. */
  modeOf?(entry: RecentDocumentEntry): string | null | undefined;
  busy: boolean;
  /** Popover keyboard selection. Undefined in the dashboard section. */
  selected?: boolean;
  /** The popover's denser geometry — same row, less air. */
  compact?: boolean;
  /**
   * DOM id of the option element. The popover's `aria-activedescendant` points
   * here, so it must sit on the element that carries `role="option"`.
   */
  id?: string;
  /** Match ranges inside `documentName` — the Quick-Open type-ahead marks them. */
  highlight?: readonly MatchRange[];
  onOpen(): void;
  onForget?(): void;
}) {
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const lockHint = lockHintOf(state);
  const mode = modeOf ? modeOf(entry) : entry.mode;
  const { dir, file } = splitDocumentPath(entry.documentPath);
  return (
    <Box
      id={id}
      data-testid={`recent-row-${entry.documentId}`}
      data-project={entry.projectId}
      data-selected={selected ? 'true' : undefined}
      role={selected === undefined ? undefined : 'option'}
      aria-selected={selected === undefined ? undefined : selected}
      sx={{
        display: 'flex',
        alignItems: 'stretch',
        borderRadius: 1,
        border: '1px solid',
        borderColor: selected ? 'primary.main' : 'rgba(255,255,255,0.08)',
        bgcolor: selected ? 'rgba(79,195,247,0.10)' : 'rgba(255,255,255,0.03)',
        opacity: busy ? 0.5 : 1,
        transition: 'background-color 120ms, border-color 120ms, opacity 120ms',
        '&:hover': busy ? undefined : {
          bgcolor: 'rgba(255,255,255,0.07)',
          borderColor: 'rgba(255,255,255,0.14)',
        },
      }}
    >
      <ButtonBase
        onClick={onOpen}
        disabled={busy}
        sx={{
          flex: 1,
          minWidth: 0,
          justifyContent: 'flex-start',
          textAlign: 'left',
          pl: 2,
          pr: 1,
          py: compact ? 0.75 : 1.25,
          borderRadius: 'inherit',
          '&.Mui-focusVisible': { bgcolor: 'rgba(255,255,255,0.07)' },
        }}
      >
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0 }}>
            <Typography
              sx={{
                fontSize: compact ? 13 : 14, fontWeight: 600, lineHeight: 1.3,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}
            >
              {highlight && highlight.length > 0
                ? splitByRanges(entry.documentName, highlight).map((part, i) => (part.match
                  ? <Box key={i} component="mark" sx={MARK_SX}>{part.text}</Box>
                  : <Fragment key={i}>{part.text}</Fragment>))
                : entry.documentName}
            </Typography>
            {lockHint && (
              <Tooltip title={lockHint}>
                <LockOutlined
                  data-testid={`recent-lock-${entry.documentId}`}
                  sx={{ fontSize: 13, color: 'text.disabled', flexShrink: 0 }}
                />
              </Tooltip>
            )}
          </Box>
          <Tooltip title={entry.documentPath} placement="bottom-start">
            <Box
              data-testid={`recent-path-${entry.documentId}`}
              sx={{
                display: 'flex', alignItems: 'baseline',
                minWidth: 0, overflow: 'hidden', mt: 0.25,
              }}
            >
              <Box component="span" sx={{ ...PATH_SPAN, flexShrink: 100 }}>
                {entry.projectName}&nbsp;·&nbsp;
              </Box>
              <Box component="span" sx={{ ...PATH_SPAN, ...PATH_MONO, flexShrink: 9999 }}>
                {dir}
              </Box>
              <Box
                component="span"
                data-testid={`recent-path-file-${entry.documentId}`}
                sx={{ ...PATH_SPAN, ...PATH_MONO, flexShrink: 1 }}
              >
                {file}
              </Box>
            </Box>
          </Tooltip>
        </Box>
        {/* The mode is the reason this list exists — one click restores the
            workspace, not just the file — so it is named, not implied. Shown
            only for a mode THIS build registers: a chip reading a mode the
            user cannot be put into would promise something the chain
            deliberately does not do. */}
        <DocumentModeChip
          mode={mode}
          modeLabel={modeLabel}
          testId={`recent-mode-${entry.documentId}`}
          sx={{ ml: 1 }}
        />
      </ButtonBase>
      {onForget && (
        <Box
          onClick={(e) => e.stopPropagation()}
          sx={{
            width: 40, flexShrink: 0, display: 'flex',
            alignItems: 'center', justifyContent: 'flex-end', pr: 1,
          }}
        >
          <IconButton
            size="small"
            disabled={busy}
            aria-label="Recent document actions"
            data-testid={`recent-menu-${entry.documentId}`}
            onClick={(e) => setMenuAnchor(e.currentTarget)}
          >
            <MoreVert sx={{ fontSize: 16 }} />
          </IconButton>
          <Menu
            sx={compact ? { zIndex: PROJECTS_DASHBOARD_ZINDEX + 20 } : undefined}
            anchorEl={menuAnchor}
            open={menuAnchor !== null}
            onClose={() => setMenuAnchor(null)}
          >
            <MenuItem
              data-testid={`recent-forget-${entry.documentId}`}
              onClick={() => { setMenuAnchor(null); onForget(); }}
              sx={{ fontSize: 13 }}
            >
              Remove from list
            </MenuItem>
          </Menu>
        </Box>
      )}
    </Box>
  );
}

/**
 * The dashboard section. Renders NOTHING when the ring is empty — an empty
 * "Recently opened" header above a first-run project list is a promise of
 * history that does not exist yet.
 */
export function RecentDocumentsSection({
  entries,
  rowStates,
  modeLabel,
  modeOf,
  busy,
  onOpen,
  onForget,
  onClear,
}: RecentDocumentsViewProps & { onClear(): void }) {
  if (entries.length === 0) return null;
  return (
    <Box data-testid="recent-documents-section" sx={{ px: 2, pt: 2 }}>
      <Box sx={{ maxWidth: ROW_MAX_WIDTH, mx: 'auto' }}>
        <Box
          sx={{
            display: 'flex', alignItems: 'center', gap: 1,
            height: SECTION_HEADER_HEIGHT, mb: 1,
          }}
        >
          <Typography
            sx={{
              fontSize: 10, letterSpacing: 0.8, textTransform: 'uppercase',
              color: 'text.disabled', flexShrink: 0,
            }}
          >
            Recently opened
          </Typography>
          <Box sx={{ flex: 1, borderTop: '1px solid rgba(255,255,255,0.08)' }} />
          <SectionAction
            icon={<DeleteSweepOutlined sx={{ fontSize: 14 }} />}
            label="Clear"
            title="Forget every recently opened document"
            testId="recent-documents-clear"
            onClick={onClear}
          />
        </Box>
        <Stack spacing={1}>
          {entries.map(e => (
            <RecentDocumentRow
              key={recentKey(e)}
              entry={e}
              state={rowStates.get(e.projectId)}
              modeLabel={modeLabel}
              modeOf={modeOf}
              busy={busy}
              onOpen={() => onOpen(e)}
              onForget={() => onForget(e)}
            />
          ))}
        </Stack>
      </Box>
    </Box>
  );
}
