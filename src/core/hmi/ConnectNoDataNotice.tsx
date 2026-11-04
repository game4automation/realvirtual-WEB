// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ConnectNoDataNotice — "connected, but no PLC outputs received" (plan-562 F10).
 *
 * The other silence from the customer case: the gateway was green, every signal
 * had a value (the default value of a tag that was never found), and the viewer
 * kept simulating. The verdict itself lives in `connect-no-data-watch.ts`; this
 * component is only its face plus the one action that helps — the CONNECT log,
 * which is where the worker already wrote down WHY nothing arrives.
 *
 * It is driven by the status poll, not by a timer of its own: every successful
 * `/status` stamps `lastStatusUpdate`, so the store notifies on the same 2 s
 * cadence the watch needs, and the window is measured in `viewer.simTime` — a
 * paused simulation does not accuse the PLC of anything.
 *
 * Non-modal (`role="status"`), no autofocus, Escape dismisses — the same rules as
 * the write-gate overlay, for the same reason: the 3D scene stays usable.
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Box, Button, Typography, IconButton } from '@mui/material';
import { Close, InfoOutlined } from '@mui/icons-material';
import type { UISlotProps } from '../rv-ui-plugin';
import { useUIVisible } from './ui-context-store';
import { getConnectSnapshot, subscribeConnectStore, type ConnectSnapshot } from './connect-store';
import { getDriveSpeedOverride, subscribeDriveSpeedOverride } from '../engine/rv-speed-override';
import {
  connectNoDataWatch,
  SimRunningClock,
  NO_DATA_REASON_TEXT,
  type NoDataHit,
  type NoDataInterfaceInput,
} from './connect-no-data-watch';
import {
  CONNECT_OPEN_LOG_COMMAND,
  ensureConnectCommandsRegistered,
} from './connect-commands';
import { commandRegistry } from './rv-command-registry';
import { ISA_AMBER } from './isa-colors';
import { FS, INK_HIGH, INK_MID } from './shared-sx';

/** The visibility element id, so a deploy can switch the notice off. */
export const CONNECT_NO_DATA_NOTICE_ID = 'connect-no-data-notice';

/**
 * Interfaces the watch may judge: connected gateway, and a worker that actually
 * reports a read health. Everything else is excluded here rather than inside the
 * watch, so "no readHealth means never a notice" is one visible line.
 */
export function noDataWatchInterfaces(snap: ConnectSnapshot): NoDataInterfaceInput[] {
  const rows: NoDataInterfaceInput[] = [];
  for (const iface of snap.interfaces) {
    const status = snap.interfaceStatus[iface.id];
    const health = status?.readHealth;
    if (!status || !health) continue;
    rows.push({
      id: iface.id,
      status: status.status,
      boundReadTags: health.boundReadTags,
      tagsWithValidValue: health.tagsWithValidValue,
      progress: health.progress,
      workerGeneration: health.workerGeneration,
      progressIsPeriodic: health.progressIsPeriodic,
      signalIssues: status.signalIssues?.length ?? 0,
    });
  }
  return rows;
}

/** "`PLCSIM_1` · no readable tags bound · 12 signal issues" */
export function describeNoDataHit(hit: NoDataHit): string {
  const parts = [hit.interfaceId, NO_DATA_REASON_TEXT[hit.reason]];
  if (hit.signalIssues > 0) {
    parts.push(`${hit.signalIssues} signal issue${hit.signalIssues === 1 ? '' : 's'}`);
  }
  return parts.join(' · ');
}

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

/** simTime → running seconds at 1× pace (the simulation speed must not shorten the window). */
const noDataRunningClock = new SimRunningClock();

export function ConnectNoDataNotice({ viewer }: UISlotProps) {
  const visible = useUIVisible(CONNECT_NO_DATA_NOTICE_ID);
  const snap = useSyncExternalStore(subscribeConnectStore, getConnectSnapshot);
  // Dismissals live in the watch (once per interface AND worker generation), so
  // the component needs its own nudge to re-render after one.
  const [dismissals, setDismissals] = useState(0);

  useEffect(() => { ensureConnectCommandsRegistered(); }, []);
  // Fold the running clock at every speed change, so one step never mixes two factors.
  useEffect(
    () => subscribeDriveSpeedOverride(() => { noDataRunningClock.advance(viewer.simTime ?? 0, getDriveSpeedOverride()); }),
    [viewer],
  );

  const connected = snap.state === 'connected' && !snap.gatewayUnreachable;
  const hits = useMemo(
    () => connectNoDataWatch.update({
      simTime: noDataRunningClock.advance(viewer.simTime ?? 0, getDriveSpeedOverride()),
      connected,
      interfaces: noDataWatchInterfaces(snap),
    }),
    // `dismissals` is a deliberate dependency: dismissing changes nothing in the
    // snapshot, but it must change what the watch returns on the next read.
    [snap, connected, viewer, dismissals],
  );

  const dismiss = useCallback(() => {
    for (const hit of hits) connectNoDataWatch.dismiss(hit.interfaceId, hit.workerGeneration);
    setDismissals((n) => n + 1);
  }, [hits]);

  useEffect(() => {
    if (!visible || hits.length === 0) return;
    const onKeyDown = (e: KeyboardEvent): void => { if (e.key === 'Escape') dismiss(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [visible, hits.length, dismiss]);

  const openLog = useCallback(() => {
    void commandRegistry.execute(CONNECT_OPEN_LOG_COMMAND, {}, { origin: 'ui', viewer });
  }, [viewer]);

  if (!visible || hits.length === 0) return null;

  return (
    <Box
      data-ui-panel
      data-testid="connect-no-data-notice"
      sx={{
        // Above the write-gate overlay's row: when both are up, two cards must
        // read as two notices, not as one overlapping smear.
        position: 'fixed', bottom: 160, left: '50%', transform: 'translateX(-50%)',
        zIndex: 9400, pointerEvents: 'auto',
      }}
    >
      <Box role="status" aria-live="polite" sx={CARD_SX}>
        <InfoOutlined sx={{ fontSize: 16, color: ISA_AMBER, mt: 0.25, flexShrink: 0 }} />
        <Box sx={{ minWidth: 0 }}>
          <Typography sx={{ fontSize: FS.body, fontWeight: 600, color: INK_HIGH }}>
            Connected, but no PLC outputs received.
          </Typography>
          {hits.map((hit) => (
            <Typography
              key={`${hit.interfaceId}|${hit.workerGeneration}`}
              sx={{ fontSize: FS.label, color: INK_MID }}
            >
              {describeNoDataHit(hit)}
            </Typography>
          ))}
          <Box sx={{ mt: 0.75 }}>
            <Button
              size="small"
              variant="outlined"
              onClick={openLog}
              sx={{ fontSize: FS.label, textTransform: 'none', py: 0.25, minWidth: 0 }}
            >
              Open log
            </Button>
          </Box>
        </Box>
        <IconButton
          size="small"
          aria-label="Close no data notice"
          onClick={dismiss}
          sx={{ p: 0.25, color: INK_MID, flexShrink: 0 }}
        >
          <Close sx={{ fontSize: 14 }} />
        </IconButton>
      </Box>
    </Box>
  );
}
