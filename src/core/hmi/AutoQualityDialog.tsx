// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * AutoQualityDialog — Modal shown once when auto-quality reduced the visual
 * preset to "Fast" (weak GPU / mobile at boot, or low FPS at runtime — see
 * auto-quality.ts). Dismissed with OK; points the user to Settings → Visual
 * where the preset can be changed back.
 *
 * Defers while the WelcomeModal is open (both fire on a first visit) so the
 * user never sees two stacked modals — the notice store keeps the message
 * until it is actually shown and dismissed.
 */

import { createPortal } from 'react-dom';
import { Box, Paper, Typography, Button } from '@mui/material';
import SpeedIcon from '@mui/icons-material/Speed';
import { useAutoQualityNotice, clearAutoQualityNotice, type AutoQualityReason } from './auto-quality';
import {
  useMayShowStartupModal,
  useStartupModalRegistration,
} from './startup-modal-coordinator';

function messageFor(reason: AutoQualityReason, presetName: string): string {
  switch (reason) {
    case 'mobile':
      return `Visual quality was set to "${presetName}" for smooth performance on this mobile device.`;
    case 'weak-gpu':
      return `This device renders with a low-performance graphics unit, so visual quality was set to "${presetName}" for smooth performance.`;
  }
}

export function AutoQualityDialog() {
  const notice = useAutoQualityNotice();
  const mayShow = useMayShowStartupModal('autoquality');
  const open = !!notice && mayShow;
  useStartupModalRegistration('autoquality', open);

  if (!notice || !open) return null;

  return createPortal(
    <Box
      role="dialog"
      aria-modal="true"
      aria-labelledby="rv-auto-quality-title"
      sx={{
        position: 'fixed',
        inset: 0,
        zIndex: 10000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        bgcolor: 'rgba(0,0,0,0.6)',
        pointerEvents: 'auto',
      }}
      onClick={clearAutoQualityNotice}
    >
      <Paper
        elevation={12}
        sx={{
          borderRadius: 2,
          width: 420,
          maxWidth: '95vw',
          p: { xs: 2.5, sm: 3 },
          display: 'flex',
          flexDirection: 'column',
          gap: 1.5,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <SpeedIcon sx={{ color: '#4fc3f7', fontSize: 22 }} />
          <Typography id="rv-auto-quality-title" variant="h6" sx={{ fontWeight: 700, fontSize: 16 }}>
            Performance mode enabled
          </Typography>
        </Box>

        <Typography variant="body2" sx={{ color: 'text.secondary', lineHeight: 1.7 }}>
          {messageFor(notice.reason, notice.presetName)}
        </Typography>
        <Typography variant="body2" sx={{ color: 'text.secondary', lineHeight: 1.7 }}>
          You can change this anytime under <strong style={{ color: '#fff' }}>Settings → Visual → Preset</strong>.
        </Typography>

        <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 0.5 }}>
          <Button
            variant="contained"
            size="small"
            onClick={clearAutoQualityNotice}
            data-testid="auto-quality-ok"
            sx={{ textTransform: 'none', fontWeight: 600, minWidth: 80 }}
          >
            OK
          </Button>
        </Box>
      </Paper>
    </Box>,
    document.body,
  );
}
