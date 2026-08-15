// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * SceneTransitionOverlay — the mask over a scene-destroying transition
 * (plan-410 F4). Entering/leaving the editor, starting and stopping an
 * in-place test run: each one clears the scene before the next one is parsed,
 * and this is what the user sees instead of an empty canvas.
 *
 * Rendered by the ALWAYS-MOUNTED HMI shell, never by a plugin slot: the exit
 * overlay must outlive the editor plugin that asked for it (review finding
 * R2-2).
 *
 * Its second job is the paint report. `showNowAndPaint()` resolves only once
 * this component has committed AND the browser has had a frame to paint it, so
 * the effect below reports after a double `requestAnimationFrame` — the first
 * callback runs before the paint of the current frame, the second after it.
 *
 * Visual: same dark glass card as OmniverseStatusOverlay, plus a full-viewport
 * scrim (this one covers a scene that is being destroyed, so the emptiness
 * behind it must not show through). Non-interactive by design.
 */

import { useEffect, useSyncExternalStore } from 'react';
import { Box, Paper, Typography, CircularProgress } from '@mui/material';
import {
  getSceneTransitionSnapshot,
  reportSceneTransitionPainted,
  setSceneTransitionOverlayMounted,
  subscribeSceneTransition,
} from './scene-transition-store';
import { LEFT_PANEL_ZINDEX } from './layout-constants';

export function SceneTransitionOverlay() {
  const snap = useSyncExternalStore(subscribeSceneTransition, getSceneTransitionSnapshot);

  useEffect(() => {
    setSceneTransitionOverlayMounted(true);
    return () => setSceneTransitionOverlayMounted(false);
  }, []);

  // Report AFTER the browser painted this state: rAF #1 fires before the
  // current frame's paint, rAF #2 after it.
  useEffect(() => {
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => reportSceneTransitionPainted());
    });
    return () => { cancelAnimationFrame(raf1); if (raf2) cancelAnimationFrame(raf2); };
  }, [snap]);

  if (!snap.visible) return null;

  return (
    <Box
      data-testid="scene-transition-overlay"
      sx={{
        position: 'fixed',
        inset: 0,
        zIndex: LEFT_PANEL_ZINDEX + 2,
        pointerEvents: 'none',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        // The scene behind this is mid-teardown — cover it, don't just dim it.
        bgcolor: 'rgba(16,16,18,0.72)',
        backdropFilter: 'blur(calc(6px * var(--rv-ui-blur-scale, 1)))',
      }}
    >
      <Paper
        elevation={8}
        sx={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1.5,
          px: 4, py: 3, borderRadius: 3, minWidth: 240, maxWidth: '80vw',
          bgcolor: 'rgba(28,28,30,0.92)',
          backdropFilter: 'blur(calc(16px * var(--rv-ui-blur-scale, 1)))',
          color: 'rgba(255,255,255,0.95)',
          border: '1px solid rgba(255,255,255,0.12)',
          textAlign: 'center',
        }}
      >
        <CircularProgress size={44} thickness={4} sx={{ color: '#4fc3f7' }} />
        <Typography sx={{ fontSize: 15, fontWeight: 600, lineHeight: 1.3 }}>
          {snap.label}
        </Typography>
      </Paper>
    </Box>
  );
}
