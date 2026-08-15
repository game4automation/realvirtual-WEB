// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * StorageNoticeBanner — the one place the storage layer gets to speak
 * (plan-397 phase 6).
 *
 * Three facts arrive here, and none of them had a consumer before. That was
 * the actual gap: `requestPersistence()` has emitted a `not-persisted` notice
 * since phase 5 and `rg onBlobStoreNotice src` found nothing but its own
 * definition — the warning existed and nobody could see it.
 *
 *  - **Storage is not persistent.** Since phase 6 scenes are GLB bodies in
 *    OPFS, and OPFS is evictable. The user decided this must not block saving,
 *    so it is a dismissible warning that says what is at risk and what to do
 *    about it, and nothing more.
 *  - **Another tab has this scene open.** A `BroadcastChannel` hint, not a
 *    lock — see `rv-scene-live-sync`. Purely informational, so it is the
 *    quietest of the three.
 *  - **A save was refused.** The compare-and-swap failed, which means the
 *    autosave has stopped and the user's work is only in this tab. That one is
 *    not dismissible by accident and not styled like a hint.
 *
 * They share a banner because they are the same conversation ("can your work
 * be kept safely?") and because a second notification style per feature is how
 * an interface stops being read at all.
 */

import { useEffect, useState } from 'react';
import { Box, Typography, IconButton, Button } from '@mui/material';
import { Warning, Error as ErrorIcon, Info, Close } from '@mui/icons-material';
import { onBlobStoreNotice, type BlobStoreNotice } from '../storage/rv-opfs-blobs';
import { clearSceneSyncNotice, onSceneSyncEvent, type SceneSyncNotice } from './scene/rv-scene-live-sync';
import { ISA_AMBER, ISA_RED } from './isa-colors';
import { useOptionalViewer } from '../../hooks/use-viewer';

type Severity = 'info' | 'warning' | 'critical';

interface Entry {
  key: string;
  severity: Severity;
  message: string;
  /** Second line: what the user can do. Omitted when there is nothing useful. */
  action?: string;
  /**
   * A button label, when the notice can be acted on rather than merely read
   * (plan-425 F3). Present only where the viewer already knows what to do — a
   * button that opens a dialog to ask would not be a repair.
   */
  actionLabel?: string;
}

const PERSIST_DISMISS_KEY = 'rv-storage-persist-dismissed';

export function StorageNoticeBanner() {
  const viewer = useOptionalViewer();
  const [persistNotice, setPersistNotice] = useState<BlobStoreNotice | null>(null);
  // A map, not a single notice (plan-422 §2.3): an autosave error and a
  // conflict can be true at the same time, and each has to be withdrawable on
  // its own — the recovering autosave clears its notice while the conflict
  // stands. Only the highest-ranked one is SHOWN; the rest wait their turn.
  const [syncNotices, setSyncNotices] = useState<ReadonlyMap<string, SceneSyncNotice>>(new Map());
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    try {
      if (sessionStorage.getItem(PERSIST_DISMISS_KEY) === '1') setDismissed(true);
    } catch { /* private mode: best-effort */ }
  }, []);

  // Both stores replay what they already emitted, which is the only reason
  // subscribing this late works at all: storage is touched during boot and the
  // shell mounts afterwards.
  useEffect(() => onBlobStoreNotice((n) => {
    if (n.kind === 'not-persisted' || n.kind === 'no-opfs') setPersistNotice(n);
  }), []);

  useEffect(() => onSceneSyncEvent((ev) => {
    setSyncNotices((prev) => {
      const next = new Map(prev);
      if (ev.type === 'clear') {
        if (!next.delete(ev.id)) return prev;
      } else {
        next.set(ev.id, ev.notice);
      }
      return next;
    });
  }), []);

  const sync = pickSyncNotice(syncNotices);
  const entry = pickEntry(persistNotice, sync?.notice ?? null, dismissed);
  if (!entry) return null;

  const isCritical = entry.severity === 'critical';
  const fg = isCritical ? ISA_RED : ISA_AMBER;
  const bg = isCritical
    ? 'rgba(180,30,30,0.95)'
    : entry.severity === 'warning' ? 'rgba(180,110,20,0.95)' : 'rgba(40,60,90,0.95)';
  const Icon = isCritical ? ErrorIcon : entry.severity === 'warning' ? Warning : Info;

  /**
   * Put back every saved link whose slot the second pass located unambiguously,
   * then take the notice down.
   *
   * The repair module is imported on DEMAND: this banner mounts in every session
   * including the read-only viewer, and the signal-bind inventory pulls the
   * whole binding stack behind it. A button nobody presses should not cost a
   * kilobyte of start-up bundle.
   */
  const handleRepair = () => {
    void (async () => {
      const id = sync?.id;
      try {
        const { repairAllOrphanedBindings } = await import('../../plugins/signal-bind/binding-inventory');
        if (viewer) repairAllOrphanedBindings(viewer);
      } catch { /* the notice stays if the repair could not run */ }
      // Withdrawn globally, not just locally dismissed: the finding it reported
      // is no longer true, so a remount must not resurrect it from the replay.
      if (id) clearSceneSyncNotice(id);
    })();
  };

  const handleDismiss = () => {
    if (entry.key === 'persist') {
      try { sessionStorage.setItem(PERSIST_DISMISS_KEY, '1'); } catch { /* private mode */ }
      setDismissed(true);
      return;
    }
    // Dismissal is local, as it always was: the store keeps the notice so a
    // remount can still find out, and the next-ranked one takes the slot.
    const id = sync?.id;
    if (!id) return;
    setSyncNotices((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  };

  return (
    <Box
      data-ui-panel
      role={isCritical ? 'alert' : 'status'}
      sx={{
        position: 'fixed',
        top: 8,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 9400,          // just under the GPU banner: that one is about
        pointerEvents: 'auto', // the session being broken, this about its data
        maxWidth: 'calc(100vw - 32px)',
      }}
    >
      <Box sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1.25,
        px: 2,
        py: 1,
        bgcolor: bg,
        border: `1px solid ${fg}`,
        borderRadius: 2,
        boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
        backdropFilter: 'blur(calc(8px * var(--rv-ui-blur-scale, 1)))',
      }}>
        <Icon sx={{ fontSize: 20, color: '#fff', flexShrink: 0 }} />
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.25 }}>
          <Typography sx={{ fontSize: 12, fontWeight: 600, color: '#fff', lineHeight: 1.3 }}>
            {entry.message}
          </Typography>
          {entry.action && (
            <Typography sx={{ fontSize: 11, color: 'rgba(255,255,255,0.85)', lineHeight: 1.3 }}>
              {entry.action}
            </Typography>
          )}
        </Box>
        {entry.actionLabel && (
          <Button
            size="small"
            variant="outlined"
            onClick={handleRepair}
            sx={{
              flexShrink: 0,
              color: '#fff',
              borderColor: 'rgba(255,255,255,0.6)',
              fontSize: 11,
              textTransform: 'none',
              '&:hover': { borderColor: '#fff', bgcolor: 'rgba(255,255,255,0.12)' },
            }}
          >
            {entry.actionLabel}
          </Button>
        )}
        <IconButton
          size="small"
          onClick={handleDismiss}
          aria-label="Dismiss"
          sx={{ color: 'rgba(255,255,255,0.8)', ml: 0.5, '&:hover': { color: '#fff' } }}
        >
          <Close sx={{ fontSize: 16 }} />
        </IconButton>
      </Box>
    </Box>
  );
}

/**
 * Rank among the scene-sync notices (plan-422 §2.3).
 *
 * Ordered by how much of the user's work is at stake right now. A refused save
 * and a failed save are both "your changes are not being kept" — the refusal
 * leads because it also tells them someone else holds the scene. Orphaned
 * bindings are about work already saved and merely inactive, and the tab hint
 * is about company, not data.
 */
const SYNC_RANK: Record<SceneSyncNotice['kind'], number> = {
  // `moved` outranks `conflict` (plan-716 §2.4): both describe a refused save,
  // but this one also knows WHY, and its advice is the opposite one. Showing the
  // conflict copy over it would tell the user to make a duplicate they do not
  // need.
  'moved': -1,
  'conflict': 0,
  'autosave-error': 1,
  // Below the "your work is not being kept" notices and above the hints: a
  // broken link is a dead end, not a threat to anything the user is holding.
  'missing-document': 2,
  'orphaned-bindings': 3,
  'other-tab': 4,
};

/** The highest-ranked active sync notice, with its id (for dismissal). */
function pickSyncNotice(
  notices: ReadonlyMap<string, SceneSyncNotice>,
): { id: string; notice: SceneSyncNotice } | null {
  let best: { id: string; notice: SceneSyncNotice } | null = null;
  for (const [id, notice] of notices) {
    if (!best || SYNC_RANK[notice.kind] < SYNC_RANK[best.notice.kind]) best = { id, notice };
  }
  return best;
}

/**
 * Which single notice to show.
 *
 * A save that is not happening outranks everything: those are the only states
 * where work is actively not being kept. The eviction warning outranks the
 * remaining hints for the same reason — one is about losing data, the others
 * about company or about bindings that are merely idle. Showing them all at
 * once would stack banners over the viewport and make the important one harder
 * to find, not easier.
 */
function pickEntry(
  persist: BlobStoreNotice | null,
  sync: SceneSyncNotice | null,
  persistDismissed: boolean,
): Entry | null {
  if (sync?.kind === 'moved') {
    return {
      key: 'moved',
      severity: 'critical',
      message: sync.message,
      action: 'Reload the page to open it under its new identity.',
    };
  }
  if (sync?.kind === 'conflict') {
    return { key: 'conflict', severity: 'critical', message: sync.message };
  }
  if (sync?.kind === 'autosave-error') {
    return {
      key: 'autosave-error',
      severity: 'critical',
      message: sync.message,
      action: 'Use Save As to write the scene somewhere it can be kept.',
    };
  }
  if (sync?.kind === 'missing-document') {
    return { key: 'missing-document', severity: 'warning', message: sync.message };
  }
  if (sync?.kind === 'orphaned-bindings') {
    return {
      key: 'orphaned-bindings',
      severity: 'warning',
      message: sync.message,
      // Offered only for the links whose new slot is unambiguous. The rest stay
      // a report: a "Reconnect" that guessed would be worse than no button.
      ...(sync.repairable > 0 ? { actionLabel: 'Reconnect' } : {}),
    };
  }
  if (persist && !persistDismissed) {
    return {
      key: 'persist',
      severity: 'warning',
      message: persist.message,
      action: 'Open a project folder to keep your scenes outside the browser.',
    };
  }
  if (sync?.kind === 'other-tab') {
    return { key: 'other-tab', severity: 'info', message: sync.message };
  }
  return null;
}
