// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * info-overlay-store.tsx — Generic non-blocking info overlay.
 *
 * A module-level reactive store for briefly showing a centered message (with
 * optional spinner) while a mode transition or long-running operation runs.
 *
 * Intended for UX hints during work that would otherwise cause a silent freeze
 * (e.g., entering docs mode, baking meshes, loading heavy assets). NOT a modal:
 * the overlay is `pointer-events: none` and does not block the UI.
 *
 * Usage:
 *   showInfoOverlay('Entering document mode…');
 *   // ... run work (prefer double-rAF so the overlay paints first) ...
 *   hideInfoOverlay();
 *
 * For fire-and-forget timed messages:
 *   showInfoOverlay('Saved', { autoHideMs: 1500, showSpinner: false });
 *
 * The InfoOverlayBridge component is auto-registered with the tooltip registry
 * and rendered by App.tsx alongside other global overlays.
 */

import { useSyncExternalStore } from 'react';
import { Box, Paper, CircularProgress, Typography } from '@mui/material';
import { tooltipRegistry } from './tooltip/tooltip-registry';

// ─── Types ─────────────────────────────────────────────────────────────

interface InfoOverlayState {
  visible: boolean;
  message: string;
  showSpinner: boolean;
}

export interface ShowInfoOverlayOptions {
  /** Show the circular progress spinner (default: true). */
  showSpinner?: boolean;
  /** Auto-hide after this many ms. If omitted, overlay stays until hideInfoOverlay(). */
  autoHideMs?: number;
}

// ─── Store ─────────────────────────────────────────────────────────────

let _state: InfoOverlayState = { visible: false, message: '', showSpinner: true };
let _snapshot = _state;
let _autoHideTimer: ReturnType<typeof setTimeout> | null = null;
const _listeners = new Set<() => void>();

function notify(): void {
  _snapshot = { ..._state };
  for (const l of _listeners) l();
}

function clearAutoHide(): void {
  if (_autoHideTimer !== null) {
    clearTimeout(_autoHideTimer);
    _autoHideTimer = null;
  }
}

/** Show (or update) the info overlay. */
export function showInfoOverlay(message: string, options?: ShowInfoOverlayOptions): void {
  clearAutoHide();
  _state = {
    visible: true,
    message,
    showSpinner: options?.showSpinner ?? true,
  };
  notify();

  if (options?.autoHideMs && options.autoHideMs > 0) {
    _autoHideTimer = setTimeout(() => {
      _autoHideTimer = null;
      hideInfoOverlay();
    }, options.autoHideMs);
  }
}

/** Hide the info overlay. No-op if already hidden. */
export function hideInfoOverlay(): void {
  clearAutoHide();
  if (!_state.visible) return;
  _state = { ..._state, visible: false };
  notify();
}

/**
 * Convenience wrapper: show the overlay, wait two animation frames so it
 * actually paints, run the synchronous work, then keep the overlay up long
 * enough for the post-work render(s) + shader recompiles to finish, and
 * finally hide it.
 *
 * Use this for mode transitions that cause a short main-thread freeze
 * (material updates, shader recompiles, mesh baking, etc.).
 *
 * Timing constraints applied (whichever is longer wins):
 *   - `minDisplayMs` — minimum total time the overlay is visible (prevents flash).
 *   - `postWorkMs`   — minimum time between work() finishing and the overlay
 *     hiding. Covers the first render + shader recompile that happens AFTER
 *     work() returns. On first-time activations this is usually the limiting
 *     factor, because work() itself may already have run for > minDisplayMs.
 *
 * @returns A Promise that resolves with the work result after the overlay hides.
 */
export function withInfoOverlay<T>(
  message: string,
  work: () => T,
  options?: { minDisplayMs?: number; postWorkMs?: number },
): Promise<T> {
  const minMs = options?.minDisplayMs ?? 400;
  const postWorkMs = options?.postWorkMs ?? 350;
  showInfoOverlay(message);
  const startedAt = performance.now();

  return new Promise<T>((resolve, reject) => {
    // Pre-work: two rAFs so React commits + browser paints the overlay
    // before the blocking work starts.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        let result: T;
        try {
          result = work();
        } catch (err) {
          hideInfoOverlay();
          reject(err);
          return;
        }
        // One rAF so the next render (which triggers the shader recompiles
        // from needsUpdate materials) happens while the overlay is still
        // on screen. Then wait at least `postWorkMs` after work finished,
        // and at least `minDisplayMs` from the original show, before hiding.
        const workDoneAt = performance.now();
        requestAnimationFrame(() => {
          const totalSoFar = performance.now() - startedAt;
          const postWorkSoFar = performance.now() - workDoneAt;
          const delay = Math.max(
            minMs - totalSoFar,
            postWorkMs - postWorkSoFar,
            0,
          );
          if (delay === 0) {
            hideInfoOverlay();
            resolve(result);
          } else {
            setTimeout(() => { hideInfoOverlay(); resolve(result); }, delay);
          }
        });
      });
    });
  });
}

function useInfoOverlayState(): InfoOverlayState {
  return useSyncExternalStore(
    (cb) => { _listeners.add(cb); return () => { _listeners.delete(cb); }; },
    () => _snapshot,
  );
}

// ─── Bridge (headless controller, rendered by App.tsx) ─────────────────

function InfoOverlayBridge() {
  const state = useInfoOverlayState();
  if (!state.visible) return null;

  return (
    <Box
      sx={{
        position: 'fixed',
        inset: 0,
        // Above all other HMI overlays (tooltips/pdf use 9000).
        zIndex: 10000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        // Dim the scene behind, same family as other HMI backdrops.
        bgcolor: 'rgba(0,0,0,0.4)',
        pointerEvents: 'none',
      }}
    >
      <Paper
        elevation={12}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          px: 3,
          py: 2,
          minWidth: 220,
          borderRadius: 2,
          bgcolor: 'rgba(20,20,20,0.85)',
          backdropFilter: 'blur(12px)',
          boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
          border: '1px solid rgba(255,255,255,0.08)',
        }}
      >
        {state.showSpinner && <CircularProgress size={24} />}
        <Typography sx={{ color: '#fff', fontSize: 14, fontWeight: 500 }}>
          {state.message}
        </Typography>
      </Paper>
    </Box>
  );
}

// Auto-register so App.tsx renders the bridge via its controller loop.
tooltipRegistry.registerController({ types: [], component: InfoOverlayBridge });
