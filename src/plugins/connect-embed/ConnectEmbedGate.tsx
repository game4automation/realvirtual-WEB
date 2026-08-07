// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  CircularProgress,
  Link,
  Paper,
  Typography,
} from '@mui/material';
import { ErrorOutline, OpenInNew, PlayArrow } from '@mui/icons-material';
import { useViewer } from '../../hooks/use-viewer';
import { useMobileLayout } from '../../hooks/use-mobile-layout';
import { useViewportInsets } from '../../hooks/use-viewport-insets';
import { getAppConfig } from '../../core/rv-app-config';
import {
  hasSeenConnectEmbedSignalHint,
  markConnectEmbedSignalHintSeen,
} from '../../core/hmi/rv-storage-keys';
import { startConnectEmbedDemo } from './connect-embed-actions';
import {
  getConnectEmbedSnapshot,
  resetConnectEmbedDemo,
  subscribeConnectEmbedStore,
} from './connect-embed-store';

const DEFAULT_SOURCE_URL = 'https://github.com/game4automation/realvirtual-WEB';

/** Minimal-shell empty/loading/error surface for the CONNECT embedded demo. */
export function ConnectEmbedGate() {
  const viewer = useViewer();
  const snap = useSyncExternalStore(
    subscribeConnectEmbedStore,
    getConnectEmbedSnapshot,
    getConnectEmbedSnapshot,
  );
  const panelSnap = useSyncExternalStore(
    viewer.leftPanelManager.subscribe,
    viewer.leftPanelManager.getSnapshot,
    viewer.leftPanelManager.getSnapshot,
  );
  const isMobile = useMobileLayout();

  // Same entry point the model row uses, so both run the gate state machine.
  const startDemo = useCallback(() => { void startConnectEmbedDemo(viewer); }, [viewer]);

  const returnToEmpty = useCallback(() => resetConnectEmbedDemo(), []);
  const left = isMobile ? 0 : panelSnap.left.activePanelWidth;
  const sourceUrl = getAppConfig().sourceUrl || DEFAULT_SOURCE_URL;

  return (
    <Box
      data-testid="connect-embed-gate"
      sx={{
        position: 'fixed',
        top: 0,
        right: 0,
        bottom: 0,
        left,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        px: 3,
        pointerEvents: 'auto',
      }}
    >
      <Paper
        role="region"
        aria-label="realvirtual CONNECT demo"
        sx={{
          width: 'min(520px, 100%)',
          p: { xs: 2, sm: 3 },
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 1,
          textAlign: 'center',
        }}
      >
        {snap.state === 'loading' ? (
          <LoadingState />
        ) : snap.state === 'load-error' ? (
          <ErrorState error={snap.error} onRetry={startDemo} onBack={returnToEmpty} />
        ) : (
          <EmptyState onStart={startDemo} sourceUrl={sourceUrl} />
        )}
      </Paper>
    </Box>
  );
}

function EmptyState({ onStart, sourceUrl }: { onStart: () => void; sourceUrl: string }) {
  return (
    <>
      <Typography component="h1" sx={{ fontSize: 18, fontWeight: 600, lineHeight: 1.45, textWrap: 'balance' }}>
        Want to check your signals and experience a digital twin with realvirtual CONNECT?
      </Typography>
      <Typography sx={{ mt: 1, color: 'text.secondary', fontSize: 13, lineHeight: 1.5 }}>
        Start the included machine demo when you are ready. Your CONNECT interfaces and signal monitoring stay available in the panel.
      </Typography>
      <Button
        data-testid="connect-embed-start"
        variant="contained"
        startIcon={<PlayArrow />}
        onClick={onStart}
        sx={{ mt: 2.5, minWidth: 180, textTransform: 'none' }}
      >
        Start the demo
      </Button>
      <Box sx={{ mt: 2 }}>
        <Link
          href={sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          underline="hover"
          sx={{ color: 'text.secondary', fontSize: 11 }}
        >
          Source code (AGPL-3.0) <OpenInNew sx={{ ml: 0.25, fontSize: 11, verticalAlign: '-1px' }} />
        </Link>
      </Box>
    </>
  );
}

function LoadingState() {
  return (
    <Box data-testid="connect-embed-loading" role="status" aria-live="polite" sx={{ py: 1 }}>
      <CircularProgress size={28} thickness={4} />
      <Typography sx={{ mt: 1.5, fontSize: 14, fontWeight: 600 }}>Loading the digital twin</Typography>
      <Typography sx={{ mt: 0.5, color: 'text.secondary', fontSize: 12 }}>
        Preparing the model and standalone simulation…
      </Typography>
    </Box>
  );
}

function ErrorState({
  error,
  onRetry,
  onBack,
}: {
  error: string | null;
  onRetry: () => void;
  onBack: () => void;
}) {
  return (
    <Box data-testid="connect-embed-error" role="alert">
      <ErrorOutline color="error" sx={{ fontSize: 28 }} />
      <Typography sx={{ mt: 1, fontSize: 14, fontWeight: 600 }}>The demo could not be loaded</Typography>
      <Typography sx={{ mt: 0.75, color: 'text.secondary', fontSize: 12, overflowWrap: 'anywhere' }}>
        {error || 'Check the embedded model and try again.'}
      </Typography>
      <Box sx={{ mt: 2, display: 'flex', justifyContent: 'center', gap: 1 }}>
        <Button variant="text" onClick={onBack} sx={{ textTransform: 'none' }}>Back</Button>
        <Button variant="contained" onClick={onRetry} sx={{ textTransform: 'none' }}>Retry</Button>
      </Box>
    </Box>
  );
}

/**
 * The one-off "connect your live signals" hint, shown while the embedded demo
 * runs.
 *
 * Since plan-373 this is ALL that floats over the viewport: the `DEMO · Standalone`
 * chip and the top-right "Close scene" button are gone. Closing the scene now
 * happens where the user opened it — on the model row in the Models panel — so the
 * top-right corner of the 3D view stays clear.
 */
export function ConnectEmbedDemoControls() {
  const insets = useViewportInsets();
  const snap = useSyncExternalStore(
    subscribeConnectEmbedStore,
    getConnectEmbedSnapshot,
    getConnectEmbedSnapshot,
  );
  const [hintOpen, setHintOpen] = useState(false);
  const demoRunning = snap.enabled && snap.state === 'demo-running';

  useEffect(() => {
    if (!demoRunning) {
      setHintOpen(false);
      return;
    }
    setHintOpen(!hasSeenConnectEmbedSignalHint());
  }, [demoRunning]);

  useEffect(() => {
    if (demoRunning && hintOpen) markConnectEmbedSignalHintSeen();
  }, [demoRunning, hintOpen]);

  const dismissHint = useCallback(() => {
    markConnectEmbedSignalHintSeen();
    setHintOpen(false);
  }, []);

  if (!snap.enabled || snap.state !== 'demo-running') return null;

  return (
    <>
      {hintOpen && (
        <Box
          sx={{
            position: 'fixed',
            top: insets.top + 96,
            left: insets.left,
            right: insets.right,
            zIndex: 1200,
            display: 'flex',
            justifyContent: 'center',
            pointerEvents: 'none',
          }}
        >
          <Alert
            data-testid="connect-embed-signal-hint"
            role="status"
            icon={false}
            variant="outlined"
            onClose={dismissHint}
            closeText="Dismiss signal connection hint"
            sx={{
              width: { xs: 'calc(100vw - 16px)', sm: 460 },
              maxWidth: 'calc(100% - 16px)',
              bgcolor: 'rgba(30,30,30,0.85) !important',
              backdropFilter: 'blur(calc(16px * var(--rv-ui-blur-scale, 1)))',
              borderColor: 'rgba(255,255,255,0.12)',
              borderRadius: 1,
              color: 'text.primary',
              alignItems: 'flex-start',
              pointerEvents: 'auto',
              '& .MuiAlert-message': { py: 0.25 },
            }}
          >
            <AlertTitle sx={{ mb: 0.5, fontSize: 14, fontWeight: 600 }}>
              Connect your live signals
            </AlertTitle>
            Hold <strong>Shift</strong> and drag a signal from the CONNECT panel over a machine
            component or drive — when its binding panel opens, drop the signal on the matching
            signal slot. Once connected, the demo&apos;s internal logic for that component is
            disabled and your live signal takes control.
          </Alert>
        </Box>
      )}
    </>
  );
}
