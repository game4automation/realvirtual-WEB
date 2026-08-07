// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * GPUWarningBanner — Top-of-screen banner shown when the active GPU
 * is integrated graphics (warning) or a software fallback (critical).
 *
 * Common silent perf trap: Edge / Chrome on Windows runs on the
 * integrated GPU because the OS GPU preference defaults to "Power
 * saving" or "Let Windows decide." The customer doesn't notice until
 * frame rate is bad. This banner surfaces the issue at startup with
 * an actionable hint.
 *
 * Dismissal model:
 *  - 'warning' (integrated detected): user can dismiss, choice is
 *    persisted in sessionStorage so it doesn't return on tab switch
 *    but re-prompts on a fresh session.
 *  - 'critical' (software fallback): NOT dismissible — the page is
 *    rendering on the CPU and that's important to keep visible.
 *
 * Mounted as a direct child of HMIShell (alongside SharedViewBanner)
 * so the CSS-zoom inheritance works correctly. The analysis is read
 * from the viewer via a 1 s polling effect — slow on purpose, this is
 * a one-time-at-startup decision, not a per-frame indicator.
 */

import { useState, useEffect } from 'react';
import { Box, Typography, IconButton } from '@mui/material';
import { Warning, Error as ErrorIcon, Close } from '@mui/icons-material';
import { useViewer } from '../../hooks/use-viewer';
import { isMobileDevice } from '../../hooks/use-mobile-layout';
import type { GPUAnalysis } from '../engine/rv-gpu-info';
import { ISA_AMBER, ISA_RED } from './isa-colors';

const DISMISS_KEY = 'rv-gpu-warning-dismissed';

export function GPUWarningBanner() {
  const viewer = useViewer();
  const [analysis, setAnalysis] = useState<GPUAnalysis | null>(null);
  const [dismissed, setDismissed] = useState(false);

  // Honour a session-scoped dismissal — sessionStorage so the banner
  // returns on a fresh tab/window but stays away during this session.
  useEffect(() => {
    try {
      if (sessionStorage.getItem(DISMISS_KEY) === '1') setDismissed(true);
    } catch { /* private mode: best-effort */ }
  }, []);

  // Poll the viewer for analysis. Slow interval — analysis is static
  // after the async adapter probe resolves (~1 frame), so we just
  // need to catch that one transition and then we're done.
  useEffect(() => {
    let lastSig = '';
    const tick = () => {
      const a = viewer.getGPUAnalysis();
      const sig = a ? `${a.severity}|${a.tier}|${a.discreteAvailableConfirmed}` : '';
      if (sig !== lastSig) {
        lastSig = sig;
        setAnalysis(a);
      }
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [viewer]);

  // Render rules: nothing for ok / unknown; critical can't be
  // dismissed; warning hides if the user dismissed it.
  // Suppress entirely on mobile — mobile GPUs (Adreno/Mali/PowerVR)
  // match the integrated pattern and the action text ("Windows
  // Settings → ...") is meaningless on a phone or tablet.
  if (isMobileDevice()) return null;
  if (!analysis || analysis.severity === 'ok') return null;
  if (analysis.severity === 'warning' && dismissed) return null;

  const isCritical = analysis.severity === 'critical';
  const fg = isCritical ? ISA_RED : ISA_AMBER;
  const bg = isCritical ? 'rgba(180,30,30,0.95)' : 'rgba(180,110,20,0.95)';
  const Icon = isCritical ? ErrorIcon : Warning;

  const handleDismiss = () => {
    try { sessionStorage.setItem(DISMISS_KEY, '1'); } catch { /* private mode */ }
    setDismissed(true);
  };

  return (
    <Box
      data-ui-panel
      role={isCritical ? 'alert' : 'status'}
      sx={{
        position: 'fixed',
        top: 8,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 9500,
        pointerEvents: 'auto',
        maxWidth: 'calc(100vw - 32px)',
      }}
    >
      <Box sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1.25,
        px: 2,
        py: 1,
        bgcolor: bg,
        border: `1px solid ${fg}`,
        borderRadius: 2,
        boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
        backdropFilter: 'blur(calc(8px * var(--rv-ui-blur-scale, 1)))',
      }}>
        <Icon sx={{ fontSize: 20, color: '#fff', flexShrink: 0 }} />
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.25 }}>
          <Typography sx={{ fontSize: 12, fontWeight: 600, color: '#fff', lineHeight: 1.3 }}>
            {analysis.message}
          </Typography>
          {analysis.action && (
            <Typography sx={{ fontSize: 11, color: 'rgba(255,255,255,0.85)', lineHeight: 1.3 }}>
              {analysis.action}
            </Typography>
          )}
        </Box>
        {!isCritical && (
          <IconButton
            size="small"
            onClick={handleDismiss}
            aria-label="Dismiss warning"
            sx={{
              color: 'rgba(255,255,255,0.7)',
              p: 0.3,
              ml: 0.5,
              flexShrink: 0,
              '&:hover': { color: '#fff' },
            }}
          >
            <Close sx={{ fontSize: 16 }} />
          </IconButton>
        )}
      </Box>
    </Box>
  );
}
