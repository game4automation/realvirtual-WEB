// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** Analysis toolbar entry, present whenever any contributor is available. */
import { useSyncExternalStore } from 'react';
import { IconButton, Tooltip } from '@mui/material';
import { Timeline } from '@mui/icons-material';
import type { UISlotProps } from '../rv-ui-plugin';
import { ACCENT } from '../hmi/shared-sx';
import { isStatsHubOpen, subscribeStatsHub, toggleStatsHub } from './stats-hub-store';

export function StatsHubButton({ viewer }: UISlotProps) {
  useSyncExternalStore(viewer.stats.subscribe, viewer.stats.getSnapshot);
  const open = useSyncExternalStore(subscribeStatsHub, isStatsHubOpen);
  if (!viewer.stats.available().length) return null;
  return <Tooltip title="Statistics" placement="right">
    <IconButton size="small" aria-label="Statistics" aria-pressed={open} onClick={toggleStatsHub}
      sx={{ color: open ? ACCENT : 'inherit', p: 0.75 }}>
      <Timeline fontSize="small" />
    </IconButton>
  </Tooltip>;
}
