// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * SharedViewBanner — Floating banner shown when following another user's view.
 *
 * Displays "Following [OperatorName]'s view" at the top-center of the screen
 * with an "Unfollow" button to break out of shared view mode.
 */

import { useSyncExternalStore } from 'react';
import { Box, Typography, Button } from '@mui/material';
import { Visibility, Close } from '@mui/icons-material';
import {
  subscribeSharedView,
  getSharedViewSnapshot,
} from '../../plugins/multiuser-plugin';

export function SharedViewBanner() {
  const snap = useSyncExternalStore(subscribeSharedView, getSharedViewSnapshot);

  if (!snap.following) return null;

  return (
    <Box
      data-ui-panel
      sx={{
        position: 'fixed',
        top: 8,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 9500,
        pointerEvents: 'auto',
      }}
    >
      <Box sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        px: 2,
        py: 0.75,
        bgcolor: 'rgba(21,101,192,0.95)',
        borderRadius: 2,
        boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
        backdropFilter: 'blur(8px)',
      }}>
        <Visibility sx={{ fontSize: 16, color: '#fff' }} />
        <Typography sx={{ fontSize: 12, fontWeight: 500, color: '#fff' }}>
          Following {snap.operatorName}&apos;s view
        </Typography>
        <Button
          size="small"
          variant="outlined"
          startIcon={<Close sx={{ fontSize: 12 }} />}
          onClick={snap.onUnfollow}
          sx={{
            fontSize: 10,
            textTransform: 'none',
            color: '#fff',
            borderColor: 'rgba(255,255,255,0.4)',
            py: 0.25,
            px: 1,
            ml: 1,
            minWidth: 0,
            '&:hover': {
              borderColor: '#fff',
              bgcolor: 'rgba(255,255,255,0.1)',
            },
          }}
        >
          Unfollow
        </Button>
      </Box>
    </Box>
  );
}
