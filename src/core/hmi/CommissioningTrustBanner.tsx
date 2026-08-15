// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * The one explicit step between a shared model and the user's own plant
 * (plan-423 F6).
 *
 * A GLB that arrived through `?glb=` is loaded untrusted (plan-386 F17): no
 * signal binding manager, no interface auto-connect, no CONNECT per-model
 * stream. For a spectator that is exactly right. For the integrator the
 * commissioning workspace exists for it is the whole job, so he is offered ONE
 * decision, in plain words, with the consequence named: this model will be
 * allowed to talk to your machines.
 *
 * ## Why a reload and not a live upgrade
 *
 * All four gates sit INSIDE the load path (the binding manager is constructed
 * during `loadModel`, the interface hooks fire from it). Re-deriving them in a
 * running viewer would be a second, untested construction order for the most
 * safety-relevant subsystem in the page. Persisting the decision and reloading
 * the same URL uses the ONE path that is exercised on every visit
 * (plan-423 Alternative 2, rejected on those grounds).
 *
 * ## Unsaved changes
 *
 * A shared link never creates a SceneStore workspace — `rv-share-boot` calls
 * `viewer.loadModel()` directly, and the neighbouring transient path does not
 * even schedule its autosave. There is therefore no draft carrier to flush and
 * no awaitable flush API to await (plan-423 §2.4 entry measurement). What edits
 * exist are in memory, so the reload is a real loss and the confirmation SAYS
 * so rather than discarding them quietly.
 *
 * Shape and placement deliberately mirror `SigWarningBanner` — the two can
 * appear together and must not look like two different products.
 */

import { useState } from 'react';
import { Box, Button, Typography } from '@mui/material';
import { Cable, WarningAmber } from '@mui/icons-material';
import { ISA_AMBER } from './isa-colors';
import { useUIVisible } from './ui-context-store';
import { useModelProvenance } from '../rv-model-provenance';
import { forgetShareTrust, rememberShareTrust } from '../share/rv-share-trust-store';

export interface CommissioningTrustBannerProps {
  /** Test seam: what "reload the page" means. Defaults to `location.reload()`. */
  onReload?: () => void;
}

export function CommissioningTrustBanner({ onReload }: CommissioningTrustBannerProps) {
  const provenance = useModelProvenance();
  const [confirming, setConfirming] = useState(false);
  const [storageWarning, setStorageWarning] = useState(false);
  // A chrome element, so it registers its own rule (doc-ui-visibility §2 case 2)
  // under a stable id a deployment can override. POSITIVE on purpose: outside
  // the commissioning workspace this must never appear, including in the
  // CONNECT embed and before mode boot, where a `hiddenIn` would fail open.
  const inCommissioning = useUIVisible('commissioning-trust-banner', {
    shownOnlyIn: ['mode:commissioning'],
  });

  // Nothing foreign on screen → nothing to decide. `source: 'local'` is what
  // every ordinary load publishes, and what clearModel() falls back to.
  if (!inCommissioning || provenance.source === 'local') return null;

  const reload = () => (onReload ? onReload() : location.reload());
  const key = provenance.trustRecordKey ?? '';
  const digest = provenance.digest ?? null;
  const canPersist = Boolean(key && digest);

  const activate = () => {
    // A refused write is not a failure: the activation still applies to the
    // load it triggers. Only the memory of it is lost, and the banner will ask
    // again next time — which is why the notice is a sentence, not an error.
    const stored = rememberShareTrust(key, digest);
    if (!stored) {
      setStorageWarning(true);
      return;
    }
    reload();
  };

  const revoke = () => {
    forgetShareTrust(key);
    reload();
  };

  const origin = provenance.sourceOrigin ? ` from ${provenance.sourceOrigin}` : '';

  return (
    <Box
      data-ui-panel
      role="alert"
      data-testid="commissioning-trust-banner"
      sx={{
        position: 'fixed',
        top: 58,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 9490,
        pointerEvents: 'auto',
        width: 'min(680px, calc(100vw - 32px))',
      }}
    >
      <Box sx={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 1.25,
        px: 2,
        py: 1.25,
        bgcolor: provenance.trusted ? 'rgba(18, 42, 52, 0.97)' : 'rgba(68, 48, 15, 0.97)',
        border: `1px solid ${provenance.trusted ? 'rgba(79,195,247,0.55)' : ISA_AMBER}`,
        borderRadius: 2,
        boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
        backdropFilter: 'blur(calc(8px * var(--rv-ui-blur-scale, 1)))',
      }}>
        {provenance.trusted
          ? <Cable sx={{ mt: 0.15, fontSize: 20, color: '#fff', flexShrink: 0 }} />
          : <WarningAmber sx={{ mt: 0.15, fontSize: 20, color: '#fff', flexShrink: 0 }} />}
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography sx={{ fontSize: 12, fontWeight: 600, color: '#fff', lineHeight: 1.4 }}>
            {provenance.trusted
              ? 'Live connections are enabled for this shared model'
              : 'Live connections are switched off for this shared model'}
          </Typography>
          <Typography sx={{ mt: 0.25, fontSize: 11, color: 'rgba(255,255,255,0.82)', lineHeight: 1.4 }}>
            {provenance.trusted
              ? `This model${origin} may bind signals and connect to your interfaces.`
              : `This model arrived through a shared link${origin}. Signal binding, CONNECT`
                + ' streaming and interface auto-connect stay off until you allow them.'}
          </Typography>

          {confirming && !provenance.trusted && (
            <Typography
              data-testid="commissioning-trust-confirm"
              sx={{ mt: 0.75, fontSize: 11, color: '#ffe2a8', lineHeight: 1.4 }}
            >
              Allowing this connects <strong>somebody else&apos;s model</strong> to your plant.
              The page reloads to apply it — <strong>unsaved changes to this shared model are
              lost</strong>.
            </Typography>
          )}

          {storageWarning && (
            <Typography
              data-testid="commissioning-trust-storage-warning"
              sx={{ mt: 0.75, fontSize: 11, color: '#ffd6d6', lineHeight: 1.4 }}
            >
              This decision could not be stored in this browser, so it cannot be applied by
              reloading. Check whether site data is blocked (private mode, quota).
            </Typography>
          )}

          {!canPersist && !provenance.trusted && (
            <Typography
              data-testid="commissioning-trust-unavailable"
              sx={{ mt: 0.75, fontSize: 11, color: 'rgba(255,255,255,0.7)', lineHeight: 1.4 }}
            >
              Not available here: this page cannot fingerprint the model (no secure context), and
              a decision that cannot name the exact bytes is not one worth remembering.
            </Typography>
          )}

          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mt: 0.75 }}>
            {provenance.trusted ? (
              <Button
                size="small"
                color="inherit"
                onClick={revoke}
                data-testid="commissioning-trust-revoke"
                sx={{ minHeight: 28, px: 1.25, py: 0.25, color: 'rgba(255,255,255,0.85)', fontSize: 11, textTransform: 'none' }}
              >
                Revoke live connections
              </Button>
            ) : confirming ? (
              <>
                <Button
                  size="small"
                  variant="contained"
                  onClick={activate}
                  disabled={!canPersist}
                  data-testid="commissioning-trust-confirm-activate"
                  sx={{ minHeight: 28, px: 1.25, py: 0.25, fontSize: 11, textTransform: 'none' }}
                >
                  Reload and allow
                </Button>
                <Button
                  size="small"
                  color="inherit"
                  onClick={() => { setConfirming(false); setStorageWarning(false); }}
                  data-testid="commissioning-trust-cancel"
                  sx={{ minHeight: 28, px: 1, py: 0.25, color: 'rgba(255,255,255,0.85)', fontSize: 11, textTransform: 'none' }}
                >
                  Cancel
                </Button>
              </>
            ) : (
              <Button
                size="small"
                variant="contained"
                onClick={() => setConfirming(true)}
                disabled={!canPersist}
                data-testid="commissioning-trust-activate"
                sx={{ minHeight: 28, px: 1.25, py: 0.25, fontSize: 11, textTransform: 'none' }}
              >
                Allow live connections
              </Button>
            )}
          </Box>
        </Box>
      </Box>
    </Box>
  );
}
