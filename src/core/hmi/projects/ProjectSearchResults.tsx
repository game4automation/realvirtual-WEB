// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ProjectSearchResults — the open project's search, as one flat list
 * (plan-507 F7–F14).
 *
 * The cards show ONE folder; a search answers "where is this thing" across all
 * of them and across every attached library. So while a term is typed the card
 * grid gives way to this list: one row per hit, grouped by root in root order,
 * each row naming the folders it sits in. The tree column stays as it is.
 *
 * ## Verbs, and why arrows only move the focus
 *
 * Click selects (the detail pane follows). Enter and double-click select AND
 * activate: an asset opens, a folder is navigated to (the host clears the
 * search, so the folder's cards appear). Arrows, Home and End move the DOM
 * focus only — roving `tabIndex` — never the dashboard selection: in the
 * compact layout a selection raises the detail sheet, and a sheet popping up on
 * every arrow press would pull the focus out of the list it is walking.
 *
 * ## Marked for the detail sheet
 *
 * The container carries `data-folder-contents` and each row `data-card-path` /
 * `data-card-selected`, the marks `ProjectsDetailSheet.returnFocus` looks for.
 * They exist only while the list is rendered — the host renders either this or
 * the card grid, never both — so the sheet hands the focus back to the row it
 * described.
 */

import { Fragment, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Box, IconButton, Typography } from '@mui/material';
import {
  ChevronRight, Folder, FolderOutlined, InsertDriveFileOutlined, ViewInArOutlined,
} from '@mui/icons-material';
import { SectionHeader } from '../shared-components';
import { collapseCrumbs, isCollapsedCrumbs } from './mobile-folder-view';
import { MARK_SX } from './RecentDocumentsSection';
import type { ProjectTreeNode } from '../../project/rv-project-tree';
import {
  isActivatableSearchNode, shownSearchHits,
  type ProjectSearchHit, type ProjectSearchResult,
} from '../../project/rv-project-tree-search';
import { rangesOfField, splitByRanges } from '../../project/rv-search-score';

export interface ProjectSearchResultsProps {
  result: ProjectSearchResult;
  /** Tree path of the dashboard selection, for the selected row. */
  selectedPath: string | null;
  compactLayout?: boolean;
  /** Coarse pointer: activatable rows get an explicit "Open" chevron. */
  touchInput?: boolean;
  onSelect(node: ProjectTreeNode): void;
  onActivate(node: ProjectTreeNode): void;
}

/** Breadcrumb levels shown before the middle folds into an ellipsis. */
const MAX_CRUMBS = 4;

function RowIcon({ node }: { node: ProjectTreeNode }) {
  const sx = { fontSize: 16, flexShrink: 0, color: 'rgba(255,255,255,0.5)' };
  if (node.kind === 'folder') {
    return node.children.length > 0 ? <Folder sx={sx} /> : <FolderOutlined sx={sx} />;
  }
  if (node.kind === 'document') return <ViewInArOutlined sx={sx} />;
  return <InsertDriveFileOutlined sx={sx} />;
}

/** "models / … / lines" — the folders a hit sits in, root excluded. */
function crumbText(hit: ProjectSearchHit): string {
  return collapseCrumbs(hit.entry.crumbs, MAX_CRUMBS)
    .map(c => (isCollapsedCrumbs(c) ? '…' : c.name))
    .join(' / ');
}

export function ProjectSearchResults({
  result,
  selectedPath,
  compactLayout = false,
  touchInput = false,
  onSelect,
  onActivate,
}: ProjectSearchResultsProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rowEls = useRef(new Map<string, HTMLElement>());
  /** The row holding the roving tab stop — by path, so it survives re-ranking. */
  const [focusPath, setFocusPath] = useState<string | null>(null);
  /** The row that last held the DOM focus and has not handed it on yet. */
  const focusedPathRef = useRef<string | null>(null);

  const hits = useMemo(() => result.groups.flatMap(g => g.hits), [result]);
  const paths = useMemo(() => hits.map(h => h.entry.node.path!), [hits]);
  const shown = shownSearchHits(result);

  const tabStop = focusPath && paths.includes(focusPath)
    ? focusPath
    : selectedPath && paths.includes(selectedPath) ? selectedPath : paths[0] ?? null;

  /**
   * Focus repair (plan-507 SOL-R2-1): ONLY when the row that carried the focus
   * was filtered away. The focus then fell to `body`; the container catches it
   * so the keyboard user is still in the list. A focus in the search field is
   * left strictly alone — a selected row vanishing is not a focus event.
   */
  useLayoutEffect(() => {
    const lost = focusedPathRef.current;
    if (!lost || paths.includes(lost)) return;
    focusedPathRef.current = null;
    const active = document.activeElement;
    if (active === null || active === document.body) containerRef.current?.focus();
  }, [paths]);

  const focusRow = useCallback((path: string | undefined) => {
    if (!path) return;
    setFocusPath(path);
    rowEls.current.get(path)?.focus();
  }, []);

  const activate = useCallback((node: ProjectTreeNode) => {
    onSelect(node);
    if (isActivatableSearchNode(node)) onActivate(node);
  }, [onSelect, onActivate]);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    const target = e.target as HTMLElement;
    const path = target.getAttribute('data-card-path');
    if (!path) return;
    const at = paths.indexOf(path);
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); focusRow(paths[Math.min(at + 1, paths.length - 1)]); break;
      case 'ArrowUp': e.preventDefault(); focusRow(paths[Math.max(at - 1, 0)]); break;
      case 'Home': e.preventDefault(); focusRow(paths[0]); break;
      case 'End': e.preventDefault(); focusRow(paths[paths.length - 1]); break;
      case 'Enter': {
        e.preventDefault();
        const hit = hits[at];
        if (hit) activate(hit.entry.node);
        break;
      }
      default: break;
    }
  }, [paths, hits, focusRow, activate]);

  if (result.total === 0) {
    return (
      <Box
        data-folder-contents
        tabIndex={-1}
        ref={containerRef}
        sx={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', alignItems: 'center',
          justifyContent: 'center', p: 3, outline: 'none' }}
      >
        <Typography sx={{ fontSize: 12, color: 'rgba(255,255,255,0.45)', textAlign: 'center' }}>
          Nothing in this project matches the search.
        </Typography>
      </Box>
    );
  }

  return (
    <Box
      ref={containerRef}
      data-folder-contents
      data-testid="project-search-results"
      role="listbox"
      aria-label="Search results"
      // Programmatic focus only: where the focus lands when its row vanished
      // and where the detail sheet falls back to.
      tabIndex={-1}
      onKeyDown={onKeyDown}
      sx={{ flex: 1, minWidth: 0, minHeight: 0, overflowY: 'auto', overflowX: 'hidden',
        px: compactLayout ? 1 : 1.5, py: 1, outline: 'none' }}
    >
      <Typography sx={{ fontSize: 11, color: 'text.secondary', mb: 0.5 }}>
        {result.total} match{result.total === 1 ? '' : 'es'}
      </Typography>
      {result.groups.map(group => (
        <Box key={group.rootId} role="group" aria-label={group.rootName} sx={{ mb: 1 }}>
          <Box sx={{ py: 0.5 }}>
            <SectionHeader>
              {group.rootKind === 'catalog' ? `Library: ${group.rootName}` : group.rootName}
            </SectionHeader>
          </Box>
          {group.hits.map(hit => {
            const node = hit.entry.node;
            const path = node.path!;
            const selected = path === selectedPath;
            const crumbs = crumbText(hit);
            const fullPath = hit.entry.crumbs.map(c => c.name).concat(node.name).join(' / ');
            const canOpen = isActivatableSearchNode(node);
            return (
              <Box
                key={path}
                ref={(el: HTMLElement | null) => {
                  if (el) rowEls.current.set(path, el);
                  else rowEls.current.delete(path);
                }}
                role="option"
                aria-selected={selected}
                tabIndex={path === tabStop ? 0 : -1}
                data-card-path={path}
                data-card-selected={selected ? 'true' : undefined}
                title={fullPath}
                onClick={() => onSelect(node)}
                onDoubleClick={() => activate(node)}
                onFocus={(e) => {
                  if (e.target !== e.currentTarget) return;
                  focusedPathRef.current = path;
                  setFocusPath(path);
                }}
                onBlur={(e) => {
                  // A real hand-over (to another element) ends the claim; a
                  // blur to nowhere may be this row being filtered away, which
                  // the repair above must still see.
                  if (e.target === e.currentTarget && e.relatedTarget !== null) {
                    focusedPathRef.current = null;
                  }
                }}
                sx={{
                  display: 'flex', alignItems: 'center', gap: 1,
                  minHeight: touchInput ? 44 : 28, px: 1, py: compactLayout ? 0.5 : 0.25,
                  borderRadius: 1, cursor: 'pointer', userSelect: 'none', outline: 'none',
                  bgcolor: selected ? 'rgba(79,195,247,0.12)' : 'transparent',
                  '&:focus-visible': { boxShadow: 'inset 0 0 0 2px #4fc3f7' },
                  ...(touchInput
                    ? { '&:active': { bgcolor: 'rgba(255,255,255,0.10)' } }
                    : { '&:hover': { bgcolor: selected ? 'rgba(79,195,247,0.16)' : 'rgba(255,255,255,0.06)' } }),
                }}
              >
                <RowIcon node={node} />
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
                    {splitByRanges(node.name, rangesOfField(hit.score, 0)).map((part, i) => (part.match
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
                </Box>
                {touchInput && canOpen && (
                  <IconButton
                    size="small"
                    aria-label="Open"
                    tabIndex={-1}
                    onClick={(e) => { e.stopPropagation(); activate(node); }}
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
      ))}
      {result.truncated && (
        <Typography data-testid="project-search-more" sx={{ fontSize: 11, color: 'text.secondary', px: 1, py: 0.5 }}>
          {result.total - shown} more matches — refine the search
        </Typography>
      )}
    </Box>
  );
}
