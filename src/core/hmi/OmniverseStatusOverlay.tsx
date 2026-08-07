// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * OmniverseStatusOverlay — a small floating status badge shown over the RTX
 * stream while the Omniverse render backend is connecting, exporting the current
 * scene (GLB→USD), loading, waiting for the Kit app, or on error (plan-256).
 * Hidden while `three` is active and once the stream is live (`streaming`), so it
 * only surfaces transient/loading state. Purely informational (pointer-events none).
 */

import { useEffect, useState } from 'react';
import { Box, Paper, Typography, CircularProgress } from '@mui/material';
import { ErrorOutline, Bolt } from '@mui/icons-material';
import { useViewer } from '../../hooks/use-viewer';
import type { RenderBackendId, RenderBackendStatus } from '../render-backend/rv-render-backend';
import { LEFT_PANEL_ZINDEX } from './layout-constants';

const LABEL: Record<RenderBackendStatus, string> = {
  idle: '',
  connecting: 'Connecting to Omniverse…',
  loading: 'Loading scene…',
  streaming: 'Omniverse RTX live',
  waiting: 'Waiting for Omniverse',
  error: 'Omniverse error',
};

export function OmniverseStatusOverlay() {
  const viewer = useViewer();
  const [backend, setBackend] = useState<RenderBackendId>(viewer.renderBackend);
  const [status, setStatus] = useState<RenderBackendStatus>(viewer.renderBackendStatus);
  const [detail, setDetail] = useState<string>(viewer.renderBackendStatusDetail);

  useEffect(() => {
    const sync = () => { setStatus(viewer.renderBackendStatus); setDetail(viewer.renderBackendStatusDetail); };
    const offBackend = viewer.onRenderBackendChange((b) => { setBackend(b); sync(); });
    const offStatus = viewer.onRenderBackendStatusChange(() => sync());
    setBackend(viewer.renderBackend);
    sync();
    return () => { offBackend(); offStatus(); };
  }, [viewer]);

  // Only for the Omniverse backend, and only for transient states (hide once live).
  if (backend !== 'omniverse' || status === 'idle' || status === 'streaming') return null;

  const spinning = status === 'connecting' || status === 'loading';
  const isError = status === 'error';
  // Parse a trailing "NN%" out of the detail line for a determinate ring.
  const pctMatch = detail.match(/(\d+)\s*%/);
  const pct = pctMatch ? Math.max(0, Math.min(100, parseInt(pctMatch[1], 10))) : null;

  return (
    <Box
      sx={{
        position: 'fixed',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        zIndex: LEFT_PANEL_ZINDEX + 1,
        pointerEvents: 'none',
        maxWidth: '80vw',
      }}
    >
      <Paper
        elevation={8}
        sx={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1.5,
          px: 4, py: 3, borderRadius: 3, minWidth: 240,
          bgcolor: isError ? 'rgba(90,24,24,0.94)' : 'rgba(28,28,30,0.92)',
          backdropFilter: 'blur(calc(16px * var(--rv-ui-blur-scale, 1)))',
          color: 'rgba(255,255,255,0.95)',
          border: `1px solid ${isError ? 'rgba(255,120,120,0.5)' : 'rgba(255,255,255,0.12)'}`,
          textAlign: 'center',
        }}
      >
        {isError ? (
          <ErrorOutline sx={{ fontSize: 40, color: '#ff8a80' }} />
        ) : status === 'waiting' ? (
          <Bolt sx={{ fontSize: 40, color: '#ffca28' }} />
        ) : pct != null ? (
          <Box sx={{ position: 'relative', display: 'inline-flex' }}>
            <CircularProgress variant="determinate" value={pct} size={52} thickness={4} sx={{ color: '#4fc3f7' }} />
            <Box sx={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Typography sx={{ fontSize: 13, fontWeight: 700 }}>{pct}%</Typography>
            </Box>
          </Box>
        ) : (
          spinning && <CircularProgress size={44} thickness={4} sx={{ color: '#4fc3f7' }} />
        )}

        <Box sx={{ minWidth: 0 }}>
          <Typography sx={{ fontSize: 15, fontWeight: 600, lineHeight: 1.3 }}>
            {LABEL[status]}
          </Typography>
          {detail && (
            <Typography sx={{ fontSize: 12, opacity: 0.8, lineHeight: 1.3, mt: 0.25 }}>
              {detail.replace(/\s*\d+\s*%$/, '')}
            </Typography>
          )}
        </Box>
      </Paper>
    </Box>
  );
}
