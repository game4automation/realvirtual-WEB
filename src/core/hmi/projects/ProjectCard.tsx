// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ProjectCard — one asset tile, and the shape a caller describes it with.
 *
 * ## Why this file exists at all
 *
 * It used to live inside `ProjectSections.tsx`, the tab-panel component that
 * plan-703 Phase 6 replaced with `ProjectTree`, and it was re-homed here
 * rather than deleted with it.
 *
 * Keeping it paid off in Lauf 13: the tree became folders-only and the assets
 * became cards again, so `ProjectFolderContents` is its renderer now — the
 * card model did not have to be reinvented to get the Unity project-window
 * layout the user asked for.
 *
 * `ProjectCardMenuAction` is the shape `ProjectsDashboardHost` builds its
 * context-menu entries in; `ProjectCardModel` is what both
 * `assets-library-groups` and the folder-contents grid fill.
 */

import { useRef, useState, type ReactNode } from 'react';
import { Box, Menu, MenuItem } from '@mui/material';
import { useLongPress } from '../../../hooks/use-long-press';
import { AssetCard, type AssetCardGlyph } from '../../library/AssetCard';
import type { LibraryCatalogEntry } from '../../library/library-types';
import type { ProjectBackend } from '../../project/backends/project-backend';
import { useThumbnailUrl } from '../../thumbnails/rv-thumbnail-url-store';
import type { SelectModifiers } from './document-multi-select';

/**
 * Two pointer clicks on one card within this window are a double-click.
 * 500 ms is the Windows default double-click time.
 */
export const DOUBLE_CLICK_MS = 500;

/** One entry of a card's right-click menu. */
export interface ProjectCardMenuAction {
  key: string;
  label: string;
  /** Rendered in the error color — reserved for delete-like verbs. */
  destructive?: boolean;
  onClick: () => void;
}

/** Everything a caller has to say to get one tile drawn. */
export interface ProjectCardModel {
  key: string;
  entry: LibraryCatalogEntry;
  tier: 'bundled' | 'user';
  selected: boolean;
  /** A click selects; Ctrl/Cmd and Shift are passed on for multi-select. */
  onSelect: (mods?: SelectModifiers) => void;
  /**
   * The card's default action — double-click. Opening is what a user means by
   * double-clicking a card everywhere else in the product, so a card that can
   * be opened should always supply this.
   */
  onOpen?: () => void;
  /** Right-click menu. Omit for a card that has no verbs beyond selection. */
  menuActions?: ProjectCardMenuAction[];
  /**
   * The SAVED preview of this document — the row's `thumbnail` pointer
   * (plan-776), resolved through `thumbnailBackend`. Omit for a card with no
   * document behind it or no saved picture: the card then shows its type
   * placeholder. Nothing is ever rendered for a card.
   */
  thumbnailPointer?: string | null;
  /** The backend the pointer is read through — the open project's. */
  thumbnailBackend?: ProjectBackend | null;
  /**
   * Stated glyph tile instead of a picture — a CONNECT configuration or
   * knowledge card, or the `file:<ext>` tile of any other project file.
   * Takes precedence over any picture.
   */
  glyph?: AssetCardGlyph;
}

/**
 * One card, plus the saved-thumbnail read that belongs to it.
 *
 * A component rather than a branch inside a grid map: the read is a hook, and
 * hooks cannot be called from a loop body. It also scopes the URL reference to
 * the card, so a card leaving the grid releases it.
 */
export interface ProjectCardProps {
  card: ProjectCardModel;
  /**
   * The primary input is a finger: a long-press stands in for the right-click
   * the card has no other way of offering. Independent of the LAYOUT axis — a
   * wide touch tablet keeps three columns and still needs this.
   */
  touchInput?: boolean;
  /** Label for the preview's top-left corner; Bundled sits bottom-left (see `AssetCard.cornerBadge`). */
  cornerBadge?: ReactNode;
}

export function ProjectCard({ card, touchInput = false, cornerBadge }: ProjectCardProps) {
  // Read, never rendered (plan-776 F9): a glyph card or an entry that brings
  // its own picture asks for nothing.
  const wantsSidecar = !card.glyph && !card.entry.thumbnailUrl;
  const url = useThumbnailUrl(
    wantsSidecar ? card.thumbnailBackend : null,
    wantsSidecar ? card.thumbnailPointer : null,
  );
  // Anchored at the pointer, not the card: a context menu that jumps to the
  // card corner reads as detached from the click that raised it.
  const [ctxPos, setCtxPos] = useState<{ x: number; y: number } | null>(null);

  // The resolved picture is merged in rather than assigned to the entry: the
  // entry is store state, and a card must not mutate it.
  const entry = url ? { ...card.entry, thumbnailUrl: url } : card.entry;

  const hasMenu = (card.menuActions?.length ?? 0) > 0;

  /**
   * The long-press is the right-click — with one deliberate difference: it
   * does NOT select.
   *
   * A right-click selects so the permanently visible detail pane is about the
   * card whose menu is open. On a coarse pointer there is no such pane: the
   * selection raises a bottom sheet, which would cover the very menu the press
   * just asked for. The menu needs no selection to be correct anyway — each
   * entry closes over its own card.
   */
  const longPress = useLongPress({
    enabled: touchInput && hasMenu,
    onLongPress: (x, y) => setCtxPos({ x, y }),
  });

  /**
   * Double-click, detected from the two clicks themselves (user report
   * 2026-10-20: "double-click must open, reliably").
   *
   * The browser's own `dblclick` is NOT reliable here: the first click selects,
   * the selection re-renders the card (thumbnail swap, tooltip, selected frame),
   * and Chromium resets its click count when the node under the pointer is
   * replaced between the two clicks — the second click then arrives as a fresh
   * single click and nothing opens. A timestamp on the card survives any
   * re-render, so two pointer clicks inside the window open, whatever the DOM
   * did in between. Keyboard activation (`detail === 0`) never counts.
   *
   * The native `dblclick` stays wired as the fallback (an OS double-click time
   * longer than ours), and is ignored when the click pair has just opened, so
   * one gesture never opens twice.
   */
  const lastClickAt = useRef(0);
  const openedAt = useRef(-Infinity);
  const open = () => {
    openedAt.current = performance.now();
    card.onOpen?.();
  };
  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (longPress.consumedLastGesture()) return;
    const now = performance.now();
    // AssetCard forwards Enter/Space as a KeyboardEvent, whose `detail` is 0.
    const isPointer = (e.detail ?? 0) > 0;
    const modified = e.ctrlKey || e.metaKey || e.shiftKey;
    // Quick Ctrl/Shift clicks are multi-select, never a double-click open.
    if (isPointer && !modified && card.onOpen && now - lastClickAt.current <= DOUBLE_CLICK_MS) {
      lastClickAt.current = 0;
      open();
      return;
    }
    lastClickAt.current = isPointer && !modified ? now : 0;
    card.onSelect({ toggle: e.ctrlKey || e.metaKey, range: e.shiftKey });
  };
  const handleDoubleClick = card.onOpen
    ? (e: React.MouseEvent<HTMLDivElement>) => {
        if (e.ctrlKey || e.metaKey || e.shiftKey) return;
        if (performance.now() - openedAt.current > DOUBLE_CLICK_MS) open();
      }
    : undefined;

  const body = (
    <AssetCard
      entry={entry}
      variant="comfortable"
      tier={card.tier}
      cornerBadge={cornerBadge}
      selected={card.selected}
      glyph={card.glyph}
      // A touch long-press still emits a click after `pointerup`; without
      // this guard the card would select behind the menu it just opened.
      // The second click of a double-click opens (see `handleClick`); the
      // native `dblclick` is only the de-duplicated fallback.
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onContextMenu={hasMenu
        ? (e) => {
            e.preventDefault();
            // Right-click also selects, so the detail pane and the menu are
            // about the same card while the menu is open.
            card.onSelect();
            setCtxPos({ x: e.clientX, y: e.clientY });
          }
        : undefined}
    />
  );

  return (
    <>
      {touchInput && hasMenu
        ? (
          // A wrapper only where the handlers are needed: on a mouse the DOM
          // stays exactly what it was, which is what keeps the desktop grid
          // tests honest about the structure they walk.
          <Box
            onPointerDown={longPress.onPointerDown}
            onPointerMove={longPress.onPointerMove}
            onPointerUp={longPress.onPointerUp}
            onPointerLeave={longPress.onPointerLeave}
            onPointerCancel={longPress.onPointerCancel}
            sx={{ minWidth: 0 }}
          >
            {body}
          </Box>
        )
        : body}
      {hasMenu && (
        <Menu
          open={ctxPos !== null}
          onClose={() => setCtxPos(null)}
          anchorReference="anchorPosition"
          anchorPosition={ctxPos ? { top: ctxPos.y, left: ctxPos.x } : undefined}
        >
          {card.menuActions!.map(a => (
            <MenuItem
              key={a.key}
              onClick={() => { setCtxPos(null); a.onClick(); }}
              sx={{ fontSize: 13, ...(a.destructive ? { color: 'error.main' } : {}) }}
            >
              {a.label}
            </MenuItem>
          ))}
        </Menu>
      )}
    </>
  );
}
