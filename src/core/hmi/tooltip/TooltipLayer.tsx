// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * TooltipLayer — Renders all visible tooltips with positioning, clamping, and styling.
 *
 * Consumes the TooltipStore via useTooltipState() and renders one glassmorphic
 * bubble per VisibleTooltip. Each bubble may contain multiple vertically stacked
 * content providers when an object has several applicable tooltip types.
 *
 * Positioning modes (per bubble):
 * - cursor: follows mouse pointer (ref-based updates via getCursorPos, polled at 100ms)
 * - world: projects a 3D Object3D to screen coordinates (polled at 100ms)
 * - fixed: uses a fixed screen position directly
 */

import { useCallback, useEffect, useRef, type FC } from 'react';
import { Box, Divider } from '@mui/material';
import { useTooltipState } from '../../../hooks/use-tooltip';
import { tooltipStore } from './tooltip-store';
import { tooltipRegistry } from './tooltip-registry';
import { projectToScreen, projectPointToScreen, clampToViewport } from './tooltip-utils';
import { useViewer } from '../../../hooks/use-viewer';
import { getUIZoom } from '../visual-settings-store';
import { BOTTOM_BAR_HEIGHT } from '../layout-constants';
import { useOverlayVisible } from '../../../hooks/use-overlay-visible';
import { registerOverlayProducer, unregisterOverlayProducer } from '../../overlay-visibility-store';
import type { VisibleTooltip } from './tooltip-store';
import type { ContextMenuTarget } from '../context-menu-store';

/** Cursor tooltip: small down-right gap, standard OS pattern. Bubble anchors
 *  at its top-left so the cursor sits close to the bubble's upper-left corner. */
const CURSOR_OFFSET_X = 14;
const CURSOR_OFFSET_Y = 14;
/** World / fixed tooltip: bubble floats above the anchor (translateY(-100%)).
 *  Small vertical gap keeps the bubble visually attached to the object. */
const WORLD_OFFSET_X = 0;
const WORLD_OFFSET_Y = -8;
const TOOLTIP_MIN_WIDTH = 160;
const TOOLTIP_EST_HEIGHT = 120;
const VIEWPORT_MARGIN = 10;
/** Keep tooltips clear of the fixed BottomBar search cluster (bottom: 8 + bar
 *  height). The bubble has a higher z-index than the search bar (1300 > 1200),
 *  so without this reserve a tooltip anchored low would render on top of — and
 *  visually occlude — the search field. Shrinking the clamp's effective viewport
 *  height by this amount pushes any low tooltip up above the bar instead. */
const BOTTOM_SAFE_AREA = BOTTOM_BAR_HEIGHT + 8;

// ─── Single Tooltip Bubble ──────────────────────────────────────────────

interface SingleTooltipBubbleProps {
  tooltip: VisibleTooltip;
}

const SingleTooltipBubble: FC<SingleTooltipBubbleProps> = ({ tooltip }) => {
  const viewer = useViewer();
  const tooltipRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef(0);
  const { primary } = tooltip;
  const isPinned = primary.lifecycle === 'pinned';

  // Right-click on pinned tooltip opens context menu for the target node
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (!isPinned) return;
    e.preventDefault();
    e.stopPropagation();

    const path = primary.targetPath;
    if (!path) return;
    const node = viewer.registry?.getNode(path);
    if (!node) return;

    const target: ContextMenuTarget = {
      path,
      node,
      types: viewer.registry!.getComponentTypes(path),
      extras: (node.userData?.realvirtual ?? {}) as Record<string, unknown>,
    };

    if (viewer.raycastManager) {
      viewer.raycastManager.holdHover = true;
      const isLayout = !!(node.userData?.realvirtual as Record<string, unknown> | undefined)?.LayoutObject;
      viewer.highlighter.highlight(node, false, { includeChildDrives: isLayout });
    }
    viewer.contextMenu.open({ x: e.clientX, y: e.clientY }, target);
  }, [isPinned, primary.targetPath, viewer]);

  useEffect(() => {
    let mounted = true;

    const tick = () => {
      if (!mounted) return;
      const el = tooltipRef.current;

      // Cursor tooltips anchor top-left (bubble appears below-right of cursor).
      // World / fixed tooltips anchor bottom-left via translateY(-100%) set below,
      // so the bubble floats above the anchor and doesn't occlude the object.
      const isCursor = primary.mode === 'cursor';
      const defaultX = isCursor ? CURSOR_OFFSET_X : WORLD_OFFSET_X;
      const defaultY = isCursor ? CURSOR_OFFSET_Y : WORLD_OFFSET_Y;
      const offsetX = primary.offset?.x ?? defaultX;
      const offsetY = primary.offset?.y ?? defaultY;

      let rawX = 0;
      let rawY = 0;
      let show = true;

      if (primary.mode === 'cursor') {
        const cursorPos = tooltipStore.getCursorPos(primary.id);
        if (!cursorPos) { show = false; }
        else { rawX = cursorPos.x + offsetX; rawY = cursorPos.y + offsetY; }
      } else if (primary.mode === 'world') {
        let screen;
        if (primary.worldAnchor) {
          screen = projectPointToScreen(primary.worldAnchor, viewer.camera, viewer.renderer, primary.worldTarget);
        } else if (primary.worldTarget) {
          screen = projectToScreen(primary.worldTarget, viewer.camera, viewer.renderer);
        }
        if (!screen?.visible) { show = false; }
        else { rawX = screen.x + offsetX; rawY = screen.y + offsetY; }
      } else if (primary.mode === 'fixed') {
        if (!primary.fixedPos) { show = false; }
        else { rawX = primary.fixedPos.x + offsetX; rawY = primary.fixedPos.y + offsetY; }
      }

      if (show && el) {
        const tooltipWidth = el.offsetWidth || TOOLTIP_MIN_WIDTH;
        const tooltipHeight = el.offsetHeight || TOOLTIP_EST_HEIGHT;
        // clampToViewport expects Y to be the BOTTOM of the tooltip (matches
        // the translateY(-100%) world/fixed anchor). For cursor mode we
        // convert Y from top→bottom before clamping, then back.
        const yBottom = isCursor ? rawY + tooltipHeight : rawY;
        // Reserve the BottomBar strip so a low tooltip never covers the search bar.
        const clampHeight = window.innerHeight - BOTTOM_SAFE_AREA;
        const clamped = clampToViewport(
          rawX, yBottom, tooltipWidth, tooltipHeight,
          VIEWPORT_MARGIN, window.innerWidth, clampHeight,
        );
        const finalTop = isCursor ? clamped.y - tooltipHeight : clamped.y;
        // CSS `zoom` on HMIShell scales its children, so a raw viewport pixel
        // value written to `left/top` inside the zoomed container is RENDERED
        // at viewport × zoom. Mouse events (clientX/Y) stay in unzoomed
        // viewport space. Dividing by the current zoom factor cancels the
        // scaling and puts the bubble exactly where the cursor / object is.
        const zoom = getUIZoom() || 1;
        el.style.left = (clamped.x / zoom) + 'px';
        el.style.top = (finalTop / zoom) + 'px';
        el.style.transform = isCursor ? 'none' : 'translateY(-100%)';
        el.style.visibility = 'visible';
      } else if (el) {
        el.style.visibility = 'hidden';
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => { mounted = false; cancelAnimationFrame(rafRef.current); };
  }, [primary, viewer]);

  // Resolve content providers for all entries in this bubble
  const providers = tooltip.contentEntries
    .map(entry => {
      const Provider = tooltipRegistry.getProvider(entry.data.type);
      return Provider ? { Provider, entry } : null;
    })
    .filter((p): p is NonNullable<typeof p> => p !== null);

  if (providers.length === 0) return null;

  return (
    <Box
      ref={tooltipRef}
      onContextMenu={isPinned ? handleContextMenu : undefined}
      sx={{
        position: 'fixed',
        left: 0,
        top: 0,
        visibility: 'hidden',
        // transform is set imperatively in the rAF tick so it can switch
        // between 'translateY(-100%)' (world/fixed) and 'none' (cursor).
        pointerEvents: isPinned ? 'auto' : 'none !important',
        zIndex: 1300,
        bgcolor: 'rgba(18, 18, 18, 0.88)',
        backdropFilter: 'blur(calc(12px * var(--rv-ui-blur-scale, 1)))',
        borderRadius: 1,
        px: 1.5,
        py: 1,
        minWidth: TOOLTIP_MIN_WIDTH,
        maxWidth: 380,
        border: '1px solid rgba(255,255,255,0.1)',
        boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
        willChange: 'left, top',
      }}
    >
      {providers.map(({ Provider, entry }, i) => (
        <Box key={entry.id}>
          {i > 0 && (
            <Divider sx={{ borderColor: 'rgba(255,255,255,0.1)', my: 0.5 }} />
          )}
          <Provider data={entry.data} viewer={viewer} isPinned={isPinned} />
        </Box>
      ))}
    </Box>
  );
};

// ─── Tooltip Layer ──────────────────────────────────────────────────────

export function TooltipLayer() {
  const { visible } = useTooltipState();
  const catVisible = useOverlayVisible('tooltips');

  // Content-driven presence (plan-250): 'tooltips' counts as present only while
  // ≥1 tooltip is actually shown — NOT on bare mount (a permanent HMI layer
  // would otherwise force the category into every session). Registered BEFORE
  // the visibility gate so a hidden category can still be re-shown.
  const hasTooltips = visible.length > 0;
  useEffect(() => {
    if (!hasTooltips) return;
    registerOverlayProducer('tooltips');
    return () => unregisterOverlayProducer('tooltips');
  }, [hasTooltips]);

  if (visible.length === 0) return null;
  if (!catVisible) return null; // 'tooltips' overlay category switched off

  return (
    <>
      {visible.map(vt => (
        <SingleTooltipBubble key={vt.key} tooltip={vt} />
      ))}
    </>
  );
}
