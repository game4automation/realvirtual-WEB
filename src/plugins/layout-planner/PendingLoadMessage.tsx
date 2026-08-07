// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * PendingLoadMessage — the HMI status line for pending placements (plan-371 F6/F7).
 *
 * A placeholder in the scene says "something is coming"; this tile says WHAT,
 * and it is the only place a failed load can be acted on. One row per pending
 * placement, because a partial failure must be recoverable on its own — with a
 * single global "loading…" the user could not tell which of three dropped
 * assets is the broken one.
 *
 * Deliberate omissions:
 *
 * - **No progress bar.** `LoadingManager.onProgress` is unreliable for GLTF
 *   (`total` is frequently 0 without a Content-Length, the callback fires twice
 *   for the `.gltf`/`.bin` pair, and `onLoad` can precede parsing). A bar that
 *   sticks at 90 % reads as broken — which is the exact impression this whole
 *   feature exists to remove.
 * - **Not `showInfoOverlay`.** That is a modal centre overlay for blocking
 *   flows; a pending placement blocks nothing, and the user is expected to keep
 *   dragging the next asset while it resolves.
 * - **No shadow, no new blur radius.** Depth comes from the glass tier `Paper`
 *   already carries via the theme (DESIGN.md "No-Shadow Rule").
 *
 * Accessibility: the 3D canvas is opaque to screen readers, so this DOM tile is
 * the only announcement channel. Loading transitions are `polite` (they are
 * progress, not news); failures are `assertive` because they need an action.
 */

import { useSyncExternalStore } from 'react';
import { Paper, Box, Typography, Button, CircularProgress } from '@mui/material';
import { Warning } from '@mui/icons-material';
import { SEVERITY_COLORS } from '../../core/hmi/severity-pulse';
import type { UISlotProps } from '../../core/rv-ui-plugin';
import type { LayoutPlannerPlugin } from './index';
import type { LayoutSnapshot, PendingPlacementInfo } from './rv-layout-store';

/** Stable empty list — a fresh `[]` per render would defeat memoisation and,
 *  as a `useSyncExternalStore` fallback, loop the component. */
const NO_PENDING: readonly PendingPlacementInfo[] = [];

const NOOP_SUBSCRIBE = (): (() => void) => () => {};
const NULL_SNAPSHOT = (): LayoutSnapshot => null as unknown as LayoutSnapshot;

export function PendingLoadMessage({ viewer }: UISlotProps) {
  const plugin = viewer.getPlugin<LayoutPlannerPlugin>('layout-planner');
  const store = plugin?.store;

  const snapshot = useSyncExternalStore(
    store?.subscribe ?? NOOP_SUBSCRIBE,
    store?.getSnapshot ?? NULL_SNAPSHOT,
  );

  const pending = snapshot?.pendingPlacements ?? NO_PENDING;
  if (!plugin) return null;

  const loading = pending.filter((p) => p.status === 'loading');
  const failed = pending.filter((p) => p.status === 'error');

  // Nothing pending: render the two live regions EMPTY rather than nothing at
  // all. A live region that is inserted into the DOM already holding its text
  // is announced inconsistently across screen readers; one that exists first
  // and is filled afterwards is announced reliably. Empty Boxes paint nothing.
  if (pending.length === 0) {
    return (
      <>
        <Box aria-live="polite" role="status" />
        <Box aria-live="assertive" role="alert" />
      </>
    );
  }

  // A single failure dominates the tile's accent: it is the only state that
  // needs the user to do something.
  const accent = failed.length > 0 ? SEVERITY_COLORS.error : SEVERITY_COLORS.info;

  return (
    <Paper
      sx={{
        p: 1.5,
        // The 3px severity-coloured left edge is the message-system convention,
        // not decoration: every tile in the 'messages' slot carries it
        // (`TileCard.tsx`), and MessagePanel's mobile peek mode deliberately
        // leaves exactly this border + icon visible at the screen edge as the
        // affordance for sliding the card in. Dropping it here would both break
        // that affordance and make one tile look foreign among the others.
        borderLeft: `3px solid ${accent}`,
        pointerEvents: 'auto',
      }}
    >
      <Typography variant="body2" sx={{ fontWeight: 600, lineHeight: 1.3, mb: 0.75 }}>
        Assets werden geladen
      </Typography>

      <Box aria-live="polite" role="status">
        {loading.map((item) => (
          <Box key={item.id} sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 0.25 }}>
            <CircularProgress size={14} thickness={5} sx={{ color: SEVERITY_COLORS.info }} />
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              {`Lade ${item.name}…`}
            </Typography>
          </Box>
        ))}
      </Box>

      <Box aria-live="assertive" role="alert">
        {failed.map((item) => (
          <Box key={item.id} sx={{ py: 0.25 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Warning sx={{ fontSize: 14, color: SEVERITY_COLORS.error }} />
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                {`${item.name} konnte nicht geladen werden`}
              </Typography>
            </Box>
            <Box sx={{ display: 'flex', gap: 0.75, mt: 0.5, ml: 3 }}>
              <Button
                size="small"
                variant="outlined"
                onClick={() => plugin.retryPendingPlacement(item.id)}
              >
                Wiederholen
              </Button>
              <Button
                size="small"
                color="inherit"
                onClick={() => plugin.removePlacementById(item.id)}
              >
                Entfernen
              </Button>
            </Box>
          </Box>
        ))}
      </Box>
    </Paper>
  );
}
