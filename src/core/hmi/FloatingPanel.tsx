// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * FloatingPanel — Reusable draggable, resizable floating panel for ECharts.
 *
 * Extracted from DriveChartOverlay to provide a consistent base for all
 * chart overlays (drive monitor, OEE, Parts/H, Cycle Time).
 *
 * Features: drag via title bar, resize via corner handle, ESC to close,
 * expand/collapse toggle, MUI Paper glassmorphism styling.
 */

import { useState, useRef, useEffect, useCallback, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Box, IconButton, Typography, Paper } from '@mui/material';
import { Close, UnfoldMore, UnfoldLess, DragIndicator } from '@mui/icons-material';
import { BOTTOM_BAR_HEIGHT } from './layout-constants';
import { useMobileLayout } from '../../hooks/use-mobile-layout';
import { getRecentAnchorPoint, placeAdjacentToAnchor, getCSSViewportSize, clientToCSS } from './panel-anchor-store';
import { getFloatingPanelRoot } from './HMIShell';

// ─── Constants ──────────────────────────────────────────────────────────

const MIN_W_DESKTOP = 400;
const MIN_W_MOBILE = 280;
const MIN_H = 200;
const BOTTOM_MARGIN = BOTTOM_BAR_HEIGHT + 12;
const LS_PREFIX = 'rv-panel-geo:';
const DBLCLICK_MS = 350;

// Open-order stack of mounted panels so Escape closes only the most
// recently opened one instead of every open panel at once.
const escStack: symbol[] = [];

// ─── Geometry persistence ──────────────────────────────────────────────

interface PanelGeometry {
  x: number; y: number;
  w: number; h: number;
}

function loadPanelGeometry(panelId: string): PanelGeometry | null {
  try {
    const raw = localStorage.getItem(LS_PREFIX + panelId);
    if (!raw) return null;
    const g = JSON.parse(raw) as PanelGeometry;
    if (typeof g.x === 'number' && typeof g.y === 'number' &&
        typeof g.w === 'number' && typeof g.h === 'number') return g;
  } catch { /* corrupt entry */ }
  return null;
}

function savePanelGeometry(panelId: string, geo: PanelGeometry): void {
  try { localStorage.setItem(LS_PREFIX + panelId, JSON.stringify(geo)); } catch { /* quota */ }
}

/** Tags that should NOT trigger drag when clicked. */
const INTERACTIVE_TAGS = new Set(['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SVG', 'PATH']);

export function isInteractive(el: HTMLElement): boolean {
  let cur: HTMLElement | null = el;
  while (cur) {
    if (INTERACTIVE_TAGS.has(cur.tagName)) return true;
    if (cur.getAttribute('role') === 'button') return true;
    // MUI Select renders its trigger as a div with role="combobox" — without this the
    // title-bar drag hook swallows the pointerdown and the dropdown never opens.
    if (cur.getAttribute('role') === 'combobox') return true;
    if (cur.classList?.contains('MuiInputBase-root')) return true;
    if (cur.classList?.contains('MuiToggleButton-root')) return true;
    if (cur.classList?.contains('MuiIconButton-root')) return true;
    if (cur.classList?.contains('MuiChip-root')) return true;
    if (cur.dataset?.dragHandle === 'true') break;
    cur = cur.parentElement;
  }
  return false;
}

// ─── Drag hook ──────────────────────────────────────────────────────────

export function useDrag(
  ref: React.RefObject<HTMLDivElement | null>,
  pos: { x: number; y: number },
  setPos: (p: { x: number; y: number }) => void,
  active = true,
) {
  const dragging = useRef(false);
  const offset = useRef({ x: 0, y: 0 });
  const posRef = useRef(pos);
  posRef.current = pos;

  useEffect(() => {
    if (!active) return;
    const el = ref.current;
    if (!el) return;

    const onDown = (e: PointerEvent) => {
      if (isInteractive(e.target as HTMLElement)) return;
      dragging.current = true;
      // Convert pointer coords (unzoomed viewport space) into the panel's
      // CSS-px coord system — pos.x/y is what's written to style.left/top
      // and lives inside the CSS-zoomed HMIShell. Mixing the two without
      // converting makes drag run zoom×-too-fast.
      offset.current = {
        x: clientToCSS(e.clientX) - posRef.current.x,
        y: clientToCSS(e.clientY) - posRef.current.y,
      };
      el.setPointerCapture(e.pointerId);
      e.preventDefault();
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging.current) return;
      setPos({
        x: clientToCSS(e.clientX) - offset.current.x,
        y: clientToCSS(e.clientY) - offset.current.y,
      });
    };
    const onUp = () => {
      dragging.current = false;
    };

    el.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      el.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, setPos, active]);
}

// ─── Resize hook ────────────────────────────────────────────────────────

export function useResize(
  ref: React.RefObject<HTMLDivElement | null>,
  size: { w: number; h: number },
  setSize: (s: { w: number; h: number }) => void,
  minW = MIN_W_DESKTOP,
  minH = MIN_H,
  active = true,
) {
  const resizing = useRef(false);
  const start = useRef({ mx: 0, my: 0, w: 0, h: 0 });
  const sizeRef = useRef(size);
  sizeRef.current = size;

  useEffect(() => {
    if (!active) return;
    const el = ref.current;
    if (!el) return;

    const onDown = (e: PointerEvent) => {
      resizing.current = true;
      // Same CSS-zoom conversion as useDrag — resize state (w, h) is in
      // CSS-px so the deltas computed from clientX/Y must be too.
      start.current = {
        mx: clientToCSS(e.clientX),
        my: clientToCSS(e.clientY),
        w: sizeRef.current.w,
        h: sizeRef.current.h,
      };
      el.setPointerCapture(e.pointerId);
      e.preventDefault();
      e.stopPropagation();
    };
    const onMove = (e: PointerEvent) => {
      if (!resizing.current) return;
      const dw = clientToCSS(e.clientX) - start.current.mx;
      const dh = clientToCSS(e.clientY) - start.current.my;
      setSize({
        w: Math.max(minW, start.current.w + dw),
        h: Math.max(minH, start.current.h + dh),
      });
    };
    const onUp = () => {
      resizing.current = false;
    };

    el.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      el.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, setSize, minW, minH, active]);
}

// ─── FloatingPanel Component ───────────────────────────────────────────────

export interface FloatingPanelProps {
  open: boolean;
  onClose: () => void;
  title: string;
  titleColor?: string;
  subtitle?: string;
  defaultWidth?: number;
  defaultHeight?: number;
  /** Desktop minimum width (resize floor + restore clamp). Defaults to 400 — set
   *  smaller for compact settings panels so they don't feel bulky. */
  minWidth?: number;
  defaultPosition?: { x: number; y: number };
  zIndex?: number;
  /** Stable key for localStorage geometry persistence. Defaults to title. */
  panelId?: string;
  /** Toolbar content rendered between title and expand/close buttons */
  toolbar?: ReactNode;
  children: ReactNode;
}

export function FloatingPanel({
  open,
  onClose,
  title,
  titleColor = '#4fc3f7',
  subtitle,
  defaultWidth = 700,
  defaultHeight = 340,
  minWidth,
  defaultPosition,
  zIndex = 1500,
  panelId,
  toolbar,
  children,
}: FloatingPanelProps) {
  const isMobile = useMobileLayout();
  const minW = isMobile ? MIN_W_MOBILE : (minWidth ?? MIN_W_DESKTOP);
  const stableId = panelId ?? title;
  // All dimension/position state lives in CSS-px (the coord system of
  // style.left/top inside the zoomed HMIShell). Use getCSSViewportSize()
  // wherever the calc would otherwise read window.innerWidth/Height.
  const cssVP0 = getCSSViewportSize();
  const expandedH = Math.round(cssVP0.h * 0.55);

  const mobileWidth = Math.min(defaultWidth, cssVP0.w - 16);
  const initialW = isMobile ? mobileWidth : defaultWidth;

  // Initial values are only relevant for the very first render; the
  // open-effect below re-anchors position whenever the panel re-opens, so
  // there's no need to derive these from a click that may have already
  // fled the freshness window.
  const [expanded, setExpanded] = useState(false);
  const [pos, setPos] = useState(() => defaultPosition ?? {
    x: isMobile ? 8 : 64,
    y: cssVP0.h - defaultHeight - BOTTOM_MARGIN,
  });
  const [size, setSize] = useState(() => ({ w: initialW, h: defaultHeight }));

  const dragRef = useRef<HTMLDivElement>(null);
  const resizeRef = useRef<HTMLDivElement>(null);

  // Refs that mirror current state — used by the resize listener (which
  // captures stale closures) and to remember pre-expand geometry without
  // touching localStorage.
  const posRef = useRef(pos);
  const sizeRef = useRef(size);
  posRef.current = pos;
  sizeRef.current = size;

  // Pre-expand snapshot so the collapse path can restore exactly where
  // the user left the panel. Lives in refs (session-only) — there is
  // intentionally NO persistence, the panel re-anchors fresh each open.
  const preExpandPos = useRef<{ x: number; y: number } | null>(null);
  const preExpandSize = useRef<{ w: number; h: number } | null>(null);

  useDrag(dragRef, pos, setPos, open);
  useResize(resizeRef, size, setSize, minW, MIN_H, open);

  /** Clamp (x, y) so the panel is fully inside the viewport. Leaves room
   *  for the left-sidebar ButtonPanel so the panel never covers its own
   *  trigger button. Operates in CSS-px (zoomed-container coords) — same
   *  coord system as panel state. */
  const clampToViewport = useCallback((x: number, y: number, w: number, h: number) => {
    const vp = getCSSViewportSize();
    const minX = isMobile ? 4 : 72; // 64px button column + 8 gutter
    const minY = 8;
    const maxX = Math.max(minX, vp.w - w - 8);
    const maxY = Math.max(minY, vp.h - h - BOTTOM_MARGIN);
    return {
      x: Math.max(minX, Math.min(x, maxX)),
      y: Math.max(minY, Math.min(y, maxY)),
    };
  }, [isMobile]);

  // ── On open: restore saved geometry or anchor near the user's click ──
  // If a saved geometry exists in localStorage, restore it. Otherwise
  // anchor next to the trigger (button, KPI card, context menu item).
  // Falls back to the consumer's defaultPosition prop, then bottom-left.
  useEffect(() => {
    if (!open) {
      // Persist geometry on close (before resetting expand state).
      if (!isMobile && posRef.current && sizeRef.current) {
        savePanelGeometry(stableId, {
          x: posRef.current.x, y: posRef.current.y,
          w: sizeRef.current.w, h: sizeRef.current.h,
        });
      }
      setExpanded(false);
      preExpandPos.current = null;
      preExpandSize.current = null;
      return;
    }

    const vp = getCSSViewportSize();

    // Try restoring saved geometry first
    const saved = !isMobile ? loadPanelGeometry(stableId) : null;
    if (saved) {
      const w = Math.max(minW, Math.min(saved.w, vp.w - 16));
      const h = Math.max(MIN_H, Math.min(saved.h, vp.h - BOTTOM_MARGIN - 8));
      setSize({ w, h });
      setPos(clampToViewport(saved.x, saved.y, w, h));
      return;
    }

    const w = isMobile ? Math.min(defaultWidth, vp.w - 16) : defaultWidth;
    const h = defaultHeight;
    setSize({ w, h });

    const anchor = getRecentAnchorPoint();
    let nextPos: { x: number; y: number };
    if (anchor) {
      nextPos = placeAdjacentToAnchor(anchor, w, h, vp.w);
    } else {
      nextPos = defaultPosition ?? {
        x: isMobile ? 8 : 64,
        y: vp.h - h - BOTTOM_MARGIN,
      };
    }
    setPos(clampToViewport(nextPos.x, nextPos.y, w, h));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Keep the panel in frame while the user resizes the browser.
  useEffect(() => {
    if (!open) return;
    const onResize = () => {
      const clamped = clampToViewport(posRef.current.x, posRef.current.y, sizeRef.current.w, sizeRef.current.h);
      if (clamped.x !== posRef.current.x || clamped.y !== posRef.current.y) {
        setPos(clamped);
      }
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Maximize when expanding (full viewport minus margins); restore the
  // pre-expand position on collapse from session refs.
  useEffect(() => {
    if (expanded) {
      preExpandPos.current = { ...posRef.current };
      preExpandSize.current = { ...sizeRef.current };
      const vp = getCSSViewportSize();
      const expandX = isMobile ? 0 : 64;
      const expandY = 8;
      const expandW = isMobile ? vp.w : vp.w - expandX - 8;
      const expandH = vp.h - expandY - BOTTOM_MARGIN;
      setPos({ x: expandX, y: expandY });
      setSize({ w: expandW, h: expandH });
    } else if (preExpandPos.current && preExpandSize.current) {
      setPos(preExpandPos.current);
      setSize(preExpandSize.current);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);

  // ── Double-click title bar to maximize/restore ──
  const lastClickTime = useRef(0);
  const handleTitleBarDoubleClick = useCallback(() => {
    const now = Date.now();
    if (now - lastClickTime.current < DBLCLICK_MS) {
      setExpanded(e => !e);
      lastClickTime.current = 0; // reset so triple-click doesn't re-fire
    } else {
      lastClickTime.current = now;
    }
  }, []);

  // ESC closes only the topmost (most recently opened) panel. The stack
  // entry is removed on close/unmount; siblings checking the stack top in
  // the same keydown still see the closing panel's id, so exactly one
  // panel closes per Escape press.
  const escId = useRef<symbol | null>(null);
  if (escId.current === null) escId.current = Symbol('floating-panel-esc');
  useEffect(() => {
    if (!open) return;
    const id = escId.current!;
    escStack.push(id);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && escStack[escStack.length - 1] === id) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      const i = escStack.indexOf(id);
      if (i >= 0) escStack.splice(i, 1);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  // Width-aware render-time clamp — backstop in case state ever lags
  // behind a viewport resize. Open-effect and resize-listener already
  // clamp via clampToViewport; this just guarantees the title bar stays
  // visible if both somehow miss a frame. CSS-px coords (zoom-aware).
  const _vpRender = getCSSViewportSize();
  const clampedX = Math.max(0, Math.min(pos.x, _vpRender.w - size.w - 8));
  const clampedY = Math.max(0, Math.min(pos.y, _vpRender.h - 40));

  const panel = (
    <Paper
      elevation={0}
      data-ui-panel
      sx={{
        position: 'fixed',
        left: clampedX,
        top: clampedY,
        width: size.w,
        height: size.h,
        zIndex,
        display: 'flex',
        flexDirection: 'column',
        borderRadius: 2,
        border: '1px solid rgba(255,255,255,0.08)',
        overflow: 'hidden',
        pointerEvents: 'auto',
        transition: expanded ? 'all 0.25s ease' : undefined,
        // DESIGN.md, FloatingPanel rule: draggable windows carry text and
        // values that must stay readable over ANY scene brightness, so they sit
        // on the darkest near-opaque glass — not the lighter floating tier the
        // theme's Paper default provides. A chart floating over a white floor
        // on 60 % glass put its own axis labels below 3:1.
        backgroundColor: 'rgba(15,15,15,0.92)',
      }}
    >
      {/* ── Draggable title bar ── */}
      <Box
        ref={dragRef}
        data-drag-handle="true"
        onPointerUp={handleTitleBarDoubleClick}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          px: 1,
          py: 0.25,
          borderBottom: '1px solid rgba(255,255,255,0.05)',
          flexShrink: 0,
          minHeight: 30,
          cursor: 'grab',
          userSelect: 'none',
          touchAction: 'none',
          '&:active': { cursor: 'grabbing' },
        }}
      >
        <DragIndicator sx={{ fontSize: 14, color: 'rgba(255,255,255,0.2)' }} />
        <Typography sx={{ fontSize: 11, fontWeight: 600, color: titleColor, letterSpacing: 0.3 }}>
          {title}
        </Typography>
        {subtitle && (
          <Typography sx={{ fontSize: 10, color: 'rgba(255,255,255,0.3)' }}>
            {subtitle}
          </Typography>
        )}

        {toolbar}

        <Box sx={{ ml: 'auto' }} />

        <IconButton
          size="small"
          aria-label={expanded ? 'Collapse window' : 'Expand window'}
          onClick={() => setExpanded((e) => !e)}
          sx={{ color: 'rgba(255,255,255,0.5)', p: 0.3, '&:hover': { color: '#fff' } }}
        >
          {expanded ? <UnfoldLess sx={{ fontSize: 16 }} /> : <UnfoldMore sx={{ fontSize: 16 }} />}
        </IconButton>

        <IconButton
          size="small"
          aria-label="Close window"
          onClick={onClose}
          sx={{ color: 'rgba(255,255,255,0.5)', p: 0.3, '&:hover': { color: '#fff' } }}
        >
          <Close sx={{ fontSize: 16 }} />
        </IconButton>
      </Box>

      {/* ── Content area ── */}
      <Box sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {children}
      </Box>

      {/* ── Resize handle (bottom-right corner) ── */}
      <Box
        ref={resizeRef}
        sx={{
          position: 'absolute',
          right: 0,
          bottom: 0,
          width: 24,
          height: 24,
          cursor: 'nwse-resize',
          touchAction: 'none',
          '&::after': {
            content: '""',
            position: 'absolute',
            right: 3,
            bottom: 3,
            width: 8,
            height: 8,
            borderRight: '2px solid rgba(255,255,255,0.15)',
            borderBottom: '2px solid rgba(255,255,255,0.15)',
            borderRadius: '0 0 4px 0',
          },
        }}
      />
    </Paper>
  );

  // Portal into HMIShell's floating-panel root so the panel's containing
  // block is HMIShell (not whichever Paper happens to host the consumer).
  // Theme-level `backdrop-filter: blur(...)` on every MuiPaper would
  // otherwise create a containing block for our `position: fixed` and
  // shift the panel by the host Paper's offset — making the top half of
  // the screen unreachable when dragging up. Falls back to inline render
  // if the portal root isn't mounted yet (server / first render race).
  const portalRoot = getFloatingPanelRoot();
  return portalRoot ? createPortal(panel, portalRoot) : panel;
}
