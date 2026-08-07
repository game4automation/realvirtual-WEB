// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ContextMenuLayer — Renders the plugin-extensible context menu.
 *
 * Uses MUI Menu with anchorReference="anchorPosition" for pixel-perfect
 * placement at the right-click / long-press position. Items are pre-filtered
 * and sorted by ContextMenuStore.open() — this component only renders.
 *
 * - No header — minimal, Blender-style
 * - Items with `shortcut` show a dimmed right-aligned key hint (e.g. F, G)
 * - Items with `danger: true` get red text (#ef5350)
 * - Items with `dividerBefore: true` get a <Divider /> above them
 * - Items with `children` render as cascading submenus (Popper-based, NOT
 *   nested MUI <Menu> — nested modal focus traps fight each other). Submenus
 *   open on hover (250 ms leave-grace), toggle on click (touch), and support
 *   ArrowRight/Enter to open, ArrowLeft/Escape to close a level.
 * - Items with `input` render as an inline text field (Enter/check submits).
 * - Click handler: call item.action(target), then store.close()
 * - MUI handles close-on-click-outside and Escape natively
 * - Hover highlight is held while the menu is open (released on close)
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Menu, MenuItem, MenuList, Divider, Box, Typography, Popper, Paper,
  InputBase, IconButton,
} from '@mui/material';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import CheckIcon from '@mui/icons-material/Check';
import { useViewer } from '../../hooks/use-viewer';
import { useContextMenu } from './context-menu-store';
import type { ContextMenuTarget, ResolvedContextMenuItem } from './context-menu-store';
import { appendKeyBadge } from './key-badge-store';

const PAPER_SX = {
  bgcolor: 'rgba(30, 30, 30, 0.95)',
  backdropFilter: 'blur(calc(12px * var(--rv-ui-blur-scale, 1)))',
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
} as const;

const SUBMENU_CLOSE_DELAY_MS = 250;

/** Dimmed right-aligned keyboard-shortcut hint (Blender style). */
function ShortcutHint({ shortcut }: { shortcut?: string }) {
  if (!shortcut) return null;
  return (
    <Typography component="span" sx={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', ml: 2 }}>
      {shortcut}
    </Typography>
  );
}

interface MenuLevelProps {
  items: ResolvedContextMenuItem[];
  target: ContextMenuTarget;
  onLeafClick: (item: ResolvedContextMenuItem, target: ContextMenuTarget) => void;
  onInputSubmit: (item: ResolvedContextMenuItem, value: string, target: ContextMenuTarget) => void;
}

/** One level of menu rows — recursion happens through SubmenuRow. */
function MenuLevel({ items, target, onLeafClick, onInputSubmit }: MenuLevelProps) {
  return (
    <>
      {items.map((item, i) => [
        item.dividerBefore && i > 0 && (
          <Divider key={`div-${item.id}`} sx={{ my: 0.5, borderColor: 'rgba(255,255,255,0.08)' }} />
        ),
        item.children ? (
          <SubmenuRow
            key={item.id}
            item={item}
            target={target}
            onLeafClick={onLeafClick}
            onInputSubmit={onInputSubmit}
          />
        ) : item.input ? (
          <InputRow key={item.id} item={item} target={target} onInputSubmit={onInputSubmit} />
        ) : (
          <MenuItem
            key={item.id}
            onClick={() => onLeafClick(item, target)}
            sx={{
              color: item.danger ? '#ef5350' : 'text.primary',
              '&:hover': {
                bgcolor: item.danger ? 'rgba(239, 83, 80, 0.12)' : 'rgba(255,255,255,0.06)',
              },
            }}
          >
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', gap: 1 }}>
              <span>{item.resolvedLabel}</span>
              <ShortcutHint shortcut={item.shortcut} />
            </Box>
          </MenuItem>
        ),
      ])}
    </>
  );
}

/** Submenu parent row — chevron + Popper-hosted child MenuList. */
function SubmenuRow({ item, target, onLeafClick, onInputSubmit }: {
  item: ResolvedContextMenuItem;
} & Omit<MenuLevelProps, 'items'>) {
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const open = anchorEl !== null;

  const cancelClose = useCallback(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimer.current = setTimeout(() => setAnchorEl(null), SUBMENU_CLOSE_DELAY_MS);
  }, [cancelClose]);

  const openSub = useCallback((el: HTMLElement) => {
    cancelClose();
    setAnchorEl(el);
  }, [cancelClose]);

  return (
    <>
      <MenuItem
        onMouseEnter={(e) => openSub(e.currentTarget)}
        onMouseLeave={scheduleClose}
        onClick={(e) => (open ? setAnchorEl(null) : openSub(e.currentTarget))}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight' || e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            openSub(e.currentTarget);
          }
        }}
        sx={{
          color: item.danger ? '#ef5350' : 'text.primary',
          bgcolor: open ? 'rgba(255,255,255,0.06)' : undefined,
          '&:hover': {
            bgcolor: item.danger ? 'rgba(239, 83, 80, 0.12)' : 'rgba(255,255,255,0.06)',
          },
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', gap: 1 }}>
          <span>{item.resolvedLabel}</span>
          <Box sx={{ display: 'flex', alignItems: 'center' }}>
            <ShortcutHint shortcut={item.shortcut} />
            <ChevronRightIcon sx={{ fontSize: 14, color: 'rgba(255,255,255,0.4)', mr: -0.5 }} />
          </Box>
        </Box>
      </MenuItem>
      <Popper
        open={open}
        anchorEl={anchorEl}
        placement="right-start"
        // Above the parent Menu (MUI modal zIndex is 1300)
        sx={{ zIndex: 1400 }}
      >
        <Paper
          sx={PAPER_SX}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft' || e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              setAnchorEl(null);
            }
          }}
        >
          <MenuList dense disablePadding sx={{ py: 0.5 }}>
            <MenuLevel
              items={item.children ?? []}
              target={target}
              onLeafClick={onLeafClick}
              onInputSubmit={onInputSubmit}
            />
          </MenuList>
        </Paper>
      </Popper>
    </>
  );
}

/** Inline text-input row (e.g. "New group…"). Enter or check-button submits. */
function InputRow({ item, target, onInputSubmit }: {
  item: ResolvedContextMenuItem;
  target: ContextMenuTarget;
  onInputSubmit: MenuLevelProps['onInputSubmit'];
}) {
  const [value, setValue] = useState(item.input?.initialValue ?? '');
  const submit = () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    onInputSubmit(item, trimmed, target);
  };

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, px: 1.5, py: 0.5 }}>
      <InputBase
        autoFocus
        value={value}
        placeholder={item.input?.placeholder ?? ''}
        onChange={(e) => setValue(e.target.value)}
        // stopPropagation is mandatory: MUI MenuList type-ahead / arrow-key
        // focus navigation would otherwise steal keystrokes from the field.
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') submit();
        }}
        sx={{
          fontSize: 12,
          color: 'text.primary',
          bgcolor: 'rgba(255,255,255,0.06)',
          border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: 0.5,
          px: 0.75,
          py: 0.1,
          width: 130,
        }}
      />
      <IconButton size="small" onClick={submit} disabled={!value.trim()} sx={{ p: 0.25 }}>
        <CheckIcon sx={{ fontSize: 14, color: value.trim() ? '#66bb6a' : 'rgba(255,255,255,0.25)' }} />
      </IconButton>
    </Box>
  );
}

export function ContextMenuLayer() {
  const viewer = useViewer();
  const snap = useContextMenu(viewer.contextMenu);

  const closeAll = useCallback(() => {
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
        item.action?.(target);
      } catch (e) {
        console.error(`[ContextMenu] Action '${item.id}' error:`, e);
      }
      closeAll();
    },
    [closeAll],
  );

  const handleInputSubmit = useCallback(
    (item: ResolvedContextMenuItem, value: string, target: ContextMenuTarget) => {
      try {
        item.input?.onSubmit(value, target);
      } catch (e) {
        console.error(`[ContextMenu] Input '${item.id}' error:`, e);
      }
      closeAll();
    },
    [closeAll],
  );

  // Keyboard chords: while the menu is open, a plain letter activates the
  // matching item of the VISIBLE level (store.descendInto replaces the level
  // when a submenu opens, so snap.items is always the active one). Capture
  // phase so MUI MenuList's type-ahead focus never sees the key; keys typed
  // into an inline InputRow are left alone.
  const { open, target } = snap;
  useEffect(() => {
    if (!open || !target) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      const item = viewer.contextMenu.findByShortcut(e.key);
      if (!item) return;
      e.preventDefault();
      e.stopPropagation();
      const keyLabel = item.shortcut ?? e.key.toUpperCase();
      if (item.children?.length) {
        appendKeyBadge(keyLabel);
        viewer.contextMenu.descendInto(item.id);
      } else if (item.action) {
        appendKeyBadge(keyLabel, item.resolvedLabel);
        handleItemClick(item, target);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [open, target, viewer, handleItemClick]);

  if (!snap.open || !snap.pos || !snap.target) return null;

  return (
    <Menu
      open
      onClose={closeAll}
      anchorReference="anchorPosition"
      anchorPosition={{ top: snap.pos.y, left: snap.pos.x }}
      // Submenus render in portaled Poppers outside the Menu's modal root —
      // without this the focus trap yanks focus back from submenu inputs.
      disableEnforceFocus
      slotProps={{
        paper: {
          sx: PAPER_SX,
        },
      }}
    >
      <MenuLevel
        items={snap.items}
        target={snap.target}
        onLeafClick={handleItemClick}
        onInputSubmit={handleInputSubmit}
      />
    </Menu>
  );
}
