// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ConnectUpdateSection — the CONNECT self-update surface (plan-343 Phase 3).
 *
 * Sits in the Connection section of the CONNECT settings window, directly under the line that
 * already shows version and build. Deliberately *not* in the ConnectPanel: that tab is a terse
 * operations view and stops its background polling while closed, and that performance contract is
 * not softened for this.
 *
 * Three rules the layout follows (plan-343 section 3):
 *   - **At rest it shows nothing.** No offer, no row.
 *   - **A beta is never proposed and never emphasised**, only offered. A running beta keeps the
 *     way back to stable permanently visible.
 *   - **Structurally impossible means invisible** — except for `no-api-key` and
 *     `no-write-permission`, where one explanatory sentence is shown because the operator can
 *     actually fix those.
 *
 * Extracted into its own file for the same reason `LicenseSection.tsx` is: a self-contained
 * section with its own confirmation dialog, mounted by `ConnectOptionsWindow`.
 */

import { useEffect, useState, useSyncExternalStore } from 'react';
import { Box, Typography, Button, LinearProgress, Dialog, DialogTitle, DialogContent, DialogActions } from '@mui/material';
import {
  connectUpdateStore,
  isBusyPhase,
  isTerminalPhase,
  updateReasonSentence,
  formatUpdateSize,
  formatUpdateRelease,
  channelLabel,
  type ConnectUpdateSnapshot,
  type UpdateChannelOffer,
} from './connect-update-store';
import { getConnectSnapshot } from './connect-store';
import { ISA_RED, ISA_GREEN, ISA_AMBER } from './isa-colors';

/** One offered action. `emphasis` is true only for a genuine stable upgrade — never for a beta. */
interface UpdateRow {
  key: string;
  label: string;
  action: string;
  offer: UpdateChannelOffer;
  emphasis: boolean;
}

/**
 * Turns the channel offers into the rows of section 3.2.
 *
 * A stable build that is older than what runs is not offered at all while on stable — going
 * backwards is only meaningful as the way back *from a beta*, and there it is labelled as such.
 */
export function buildUpdateRows(snap: ConnectUpdateSnapshot): UpdateRow[] {
  const rows: UpdateRow[] = [];
  const runningBeta = snap.current?.channel === 'beta';
  const stable = snap.channels.stable;
  const beta = snap.channels.beta;

  if (stable && !stable.isCurrent) {
    if (runningBeta) {
      rows.push({
        key: 'stable',
        label: `Back to Stable ${stable.candidate.semver}`,
        action: 'Switch',
        offer: stable,
        emphasis: false,
      });
    } else if (stable.isNewer) {
      rows.push({
        key: 'stable',
        label: `Stable ${stable.candidate.semver} available`,
        action: 'Update',
        offer: stable,
        emphasis: true,
      });
    }
  }

  if (beta && !beta.isCurrent && (beta.isNewer || beta.isChannelSwitch)) {
    rows.push({
      key: 'beta',
      label: `Beta ${beta.candidate.semver}`,
      action: 'Install',
      offer: beta,
      emphasis: false,
    });
  }

  return rows;
}

/** The one line that describes what the gateway is doing right now. */
function progressLabel(snap: ConnectUpdateSnapshot): string {
  if (snap.reconnecting || snap.phase === 'restarting' || snap.phase === 'verifying-health') {
    return 'CONNECT is restarting — reconnecting…';
  }
  switch (snap.phase) {
    case 'downloading': {
      const version = snap.expected?.semver ?? '';
      const pct = snap.progress?.fraction != null ? ` ${Math.round(snap.progress.fraction * 100)} %` : '';
      return `Downloading ${version}…${pct}`;
    }
    case 'verifying':
      return 'Checking signature…';
    case 'staging':
      return 'Preparing installation…';
    default:
      return 'Working…';
  }
}

export function ConnectUpdateSection() {
  const snap = useSyncExternalStore(connectUpdateStore.subscribe, connectUpdateStore.getSnapshot);
  const [confirm, setConfirm] = useState<UpdateRow | null>(null);

  // Detaching is not a stop: an update already under way keeps polling without a mounted
  // component, so closing this window cannot orphan a running program swap.
  useEffect(() => connectUpdateStore.attach(), []);

  // An older gateway does not know the feature at all and shows nothing whatsoever.
  if (snap.gateway !== 'supported') return null;

  const busy = isBusyPhase(snap.phase) || snap.reconnecting || snap.applying;

  // Structurally impossible: silent, except for the two causes the operator can remove.
  if (!snap.supported && !busy) {
    const actionable = snap.reason === 'no-api-key' || snap.reason === 'no-write-permission';
    if (!actionable) return null;
    return (
      <Typography sx={{ fontSize: 10, color: 'rgba(255,255,255,0.6)', lineHeight: 1.5, mt: 0.75 }}>
        {updateReasonSentence(snap.reason)}
      </Typography>
    );
  }

  if (busy) {
    const indeterminate = snap.progress?.fraction == null;
    return (
      <Box sx={{ mt: 0.75 }}>
        <Typography sx={{ fontSize: 10, color: 'rgba(255,255,255,0.75)' }}>{progressLabel(snap)}</Typography>
        <LinearProgress
          variant={indeterminate ? 'indeterminate' : 'determinate'}
          value={indeterminate ? undefined : Math.round((snap.progress?.fraction ?? 0) * 100)}
          sx={{ height: 2, mt: 0.5, borderRadius: 1 }}
        />
      </Box>
    );
  }

  // How the last attempt ended. Success is shown ONLY for the terminal `succeeded` — a reachable
  // /health during the restart means nothing more than "the connection is back" (section 2.4).
  //
  // The reason is rendered whenever the gateway reports one, NOT only in a terminal state: once a
  // build is still on offer the gateway deliberately flips a finished job back to `available` so a
  // failed attempt cannot permanently hide it. Gating this on the phase would silently swallow the
  // very sentence that explains why the previous attempt failed.
  const succeeded = snap.phase === 'succeeded';
  const rolledBack = snap.phase === 'rolled-back';
  const outcome = succeeded
    ? `Updated to ${snap.current?.semver ?? ''} (${channelLabel(snap.current?.channel ?? 'stable')})`
    : updateReasonSentence(snap.jobReason);

  // A terminal job offers nothing further; anything else may still carry an open offer.
  const rows = isTerminalPhase(snap.phase) ? [] : buildUpdateRows(snap);
  const runningBeta = snap.current?.channel === 'beta';
  if (!outcome && rows.length === 0 && !runningBeta) return null;

  return (
    <Box sx={{ mt: 0.75, display: 'flex', flexDirection: 'column', gap: 0.25 }}>
      {outcome && (
        <Typography sx={{ fontSize: 10, lineHeight: 1.5, color: succeeded ? ISA_GREEN : rolledBack ? ISA_AMBER : ISA_RED }}>
          {outcome}
        </Typography>
      )}
      {runningBeta && (
        <Typography sx={{ fontSize: 10, color: 'rgba(255,255,255,0.6)' }}>
          Running as Beta {snap.current?.semver}
        </Typography>
      )}
      {rows.map((row) => (
        <Box key={row.key} sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <Typography
            sx={{ fontSize: 11, flex: 1, minWidth: 0, color: row.emphasis ? 'text.primary' : 'rgba(255,255,255,0.6)' }}
          >
            {row.label}
          </Typography>
          <Button
            size="small"
            variant={row.emphasis ? 'contained' : 'text'}
            onClick={() => setConfirm(row)}
            sx={{ fontSize: 10, textTransform: 'none', minWidth: 72 }}
          >
            {row.action}
          </Button>
        </Box>
      ))}

      {confirm && (
        <UpdateConfirmDialog
          row={confirm}
          snap={snap}
          onClose={() => setConfirm(null)}
          onConfirm={() => {
            const candidate = confirm.offer.candidate;
            setConfirm(null);
            void connectUpdateStore.apply(candidate);
          }}
        />
      )}
    </Box>
  );
}

/**
 * Confirmation before a program swap — a real dialog, never `window.confirm` (panel convention).
 *
 * Names both versions with build and date, the channel, the download size (or "Size unknown", as
 * no manifest form carries one) and the fact that CONNECT restarts and the connection drops. A
 * beta is explicitly called a pre-release, the way back to stable explicitly an older version, and
 * a pin change explicitly a change to a project file. There is deliberately no change log and no
 * outbound link.
 */
function UpdateConfirmDialog({
  row,
  snap,
  onClose,
  onConfirm,
}: {
  row: UpdateRow;
  snap: ConnectUpdateSnapshot;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { offer } = row;
  const isBeta = offer.candidate.channel === 'beta';
  const isOlder = offer.isDowngrade;

  const title = isBeta ? 'Install beta build' : isOlder ? 'Switch back to stable' : 'Update CONNECT';

  return (
    <Dialog open onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ fontSize: 14 }}>{title}</DialogTitle>
      <DialogContent sx={{ pt: 1 }}>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, mb: 1.5 }}>
          <Row label="Currently running">
            {/* The running build's date is not part of /update/status — it comes from the same
                /health the version line above already shows. */}
            {formatUpdateRelease(snap.current?.semver ?? '', snap.current?.build ?? null, getConnectSnapshot().serverBuildDate)} ({channelLabel(snap.current?.channel ?? 'stable')})
          </Row>
          <Row label="Will be installed">
            {formatUpdateRelease(offer.candidate.semver, offer.candidate.build, offer.buildDate)} ({channelLabel(offer.candidate.channel)})
          </Row>
          <Row label="Download">{formatUpdateSize(offer.sizeBytes)}</Row>
        </Box>

        {isBeta && (
          <Typography sx={{ fontSize: 11, color: ISA_AMBER, mb: 0.75, lineHeight: 1.5 }}>
            This is a pre-release build.
          </Typography>
        )}
        {isOlder && (
          <Typography sx={{ fontSize: 11, color: ISA_AMBER, mb: 0.75, lineHeight: 1.5 }}>
            This installs an older version.
          </Typography>
        )}
        <Typography sx={{ fontSize: 11, color: 'rgba(255,255,255,0.65)', lineHeight: 1.5 }}>
          CONNECT restarts briefly during the update. The connection drops and is re-established
          automatically.
        </Typography>
        {snap.pinWillChange && (
          <Typography sx={{ fontSize: 11, color: 'rgba(255,255,255,0.65)', mt: 0.75, lineHeight: 1.5 }}>
            The project file connect.lock.json{snap.pinPath ? ` (${snap.pinPath})` : ''} will be changed.
          </Typography>
        )}
      </DialogContent>
      <DialogActions>
        <Button autoFocus onClick={onClose} sx={{ textTransform: 'none' }}>Cancel</Button>
        <Button variant="contained" onClick={onConfirm} sx={{ textTransform: 'none' }}>{row.action}</Button>
      </DialogActions>
    </Dialog>
  );
}

/** Label/value line of the dialog — values in monospace, as every measured value in this UI. */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Box sx={{ display: 'flex', gap: 1, alignItems: 'baseline' }}>
      <Typography sx={{ fontSize: 11, color: 'rgba(255,255,255,0.55)', minWidth: 118 }}>{label}</Typography>
      <Typography sx={{ fontSize: 11, fontFamily: 'monospace', color: 'rgba(255,255,255,0.9)' }}>{children}</Typography>
    </Box>
  );
}
