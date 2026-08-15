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
import { Box, Slider, Tooltip, Typography } from '@mui/material';
import { GridViewOutlined, ViewModuleOutlined } from '@mui/icons-material';
import { ProjectCard, type ProjectCardModel } from './ProjectCard';
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

/** A card plus the two things only the grid can give it. */
export interface FolderCardModel extends ProjectCardModel {
  /** Set for a card the user may move — a writable, non-catalog row. */
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDragEnd?: (e: React.DragEvent) => void;
}

export interface ProjectFolderContentsProps {
  cards: readonly FolderCardModel[];
  /**
   * What to say when there is nothing to show. Two different silences —
   * "this folder is empty" and "your filter matched nothing" — and the caller
   * is the only one that knows which one it is.
   */
  emptyMessage?: string;
}

export function ProjectFolderContents({
  cards,
  emptyMessage = 'This folder is empty.',
}: ProjectFolderContentsProps) {
  const [cardSize, setCardSize] = useState(readCardSize);

  // Written on every drag step. The value is one small number and the grid
  // reflows anyway, so a debounce would only add a way for the last change to
  // get lost.
  const changeSize = useCallback((value: number) => {
    setCardSize(value);
    try { localStorage.setItem(PROJECTS_CARD_SIZE_KEY, String(value)); } catch { /* private mode */ }
  }, []);

  return (
    <Box sx={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {cards.length === 0 ? (
        <Box
          data-folder-contents
          sx={{
            flex: 1,
            minWidth: 0,
            minHeight: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            p: 3,
          }}
        >
          <Typography sx={{ fontSize: 12, color: 'rgba(255,255,255,0.45)' }}>
            {emptyMessage}
          </Typography>
        </Box>
      ) : (
        <Box
          data-folder-contents
          role="list"
          aria-label="Folder contents"
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
