// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * ModelSearchResults — the models of every project, as one flat list
 * (plan-509 F4, F9–F11).
 *
 * The sister of `ProjectSearchResults` (the open project's search), not a
 * generalisation of it: that one is built on tree nodes of ONE open project,
 * this one on index snapshots of MANY closed ones. The row mechanics are the
 * same on purpose — grouped by project in the Projects screen's order, the
 * model name with its match marked, the folders as a breadcrumb, roving
 * `tabIndex`, Enter / double-click to open, a touch chevron.
 *
 * ## Arrows only move the focus
 *
 * Arrows, Home and End move the DOM focus; Enter and double-click open. A
 * single click only focuses the row: opening a hit may raise a folder-access
 * prompt and switch projects, which a stray click must not do.
 *
 * ## A locked project still lists its models
 *
 * The index is the last seen state, readable without the folder. A project
 * whose folder needs a grant again shows the list's own lock symbol in its
 * group header; opening a hit asks for the grant then, never before (F8).
 */

import { Fragment, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Box, IconButton, Tooltip, Typography } from '@mui/material';
import { ChevronRight, LockOutlined, ViewInArOutlined } from '@mui/icons-material';
import { SectionHeader } from '../shared-components';
import { collapseCrumbs, isCollapsedCrumbs } from './mobile-folder-view';
import { MARK_SX } from './RecentDocumentsSection';
import { DocumentModeChip } from './DocumentModeChip';
import { ROW_MAX_WIDTH, type LinkedRowState } from './ProjectsList';
import {
  shownModelHits,
  type ModelSearchGroup, type ModelSearchHit, type ModelSearchResult,
} from '../../project/rv-model-search';
import { rangesOfField, splitByRanges } from '../../project/rv-search-score';

export interface ModelSearchResultsProps {
  result: ModelSearchResult;
  /** Row state of a group's project (linked folders only); a lock when not ready. */
  stateOf?(group: ModelSearchGroup): LinkedRowState | undefined;
  /** Linked projects without a snapshot — the empty state then explains why (F11). */
  unindexedCount?: number;
  /** An open is running: every row is inert. */
  busy?: boolean;
  compactLayout?: boolean;
  /** Coarse pointer: rows get an explicit "Open" chevron. */
  touchInput?: boolean;
  /**
   * The mode a hit opens in (plan-513) — the host's `effectiveOpenMode` over
   * the stored last mode and the indexed declared mode. No chip without it.
   */
  modeOf?(hit: ModelSearchHit): string | null | undefined;
  /** `viewer.modes.descriptor(id)?.label` — undefined for a mode this build lacks. */
  modeLabel?(mode: string): string | undefined;
  onActivate(hit: ModelSearchHit): void;
}

/** Breadcrumb levels shown before the middle folds into an ellipsis. */
const MAX_CRUMBS = 4;

/** Same sentences as the recents' lock (RecentDocumentsSection). */
function lockHintOf(state: LinkedRowState | undefined): string | null {
  if (state === 'needs-grant') return 'Opening this will ask for folder access again';
  if (state === 'denied') return 'Access to this project folder was not granted';
  if (state === 'missing') return 'This project folder was not found';
  return null;
}

/** Row identity — a document id is unique only within its project. */
function rowKeyOf(hit: ModelSearchHit): string {
  return `${hit.entry.backend}:${hit.entry.projectId}/${hit.entry.doc.id}`;
}

function crumbText(hit: ModelSearchHit): string {
  return collapseCrumbs(hit.entry.crumbs.map(name => ({ name })), MAX_CRUMBS)
    .map(c => (isCollapsedCrumbs(c) ? '…' : c.name))
    .join(' / ');
}

export function ModelSearchResults({
  result,
  stateOf,
  unindexedCount = 0,
  busy = false,
  compactLayout = false,
  touchInput = false,
  modeOf,
  modeLabel,
  onActivate,
}: ModelSearchResultsProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rowEls = useRef(new Map<string, HTMLElement>());
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const focusedKeyRef = useRef<string | null>(null);

  const hits = useMemo(() => result.groups.flatMap(g => g.hits), [result]);
  const keys = useMemo(() => hits.map(rowKeyOf), [hits]);
  const shown = shownModelHits(result);
  const tabStop = focusKey && keys.includes(focusKey) ? focusKey : keys[0] ?? null;

  // Focus repair, as in ProjectSearchResults: only when the focused row was
  // filtered away and the focus fell to `body`.
  useLayoutEffect(() => {
    const lost = focusedKeyRef.current;
    if (!lost || keys.includes(lost)) return;
    focusedKeyRef.current = null;
    const active = document.activeElement;
    if (active === null || active === document.body) containerRef.current?.focus();
  }, [keys]);

  const focusRow = useCallback((key: string | undefined) => {
    if (!key) return;
    setFocusKey(key);
    rowEls.current.get(key)?.focus();
  }, []);

  const activate = useCallback((hit: ModelSearchHit) => {
    if (busy) return;
    onActivate(hit);
  }, [busy, onActivate]);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    const key = (e.target as HTMLElement).getAttribute('data-model-hit');
    if (!key) return;
    const at = keys.indexOf(key);
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); focusRow(keys[Math.min(at + 1, keys.length - 1)]); break;
      case 'ArrowUp': e.preventDefault(); focusRow(keys[Math.max(at - 1, 0)]); break;
      case 'Home': e.preventDefault(); focusRow(keys[0]); break;
      case 'End': e.preventDefault(); focusRow(keys[keys.length - 1]); break;
      case 'Enter': {
        e.preventDefault();
        const hit = hits[at];
        if (hit) activate(hit);
        break;
      }
      default: break;
    }
  }, [keys, hits, focusRow, activate]);

  if (result.total === 0) {
    return (
      <Box
        data-testid="model-search-empty"
        tabIndex={-1}
        ref={containerRef}
        sx={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: 0.5, p: 3, outline: 'none' }}
      >
        <Typography sx={{ fontSize: 12, color: 'rgba(255,255,255,0.45)', textAlign: 'center' }}>
          No documents match
        </Typography>
        {unindexedCount > 0 && (
          <Typography
            data-testid="model-search-unindexed-hint"
            sx={{ fontSize: 11, color: 'text.disabled', textAlign: 'center', maxWidth: 420 }}
          >
            Only projects that have been opened once are searched.{' '}
            {unindexedCount === 1
              ? '1 linked project has not been opened yet.'
              : `${unindexedCount} linked projects have not been opened yet.`}
          </Typography>
        )}
      </Box>
    );
  }

  return (
    <Box
      ref={containerRef}
      data-testid="model-search-results"
      role="listbox"
      aria-label="Document search results"
      aria-busy={busy || undefined}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      sx={{ flex: 1, minWidth: 0, minHeight: 0, overflowY: 'auto', overflowX: 'hidden',
        px: compactLayout ? 1 : 1.5, py: 1, outline: 'none' }}
    >
      {/* The project cards' own column: the hit list replaces them in place. */}
      <Box sx={{ maxWidth: ROW_MAX_WIDTH, mx: 'auto' }}>
        <Typography sx={{ fontSize: 11, color: 'text.secondary', mb: 0.5 }}>
          {result.total} document{result.total === 1 ? '' : 's'}
        </Typography>
        {result.groups.map(group => {
          const lockHint = lockHintOf(stateOf?.(group));
          return (
            <Box key={group.key} role="group" aria-label={group.projectName} sx={{ mb: 1 }}
              data-testid={`model-search-group-${group.key}`}>
              <Box sx={{ py: 0.5, display: 'flex', alignItems: 'center', gap: 0.5 }}>
                <SectionHeader>{group.projectName}</SectionHeader>
                {lockHint && (
                  <Tooltip title={lockHint}>
                    <LockOutlined
                      data-testid={`model-search-lock-${group.key}`}
                      aria-label={lockHint}
                      sx={{ fontSize: 13, color: 'text.disabled', flexShrink: 0 }}
                    />
                  </Tooltip>
                )}
              </Box>
              {group.hits.map(hit => {
                const key = rowKeyOf(hit);
                const doc = hit.entry.doc;
                const crumbs = crumbText(hit);
                const tagRanges = rangesOfField(hit.score, 1);
                const tagText = doc.tags.join(' ');
                return (
                  <Box
                    key={key}
                    ref={(el: HTMLElement | null) => {
                      if (el) rowEls.current.set(key, el);
                      else rowEls.current.delete(key);
                    }}
                    role="option"
                    aria-selected={false}
                    aria-disabled={busy || undefined}
                    tabIndex={key === tabStop ? 0 : -1}
                    data-model-hit={key}
                    title={doc.path}
                    onDoubleClick={() => activate(hit)}
                    onFocus={(e) => {
                      if (e.target !== e.currentTarget) return;
                      focusedKeyRef.current = key;
                      setFocusKey(key);
                    }}
                    onBlur={(e) => {
                      if (e.target === e.currentTarget && e.relatedTarget !== null) {
                        focusedKeyRef.current = null;
                      }
                    }}
                    sx={{
                      display: 'flex', alignItems: 'center', gap: 1,
                      minHeight: touchInput ? 44 : 28, px: 1, py: compactLayout ? 0.5 : 0.25,
                      borderRadius: 1, cursor: busy ? 'progress' : 'pointer', userSelect: 'none',
                      outline: 'none', opacity: busy ? 0.6 : 1,
                      '&:focus-visible': { boxShadow: 'inset 0 0 0 2px #4fc3f7' },
                      ...(touchInput
                        ? { '&:active': { bgcolor: 'rgba(255,255,255,0.10)' } }
                        : { '&:hover': { bgcolor: 'rgba(255,255,255,0.06)' } }),
                    }}
                  >
                    <ViewInArOutlined sx={{ fontSize: 16, flexShrink: 0, color: 'rgba(255,255,255,0.5)' }} />
                    <Box sx={{
                      flex: 1, minWidth: 0, display: 'flex',
                      ...(compactLayout
                        ? { flexDirection: 'column', alignItems: 'flex-start' }
                        : { alignItems: 'baseline', gap: 1.5 }),
                    }}>
                      <Typography
                        component="span"
                        data-search-name
                        sx={{ fontSize: 12, color: 'text.primary', minWidth: 0,
                          overflow: 'hidden', textOverflow: 'ellipsis',
                          whiteSpace: compactLayout ? 'normal' : 'nowrap',
                          overflowWrap: 'anywhere', flexShrink: 0, maxWidth: compactLayout ? '100%' : '60%' }}
                      >
                        {splitByRanges(doc.name, rangesOfField(hit.score, 0)).map((part, i) => (part.match
                          ? <Box key={i} component="mark" sx={MARK_SX}>{part.text}</Box>
                          : <Fragment key={i}>{part.text}</Fragment>))}
                      </Typography>
                      {crumbs !== '' && (
                        <Typography
                          component="span"
                          data-search-crumbs
                          sx={{ fontSize: 11, color: 'text.disabled', minWidth: 0, maxWidth: '100%',
                            overflow: 'hidden', textOverflow: 'ellipsis',
                            whiteSpace: compactLayout ? 'normal' : 'nowrap', overflowWrap: 'anywhere' }}
                        >
                          {crumbs}
                        </Typography>
                      )}
                      {/* Tags only when they matched — the reason a row with
                          an unrelated name is in the list at all. */}
                      {tagRanges.length > 0 && (
                        <Typography
                          component="span"
                          data-search-tags
                          sx={{ fontSize: 11, color: 'text.secondary', minWidth: 0,
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                        >
                          {'tag: '}
                          {splitByRanges(tagText, tagRanges).map((part, i) => (part.match
                            ? <Box key={i} component="mark" sx={MARK_SX}>{part.text}</Box>
                            : <Fragment key={i}>{part.text}</Fragment>))}
                        </Typography>
                      )}
                    </Box>
                    {modeOf && modeLabel && (
                      <DocumentModeChip
                        mode={modeOf(hit)}
                        modeLabel={modeLabel}
                        testId={`model-search-mode-${key}`}
                      />
                    )}
                    {touchInput && (
                      <IconButton
                        size="small"
                        aria-label="Open"
                        tabIndex={-1}
                        disabled={busy}
                        onClick={(e) => { e.stopPropagation(); activate(hit); }}
                        onDoubleClick={(e) => e.stopPropagation()}
                        sx={{ width: 44, height: 44, flexShrink: 0 }}
                      >
                        <ChevronRight sx={{ fontSize: 20 }} />
                      </IconButton>
                    )}
                  </Box>
                );
              })}
            </Box>
          );
        })}
        {result.truncated && (
          <Typography data-testid="model-search-more" sx={{ fontSize: 11, color: 'text.secondary', px: 1, py: 0.5 }}>
            {result.total - shown} more matches — refine the search
          </Typography>
        )}
      </Box>
    </Box>
  );
}
