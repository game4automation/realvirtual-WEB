// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ProjectFolderContents — the right half of the project window (Lauf 13).
 *
 * The Unity model, and the user asked for it in those words: the tree shows
 * folders, the selected folder's assets are cards. Phase 6 had put both in the
 * tree and left the middle of the screen empty; this is what fills it.
 *
 * ## It renders `ProjectCard`, which had lost its renderer
 *
 * `ProjectCard` and `ProjectCardModel` survived the tab-to-tree swap without a
 * caller. They are the caller-facing shape of a tile — preview, selection,
 * double-click-opens, right-click menu — and rebuilding that shape would have
 * been a second card model to keep in step with `AssetCard`. So this is a grid
 * over the existing model, not a new one.
 *
 * ## Drag lives on the grid item, not inside the card
 *
 * The wrapper carries `draggable` and the two handlers so `ProjectCard` stays
 * exactly as presentational as it was. The drop target is the tree; the grid
 * only announces which card is in flight (see `ProjectTree.externalDragPath`).
 */

import { useCallback, useState } from 'react';
import { Box, Menu, MenuItem, Slider, Tooltip, Typography } from '@mui/material';
import {
  Folder, FolderOutlined, GridViewOutlined, ViewModuleOutlined,
} from '@mui/icons-material';
import {
  ProjectCard, type ProjectCardMenuAction, type ProjectCardModel,
} from './ProjectCard';
import { PROJECTS_CARD_SIZE_KEY } from '../rv-storage-keys';

/** Card edge length in pixels: the grid's `minmax` floor. */
const MIN_CARD = 72;
const MAX_CARD = 240;
const DEFAULT_CARD = 112;

/** The stored size, clamped — a hand-edited or stale value must not break the grid. */
function readCardSize(): number {
  try {
    const raw = Number(localStorage.getItem(PROJECTS_CARD_SIZE_KEY));
    if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_CARD;
    return Math.min(MAX_CARD, Math.max(MIN_CARD, Math.round(raw)));
  } catch {
    return DEFAULT_CARD;
  }
}

/**
 * A subfolder as a navigation tile — deliberately NOT a card. The user asked
 * for "the same as in the project hierarchy": the tree's folder icon, a name,
 * nothing else. A card frame with a preview well would promise an asset where
 * there is only a place to go.
 */
export interface FolderTileModel {
  /** Tree path — the grid item's identity, same as a card's `key`. */
  key: string;
  name: string;
  /**
   * Filled icon when the folder holds anything, outlined when empty — the
   * tree's `KindIcon` rule, so the same folder reads the same on both sides.
   */
  holdsSomething?: boolean;
  /** Click and double-click both navigate — the tree row's verb, not a card's. */
  onOpen: () => void;
  /** Right-click menu; omit for a folder with no verbs beyond navigation. */
  menuActions?: ProjectCardMenuAction[];
}

/**
 * One folder tile: icon over label, hover wash, its own context menu. The menu
 * duplicates `ProjectCard`'s tiny anchor-position pattern rather than reusing
 * the card, because reusing the card is exactly what this component exists to
 * stop doing.
 *
 * The GEOMETRY, though, is the card's on purpose — same padding, gap, a
 * transparent border where the card has a visible one, and an icon square with
 * the preview square's aspect — so the folder's label sits on exactly the
 * baseline of the card labels beside it, at every card size.
 */
function FolderTile({ tile }: { tile: FolderTileModel }) {
  const [ctxPos, setCtxPos] = useState<{ x: number; y: number } | null>(null);
  const hasMenu = (tile.menuActions?.length ?? 0) > 0;
  const iconSx = { width: '68%', height: '68%', color: 'rgba(255,255,255,0.5)' };
  return (
    <>
      <Box
        onClick={tile.onOpen}
        onDoubleClick={tile.onOpen}
        onContextMenu={hasMenu
          ? (e) => { e.preventDefault(); e.stopPropagation(); setCtxPos({ x: e.clientX, y: e.clientY }); }
          : undefined}
        sx={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 0.25,
          p: 0.5,
          borderRadius: 1,
          border: '1px solid transparent',
          cursor: 'pointer',
          userSelect: 'none',
          '&:hover': { bgcolor: 'rgba(255,255,255,0.06)' },
        }}
      >
        <Box
          sx={{
            width: '100%',
            aspectRatio: '1',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {tile.holdsSomething ? <Folder sx={iconSx} /> : <FolderOutlined sx={iconSx} />}
        </Box>
        <Typography
          sx={{
            fontSize: 12,
            color: 'text.secondary',
            textAlign: 'center',
            lineHeight: 1.2,
            maxWidth: '100%',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {tile.name}
        </Typography>
      </Box>
      {hasMenu && (
        <Menu
          open={ctxPos !== null}
          onClose={() => setCtxPos(null)}
          anchorReference="anchorPosition"
          anchorPosition={ctxPos ? { top: ctxPos.y, left: ctxPos.x } : undefined}
        >
          {tile.menuActions!.map(a => (
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

/** A card plus the two things only the grid can give it. */
export interface FolderCardModel extends ProjectCardModel {
  /** Set for a card the user may move — a writable, non-catalog row. */
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDragEnd?: (e: React.DragEvent) => void;
}

export interface ProjectFolderContentsProps {
  cards: readonly FolderCardModel[];
  /** Subfolder navigation tiles, rendered ahead of the cards. */
  folders?: readonly FolderTileModel[];
  /**
   * What to say when there is nothing to show. Two different silences —
   * "this folder is empty" and "your filter matched nothing" — and the caller
   * is the only one that knows which one it is.
   */
  emptyMessage?: string;
  /**
   * Right-click on the BLANK part of the grid — the folder's own menu.
   *
   * Only fires when the event started on the grid background: a right-click on
   * a card is that card's business, and the card's own menu already claims it
   * (`ProjectCard` stops propagation).
   */
  onBackgroundContextMenu?: (e: React.MouseEvent) => void;
  /**
   * Offered inside the empty state, next to the message. A toolbar button is
   * easy to miss on a screen whose middle is blank; the offer belongs where the
   * user is already looking.
   */
  emptyAction?: React.ReactNode;
}

export function ProjectFolderContents({
  cards,
  folders = [],
  emptyMessage = 'This folder is empty.',
  onBackgroundContextMenu,
  emptyAction,
}: ProjectFolderContentsProps) {
  const [cardSize, setCardSize] = useState(readCardSize);

  /** The grid's own background, not a card sitting on it. */
  const backgroundMenu = useCallback((e: React.MouseEvent) => {
    if (!onBackgroundContextMenu) return;
    if (e.target !== e.currentTarget) return;
    onBackgroundContextMenu(e);
  }, [onBackgroundContextMenu]);

  // Written on every drag step. The value is one small number and the grid
  // reflows anyway, so a debounce would only add a way for the last change to
  // get lost.
  const changeSize = useCallback((value: number) => {
    setCardSize(value);
    try { localStorage.setItem(PROJECTS_CARD_SIZE_KEY, String(value)); } catch { /* private mode */ }
  }, []);

  return (
    <Box sx={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {cards.length === 0 && folders.length === 0 ? (
        <Box
          data-folder-contents
          onContextMenu={onBackgroundContextMenu}
          sx={{
            flex: 1,
            minWidth: 0,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 1.5,
            p: 3,
          }}
        >
          <GridViewOutlined sx={{ fontSize: 28, color: 'rgba(255,255,255,0.18)' }} />
          <Typography sx={{ fontSize: 12, color: 'rgba(255,255,255,0.45)', textAlign: 'center' }}>
            {emptyMessage}
          </Typography>
          {emptyAction}
        </Box>
      ) : (
        <Box
          data-folder-contents
          role="list"
          aria-label="Folder contents"
          onContextMenu={backgroundMenu}
          sx={{
            flex: 1,
            minWidth: 0,
            minHeight: 0,
            overflow: 'auto',
            p: 1.5,
            display: 'grid',
            gridTemplateColumns: `repeat(auto-fill, minmax(${cardSize}px, 1fr))`,
            gap: 1.5,
            alignContent: 'start',
          }}
        >
          {folders.map(tile => (
            <Box key={tile.key} role="listitem" data-card-path={tile.key} sx={{ minWidth: 0 }}>
              <FolderTile tile={tile} />
            </Box>
          ))}
          {cards.map(card => (
            <Box
              key={card.key}
              role="listitem"
              data-card-path={card.key}
              draggable={card.draggable || undefined}
              onDragStart={card.onDragStart}
              onDragEnd={card.onDragEnd}
              sx={{ minWidth: 0 }}
            >
              <ProjectCard card={card} />
            </Box>
          ))}
        </Box>
      )}

      {/* Card size. Bottom-right and quiet: it is a view preference, not a verb
          of the project, and it stays reachable when the folder is empty so the
          chrome does not move as you navigate. */}
      <Box
        data-card-size-bar
        sx={{
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gap: 1,
          px: 1.5,
          py: 0.5,
          borderTop: '1px solid rgba(255,255,255,0.08)',
        }}
      >
        <GridViewOutlined sx={{ fontSize: 12, color: 'rgba(255,255,255,0.4)' }} />
        <Tooltip title="Card size" placement="top">
          <Slider
            size="small"
            min={MIN_CARD}
            max={MAX_CARD}
            step={8}
            value={cardSize}
            aria-label="Card size"
            onChange={(_, v) => changeSize(Array.isArray(v) ? v[0]! : v)}
            sx={{
              width: 120,
              color: '#4fc3f7',
              '& .MuiSlider-thumb': { width: 10, height: 10 },
              '& .MuiSlider-rail': { opacity: 0.25 },
            }}
          />
        </Tooltip>
        <ViewModuleOutlined sx={{ fontSize: 16, color: 'rgba(255,255,255,0.4)' }} />
      </Box>
    </Box>
  );
}
