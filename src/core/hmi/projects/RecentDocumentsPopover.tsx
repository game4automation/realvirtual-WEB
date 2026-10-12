// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Recently opened flyout shared by the Projects folder hover and keyboard shortcut.
 *
 * Since plan-507 it is a WAI-ARIA combobox: a search field on top keeps the DOM
 * focus while arrows move `aria-activedescendant` through the ranked list, so
 * typing, moving and choosing never fight over the focus. The list is ranked by
 * the shared scorer (`rv-search-score`); an empty term is the ring unchanged.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Stack, Typography, IconButton, Tooltip, Popper, InputBase } from '@mui/material';
import { Close, PushPin, PushPinOutlined, DeleteSweepOutlined, Search } from '@mui/icons-material';
import {
  cancelRecentDocumentsClose, getRecentDocumentsOpen, scheduleRecentDocumentsClose,
  setRecentDocumentsFocusInside, setRecentDocumentsPinned,
} from './projects-dashboard-store';
import { rangesOfField, rankBySearch, tokenizeSearchTerm } from '../../project/rv-search-score';
import { PROJECTS_DASHBOARD_ZINDEX } from '../layout-constants';
import { RecentDocumentRow, recentKey } from './RecentDocumentsSection';
import type { RecentDocumentsViewProps } from './RecentDocumentsSection';
import type { RecentDocumentEntry } from '../../project/rv-project-recents';
import { getFloatingPanelRoot } from '../HMIShell';
import { createPortal } from 'react-dom';

/** The listbox the combobox controls - one popover per session, so a fixed id is unique. */
const LISTBOX_ID = 'recent-documents-listbox';

export function RecentDocumentsPopover({
  open,
  autoFocus = true,
  entries,
  rowStates,
  modeLabel,
  modeOf,
  busy,
  onOpen,
  onClose,
  onForget,
  onClear,
}: Omit<RecentDocumentsViewProps, 'onForget'> & {
  onForget?: RecentDocumentsViewProps['onForget'];
  onClear?(): void;
  open: boolean;
  autoFocus?: boolean;
  onClose(): void;
}) {
  const [cursor, setCursor] = useState(0);
  const [pinned, setPinned] = useState(false);
  /** The type-ahead term. Local: it means nothing once the flyout is gone. */
  const [term, setTerm] = useState('');
  const panelRef = useRef<HTMLDivElement | null>(null);
  const anchor = document.querySelector<HTMLElement>('[data-recent-documents-trigger]');
  const inputRef = useRef<HTMLInputElement | null>(null);
  /**
   * Where the focus came from, so Escape can put it back.
   *
   * Captured on the OPEN transition rather than on mount: the component is
   * mounted for the whole session, and reading `activeElement` at mount time
   * would hand every close back to whatever was focused at boot.
   */
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    returnFocusRef.current = document.activeElement as HTMLElement | null;
    setCursor(0);
    setPinned(false);
    // Every open starts unfiltered - a term left over from the last visit
    // would hide the ring behind a search the user no longer remembers.
    setTerm('');
    // One frame late: the element has to be in the document before it can
    // take focus, and the portal mounts in the same commit as this effect.
    const id = requestAnimationFrame(() => { if (autoFocus) inputRef.current?.focus(); });
    return () => cancelAnimationFrame(id);
  }, [open, autoFocus]);

  const close = useCallback(() => {
    onClose();
    const back = returnFocusRef.current;
    returnFocusRef.current = null;
    // Guard both ways: the element may have been unmounted while the popover
    // was up (a mode switch behind it), and a detached node cannot take focus.
    if (back && back.isConnected && typeof back.focus === 'function') back.focus();
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target as HTMLElement;
      if (pinned || panelRef.current?.contains(target)
        || target.closest('[data-recent-documents-trigger], .MuiPopover-root')) return;
      // Clicking the workspace must leave focus at the clicked control.
      onClose();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented
        || (event.target instanceof Element && event.target.closest('.MuiPopover-root, .MuiDialog-root'))) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
    };
    document.addEventListener('pointerdown', dismiss);
    window.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      window.removeEventListener('keydown', escape, true);
    };
  }, [open, pinned, onClose, close]);

  /** Normalised term - what decides whether the cursor goes back to the top. */
  const termKey = tokenizeSearchTerm(term).join(' ');
  /** The ring, ranked by the term; non-matches dropped once a term is typed. */
  const ranked = useMemo(() => {
    const all = rankBySearch(entries, e => [e.documentName, e.projectName, e.documentPath], termKey);
    return termKey === '' ? all : all.filter(r => r.score !== null);
  }, [entries, termKey]);

  // `aria-activedescendant` does not scroll; the author has to (APG combobox).
  useEffect(() => {
    const current = ranked[cursor]?.item;
    if (open && current) document.getElementById(`recent-option-${recentKey(current)}`)?.scrollIntoView({ block: 'nearest' });
  }, [open, cursor, ranked]);

  // The ring changed under an unchanged term (a forget, a new open): keep the
  // cursor where it was, just inside the list.
  useEffect(() => {
    setCursor(c => Math.min(c, Math.max(0, ranked.length - 1)));
  }, [ranked.length]);

  const onTermChange = useCallback((value: string) => {
    setTerm(value);
    // A different term is a different question: Enter must open ITS best
    // answer, not whatever row the cursor sat on in the previous list. A
    // trailing space changes nothing and keeps the cursor.
    if (tokenizeSearchTerm(value).join(' ') !== termKey) setCursor(0);
  }, [termKey]);

  const choose = useCallback((entry: RecentDocumentEntry) => {
    // Close FIRST. The chain's target mode may unmount the host this popover
    // lives in (`mode:viewer`), and a popover that is still open when that
    // happens disappears without ever returning the focus it took.
    if (!pinned) close();
    onOpen(entry);
  }, [close, onOpen, pinned]);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (ranked.length === 0 && e.key !== 'Escape') return;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setCursor(c => Math.min(c + 1, ranked.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setCursor(c => Math.max(c - 1, 0));
        break;
      case 'Home':
        e.preventDefault();
        setCursor(0);
        break;
      case 'End':
        e.preventDefault();
        setCursor(ranked.length - 1);
        break;
      case 'Enter': {
        // An IME is still composing: this Enter commits the composition, it
        // does not choose a row (WebKit reports it as keyCode 229).
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
        e.preventDefault();
        const entry = ranked[cursor]?.item;
        if (entry && !busy) choose(entry);
        break;
      }
      case 'Escape':
        // Stopped, not just handled: the dashboard shell closes itself on a
        // window-level Escape, and one press must dismiss ONE thing.
        e.preventDefault();
        e.stopPropagation();
        close();
        break;
      default:
        break;
    }
  }, [ranked, cursor, busy, choose, close]);

  /**
   * Focus entering the panel keeps a hover-opened flyout open; focus leaving it
   * - to another element or to nowhere (`relatedTarget === null`) - lets the
   * hover timer run again (plan-507 SOL-3).
   */
  const onPanelFocus = useCallback(() => setRecentDocumentsFocusInside(true), []);
  const onPanelBlur = useCallback((e: React.FocusEvent) => {
    const next = e.relatedTarget as Node | null;
    if (next && panelRef.current?.contains(next)) return;
    setRecentDocumentsFocusInside(false);
    if (getRecentDocumentsOpen()) scheduleRecentDocumentsClose();
  }, []);

  if (!open) return null;
  const active = ranked[cursor]?.item;
  const activeId = active ? `recent-option-${recentKey(active)}` : undefined;
  const content = (
    <Popper
      open
      anchorEl={anchor ?? { getBoundingClientRect: () => new DOMRect(48, 72, 0, 0) }}
      placement="right-start"
      disablePortal
      popperOptions={{ strategy: 'fixed' }}
      modifiers={[
        { name: 'offset', options: { offset: [0, 8] } },
        { name: 'flip', options: { fallbackPlacements: ['left-start', 'bottom-end', 'bottom-start'] } },
        { name: 'preventOverflow', options: { padding: 8, rootBoundary: 'viewport' } },
      ]}
      sx={{ zIndex: PROJECTS_DASHBOARD_ZINDEX + 10, pointerEvents: 'auto' }}
    >
    <Box ref={panelRef} id="recent-documents-flyout" data-ui-panel
      onMouseEnter={cancelRecentDocumentsClose} onMouseLeave={scheduleRecentDocumentsClose}
      onFocusCapture={onPanelFocus} onBlur={onPanelBlur}
      sx={{ width: 'min(400px, calc(100vw - 16px))', boxSizing: 'border-box', p: 1.5,
        borderRadius: 1.5, bgcolor: '#1e1e1e', color: 'text.primary', boxShadow: 8 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 1 }}>
        <Typography sx={{ flex: 1, fontSize: 13, fontWeight: 600 }}>Recently opened</Typography>
        {onClear && <Tooltip title="Clear recently opened">
          <IconButton size="small" aria-label="Clear recently opened" disabled={busy || !entries.length}
            onClick={onClear} data-testid="recent-documents-clear"><DeleteSweepOutlined fontSize="small" /></IconButton>
        </Tooltip>}
        <Tooltip title={pinned ? 'Unpin recently opened' : 'Keep open while working'}>
          <IconButton size="small" aria-label="Pin recently opened" aria-pressed={pinned}
            onClick={() => { setRecentDocumentsPinned(!pinned); setPinned(!pinned); }} color={pinned ? 'primary' : 'default'}>
            {pinned ? <PushPin fontSize="small" /> : <PushPinOutlined fontSize="small" />}
          </IconButton>
        </Tooltip>
        <IconButton size="small" aria-label="Close recently opened" onClick={close}><Close fontSize="small" /></IconButton>
      </Box>
      <Box sx={{
        display: 'flex', alignItems: 'center', gap: 0.75, mb: 1, px: 1, height: 32,
        borderRadius: 1, border: '1px solid rgba(255,255,255,0.14)', bgcolor: 'rgba(255,255,255,0.04)',
        '&:focus-within': { borderColor: 'primary.main' },
      }}>
        <Search sx={{ fontSize: 16, color: 'text.disabled' }} />
        <InputBase
          inputRef={inputRef}
          value={term}
          onChange={(e) => onTermChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Search recently opened…"
          fullWidth
          inputProps={{
            role: 'combobox',
            'aria-label': 'Search recently opened',
            'aria-expanded': true,
            'aria-controls': LISTBOX_ID,
            'aria-activedescendant': activeId,
            'aria-autocomplete': 'list',
            autoComplete: 'off',
            spellCheck: false,
            'data-testid': 'recent-documents-search',
          }}
          sx={{ fontSize: 13, flex: 1 }}
        />
      </Box>
      <Box
        id={LISTBOX_ID} tabIndex={-1} role="listbox"
        aria-label="Recently opened documents"
        data-testid="recent-documents-popover"
        sx={{ maxHeight: 'min(480px, calc(100dvh - 180px))', overflowY: 'auto', outline: 'none' }}
      >
      {entries.length === 0 ? (
        <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>
          Nothing opened yet.
        </Typography>
      ) : ranked.length === 0 ? (
        <Typography data-testid="recent-documents-no-match" sx={{ fontSize: 13, color: 'text.secondary' }}>
          Nothing matches
        </Typography>
      ) : (
        <Stack spacing={0.75}>
          {ranked.map(({ item: e, score }, i) => (
            <Box key={recentKey(e)}>
              <RecentDocumentRow
                id={`recent-option-${recentKey(e)}`}
                entry={e}
                state={rowStates.get(e.projectId)}
                modeLabel={modeLabel}
                modeOf={modeOf}
                busy={busy}
                selected={i === cursor}
                compact
                highlight={rangesOfField(score, 0)}
                onOpen={() => choose(e)}
                onForget={onForget ? () => onForget(e) : undefined}
              />
            </Box>
          ))}
        </Stack>
      )}
      </Box>
    </Box>
    </Popper>
  );
  // Portalled when the shell is up, inline otherwise — the same fallback
  // `ProjectsDashboard` uses, so a harness that renders this component alone
  // still gets a list instead of a crash.
  const root = getFloatingPanelRoot();
  return root ? createPortal(content, root) : content;
}
