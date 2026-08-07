// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControlLabel,
  Link,
  TextField,
  Typography,
} from '@mui/material';
import {
  HourglassTop,
  VerifiedUserOutlined,
  WarningAmber,
} from '@mui/icons-material';
import { ISA_AMBER, ISA_GREEN } from './isa-colors';
import {
  activateCommercialLicense,
  clearLicenseAction,
  deactivateLicense,
  deriveLicensePresentation,
  getLicenseSnapshot,
  LICENSE_TERMS_URL,
  registerCommunityLicense,
  subscribeLicenseStore,
  type LicenseRegistrationStatus,
  type LicenseStatus,
} from './license-store';

interface LicenseSectionProps {
  serverUrl: string;
  /** Test seam for deterministic state rendering; production reads the shared store. */
  statusOverride?: LicenseStatus | null;
}

function registrationMessage(registration: LicenseRegistrationStatus | null | undefined) {
  switch (registration?.status) {
    case 'waitingForEmailConfirmation':
      return {
        severity: 'info' as const,
        message: `Waiting for confirmation - check your inbox${registration.email ? ` (${registration.email})` : ''}.`,
      };
    case 'portalUnreachable':
      return {
        severity: 'warning' as const,
        message: 'The registration portal is currently unreachable. CONNECT will keep trying. For an air-gapped machine, import a signed license with --license-file <path>.',
      };
    case 'expired':
      return {
        severity: 'warning' as const,
        message: 'This registration request expired. Enter your email again to request a new link, or use --license-file <path> for an offline license.',
      };
    default:
      return null;
  }
}

export function LicenseSection({ serverUrl, statusOverride }: LicenseSectionProps) {
  const snapshot = useSyncExternalStore(subscribeLicenseStore, getLicenseSnapshot);
  const status = statusOverride === undefined ? snapshot.status : statusOverride;
  const supported = statusOverride === undefined ? snapshot.supported : true;
  const [dialogOpen, setDialogOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [licenseKey, setLicenseKey] = useState('');
  const [productUpdatesConsent, setProductUpdatesConsent] = useState(false);
  const [deactivateKey, setDeactivateKey] = useState('');

  useEffect(() => {
    if (status?.registration?.email && !email) setEmail(status.registration.email);
  }, [status?.registration?.email, email]);

  if (supported === false) return null;

  if (!status) {
    return snapshot.loading ? (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 0.5 }}>
        <CircularProgress size={10} aria-label="Checking license" />
        <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>License: Checking...</Typography>
      </Box>
    ) : null;
  }

  const presentation = deriveLicensePresentation(status);
  const warning = presentation.kind === 'warning';
  const pending = presentation.kind === 'pending';
  const licensed = presentation.kind === 'licensed';
  const color = warning ? ISA_AMBER : 'rgba(255,255,255,0.70)';
  // Icon signals the license tier at a glance: green = full commercial license,
  // amber = free tier or degraded/warning, neutral = pending.
  const iconColor = presentation.kind === 'licensed'
    ? ISA_GREEN
    : presentation.kind === 'free' || warning ? ISA_AMBER : color;
  const registration = registrationMessage(status.registration);
  const busy = snapshot.action === 'registering'
    || snapshot.action === 'activating'
    || snapshot.action === 'deactivating';

  const closeDialog = () => {
    if (busy) return;
    setDialogOpen(false);
    clearLicenseAction();
  };

  return (
    <>
      <Box
        data-testid="license-status-line"
        sx={{ display: 'flex', alignItems: 'flex-start', gap: 0.5, mt: 0.5, minWidth: 0 }}
      >
        {warning ? (
          <WarningAmber role="img" aria-label="License warning" sx={{ fontSize: 13, color: iconColor, mt: 0.1 }} />
        ) : pending ? (
          <HourglassTop role="img" aria-label="License pending" sx={{ fontSize: 13, color: iconColor, mt: 0.1 }} />
        ) : (
          <VerifiedUserOutlined role="img" aria-label="License active" sx={{ fontSize: 13, color: iconColor, mt: 0.1 }} />
        )}
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Typography sx={{ fontSize: 11, fontWeight: 500, color, lineHeight: 1.35 }}>
            {presentation.label}
          </Typography>
          {presentation.detail && (
            <Typography sx={{ fontSize: 10, color, lineHeight: 1.35 }}>
              {presentation.detail}
            </Typography>
          )}
        </Box>
        {presentation.actionLabel && (
          <Button
            size="small"
            variant="text"
            onClick={() => { clearLicenseAction(); setDialogOpen(true); }}
            sx={{ minWidth: 0, p: 0, fontSize: 10, textTransform: 'none', whiteSpace: 'nowrap' }}
          >
            {presentation.actionLabel}
          </Button>
        )}
      </Box>

      <Dialog
        open={dialogOpen}
        onClose={closeDialog}
        maxWidth="xs"
        fullWidth
        slotProps={{
          paper: {
            elevation: 0,
            sx: {
              bgcolor: 'rgba(30,30,30,0.78)',
              backdropFilter: 'blur(calc(16px * var(--rv-ui-blur-scale, 1)))',
              backgroundImage: 'none',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: '4px',
            },
          },
        }}
      >
        <DialogTitle sx={{ fontSize: 14, fontWeight: 600 }}>
          {licensed ? 'realvirtual CONNECT license' : 'Activate realvirtual CONNECT'}
        </DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          {!licensed && (
            <Alert severity="info" sx={{ '& .MuiAlert-message': { fontSize: 11, lineHeight: 1.5 } }}>
              realvirtual CONNECT and its interfaces are currently in <strong>beta</strong>.
              If you run into problems or have questions, please contact{' '}
              <Link href="mailto:info@realvirtual.io" sx={{ fontSize: 11 }}>
                info@realvirtual.io
              </Link>
              .
            </Alert>
          )}

          {licensed && (
            <Box>
              <Typography sx={{ fontSize: 12, fontWeight: 600, mb: 0.5 }}>Deactivate this device</Typography>
              <Typography sx={{ fontSize: 11, color: 'text.secondary', mb: 1 }}>
                Releases this machine&apos;s seat so the license can be activated on another device.
                Enter your license key to confirm.
              </Typography>
              <TextField
                fullWidth
                size="small"
                label="License key"
                value={deactivateKey}
                onChange={(event) => setDeactivateKey(event.target.value)}
                disabled={busy}
                inputProps={{ spellCheck: false }}
                sx={{ '& .MuiInputBase-input': { fontSize: 12, fontFamily: 'monospace' } }}
              />
              <Button
                size="small"
                variant="outlined"
                color="error"
                onClick={() => void deactivateLicense(serverUrl, deactivateKey)}
                disabled={busy || !deactivateKey.trim()}
                sx={{ mt: 1, textTransform: 'none', fontSize: 11 }}
              >
                {snapshot.action === 'deactivating' ? 'Deactivating...' : 'Deactivate license'}
              </Button>
            </Box>
          )}

          {!licensed && (
          <Box>
            <Typography sx={{ fontSize: 12, fontWeight: 600, mb: 0.5 }}>Start free with 20 signals</Typography>
            <Typography sx={{ fontSize: 11, color: 'text.secondary', mb: 1 }}>
              Enter your email. We will send a confirmation link; no password is required.
            </Typography>
            <TextField
              fullWidth
              size="small"
              type="email"
              label="Email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={busy}
              sx={{ '& .MuiInputBase-input': { fontSize: 12 } }}
            />
            <FormControlLabel
              sx={{ mt: 0.5, mr: 0, alignItems: 'flex-start' }}
              control={
                <Checkbox
                  size="small"
                  checked={productUpdatesConsent}
                  onChange={(event) => setProductUpdatesConsent(event.target.checked)}
                  disabled={busy}
                  sx={{ py: 0.25 }}
                />
              }
              label={
                <Typography sx={{ fontSize: 10, color: 'text.secondary', lineHeight: 1.4, pt: 0.4 }}>
                  Also keep me informed about product updates and news (optional, revocable at any time)
                </Typography>
              }
            />
            <Button
              size="small"
              variant="contained"
              onClick={() => void registerCommunityLicense(serverUrl, email, productUpdatesConsent)}
              disabled={busy || !email.trim()}
              sx={{ mt: 1, textTransform: 'none', fontSize: 11 }}
            >
              {snapshot.action === 'registering' ? 'Sending...' : 'Send confirmation link'}
            </Button>
          </Box>
          )}

          {(registration || snapshot.actionMessage) && (
            <Box aria-live="polite" aria-atomic="true">
              {registration && <Alert severity={registration.severity}>{registration.message}</Alert>}
              {snapshot.actionMessage && (
                <Alert
                  severity={snapshot.action === 'error' ? 'error' : 'success'}
                  sx={{ mt: registration ? 0.75 : 0 }}
                >
                  {snapshot.actionMessage}
                </Alert>
              )}
            </Box>
          )}

          {!licensed && (
          <>
          <Divider sx={{ borderColor: 'rgba(255,255,255,0.08)' }} />

          <Box>
            <Typography sx={{ fontSize: 12, fontWeight: 600, mb: 0.5 }}>Activate a license key</Typography>
            <TextField
              fullWidth
              size="small"
              label="License key"
              value={licenseKey}
              onChange={(event) => setLicenseKey(event.target.value)}
              disabled={busy}
              inputProps={{ spellCheck: false }}
              sx={{ '& .MuiInputBase-input': { fontSize: 12, fontFamily: 'monospace' } }}
            />
            <Button
              size="small"
              variant="contained"
              onClick={() => void activateCommercialLicense(serverUrl, licenseKey)}
              disabled={busy || !licenseKey.trim()}
              sx={{ mt: 1, textTransform: 'none', fontSize: 11 }}
            >
              {snapshot.action === 'activating' ? 'Activating...' : 'Activate license'}
            </Button>
          </Box>

          <Typography sx={{ fontSize: 10, color: 'text.secondary', lineHeight: 1.4 }}>
            By activating you agree to the{' '}
            <Link
              href={LICENSE_TERMS_URL}
              target="_blank"
              rel="noopener noreferrer"
              sx={{ fontSize: 10 }}
            >
              realvirtual license terms
            </Link>
            . See our{' '}
            <Link
              href="https://realvirtual.io/en/privacy/"
              target="_blank"
              rel="noopener noreferrer"
              sx={{ fontSize: 10 }}
            >
              privacy policy
            </Link>
            {' '}for how we handle your email.
          </Typography>
          </>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={closeDialog} disabled={busy} sx={{ textTransform: 'none' }}>Close</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

