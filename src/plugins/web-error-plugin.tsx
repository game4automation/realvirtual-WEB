// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * WebErrorPlugin — right-side error panel for the central ErrorStore.
 *
 * Registers a 'messages'-slot panel that lists every currently active error
 * (one TileCard per error, ISA-101 red). Clicking a card focuses + highlights
 * the faulting part in 3D. Cards are rendered as a compact overlapping stack
 * that fans out on hover, so the normal case needs no scrolling; a maxHeight +
 * overflow fallback covers very large alarm counts.
 *
 * Store lifecycle: the plugin clears the ErrorStore on model switch via
 * onModelCleared (clearModel() does NOT run a per-component dispose sweep).
 */

import { useState, useSyncExternalStore } from 'react';
import { Box, Badge } from '@mui/material';
import type { RVViewerPlugin } from '../core/rv-plugin';
import type { UISlotEntry, UISlotProps } from '../core/rv-ui-plugin';
import type { RVViewer } from '../core/rv-viewer';
import type { ErrorEntry } from '../core/engine/rv-error-store';
import { TileCard } from '../core/hmi/TileCard';
import { pulseSeverityOutline } from '../core/hmi/severity-pulse';
import { collectNodeAiContext } from '../core/hmi/search-ai-context';
import { AskAiButton } from '../core/hmi/AskAiButton';
import { useSearchDiagnosisAvailable } from './diagnose/search-diagnose-registry';

// ─── Constants (inline, glanceable) ─────────────────────────────────────

/** Vertical offset (px) between stacked cards in the collapsed state. */
const STACK_OFFSET_PX = 10;
/** Card height estimate (px) used to lay out the fanned-out stack. */
const CARD_HEIGHT_PX = 76;
/** Max panel height before the fanned-out list scrolls (px). */
const MAX_PANEL_HEIGHT_PX = 480;

/** Format a performance.now() timestamp to a wall-clock HH:MM:SS string. */
function formatSince(since: number): string {
  // `since` is a performance timestamp (ms since navigation start); convert to a
  // wall-clock time by anchoring against the current performance/Date offset.
  const epochMs = since + (Date.now() - performance.now());
  const d = new Date(epochMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// ─── Reactive subscription to the ErrorStore ────────────────────────────

function useActiveErrors(viewer: RVViewer): ErrorEntry[] {
  const store = viewer.errorStore;
  return useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => store.getActive(),
  );
}

function AskAiAction({ viewer, error }: { viewer: RVViewer; error: ErrorEntry }) {
  const handleClick = () => {
    const context = collectNodeAiContext(viewer, error.path);
    viewer.emit('diagnose-request', {
      nodePath: error.path,
      label: error.text || 'Error',
      source: 'web-error',
      ...(context?.docHints?.length ? { docHints: context.docHints } : {}),
      ...(context?.machineContext ? { machineContext: context.machineContext } : {}),
    });
  };

  return (
    <AskAiButton onClick={handleClick} />
  );
}

// ─── Panel ──────────────────────────────────────────────────────────────

export function WebErrorPanel({ viewer }: UISlotProps) {
  const errors = useActiveErrors(viewer);
  const aiAvailable = useSearchDiagnosisAvailable();
  const [hovered, setHovered] = useState(false);

  if (errors.length === 0) return null;

  // Frame the faulting part and pulse its outline in the severity color
  // (same alarm effect as the Toray showcase, generalized in severity-pulse).
  const focusError = (path: string) => {
    pulseSeverityOutline(viewer, path, 'error');
  };

  // Single error → render the plain card (no stack chrome).
  if (errors.length === 1) {
    const e = errors[0];
    return (
      <Box data-ui-panel sx={{ pointerEvents: 'auto' }}>
        <TileCard
          title={e.text || 'Error'}
          subtitle={e.path.split('/').pop() ?? e.path}
          severity="error"
          icon="warning"
          timestamp={formatSince(e.since)}
          componentPath={e.path}
          onAction={() => focusError(e.path)}
          actions={aiAvailable ? <AskAiAction viewer={viewer} error={e} /> : undefined}
        />
      </Box>
    );
  }

  // Collapsed: overlapping stack (top card full, rest as offset edges + count
  // badge). Hovered: fanned out into a scrollable column. Touch: tap toggles.
  const expanded = hovered;
  const collapsedHeight = CARD_HEIGHT_PX + (errors.length - 1) * STACK_OFFSET_PX;

  return (
    <Badge
      badgeContent={expanded ? 0 : errors.length}
      color="error"
      data-ui-panel
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => setHovered((h) => !h)}
      sx={{
        display: 'block',
        width: '100%',
        pointerEvents: 'auto',
        '& .MuiBadge-badge': { transform: 'scale(1) translate(-6px, 6px)' },
      }}
    >
      <Box
        sx={{
          position: 'relative',
          width: '100%',
          height: expanded ? 'auto' : collapsedHeight,
          maxHeight: expanded ? MAX_PANEL_HEIGHT_PX : undefined,
          overflowY: expanded ? 'auto' : 'visible',
          transition: 'height 0.2s ease',
          display: expanded ? 'flex' : 'block',
          flexDirection: 'column',
          gap: expanded ? 1 : 0,
        }}
      >
        {errors.map((e, i) => (
          <Box
            key={e.path}
            sx={
              expanded
                ? { width: '100%' }
                : {
                    position: 'absolute',
                    top: i * STACK_OFFSET_PX,
                    left: 0,
                    right: 0,
                    // Top-most card (last in list) on top; older cards peek below.
                    zIndex: i + 1,
                    // Non-top cards are dimmed edges peeking under the top card.
                    opacity: i === errors.length - 1 ? 1 : 0.85,
                  }
            }
          >
            <TileCard
              title={e.text || 'Error'}
              subtitle={e.path.split('/').pop() ?? e.path}
              severity="error"
              icon="warning"
              timestamp={formatSince(e.since)}
              onAction={() => focusError(e.path)}
              actions={aiAvailable ? <AskAiAction viewer={viewer} error={e} /> : undefined}
            />
          </Box>
        ))}
      </Box>
    </Badge>
  );
}

// ─── Plugin ─────────────────────────────────────────────────────────────

export class WebErrorPlugin implements RVViewerPlugin {
  readonly id = 'web-error';
  readonly slots: UISlotEntry[] = [
    { slot: 'messages', component: WebErrorPanel, order: 5 },
  ];

  /** Clear the error registry on model switch — clearModel() runs no per-component
   *  dispose sweep, so this hook is the reliable store cleanup (plan §2.7). */
  onModelCleared(viewer: RVViewer): void {
    viewer.errorStore.clear();
  }
}
