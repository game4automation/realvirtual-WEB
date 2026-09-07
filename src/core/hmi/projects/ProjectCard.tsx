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

import { useState } from 'react';
import { Box, Menu, MenuItem } from '@mui/material';
import { useLongPress } from '../../../hooks/use-long-press';
import { AssetCard } from '../../library/AssetCard';
import type { LibraryCatalogEntry } from '../../library/library-types';
import { useOptionalViewer } from '../../../hooks/use-viewer';
import {
  useAssetThumbnail,
  type ResolvedThumbnailSource,
} from '../../thumbnails/use-asset-thumbnail';
import type { ThumbnailKeyParts } from '../../thumbnails/thumbnail-key';

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
  onSelect: () => void;
  /**
   * The card's default action — double-click. Opening is what a user means by
   * double-clicking a card everywhere else in the product, so a card that can
   * be opened should always supply this.
   */
  onOpen?: () => void;
  /** Right-click menu. Omit for a card that has no verbs beyond selection. */
  menuActions?: ProjectCardMenuAction[];
  /**
   * Preview identity + how to load the asset, for a card whose entry has no
   * picture of its own (§2.7). Omit for a card that can never have one — a
   * scene's thumbnail is a saved snapshot of a composed scene, not a render of
   * a single GLB, so there is nothing here to generate.
   */
  thumbnailKey?: ThumbnailKeyParts;
  resolveThumbnail?: () => Promise<ResolvedThumbnailSource | null>;
  /**
   * Stated glyph tile instead of a picture — a CONNECT configuration or
   * knowledge card. Suppresses the thumbnail request: nothing to render.
   */
  glyph?: 'connect' | 'knowledge';
}

/**
 * One card, plus the preview request that belongs to it.
 *
 * A component rather than a branch inside a grid map: the pull is a hook, and
 * hooks cannot be called from a loop body. It also keeps the per-card
 * observer/effect scoped to the card, so a card leaving the grid takes its
 * pending request with it.
 */
export interface ProjectCardProps {
  card: ProjectCardModel;
  /**
   * The primary input is a finger: a long-press stands in for the right-click
   * the card has no other way of offering. Independent of the LAYOUT axis — a
   * wide touch tablet keeps three columns and still needs this.
   */
  touchInput?: boolean;
}

export function ProjectCard({ card, touchInput = false }: ProjectCardProps) {
  const viewer = useOptionalViewer();
  const { ref, url, empty } = useAssetThumbnail<HTMLDivElement>({
    service: viewer?.thumbnails ?? null,
    keyParts: card.thumbnailKey ?? null,
    resolve: card.resolveThumbnail ?? null,
    // A glyph card has nothing to render — never queue a request for it.
    enabled: !card.entry.thumbnailUrl && !card.glyph,
  });
  // Anchored at the pointer, not the card: a context menu that jumps to the
  // card corner reads as detached from the click that raised it.
  const [ctxPos, setCtxPos] = useState<{ x: number; y: number } | null>(null);

  // The generated picture is merged in rather than assigned to the entry: the
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

  const body = (
    <AssetCard
      ref={ref}
      entry={entry}
      variant="comfortable"
      tier={card.tier}
      selected={card.selected}
      empty={empty}
      glyph={card.glyph}
      // A touch long-press still emits a click after `pointerup`; without
      // this guard the card would select behind the menu it just opened.
      onClick={() => { if (!longPress.consumedLastGesture()) card.onSelect(); }}
      onDoubleClick={card.onOpen}
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
