// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Analytics consent gate — a blocking full-screen dialog shown BEFORE the app
 * boots, but only when an analytics tracker is configured
 * (settings.json analytics.googleAnalyticsId) and the user has not yet opted in.
 *
 * Google Analytics sets cookies and transfers personal data, so under GDPR /
 * §25 TDDDG it must not load without prior, active consent. This gate enforces
 * that: the returned promise resolves only after the user accepts, and main.ts
 * awaits it before creating the viewer — so without consent the app does not run.
 *
 * On private/self-hosted deploys with no analytics id, requireAnalyticsConsent()
 * resolves immediately and nothing is shown.
 */

import { useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ThemeProvider } from '@mui/material/styles';
import { Box, Typography, Button, Paper, Link } from '@mui/material';
import { Cookie } from '@mui/icons-material';
import { rvDarkTheme } from './theme';
import { getAppConfig } from '../rv-app-config';
import { isAnalyticsConfigured, hasAnalyticsConsent, grantAnalyticsConsent } from '../consent-store';

/**
 * Resolve immediately when analytics is not configured or already consented.
 * Otherwise mount a blocking gate and resolve only once the user opts in.
 */
export function requireAnalyticsConsent(): Promise<void> {
  if (!isAnalyticsConfigured() || hasAnalyticsConsent()) return Promise.resolve();

  return new Promise<void>((resolve) => {
    const el = document.createElement('div');
    el.id = 'rv-consent-gate-root';
    el.style.cssText = 'position:fixed;inset:0;z-index:30000;pointer-events:auto;';
    document.body.appendChild(el);
    const root: Root = createRoot(el);

    const finish = () => {
      grantAnalyticsConsent();
      // Defer unmount so it doesn't run during the component's own commit.
      setTimeout(() => {
        try { root.unmount(); } catch { /* ignore */ }
        if (el.parentNode) el.parentNode.removeChild(el);
      }, 0);
      resolve();
    };

    root.render(
      <ThemeProvider theme={rvDarkTheme}>
        <ConsentGate onAccept={finish} />
      </ThemeProvider>,
    );
  });
}

function ConsentGate({ onAccept }: { onAccept: () => void }) {
  const [declined, setDeclined] = useState(false);
  const privacyUrl = getAppConfig().analytics?.privacyPolicyUrl;

  return (
    <Box sx={{
      position: 'fixed', inset: 0,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      bgcolor: 'rgba(0,0,0,0.88)', backdropFilter: 'blur(calc(12px * var(--rv-ui-blur-scale, 1)))', p: 2,
    }}>
      <Paper elevation={12} sx={{
        width: 420, maxWidth: '100%', p: 4, borderRadius: 3,
        bgcolor: 'rgba(30,30,30,0.97)', border: '1px solid rgba(255,255,255,0.08)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, textAlign: 'center',
      }}>
        <Box sx={{
          width: 48, height: 48, borderRadius: '50%',
          bgcolor: 'rgba(79,195,247,0.12)', border: '1px solid rgba(79,195,247,0.3)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Cookie sx={{ fontSize: 24, color: '#4fc3f7' }} />
        </Box>

        <Typography sx={{ fontSize: 16, fontWeight: 700, color: 'rgba(255,255,255,0.92)' }}>
          {declined ? 'Consent required' : 'Analytics & cookies'}
        </Typography>

        <Typography sx={{ fontSize: 13, color: 'rgba(255,255,255,0.6)', lineHeight: 1.5 }}>
          {declined
            ? 'This demo uses Google Analytics, which requires your consent. Without it the application cannot be loaded.'
            : 'This site uses Google Analytics to understand how the demo is used. It stores cookies and transfers usage data to Google. Analytics loads only after you accept — nothing is tracked until then.'}
        </Typography>

        {privacyUrl && (
          <Link
            href={privacyUrl}
            target="_blank"
            rel="noopener noreferrer"
            sx={{ fontSize: 12, color: '#4fc3f7' }}
          >
            Privacy policy
          </Link>
        )}

        <Box sx={{ display: 'flex', gap: 1.5, width: '100%', mt: 1 }}>
          {!declined && (
            <Button
              fullWidth
              variant="text"
              onClick={() => setDeclined(true)}
              sx={{ textTransform: 'none', color: 'rgba(255,255,255,0.55)' }}
            >
              Decline
            </Button>
          )}
          <Button
            fullWidth
            variant="contained"
            onClick={onAccept}
            sx={{ textTransform: 'none', fontWeight: 700, bgcolor: '#4fc3f7', '&:hover': { bgcolor: '#4fc3f7cc' } }}
          >
            {declined ? 'Accept & continue' : 'Accept'}
          </Button>
        </Box>
      </Paper>
    </Box>
  );
}
