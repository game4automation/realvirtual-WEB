// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * AiBridgeGate — the consent gate and the acquisition dead end for the AI Bridge
 * (plan-366 Phase 6).
 *
 * Two surfaces live here:
 *
 *   `AiBridgeGate`          wraps the Settings ▸ AI tab body. The AI panel is
 *                           MOUNTED only after the device acknowledged what the
 *                           bridge may reach. Because both entrances (activity
 *                           bar, Settings tab — and on mobile the tab alone) end
 *                           up here, the gate cannot be walked around.
 *   `AiBridgeDownloadInfo`  the "no CONNECT answered" state: realvirtual CONNECT
 *                           is the MCP server, so without it there is nothing to
 *                           configure — this states that and offers the download,
 *                           reusing `ConnectDownloadLinks` from ConnectPanel.
 *
 * Design: MUI `Dialog` (a Modal — the overlay stacking contract, never a
 * z-index bump), elevation 0 glass, 13px body, one Instrument Blue primary.
 */

import { useState, type ReactNode } from 'react';
import {
  Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Typography,
} from '@mui/material';
import { AI_BRIDGE_CONSENT_VERSION, grantAiBridgeConsent, useAiBridgeConsent } from './ai-consent-store';
import { requestSettingsTab } from './settings-tab-store';
import { ConnectDownloadLinks } from './ConnectPanel';

/** AI tab id in SettingsPanel — the one place `Configure…` can land. */
const SETTINGS_TAB_AI = 5;

function ScopeLine({ label, text }: { label: string; text: string }) {
  return (
    <Typography sx={{ fontSize: 12, color: 'text.secondary', lineHeight: 1.6 }}>
      <Box component="span" sx={{ fontWeight: 600, color: 'text.primary' }}>{label}</Box>
      {' — '}
      {text}
    </Typography>
  );
}

/**
 * One-time scope acknowledgement. The wording names the reach exactly as the
 * gateway implements it since plan-366: local calls need no configuration, calls
 * from another machine need a valid API key. It must not claim "localhost only" —
 * CONNECT binds `0.0.0.0` on Windows and `/webviewer` was never loopback-only.
 */
export function AiBridgeConsentDialog({
  open, onAcknowledge, onConfigure, onClose,
}: {
  open: boolean;
  onAcknowledge: () => void;
  onConfigure: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth data-testid="ai-consent-dialog">
      <DialogTitle sx={{ fontSize: 14 }}>Before you connect an AI assistant</DialogTitle>
      <DialogContent>
        <Typography sx={{ fontSize: 13, color: 'text.primary', lineHeight: 1.6 }}>
          The AI Bridge hands a connected assistant the same control you have in this
          viewer. Nothing is asked again per action.
        </Typography>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, mt: 1.5 }}>
          <ScopeLine
            label="Scene"
            text="read the full hierarchy, and create, move, rename or delete objects."
          />
          <ScopeLine
            label="Signals"
            text="read every PLC signal and write to them — including a live controller when one is attached."
          />
          <ScopeLine
            label="Simulation"
            text="start, pause, reset and jog drives."
          />
        </Box>
        <Typography sx={{ fontSize: 12, color: 'text.secondary', lineHeight: 1.6, mt: 1.5 }}>
          <Box component="span" sx={{ fontWeight: 600, color: 'text.primary' }}>How far it reaches.</Box>
          {' '}
          realvirtual CONNECT hosts the bridge. On this machine it works without any
          configuration. From another machine it answers only with a valid API key, so
          set one in CONNECT before you expose that machine to a network you do not
          control.
        </Typography>
        <Typography sx={{ fontSize: 12, color: 'text.secondary', lineHeight: 1.6, mt: 1 }}>
          You can switch the bridge off or restrict it at any time under Settings ▸ AI.
        </Typography>
        <Typography
          sx={{ fontSize: 10, fontFamily: 'monospace', color: 'text.disabled', mt: 1.5 }}
        >
          scope {AI_BRIDGE_CONSENT_VERSION}
        </Typography>
      </DialogContent>
      <DialogActions>
        {/* Escape and the backdrop lead here too: a modal that can only be left
            by agreeing would be coercion, not consent. */}
        <Button onClick={onClose} sx={{ textTransform: 'none', color: 'text.secondary', mr: 'auto' }}>
          Not now
        </Button>
        <Button onClick={onConfigure} sx={{ textTransform: 'none' }}>
          Configure…
        </Button>
        <Button autoFocus variant="contained" onClick={onAcknowledge} sx={{ textTransform: 'none' }}>
          Got it
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/**
 * Gate in front of the AI panel. `children` is the (lazily imported) `McpTab`
 * element: React only pulls its chunk once the element is actually rendered, so
 * an un-consented device never loads, never mounts and never reaches the panel.
 */
export function AiBridgeGate({ children }: { children: ReactNode }) {
  const consented = useAiBridgeConsent();
  // Declining must be possible without agreeing to anything, and without the
  // dialog re-opening on the spot: it steps aside for this visit and the tab
  // keeps one quiet way back in.
  const [deferred, setDeferred] = useState(false);
  if (consented) return <>{children}</>;

  // Both ways FORWARD record the acknowledgement — both are explicit clicks on a
  // dialog that states the scope — and both land in the AI panel, which IS the
  // configuration surface. `Configure…` additionally asks SettingsPanel for the
  // AI tab, so the same dialog can be raised from outside Settings later.
  const acknowledge = () => { grantAiBridgeConsent(); };
  const configure = () => { grantAiBridgeConsent(); requestSettingsTab(SETTINGS_TAB_AI); };

  return (
    <Box data-testid="ai-consent-gate">
      <Typography sx={{ fontSize: 12, color: 'text.secondary', lineHeight: 1.6 }}>
        The AI Bridge stays closed until you have seen what it may reach on this device.
      </Typography>
      {deferred && (
        <Button
          size="small"
          variant="outlined"
          onClick={() => setDeferred(false)}
          sx={{ mt: 1, textTransform: 'none' }}
        >
          Review access…
        </Button>
      )}
      <AiBridgeConsentDialog
        open={!deferred}
        onAcknowledge={acknowledge}
        onConfigure={configure}
        onClose={() => setDeferred(true)}
      />
    </Box>
  );
}

/**
 * Connection dead end: no CONNECT answered, so the AI features have no server.
 * States the dependency plainly and offers the download — the same stable/beta
 * affordance the CONNECT panel uses, versions included.
 */
export function AiBridgeDownloadInfo() {
  return (
    <Box sx={{ color: 'text.secondary' }} data-testid="ai-connect-download-info">
      <Typography sx={{ fontSize: 12, lineHeight: 1.6 }}>
        The AI features need realvirtual CONNECT as their MCP server — it hosts the
        bridge this viewer and your AI assistant both talk to. No CONNECT answered on
        this machine.
      </Typography>
      <Box sx={{ mt: 1 }}>
        <ConnectDownloadLinks />
      </Box>
      {/* Readable prose keeps the AA ink ramp — only the scope stamp goes dimmer. */}
      <Typography sx={{ fontSize: 11, lineHeight: 1.6, mt: 1, color: 'text.secondary' }}>
        Already installed? Start CONNECT, then open this again.
      </Typography>
    </Box>
  );
}

/** The download dead end as a dialog — what the activity-bar entry raises. */
export function AiBridgeDownloadDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth data-testid="ai-download-dialog">
      <DialogTitle sx={{ fontSize: 14 }}>AI Bridge needs realvirtual CONNECT</DialogTitle>
      <DialogContent>
        <AiBridgeDownloadInfo />
      </DialogContent>
      <DialogActions>
        <Button autoFocus onClick={onClose} sx={{ textTransform: 'none' }}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
