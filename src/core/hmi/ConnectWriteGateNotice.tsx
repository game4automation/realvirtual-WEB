// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ConnectWriteGateNotice — "this interface does not accept your values" (plan-562 F6/F7).
 *
 * The visible half of the customer case this plan came from: PLCSIM Advanced was
 * attached through CONNECT, the connection stood, and not one viewer input ever
 * reached the PLC because `AllowWebToPlc` defaults to `false` and CONNECT logged
 * the dropped writes exactly once. CONNECT now counts those attempts per
 * interface and reports them in `/status`; this overlay turns the first hit into
 * a sentence and a one-click fix.
 *
 * Non-modal by decision (DESIGN.md / F-NFR): a modal would block the 3D scene
 * the operator is watching, and the viewer stays perfectly usable read-only. So
 * `role="status"`, no autofocus (the canvas keeps the keyboard), buttons reachable
 * by Tab, Escape puts the question down for this session.
 *
 * At most ONE card: a gateway with four blocked interfaces would otherwise paint
 * a wall of overlays over the scene. The first affected interface gets the card,
 * the rest are counted in a "+N more interfaces" line — answering the first one
 * usually answers the cause for all of them.
 *
 * Both buttons are views of the `connect.*` commands, so the overlay, the
 * interface card and any later surface can never drift apart on what "Allow
 * writes" means.
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Box, Button, Typography, IconButton } from '@mui/material';
import { Close, WarningAmber } from '@mui/icons-material';
import type { UISlotProps } from '../rv-ui-plugin';
import { useUIVisible } from './ui-context-store';
import {
  getConnectSnapshot,
  subscribeConnectStore,
  type ConnectInterface,
  type ConnectSnapshot,
  type SetAllowWebToPlcResult,
} from './connect-store';
import {
  dismissWriteGateNotice,
  isWriteGateDismissed,
  isWriteGateReadOnly,
  useWriteGateDecisions,
} from './connect-write-gate-store';
import {
  CONNECT_ALLOW_WRITES_COMMAND,
  CONNECT_READ_ONLY_COMMAND,
  ensureConnectCommandsRegistered,
  openConnectInterfaceEdit,
} from './connect-commands';
import { commandRegistry } from './rv-command-registry';
import { interfaceEndpointLabel, interfaceTypeLabel } from './ConnectPanel';
import { ISA_AMBER } from './isa-colors';
import { FS, INK_HIGH, INK_MID } from './shared-sx';

/** The visibility element id, so a deploy can switch the overlay off. */
export const CONNECT_WRITE_GATE_NOTICE_ID = 'connect-write-gate-notice';

/** Everything one card needs — derived once, so the texts cannot disagree. */
export interface WriteGateCandidate {
  interfaceId: string;
  /** `<type label> · <endpoint>`, the target the effect line names. */
  target: string;
  /** Viewer writes CONNECT dropped for this interface. */
  blockedCount: number;
  /** Recent blocked signal names, newest first (gateway keeps at most 20). */
  blockedSignals: readonly string[];
  /** PLCInput signals this interface would receive on opening the gate. */
  inputSignalCount: number;
  /** Revision of THIS snapshot — sent back with the flip, or absent on old gateways. */
  configRevision?: string;
}

/** PLCInput signals of an interface, topic signals included (MQTT ProcessImage). */
function countInputSignals(iface: ConnectInterface): number {
  const all = [
    ...(iface.topics ?? []).flatMap((t) => t.signals ?? []),
    ...(iface.signals ?? []),
  ];
  const inputs = all.filter((s) => typeof s.type === 'string' && s.type.startsWith('PLCInput'));
  // A configuration without explicit directions still writes whatever it has —
  // naming 0 signals would read as "this changes nothing", which is the lie.
  return inputs.length || all.length;
}

/**
 * Interfaces whose closed write gate has actually swallowed a viewer write and
 * that the user has neither decided about nor put down this session.
 *
 * `allowWebToPlc !== true` is checked against the interface list, not the status:
 * right after a successful flip the counter is still non-zero while the config
 * already says yes, and the overlay must be gone at that moment, not two polls
 * later.
 */
export function collectWriteGateCandidates(snap: ConnectSnapshot): WriteGateCandidate[] {
  if (snap.state !== 'connected' || snap.gatewayUnreachable) return [];
  const candidates: WriteGateCandidate[] = [];
  for (const iface of snap.interfaces) {
    if (iface.allowWebToPlc === true) continue;
    const status = snap.interfaceStatus[iface.id];
    const blocked = status?.writesBlockedByGate ?? 0;
    if (blocked <= 0) continue;
    if (isWriteGateReadOnly(snap.serverUrl, iface.id)) continue;
    if (isWriteGateDismissed(snap.serverUrl, iface.id)) continue;
    const endpoint = interfaceEndpointLabel(iface);
    const label = interfaceTypeLabel(iface.type);
    candidates.push({
      interfaceId: iface.id,
      target: endpoint ? `${label} · ${endpoint}` : label,
      blockedCount: blocked,
      blockedSignals: status?.blockedSignals ?? [],
      inputSignalCount: countInputSignals(iface),
      ...(status?.configRevision ? { configRevision: status.configRevision } : {}),
    });
  }
  return candidates;
}

/**
 * "`BT2_OpMode` and 3 more inputs were not sent to the PLC." — the sentence that
 * names what was lost. The distinct names the gateway kept are the better
 * measure than the raw attempt count (one signal written 400 times is one lost
 * input, not 400), and a gateway that reports only the count still gets a true
 * sentence from it.
 */
export function describeBlockedWrites(candidate: WriteGateCandidate): string {
  const names = candidate.blockedSignals;
  const count = names.length || candidate.blockedCount;
  const more = Math.max(count - 1, 0);
  const head = names[0] ?? 'An input';
  if (more === 0) return `${head} was not sent to the PLC.`;
  return `${head} and ${more} more input${more === 1 ? '' : 's'} were not sent to the PLC.`;
}

/** The effect line: what pressing "Allow writes" does, before it is pressed. */
export function describeAllowEffect(candidate: WriteGateCandidate): string {
  const n = candidate.inputSignalCount;
  return `Allowing writes sends the current input values (${n} signal${n === 1 ? '' : 's'})`
    + ` to ${candidate.target} now.`;
}

/** Operator-facing copy per failed outcome of the gate endpoint (F7). */
const OUTCOME_TEXT: Readonly<Record<string, string>> = {
  changed: 'The interface changed - review it first',
  unsupported: 'Update CONNECT to allow writes from here',
};

const CARD_SX = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 1,
  px: 1.5,
  py: 1,
  maxWidth: 520,
  borderRadius: 1,
  bgcolor: 'background.paper',
  border: `1px solid ${ISA_AMBER}66`,
  boxShadow: 6,
} as const;

const ACTION_SX = {
  fontSize: FS.label,
  textTransform: 'none',
  py: 0.25,
  minWidth: 0,
} as const;

export function ConnectWriteGateNotice({ viewer }: UISlotProps) {
  const visible = useUIVisible(CONNECT_WRITE_GATE_NOTICE_ID);
  const snap = useSyncExternalStore(subscribeConnectStore, getConnectSnapshot);
  // The decisions are not part of the CONNECT snapshot, so the overlay needs its
  // own subscription — without it "Read only" would not hide the card until the
  // next status poll happened to arrive.
  const decisions = useWriteGateDecisions();
  const [outcome, setOutcome] = useState<SetAllowWebToPlcResult['kind'] | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);

  useEffect(() => { ensureConnectCommandsRegistered(); }, []);

  // `decisions` is load-bearing in the dependency list: a "Read only" or a ✕
  // changes nothing in the CONNECT snapshot, so without it the memo would keep
  // handing back the card the user just answered.
  const candidates = useMemo(() => collectWriteGateCandidates(snap), [snap, decisions]);
  const candidate = candidates[0];
  const interfaceId = candidate?.interfaceId;

  // A new interface in the card inherits nothing from the previous one's answer.
  useEffect(() => { setOutcome(null); setErrorText(null); }, [interfaceId]);

  const close = useCallback(() => {
    if (!interfaceId) return;
    dismissWriteGateNotice(snap.serverUrl, interfaceId);
  }, [snap.serverUrl, interfaceId]);

  // Escape closes — but only for this session, and without preventing anything
  // else from seeing the key: the overlay is an aside, not a dialog.
  useEffect(() => {
    if (!interfaceId || !visible) return;
    const onKeyDown = (e: KeyboardEvent): void => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [interfaceId, visible, close]);

  const handleAllow = useCallback(async () => {
    if (!interfaceId) return;
    setErrorText(null);
    const result = await commandRegistry.execute<SetAllowWebToPlcResult>(
      CONNECT_ALLOW_WRITES_COMMAND, { interfaceId }, { origin: 'ui', viewer },
    );
    if (!result.ok) {
      setOutcome('error');
      setErrorText(result.reason);
      return;
    }
    if (result.value.kind === 'ok') {
      setOutcome(null);
      return;
    }
    if (result.value.kind === 'gone') {
      // The interface is gone, so the question is void — not an error to read.
      dismissWriteGateNotice(snap.serverUrl, interfaceId);
      return;
    }
    setOutcome(result.value.kind);
    if (result.value.kind === 'error') setErrorText(result.value.message);
  }, [interfaceId, viewer, snap.serverUrl]);

  const handleReadOnly = useCallback(() => {
    if (!interfaceId) return;
    void commandRegistry.execute(
      CONNECT_READ_ONLY_COMMAND, { interfaceId }, { origin: 'ui', viewer },
    );
  }, [interfaceId, viewer]);

  const handleOpenEdit = useCallback(() => {
    if (!interfaceId) return;
    openConnectInterfaceEdit(viewer, interfaceId);
  }, [viewer, interfaceId]);

  if (!visible || !candidate) return null;

  const extra = candidates.length - 1;
  const message = outcome === 'error'
    ? (errorText ?? 'The gateway did not answer.')
    : outcome
      ? OUTCOME_TEXT[outcome]
      : null;

  return (
    <Box
      data-ui-panel
      data-testid="connect-write-gate-notice"
      sx={{
        position: 'fixed', bottom: 96, left: '50%', transform: 'translateX(-50%)',
        zIndex: 9400, pointerEvents: 'auto',
      }}
    >
      <Box role="status" aria-live="polite" sx={CARD_SX}>
        <WarningAmber sx={{ fontSize: 16, color: ISA_AMBER, mt: 0.25, flexShrink: 0 }} />
        <Box sx={{ minWidth: 0 }}>
          <Typography sx={{ fontSize: FS.body, fontWeight: 600, color: INK_HIGH }}>
            {candidate.interfaceId} does not accept values from the viewer.
          </Typography>
          <Typography sx={{ fontSize: FS.label, color: INK_MID }}>
            {describeBlockedWrites(candidate)}
          </Typography>
          <Typography sx={{ fontSize: FS.label, color: INK_MID }}>
            {describeAllowEffect(candidate)}
          </Typography>
          {message && (
            <Typography
              data-testid="connect-write-gate-outcome"
              sx={{ fontSize: FS.label, color: ISA_AMBER, mt: 0.25 }}
            >
              {message}
            </Typography>
          )}
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 0.75, flexWrap: 'wrap' }}>
            <Button size="small" variant="contained" onClick={() => void handleAllow()} sx={ACTION_SX}>
              Allow writes
            </Button>
            <Button size="small" variant="outlined" onClick={handleReadOnly} sx={ACTION_SX}>
              Read only, don&apos;t ask again
            </Button>
            {outcome === 'unsupported' && (
              <Button size="small" variant="text" onClick={handleOpenEdit} sx={ACTION_SX}>
                Open interface settings
              </Button>
            )}
          </Box>
          {extra > 0 && (
            <Typography sx={{ fontSize: FS.micro, color: INK_MID, mt: 0.5 }}>
              +{extra} more interface{extra === 1 ? '' : 's'}
            </Typography>
          )}
        </Box>
        <IconButton
          size="small"
          aria-label="Close write gate notice"
          onClick={close}
          sx={{ p: 0.25, color: INK_MID, flexShrink: 0 }}
        >
          <Close sx={{ fontSize: 14 }} />
        </IconButton>
      </Box>
    </Box>
  );
}
