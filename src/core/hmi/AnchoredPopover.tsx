// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * AnchoredPopover — Generic 3D-anchored context popover layer (mounted once in App).
 *
 * Renders the active popoverStore request: projects its world anchor to screen every
 * frame (rAF, like TooltipLayer), positions a floating glass panel offset clear of the
 * anchor (so a gizmo at the point stays visible), and renders the registered content
 * component for the request id. The panel is draggable by its top grip — the user
 * displacement is kept in screen space so the panel still tracks the point during orbit.
 * Reusable for any component panel.
 */

import { useEffect, useRef, useSyncExternalStore, createElement } from 'react';
import { Box, Typography, IconButton } from '@mui/material';
import DragIndicatorIcon from '@mui/icons-material/DragIndicator';
import CloseIcon from '@mui/icons-material/Close';
import { popoverStore, popoverContentRegistry } from './popover-store';
import { projectPointToScreen } from './tooltip/tooltip-utils';
import { getUIZoom } from './visual-settings-store';
import { useViewer } from '../../hooks/use-viewer';

/** Default screen offset — far enough that the gizmo at the anchor stays fully visible. */
const DEFAULT_OFFSET = { x: 56, y: -24 };

export function AnchoredPopover() {
  const req = useSyncExternalStore(popoverStore.subscribe, popoverStore.getSnapshot);
  const viewer = useViewer();
  const ref = useRef<HTMLDivElement>(null);
  const rafRef = useRef(0);
  /** User drag displacement in client px (kept in a ref → no per-frame re-render). */
  const dragRef = useRef({ x: 0, y: 0 });

  // Escape dismisses the active popover.
  useEffect(() => {
    if (!req) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') popoverStore.hide(req.id); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [req]);

  // Follow the world anchor each frame (+ user drag displacement).
  useEffect(() => {
    if (!req) return;
    dragRef.current = { x: 0, y: 0 }; // new popover starts attached
    let mounted = true;
    const ox = req.offset?.x ?? DEFAULT_OFFSET.x;
    const oy = req.offset?.y ?? DEFAULT_OFFSET.y;
    const tick = () => {
      if (!mounted) return;
      const el = ref.current;
      if (el) {
        const s = projectPointToScreen(req.getWorld(), viewer.camera, viewer.renderer);
        if (s.visible) {
          const zoom = getUIZoom() || 1;
          const margin = 8;
          const vw = window.innerWidth / zoom;
          const vh = window.innerHeight / zoom;
          const w = el.offsetWidth;
          const h = el.offsetHeight;
          let left = (s.x + ox + dragRef.current.x) / zoom;
          let top = (s.y + oy + dragRef.current.y) / zoom;
          // Clamp into the viewport so the whole panel stays visible (never clipped
          // off-screen); if it is larger than the viewport, pin to the top-left margin.
          if (w > 0) left = Math.min(Math.max(margin, left), Math.max(margin, vw - w - margin));
          if (h > 0) top = Math.min(Math.max(margin, top), Math.max(margin, vh - h - margin));
          el.style.left = left + 'px';
          el.style.top = top + 'px';
          el.style.visibility = 'visible';
        } else {
          el.style.visibility = 'hidden';
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { mounted = false; cancelAnimationFrame(rafRef.current); };
  }, [req, viewer]);

  if (!req) return null;
  const Content = popoverContentRegistry.get(req.id);
  if (!Content) return null;

  const onGripDown = (e: React.PointerEvent) => {
    e.preventDefault(); e.stopPropagation();
    const startX = e.clientX, startY = e.clientY;
    const base = { ...dragRef.current };
    const move = (ev: PointerEvent) => { dragRef.current = { x: base.x + (ev.clientX - startX), y: base.y + (ev.clientY - startY) }; };
    const up = () => { window.removeEventListener('pointermove', move, true); window.removeEventListener('pointerup', up, true); };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
  };

  return (
    <Box
      ref={ref}
      data-rv-popover=""
      onPointerDown={(e) => e.stopPropagation()}
      sx={{
        position: 'fixed', left: 0, top: 0, visibility: 'hidden',
        pointerEvents: 'auto', zIndex: 1250,
        // Same translucent grey glass as the theme's Paper default (and the
        // error/alarm tiles), so every draggable window shares one surface tier.
        bgcolor: 'rgba(30,30,30,0.6)', backdropFilter: 'blur(calc(16px * var(--rv-ui-blur-scale, 1)))',
        border: '1px solid rgba(255,255,255,0.12)', borderRadius: 1,
        // The popover floats outside the app's font cascade — without this,
        // plain (non-Typography) content falls back to the browser serif.
        fontFamily: (t) => t.typography.fontFamily,
        willChange: 'left, top',
      }}
    >
      {/* Drag titlebar — shows the title + close when the request provides one
          (compact window), else just the drag grip. */}
      <Box
        onPointerDown={onGripDown}
        sx={{
          display: 'flex', alignItems: 'center', gap: 0.5,
          px: req.title ? 1 : 0, minHeight: req.title ? 22 : 16, cursor: 'move',
          color: 'rgba(255,255,255,0.4)',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
          borderRadius: '4px 4px 0 0', '&:hover': { color: 'rgba(255,255,255,0.7)' },
        }}
      >
        {req.title ? (
          <>
            <DragIndicatorIcon sx={{ fontSize: 13, transform: 'rotate(90deg)', flexShrink: 0 }} />
            <Typography sx={{ fontSize: 11, fontWeight: 700, color: '#4fc3f7', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {req.title}
            </Typography>
            <IconButton
              size="small"
              aria-label="close"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => popoverStore.hide(req.id)}
              sx={{ p: 0.25, color: 'rgba(255,255,255,0.6)', '&:hover': { color: '#fff' } }}
            >
              <CloseIcon sx={{ fontSize: 14 }} />
            </IconButton>
          </>
        ) : (
          <Box sx={{ flex: 1, display: 'flex', justifyContent: 'center' }}>
            <DragIndicatorIcon sx={{ fontSize: 14, transform: 'rotate(90deg)' }} />
          </Box>
        )}
      </Box>
      <Box sx={{ px: 1.25, py: 1 }}>{createElement(Content)}</Box>
    </Box>
  );
}
