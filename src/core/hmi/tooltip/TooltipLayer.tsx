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
import type { VisibleTooltip } from './tooltip-store';
import type { ContextMenuTarget } from '../context-menu-store';

const DEFAULT_OFFSET_X = 16;
const DEFAULT_OFFSET_Y = -12;
const TOOLTIP_MIN_WIDTH = 160;
const TOOLTIP_EST_HEIGHT = 120;
const VIEWPORT_MARGIN = 10;

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

      const offsetX = primary.offset?.x ?? DEFAULT_OFFSET_X;
      const offsetY = primary.offset?.y ?? DEFAULT_OFFSET_Y;

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
        const clamped = clampToViewport(
          rawX, rawY, tooltipWidth, tooltipHeight,
          VIEWPORT_MARGIN, window.innerWidth, window.innerHeight,
        );
        el.style.left = clamped.x + 'px';
        el.style.top = clamped.y + 'px';
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
        transform: 'translateY(-100%)',
        pointerEvents: isPinned ? 'auto' : 'none !important',
        zIndex: 1300,
        bgcolor: 'rgba(18, 18, 18, 0.88)',
        backdropFilter: 'blur(12px)',
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

  if (visible.length === 0) return null;

  return (
    <>
      {visible.map(vt => (
        <SingleTooltipBubble key={vt.key} tooltip={vt} />
      ))}
    </>
  );
}
