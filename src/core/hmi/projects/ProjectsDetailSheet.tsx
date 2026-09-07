// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ProjectsDetailSheet — the detail pane as a bottom sheet (plan-458 §2.4).
 *
 * On a phone the dashboard's third column has nowhere to be: 280 + grid + 260
 * does not fit 390px, and a column pushed off-screen is worse than no column.
 * The selection's facts and verbs rise from the bottom instead, over a grid
 * that stays visible — which is what keeps "this is the card I just tapped"
 * legible, and is the same idiom `MobileSelectionSheet` already uses for the
 * scene inspector.
 *
 * ## Why the lifecycle is three states and not `open`
 *
 * A sheet that merely stops rendering cannot animate out, and one that keeps
 * rendering until the animation ends stays in the tab order and the
 * accessibility tree for a fifth of a second after the user dismissed it —
 * long enough for a screen reader to read a panel that is visibly leaving.
 *
 * So: `open` is the caller's intent, `mounted` is whether the DOM exists, and
 * `closing` is the exit in flight. On close the sheet leaves the a11y tree and
 * the tab order in the SAME commit (`aria-hidden` + `inert` +
 * `pointer-events: none`, set from a layout effect), and unmounts when the
 * transition reports done — or after a fallback timer, because a
 * `transitionend` that never arrives must not leave a sheet mounted forever.
 * Under `prefers-reduced-motion` there is no exit at all: it unmounts at once.
 *
 * No swipe-to-dismiss. The close button is the exit, and a gesture whose only
 * discoverability is that other apps have it is not worth the handler.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Box, Paper } from '@mui/material';
import { WINDOW_DARK_BG } from '../LeftPanel';
import { MOBILE_SHEET_HEIGHT, MOBILE_SHEET_MAX_HEIGHT } from '../layout-constants';
import { ProjectsDetailPane, type ProjectsDetailPaneProps } from './ProjectsDetailPane';

/** Exit duration and its fallback — the fallback outlives the transition. */
const EXIT_MS = 200;
const EXIT_FALLBACK_MS = 220;

export interface ProjectsDetailSheetProps {
  /** Should the sheet be up? The host derives it from the selection kind. */
  open: boolean;
  /** The close button. Dismisses the sheet and LEAVES the selection standing. */
  onClose: () => void;
  /** Everything the pane needs — passed through untouched. */
  detail: ProjectsDetailPaneProps;
}

function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function'
    && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function ProjectsDetailSheet({ open, onClose, detail }: ProjectsDetailSheetProps) {
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);
  // Separate from `mounted` so the entrance has a frame to transition FROM:
  // mounting at `translateY(0)` would show the sheet already in place.
  const [entered, setEntered] = useState(false);
  const paperRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    if (open) {
      setMounted(true);
      setClosing(false);
      return;
    }
    if (!mounted) return;
    if (prefersReducedMotion()) {
      setMounted(false);
      setEntered(false);
      return;
    }
    setClosing(true);
    const t = setTimeout(() => { setMounted(false); setClosing(false); setEntered(false); },
      EXIT_FALLBACK_MS);
    return () => clearTimeout(t);
  }, [open, mounted]);

  useEffect(() => {
    if (!mounted || !open) { setEntered(false); return; }
    if (prefersReducedMotion()) { setEntered(true); return; }
    const id = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(id);
  }, [mounted, open]);

  /**
   * Focus in on open, and back where it came from on close.
   *
   * "Where it came from" is the selected card, found by the mark the grid puts
   * on it — the sheet does not know which path it is showing, and asking it to
   * would make it care about the grid's identity scheme. The grid itself is
   * the fallback, so focus never lands on `document.body`.
   */
  const returnFocus = useCallback(() => {
    const card = document.querySelector<HTMLElement>('[data-card-path][data-card-selected="true"]');
    (card ?? document.querySelector<HTMLElement>('[data-folder-contents]'))?.focus?.();
  }, []);

  // Keyed on `mounted && open`, not on `open` alone: the render where `open`
  // first turns true has no DOM yet (the layout effect above mounts it), so a
  // focus call there would land on nothing and never be retried.
  const wasUp = useRef(false);
  useEffect(() => {
    const up = mounted && open;
    const was = wasUp.current;
    wasUp.current = up;
    if (up && !was) {
      paperRef.current?.querySelector<HTMLElement>('[aria-label="Close details"]')?.focus();
    }
    // On the way out focus leaves at once — it may not sit inside an element
    // that is about to be `inert`.
    if (!up && was) returnFocus();
  }, [mounted, open, returnFocus]);

  if (!mounted) return null;

  return (
    <Paper
      elevation={0}
      data-ui-panel
      data-testid="projects-detail-sheet"
      ref={paperRef}
      aria-hidden={closing || undefined}
      inert={closing || undefined}
      onTransitionEnd={(e) => {
        // Only the sheet's own slide, never a transition bubbling up from a
        // button inside it.
        if (closing && e.target === e.currentTarget) {
          setMounted(false);
          setClosing(false);
          setEntered(false);
        }
      }}
      sx={{
        position: 'absolute', left: 0, right: 0, bottom: 0,
        height: MOBILE_SHEET_HEIGHT, maxHeight: MOBILE_SHEET_MAX_HEIGHT,
        backgroundColor: `${WINDOW_DARK_BG} !important`,
        borderTop: '1px solid rgba(255,255,255,0.08)',
        borderRadius: '8px 8px 0 0',
        display: 'flex', flexDirection: 'column',
        // No safe-area padding of its own: unlike `MobileSelectionSheet` this
        // sheet is absolute INSIDE the dashboard shell, and the shell already
        // reserves `env(safe-area-inset-bottom)`. Reserving it twice would
        // leave a second empty strip above the home indicator.
        // Only transform and opacity — a bottom sheet animating its HEIGHT
        // relayouts the grid behind it on every frame.
        transform: entered && !closing ? 'none' : 'translateY(100%)',
        transition: `transform ${EXIT_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`,
        '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
        pointerEvents: closing ? 'none' : 'auto',
      }}
    >
      {/* Grab handle — a statement that this surface belongs to the bottom
          edge, not an affordance: there is no drag behind it (§2.4). */}
      <Box sx={{ display: 'flex', justifyContent: 'center', pt: 0.75, pb: 0.25, flexShrink: 0 }}>
        <Box sx={{ width: 32, height: 4, borderRadius: '2px', bgcolor: 'rgba(255,255,255,0.22)' }} />
      </Box>
      <ProjectsDetailPane {...detail} variant="sheet" onClose={onClose} />
    </Paper>
  );
}
