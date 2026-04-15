// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ContextMenuLayer — Renders the plugin-extensible context menu.
 *
 * Uses MUI Menu with anchorReference="anchorPosition" for pixel-perfect
 * placement at the right-click / long-press position. Items are pre-filtered
 * and sorted by ContextMenuStore.open() — this component only renders.
 *
 * - Header shows the target node name (last path segment)
 * - Items with `danger: true` get red text (#ef5350)
 * - Items with `dividerBefore: true` get a <Divider /> above them
 * - Click handler: call item.action(target), then store.close()
 * - MUI handles close-on-click-outside and Escape natively
 * - Hover highlight is held while the menu is open (released on close)
 */

import { useCallback } from 'react';
import { Menu, MenuItem, Divider, Box, Typography } from '@mui/material';
import { useViewer } from '../../hooks/use-viewer';
import { useContextMenu } from './context-menu-store';
import type { ContextMenuTarget, ResolvedContextMenuItem } from './context-menu-store';

export function ContextMenuLayer() {
  const viewer = useViewer();
  const snap = useContextMenu(viewer.contextMenu);

  const handleClose = useCallback(() => {
    viewer.contextMenu.close();
    // Release hover highlight hold
    if (viewer.raycastManager) {
      viewer.raycastManager.holdHover = false;
      viewer.highlighter.clear();
    }
  }, [viewer]);

  const handleItemClick = useCallback(
    (item: ResolvedContextMenuItem, target: ContextMenuTarget) => {
      try {
        item.action(target);
      } catch (e) {
        console.error(`[ContextMenu] Action '${item.id}' error:`, e);
      }
      viewer.contextMenu.close();
      if (viewer.raycastManager) {
        viewer.raycastManager.holdHover = false;
        viewer.highlighter.clear();
      }
    },
    [viewer],
  );

  if (!snap.open || !snap.pos || !snap.target) return null;

  // Extract display name from path (last segment)
  const nodeName = snap.target.path.split('/').pop() ?? snap.target.path;

  return (
    <Menu
      open
      onClose={handleClose}
      anchorReference="anchorPosition"
      anchorPosition={{ top: snap.pos.y, left: snap.pos.x }}
      slotProps={{
        paper: {
          sx: {
            bgcolor: 'rgba(30, 30, 30, 0.95)',
            backdropFilter: 'blur(12px)',
            border: '1px solid rgba(255,255,255,0.1)',
            boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
            minWidth: 140,
            '& .MuiList-root': {
              py: 0.5,
            },
            '& .MuiMenuItem-root': {
              fontSize: 12,
              py: 0.5,
              px: 1.5,
              minHeight: 'auto',
            },
          },
        },
      }}
    >
      {/* Header — node name (non-interactive, dimmed) */}
      <Box sx={{ px: 1.5, py: 0.4, borderBottom: '1px solid rgba(255,255,255,0.08)', pointerEvents: 'none' }}>
        <Typography sx={{ fontSize: 10, fontWeight: 500, color: 'rgba(255,255,255,0.35)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200 }}>
          {nodeName}
        </Typography>
      </Box>

      {snap.items.map((item, i) => [
        item.dividerBefore && i > 0 && (
          <Divider key={`div-${item.id}`} sx={{ my: 0.5, borderColor: 'rgba(255,255,255,0.08)' }} />
        ),
        <MenuItem
          key={item.id}
          onClick={() => handleItemClick(item, snap.target!)}
          sx={{
            color: item.danger ? '#ef5350' : 'text.primary',
            '&:hover': {
              bgcolor: item.danger ? 'rgba(239, 83, 80, 0.12)' : 'rgba(255,255,255,0.06)',
            },
          }}
        >
          {item.resolvedLabel}
        </MenuItem>,
      ])}
    </Menu>
  );
}
