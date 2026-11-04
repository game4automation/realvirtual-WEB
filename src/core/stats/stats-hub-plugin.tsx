// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** Core shell for statistics contributed by independently loaded features. */
import { lazy, Suspense, useSyncExternalStore } from 'react';
import type { RVViewerPlugin } from '../rv-plugin';
import type { UISlotEntry, UISlotProps } from '../rv-ui-plugin';
import { TOOL_GROUP } from '../hmi/button-panel-sections';
import { StatsHubButton } from './StatsHubButton';
import { isStatsHubOpen, subscribeStatsHub } from './stats-hub-store';

// The window (MUI Tabs + Table) stays out of the entry chunk: only the button,
// the registry and the store are boot code. The chunk loads on the first open;
// a plain `open &&` gate is right here — the window holds no state worth keeping
// across a close (preferences live in the store), and unmounting stops its timers.
const StatsHubWindow = lazy(() => import('./StatsHubWindow').then(m => ({ default: m.StatsHubWindow })));

function StatsHubWindowShell(props: UISlotProps) {
  const open = useSyncExternalStore(subscribeStatsHub, isStatsHubOpen);
  if (!open) return null;
  return <Suspense fallback={null}><StatsHubWindow {...props} /></Suspense>;
}

export class StatsHubPlugin implements RVViewerPlugin {
  readonly id = 'stats-hub';
  readonly core = true;
  readonly slots: UISlotEntry[] = [
    { slot: 'button-group', component: StatsHubButton, order: 50, group: TOOL_GROUP.analysis, visibilityRule: {} },
    { slot: 'overlay', component: StatsHubWindowShell, order: 50, visibilityRule: {} },
  ];
}
