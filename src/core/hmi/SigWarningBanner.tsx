// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { useEffect, useState } from 'react';
import { Box, Button, CircularProgress, IconButton, Typography } from '@mui/material';
import { Close, GppBad, InfoOutlined, KeyboardArrowDown, KeyboardArrowUp } from '@mui/icons-material';
import { ISA_AMBER } from './isa-colors';
import { useSignatureUiState } from '../rv-sig-store';

export interface SigWarningBannerProps {
  compact?: boolean;
}

/**
 * Warns when an rv_sig-bearing model cannot be trusted and keeps its logic
 * disabled until the user explicitly activates it.
 */
export function SigWarningBanner({ compact = false }: SigWarningBannerProps) {
  const state = useSignatureUiState();
  const [dismissed, setDismissed] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [activationError, setActivationError] = useState(false);

  useEffect(() => {
    setDismissed(false);
    setDetailsOpen(false);
    setActivationError(false);
  }, [state.modelName, state.signatureState]);

  const visible = state.logicRunState !== 'active'
    && (state.signatureState === 'invalid' || state.signatureState === 'unverifiable');
  if (!visible || dismissed) return null;

  const unverifiable = state.signatureState === 'unverifiable';
  const activating = state.logicRunState === 'activating';
  const title = unverifiable
    ? 'Model signature could not be verified'
    : 'Model signature is invalid';
  const summary = unverifiable
    ? 'Automation logic is disabled because this browser could not verify the model provenance.'
    : 'Automation logic is disabled because the model contents do not match its signature.';

  const handleActivate = async () => {
    setActivationError(false);
    try {
      if (!await state.viewer?.activateGatedLogic()) setActivationError(true);
    } catch {
      setActivationError(true);
    }
  };

  return (
    <Box
      data-ui-panel
      role="alert"
      data-testid="sig-warning-banner"
      sx={{
        position: 'fixed',
        top: compact ? 8 : 58,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 9500,
        pointerEvents: 'auto',
        width: compact ? 'min(520px, calc(100vw - 24px))' : 'min(680px, calc(100vw - 32px))',
      }}
    >
      <Box sx={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 1.25,
        px: compact ? 1.25 : 2,
        py: compact ? 1 : 1.25,
        bgcolor: 'rgba(68, 48, 15, 0.97)',
        border: `1px solid ${ISA_AMBER}`,
        borderRadius: 2,
        boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
        backdropFilter: 'blur(calc(8px * var(--rv-ui-blur-scale, 1)))',
      }}>
        {unverifiable
          ? <InfoOutlined sx={{ mt: 0.15, fontSize: 20, color: '#fff', flexShrink: 0 }} />
          : <GppBad sx={{ mt: 0.15, fontSize: 20, color: '#fff', flexShrink: 0 }} />}
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography sx={{ fontSize: 12, fontWeight: 600, color: '#fff', lineHeight: 1.4 }}>
            {title}
          </Typography>
          {!compact && (
            <Typography sx={{ mt: 0.25, fontSize: 11, color: 'rgba(255,255,255,0.82)', lineHeight: 1.4 }}>
              {summary}
            </Typography>
          )}
          {detailsOpen && (
            <Typography
              data-testid="sig-warning-details"
              sx={{ mt: 0.75, fontSize: 11, color: 'rgba(255,255,255,0.78)', lineHeight: 1.4 }}
            >
              Model: {state.modelName || 'unknown'}
              {state.signerOrganization ? ` · Signer: ${state.signerOrganization}` : ''}
              {' · Activation is remembered for this model in this browser.'}
            </Typography>
          )}
          {activationError && (
            <Typography sx={{ mt: 0.75, fontSize: 11, color: '#ffd6d6', lineHeight: 1.4 }}>
              Logic activation did not complete. Reload the model and try again.
            </Typography>
          )}
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mt: 0.75 }}>
            <Button
              size="small"
              variant="contained"
              disabled={activating}
              onClick={() => { void handleActivate(); }}
              startIcon={activating ? <CircularProgress size={12} color="inherit" /> : undefined}
              sx={{ minHeight: 28, px: 1.25, py: 0.25, fontSize: 11, textTransform: 'none' }}
            >
              {activating ? 'Activating…' : 'Activate logic'}
            </Button>
            <Button
              size="small"
              color="inherit"
              onClick={() => setDetailsOpen((open) => !open)}
              endIcon={detailsOpen ? <KeyboardArrowUp /> : <KeyboardArrowDown />}
              sx={{ minHeight: 28, px: 1, py: 0.25, color: 'rgba(255,255,255,0.85)', fontSize: 11, textTransform: 'none' }}
            >
              Details
            </Button>
          </Box>
        </Box>
        <IconButton
          size="small"
          onClick={() => setDismissed(true)}
          aria-label="Dismiss model signature warning"
          sx={{ color: 'rgba(255,255,255,0.7)', p: 0.3, flexShrink: 0, '&:hover': { color: '#fff' } }}
        >
          <Close sx={{ fontSize: 16 }} />
        </IconButton>
      </Box>
    </Box>
  );
}
