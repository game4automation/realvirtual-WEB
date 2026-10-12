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

import { useState, useRef, useEffect, useCallback, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Box, IconButton, Typography, Paper } from '@mui/material';
import { Close, UnfoldMore, UnfoldLess, DragIndicator, ExpandLess, ExpandMore } from '@mui/icons-material';
import { BOTTOM_BAR_HEIGHT } from './layout-constants';
import { useMobileLayout } from '../../hooks/use-mobile-layout';
import { getRecentAnchorPoint, placeAdjacentToAnchor, getCSSViewportSize, clientToCSS } from './panel-anchor-store';
import { getFloatingPanelRoot } from './HMIShell';
import { isContextActive, _subscribe as subscribeUiContext } from './ui-context-store';

// ─── Constants ──────────────────────────────────────────────────────────

const MIN_W_DESKTOP = 400;
const MIN_W_MOBILE = 280;
const MIN_H = 200;
const BOTTOM_MARGIN = BOTTOM_BAR_HEIGHT + 12;
/** px of the panel that must stay on screen so it can always be grabbed again. */
const TITLE_BAR_KEEP = 40;
/** px of a too-wide panel that must stay on screen, for the same reason. */
const EDGE_KEEP = 120;
const LS_PREFIX = 'rv-panel-geo:';
/** Collapsed state of a `collapsible` panel — plan-477 F2/F16. */
const LS_COLLAPSED_PREFIX = 'rv-panel-collapsed:';
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

/** Persisted collapsed state, or null when the panel has never been collapsed. */
function loadPanelCollapsed(panelId: string): boolean | null {
  try {
    const raw = localStorage.getItem(LS_COLLAPSED_PREFIX + panelId);
    if (raw === '1') return true;
    if (raw === '0') return false;
  } catch { /* unavailable */ }
  return null;
}

function savePanelCollapsed(panelId: string, collapsed: boolean): void {
  try { localStorage.setItem(LS_COLLAPSED_PREFIX + panelId, collapsed ? '1' : '0'); } catch { /* quota */ }
}

/**
 * Is the kiosk context active? (plan-477 F14.)
 *
 * A subscription rather than a read, so a panel folds away the moment a tour
 * starts. Only `collapsible` panels consult it — the 21 pre-existing panels are
 * not collapsible and therefore cannot be affected by it.
 */
function useKioskContext(): boolean {
  return useSyncExternalStore(
    subscribeUiContext,
    () => isContextActive('kiosk'),
    () => false,
  );
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
    // A slider is dragged with the same gesture the panel is — without this the
    // title-bar/handle drag swallows the grab and the window moves instead of
    // the thumb (plan-477 F9).
    if (cur.classList?.contains('MuiSlider-root')) return true;
    if (cur.classList?.contains('MuiSlider-thumb')) return true;
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
  /**
   * Called once after a drag this hook actually owned (plan-477 F3).
   *
   * Opt-in and side-effect-free by default: the `pointerup` listener is on
   * `window`, so it also sees the release of a drag that started anywhere else
   * on the page. Without the `dragging` guard a click in the 3D scene would
   * "end a drag" of every mounted panel. The 21 existing callers pass nothing
   * and are byte-for-byte unaffected.
   */
  onEnd?: () => void,
  host?: HTMLElement | null,
) {
  const dragging = useRef(false);
  const offset = useRef({ x: 0, y: 0 });
  const posRef = useRef(pos);
  posRef.current = pos;
  // In a ref, so passing a fresh closure each render never re-subscribes the
  // listeners (which would drop an in-flight drag).
  const onEndRef = useRef(onEnd);
  onEndRef.current = onEnd;

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
      const wasDragging = dragging.current;
      dragging.current = false;
      if (wasDragging) onEndRef.current?.();
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
  }, [ref, setPos, active, host]);
}

// ─── Resize hook ────────────────────────────────────────────────────────

export function useResize(
  ref: React.RefObject<HTMLDivElement | null>,
  size: { w: number; h: number },
  setSize: (s: { w: number; h: number }) => void,
  minW = MIN_W_DESKTOP,
  minH = MIN_H,
  active = true,
  /** Called once after a resize this hook actually owned — see {@link useDrag}. */
  onEnd?: () => void,
  host?: HTMLElement | null,
) {
  const resizing = useRef(false);
  const start = useRef({ mx: 0, my: 0, w: 0, h: 0 });
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const onEndRef = useRef(onEnd);
  onEndRef.current = onEnd;

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
      const wasResizing = resizing.current;
      resizing.current = false;
      if (wasResizing) onEndRef.current?.();
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
  }, [ref, setSize, minW, minH, active, host]);
}

// ─── FloatingPanel Component ───────────────────────────────────────────────

export interface FloatingPanelProps {
  open: boolean;
  /** Optional since plan-477: a `closable={false}` panel has nothing to close. */
  onClose?: () => void;
  /**
   * Can the user close this panel? Default `true` — the pre-plan-477 behaviour.
   *
   * `false` makes it a permanent fixture: no close button, no Escape entry, and
   * `open` is treated as `true` everywhere (a consumer that has no way to close
   * a panel has no way to reopen it either, so a stale `false` would be a dead
   * window). Its geometry is persisted at the end of each drag/resize instead of
   * on close, which is the moment a closable panel uses.
   */
  closable?: boolean;
  /** Show the collapse button (title bar only, content unmounted). Default `false`. */
  collapsible?: boolean;
  /** Remember the collapsed state under `rv-panel-collapsed:<panelId>`. Default `false`. */
  persistCollapsed?: boolean;
  /** Start collapsed when nothing is stored (plan-543 `WebOperatorPanel.StartCollapsed`). Default `false`. */
  defaultCollapsed?: boolean;
  /** Take the height from the content instead of `defaultHeight`. Default `false`. */
  autoHeight?: boolean;
  /** Render the resize handle. Default `true`. */
  resizable?: boolean;
  /** Landmark role. Only set when passed — no default, so the 21 existing panels keep none. */
  role?: string;
  'aria-label'?: string;
  title: string;
  titleColor?: string;
  subtitle?: string;
  defaultWidth?: number;
  /** Content-driven width in CSS pixels. Disables manual resize and expansion. */
  fixedWidth?: number;
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
  closable = true,
  collapsible = false,
  persistCollapsed = false,
  defaultCollapsed = false,
  autoHeight = false,
  resizable = true,
  role,
  'aria-label': ariaLabel,
  title,
  titleColor = '#4fc3f7',
  subtitle,
  defaultWidth = 700,
  fixedWidth,
  defaultHeight = 340,
  minWidth,
  defaultPosition,
  zIndex = 1500,
  panelId,
  toolbar,
  children,
}: FloatingPanelProps) {
  // Moving from the inline fallback into the shell portal replaces the DOM
  // handles. Rebind native drag/resize listeners to the new elements.
  const portalRoot = getFloatingPanelRoot();
  const isMobile = useMobileLayout();
  const minW = isMobile ? MIN_W_MOBILE : (minWidth ?? MIN_W_DESKTOP);
  const stableId = panelId ?? title;
  // A panel that cannot be closed is always open (F1). Every place that used
  // `open` to decide "is this panel alive right now" uses this instead.
  const effectiveOpen = closable ? open : true;
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
  // Collapsed ≠ expanded. `expanded` maximizes and keeps the content visible;
  // `collapsed` leaves the title bar and unmounts the content (plan-477 §2.4).
  // Mobile starts collapsed; a stored value wins over that default.
  const [collapsed, setCollapsed] = useState(() => {
    if (!collapsible) return false;
    const stored = persistCollapsed ? loadPanelCollapsed(stableId) : null;
    return stored ?? (defaultCollapsed || isMobile);
  });
  const [pos, setPos] = useState(() => defaultPosition ?? {
    x: isMobile ? 8 : 64,
    y: cssVP0.h - defaultHeight - BOTTOM_MARGIN,
  });
  const [storedSize, setSize] = useState(() => ({ w: initialW, h: defaultHeight }));
  const size = fixedWidth === undefined
    ? storedSize
    : { ...storedSize, w: Math.min(fixedWidth, cssVP0.w - 16) };

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

  // Kiosk forces the panel shut for the duration of the context, WITHOUT
  // touching the persisted value — leaving a tour restores what the user had
  // (F14/A1). Only collapsible panels can be affected.
  const kioskActive = useKioskContext();
  const effectiveCollapsed = collapsible && (collapsed || kioskActive);

  // The panel element, so `autoHeight` can be clamped against what it actually
  // measures rather than against the `defaultHeight` it is not using.
  const panelElRef = useRef<HTMLDivElement>(null);
  const currentH = useCallback(
    () => (autoHeight && panelElRef.current ? panelElRef.current.offsetHeight : sizeRef.current.h),
    [autoHeight],
  );

  // ── Geometry persistence for a panel that never closes (§2.5) ──
  // A closable panel writes its geometry in the `!open` branch below; a panel
  // that never closes never reaches it. So it writes at the end of each drag
  // and resize — and only the NORMAL geometry: maximized and collapsed are
  // transient states, and persisting either would restore a window the user
  // never arranged.
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const collapsedRef = useRef(effectiveCollapsed);
  collapsedRef.current = effectiveCollapsed;
  const persistGeometryNow = useCallback(() => {
    if (closable || isMobile) return;
    if (expandedRef.current || collapsedRef.current) return;
    savePanelGeometry(stableId, {
      x: posRef.current.x, y: posRef.current.y,
      w: sizeRef.current.w, h: sizeRef.current.h,
    });
  }, [closable, isMobile, stableId]);

  useDrag(dragRef, pos, setPos, effectiveOpen, closable ? undefined : persistGeometryNow, portalRoot);
  useResize(resizeRef, size, setSize, minW, MIN_H, effectiveOpen, closable ? undefined : persistGeometryNow, portalRoot);

  /** Clamp (x, y) so the panel is fully inside the viewport. Leaves room
   *  for the left-sidebar ButtonPanel so the panel never covers its own
   *  trigger button. Operates in CSS-px (zoomed-container coords) — same
   *  coord system as panel state. */
  const clampToViewport = useCallback((x: number, y: number, w: number, h: number) => {
    const vp = getCSSViewportSize();
    const minX = isMobile ? 4 : 72; // 64px button column + 8 gutter
    const minY = 8;
    // A panel BIGGER than the viewport used to collapse its own travel to a
    // single value: `Math.max(minY, vp.h - h - BOTTOM_MARGIN)` returns `minY`
    // once `h` exceeds the screen, so min and max met and the window became
    // undraggable along that axis. The ControlWindow lost its drag exactly that
    // way, twice, by growing one group too many — a panel must not stop moving
    // because of what a project put inside it.
    //
    // So the fit value is only a CEILING while it really is one. When it is
    // not, the panel keeps a real range and travels until its title bar is
    // about to leave — never past it, or there would be nothing left to grab.
    const fitX = vp.w - w - 8;
    const fitY = vp.h - h - BOTTOM_MARGIN;
    const maxX = fitX >= minX ? fitX : Math.max(minX, vp.w - EDGE_KEEP);
    const maxY = fitY >= minY ? fitY : Math.max(minY, vp.h - TITLE_BAR_KEEP);
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
    if (!effectiveOpen) {
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
  }, [effectiveOpen]);

  // Keep the panel in frame while the user resizes the browser.
  useEffect(() => {
    if (!effectiveOpen) return;
    const onResize = () => {
      const clamped = clampToViewport(posRef.current.x, posRef.current.y, sizeRef.current.w, currentH());
      if (clamped.x !== posRef.current.x || clamped.y !== posRef.current.y) {
        setPos(clamped);
      }
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveOpen]);

  // ── Collapse: persist, and leave maximize on the way in (§2.4) ──
  useEffect(() => {
    if (!collapsible || !persistCollapsed) return;
    savePanelCollapsed(stableId, collapsed);
  }, [collapsible, persistCollapsed, stableId, collapsed]);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((c) => {
      // Collapsing leaves maximize — the two states are exclusive, and
      // restoring a maximized window out of a collapsed one is nobody's intent.
      if (!c) setExpanded(false);
      return !c;
    });
  }, []);

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
  const handleTitleBarDoubleClick = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    // Same exemption the drag hook applies (F9): two quick taps on the collapse
    // button are two collapses, never a maximize.
    if (isInteractive(e.target as HTMLElement)) return;
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
    // A panel that cannot be closed takes no place on the Escape stack — not
    // even an inert one, or it would swallow the Escape meant for the panel
    // below it (F1).
    if (!effectiveOpen || !closable) return;
    const id = escId.current!;
    escStack.push(id);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && escStack[escStack.length - 1] === id) onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      const i = escStack.indexOf(id);
      if (i >= 0) escStack.splice(i, 1);
      window.removeEventListener('keydown', onKey);
    };
  }, [effectiveOpen, closable, onClose]);

  if (!effectiveOpen) return null;

  // Width-aware render-time clamp — backstop in case state ever lags
  // behind a viewport resize. Open-effect and resize-listener already
  // clamp via clampToViewport; this just guarantees the title bar stays
  // visible if both somehow miss a frame. CSS-px coords (zoom-aware).
  const _vpRender = getCSSViewportSize();
  const clampedX = Math.max(0, Math.min(pos.x, _vpRender.w - size.w - 8));
  const clampedY = Math.max(0, Math.min(pos.y, _vpRender.h - 40));

  const contentId = `rv-panel-content-${stableId.replace(/[^A-Za-z0-9_-]/g, '-')}`;

  const panel = (
    <Paper
      elevation={0}
      data-ui-panel
      ref={panelElRef}
      {...(role ? { role } : {})}
      {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}
      sx={{
        position: 'fixed',
        left: clampedX,
        top: clampedY,
        width: size.w,
        // Collapsed = title bar only; autoHeight = as tall as the content.
        height: effectiveCollapsed || autoHeight ? 'auto' : size.h,
        // ...but never taller than the screen it has to be dragged around in.
        // Without this an `autoHeight` panel grows with whatever a project puts
        // inside it, and a panel bigger than the viewport can no longer be
        // positioned freely (see `clampToViewport`) NOR read to the end. The
        // content area scrolls instead, so the window stays both movable and
        // complete. Position-independent on purpose: a cap that shrank as the
        // panel is dragged down would reflow the content under the pointer.
        maxHeight: Math.max(MIN_H, _vpRender.h - 8 - BOTTOM_MARGIN),
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
        onPointerUp={fixedWidth === undefined ? handleTitleBarDoubleClick : undefined}
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

        {collapsible && (
          <IconButton
            size="small"
            aria-label={effectiveCollapsed ? 'Expand panel' : 'Collapse panel'}
            aria-expanded={!effectiveCollapsed}
            aria-controls={contentId}
            onClick={toggleCollapsed}
            sx={{ color: 'rgba(255,255,255,0.5)', p: 0.3, '&:hover': { color: '#fff' } }}
          >
            {effectiveCollapsed ? <ExpandMore sx={{ fontSize: 16 }} /> : <ExpandLess sx={{ fontSize: 16 }} />}
          </IconButton>
        )}

        {!effectiveCollapsed && fixedWidth === undefined && (
          <IconButton
            size="small"
            aria-label={expanded ? 'Collapse window' : 'Expand window'}
            onClick={() => setExpanded((e) => !e)}
            sx={{ color: 'rgba(255,255,255,0.5)', p: 0.3, '&:hover': { color: '#fff' } }}
          >
            {expanded ? <UnfoldLess sx={{ fontSize: 16 }} /> : <UnfoldMore sx={{ fontSize: 16 }} />}
          </IconButton>
        )}

        {closable && (
          <IconButton
            size="small"
            aria-label="Close window"
            onClick={onClose}
            sx={{ color: 'rgba(255,255,255,0.5)', p: 0.3, '&:hover': { color: '#fff' } }}
          >
            <Close sx={{ fontSize: 16 }} />
          </IconButton>
        )}
      </Box>

      {/* ── Content area (unmounted while collapsed — F2) ── */}
      {!effectiveCollapsed && (
        <Box
          id={contentId}
          sx={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            // The overflow the `maxHeight` above creates has to go somewhere.
            // Only this area scrolls — the title bar stays put, so the drag
            // handle and the collapse button never scroll out of reach.
            overflowY: 'auto',
            overflowX: 'hidden',
          }}
        >
          {children}
        </Box>
      )}

      {/* ── Resize handle (bottom-right corner) ── */}
      {resizable && fixedWidth === undefined && !effectiveCollapsed && (
      <Box
        ref={resizeRef}
        data-resize-handle="true"
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
      )}
    </Paper>
  );

  // Portal into HMIShell's floating-panel root so the panel's containing
  // block is HMIShell (not whichever Paper happens to host the consumer).
  // Theme-level `backdrop-filter: blur(...)` on every MuiPaper would
  // otherwise create a containing block for our `position: fixed` and
  // shift the panel by the host Paper's offset — making the top half of
  // the screen unreachable when dragging up. Falls back to inline render
  // if the portal root isn't mounted yet (server / first render race).
  return portalRoot ? createPortal(panel, portalRoot) : panel;
}
