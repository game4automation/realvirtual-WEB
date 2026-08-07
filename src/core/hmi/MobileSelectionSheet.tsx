// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * MobileSelectionSheet — half-height bottom sheet shown on the compact (mobile)
 * layout when a 3D object is double-clicked.
 *
 * On the compact layout the viewer skips the double-click camera zoom and the
 * editor skips the fullscreen hierarchy + inspector panels (see rv-viewer.ts
 * dblclick gate and rv-extras-editor object-focus gate). This sheet owns the
 * interaction instead, keeping the 3D scene visible above it:
 *   - breadcrumb (parent chain) — tap a segment to select that ancestor
 *   - direct children as tappable chips — tap to drill into a child
 *   - the standard PropertyInspector content below (embedded, no panel chrome)
 */

import { useEffect, useMemo, useState } from 'react';
import { Box, Paper, Typography, IconButton, Chip } from '@mui/material';
import { Close, ChevronRight } from '@mui/icons-material';
import { useViewer } from '../../hooks/use-viewer';
import { useMobileLayout } from '../../hooks/use-mobile-layout';
import { useSelection } from '../../hooks/use-selection';
import { computeAncestors } from './hierarchy-utils';
import { PropertyInspector } from './rv-property-inspector';
import { RV_SCROLL_CLASS } from './shared-sx';
import { WINDOW_DARK_BG } from './LeftPanel';
import { LEFT_PANEL_MOBILE_ZINDEX } from './layout-constants';

/** Display label for a path = its last segment. */
function leafName(path: string): string {
  return path.split('/').pop() ?? path;
}

export function MobileSelectionSheet() {
  const viewer = useViewer();
  const isMobile = useMobileLayout();
  const selection = useSelection();
  const primaryPath = selection.primaryPath;
  const [open, setOpen] = useState(false);

  // Open on double-click (object-focus). Only relevant on the compact layout —
  // there the viewer/editor suppress the zoom + fullscreen panels. Select through
  // the SelectionManager ourselves so `primaryPath` (and, via selection-changed,
  // the inspector's plugin state) are guaranteed set even if the preceding click
  // didn't register a selection.
  useEffect(() => {
    if (!isMobile) return;
    return viewer.on('object-focus', ({ path }) => {
      if (!path) return;
      viewer.selectionManager.select(path);
      setOpen(true);
    });
  }, [viewer, isMobile]);

  // Close once nothing is selected (e.g. clicked empty space).
  useEffect(() => {
    if (!primaryPath) setOpen(false);
  }, [primaryPath]);

  // Breadcrumb (ancestor paths) + direct children for the current node.
  const nav = useMemo(() => {
    if (!primaryPath || !viewer.registry) {
      return { crumbs: [] as string[], children: [] as string[] };
    }
    const crumbs = computeAncestors(primaryPath);
    const node = viewer.registry.getNode(primaryPath);
    const children: string[] = [];
    if (node) {
      for (const child of node.children) {
        const p = viewer.registry.getPathForNode(child);
        if (p) children.push(p);
      }
    }
    return { crumbs, children };
  }, [primaryPath, viewer.registry]);

  if (!isMobile || !open || !primaryPath) return null;

  // Navigating selects through the central manager so highlight + inspector and
  // this sheet all follow the same source of truth.
  const select = (path: string) => viewer.selectionManager.select(path);

  return (
    <Paper
      elevation={8}
      data-ui-panel
      sx={{
        position: 'fixed', left: 0, right: 0, bottom: 0,
        height: '55dvh', maxHeight: '72dvh',
        zIndex: LEFT_PANEL_MOBILE_ZINDEX,
        backgroundColor: `${WINDOW_DARK_BG} !important`,
        borderRadius: '8px 8px 0 0',
        display: 'flex', flexDirection: 'column',
        pointerEvents: 'auto',
        pb: 'env(safe-area-inset-bottom, 0px)',
      }}
    >
      {/* Header: breadcrumb path (tap to go up) + close */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, px: 1, py: 0.5, borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
        <Box
          className={RV_SCROLL_CLASS}
          sx={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 0.25, overflowX: 'auto', whiteSpace: 'nowrap' }}
        >
          {nav.crumbs.map((c) => (
            <Box key={c} sx={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}>
              <Typography
                onClick={() => select(c)}
                sx={{ fontSize: 11, color: 'text.secondary', cursor: 'pointer', '&:hover': { color: 'text.primary' } }}
              >
                {leafName(c)}
              </Typography>
              <ChevronRight sx={{ fontSize: 14, color: 'text.disabled' }} />
            </Box>
          ))}
          <Typography sx={{ fontSize: 11, fontWeight: 600, color: 'text.primary', flexShrink: 0 }}>
            {leafName(primaryPath)}
          </Typography>
        </Box>
        <IconButton
          size="small"
          onClick={() => { setOpen(false); viewer.selectionManager.clear(); }}
          sx={{ p: 0.25, flexShrink: 0, color: 'text.secondary' }}
          aria-label="Close inspector"
        >
          <Close sx={{ fontSize: 18 }} />
        </IconButton>
      </Box>

      {/* Direct children as drill-in chips */}
      {nav.children.length > 0 && (
        <Box
          className={RV_SCROLL_CLASS}
          sx={{ display: 'flex', gap: 0.5, px: 1, py: 0.5, overflowX: 'auto', borderBottom: '1px solid rgba(255,255,255,0.06)', '& > *': { flexShrink: 0 } }}
        >
          {nav.children.map((c) => (
            <Chip
              key={c}
              label={leafName(c)}
              size="small"
              onClick={() => select(c)}
              sx={{ fontSize: 11, cursor: 'pointer' }}
            />
          ))}
        </Box>
      )}

      {/* Inspector content */}
      <Box sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <PropertyInspector viewer={viewer} />
      </Box>
    </Paper>
  );
}
