// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * LiveLinkPill — status pill right of the simulation controls while the USD
 * live link is switched on (plan-637 F6): connecting / transferring / live
 * with the measured rate / retrying / token needed / error. Hidden while sync
 * is off. Clicking it switches sync off in every state — including an error
 * or a missing token, where no session runs.
 */

import { useSyncExternalStore } from 'react';
import { FiberManualRecord } from '@mui/icons-material';
import type { UISlotProps } from '../../core/rv-ui-plugin';
import { ActionGroupPill, ActionSegment } from '../../core/hmi/action-group';
import { ERROR, FS, ICON_SIZE, SUCCESS, WARN } from '../../core/hmi/shared-sx';
import type { UsdLiveLinkPlugin } from './usd-live-link-plugin';
import type { LiveLinkState } from './live-link-store';

/** Short pill label for a state. */
export function pillLabel(state: LiveLinkState): string {
  switch (state.status) {
    case 'live': return `Isaac Sim · ${state.sentHz || state.rateHz} Hz`;
    case 'needs-token': return 'Isaac Sim · token needed';
    case 'connecting': return (state.attempt ?? 1) >= 2 ? 'Isaac Sim · retrying' : 'Isaac Sim · connecting';
    case 'mounting': return 'Isaac Sim · transferring';
    case 'error': return 'Isaac Sim · error';
    default: return 'Isaac Sim';
  }
}

/** Tooltip of the pill: state detail, outdated-extension hint, how to stop. */
export function pillTitle(state: LiveLinkState): string {
  // Each part ends in exactly one full stop — a message that brings its own
  // ("…the realvirtual Live Sync panel.") must not turn into "..".
  const trim = (t: string) => t.trim().replace(/[.…]+$/, '');
  const head = 'USD live link to Isaac Sim' + (state.message ? ` — ${trim(state.message)}` : '');
  const parts = [head, ...(state.extensionNotice ? [trim(state.extensionNotice)] : []), 'Click to stop syncing'];
  return parts.join('. ') + '.';
}

function pillColor(state: LiveLinkState): string {
  if (state.status === 'live') return SUCCESS;
  if (state.status === 'error') return ERROR;
  return WARN; // needs-token, connecting, mounting
}

export function LiveLinkPill({ viewer }: UISlotProps) {
  const plugin = viewer.getPlugin<UsdLiveLinkPlugin>('usd-live-link') ?? null;
  const state = useSyncExternalStore(
    plugin?.store.subscribe ?? (() => () => {}),
    plugin?.store.getSnapshot ?? (() => null),
  );
  if (!plugin || !state || state.status === 'off') return null;
  const color = pillColor(state);
  return (
    // 24px instead of the shared 22px pill: the pill is the one-click stop of
    // the link, so it gets the minimum target size (WCAG 2.5.8).
    <ActionGroupPill data-testid="usd-live-link-pill" sx={{ height: { xs: 32, sm: 24 } }}>
      <ActionSegment
        title={pillTitle(state)}
        icon={<FiberManualRecord sx={{ fontSize: ICON_SIZE.xs, color }} />}
        label={pillLabel(state)}
        sx={{ fontSize: FS.body }}
        onClick={() => plugin.setSyncEnabled(false)}
        buttonProps={{ 'aria-label': `USD live link: ${pillLabel(state)}` }}
      />
    </ActionGroupPill>
  );
}
