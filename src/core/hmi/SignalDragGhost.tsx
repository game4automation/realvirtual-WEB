// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * SignalDragGhost — chip-styled ghost that follows the cursor during a
 * Shift+Drag of a signal chip (plan-246 F8).
 *
 * Rendered once in App.tsx; portals to document.body so it floats above every
 * popover/panel. Position updates go through a DIRECT DOM transform driven by
 * `subscribeSignalDragPos` — no React state per pointermove (hot-path rule).
 * `pointer-events: none` so `elementFromPoint` hit-testing (drop targets,
 * 3D auto-open) always sees what is underneath the ghost.
 */

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Box } from '@mui/material';
import {
  useSignalDragActive,
  getSignalDragPayload,
  getSignalDragPosition,
  subscribeSignalDragPos,
} from './signal-drag-store';
import { signalValueColor } from './signal-colors';
import { CHIP_RADIUS } from './shared-sx';

const GHOST_OFFSET_X = 14;
const GHOST_OFFSET_Y = 10;

export function SignalDragGhost() {
  const active = useSignalDragActive();
  if (!active) return null;
  return createPortal(<GhostChip />, document.body);
}

/** Inner chip — mounted only while dragging, so payload/position are always set. */
function GhostChip() {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const move = (x: number, y: number) => {
      el.style.transform = `translate(${x + GHOST_OFFSET_X}px, ${y + GHOST_OFFSET_Y}px)`;
    };
    const p = getSignalDragPosition();
    move(p.x, p.y);
    return subscribeSignalDragPos(move);
  }, []);

  const payload = getSignalDragPayload();
  // Same rule as the chip it was torn from (plan-341 Phase 0): the hue carries
  // the direction. The drag payload deliberately carries no value, so the ghost
  // is a type badge — always the `weak` step, never claiming a state.
  const color = signalValueColor(payload?.direction ?? 'unknown', false);

  return (
    <Box
      ref={ref}
      data-rv-signal-drag-ghost="true"
      sx={{
        position: 'fixed',
        top: 0,
        left: 0,
        zIndex: 12000,
        pointerEvents: 'none',
        willChange: 'transform',
        px: 0.75,
        py: 0.25,
        borderRadius: CHIP_RADIUS,
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: 0.3,
        whiteSpace: 'nowrap',
        maxWidth: 280,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        // Portals to document.body — outside the app's font cascade; without
        // this the browser falls back to serif (same fix as AnchoredPopover).
        fontFamily: (t) => t.typography.fontFamily,
        color,
        bgcolor: '#1e1e1e',
        border: `1px solid ${color}88`,
      }}
    >
      {payload?.name ?? ''}
    </Box>
  );
}
