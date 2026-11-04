// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * MaintenanceMessages — the maintenance tiles of the message panel
 * (plan-522 Phase 6). One tile per procedure the MaintenancePlugin lists
 * (`Message: Always`, or upcoming / due / overdue by its triggers, plan-522
 * Phase 7 — the headline and severity follow the level);
 * clicking a tile opens that procedure's guide. Registered by the plugin only
 * while the loaded model has such a procedure, in every workspace mode — an
 * operator in the HMI reaches the guide from here.
 */

import { Fragment, useEffect, useState } from 'react';
import type { UISlotEntry, UISlotProps } from '../rv-ui-plugin';
import type { MaintenanceMessageEntry, MaintenancePluginAPI } from '../types/plugin-types';
import { TileCard } from './TileCard';

function formatCounter(v: number): string {
  const digits = v >= 100 ? 0 : v >= 10 ? 1 : 2;
  return v.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

/**
 * Tile subtitle: authored text, else "<trigger>: <counter> / <interval> <unit>"
 * of the deciding trigger (plan-522 Phase 7; a count has no unit), else the
 * trigger name, else the estimate.
 */
export function maintenanceTileSubtitle(e: MaintenanceMessageEntry): string {
  if (e.procedure.messageText) return e.procedure.messageText;
  const prefix = e.triggerName ? `${e.triggerName}: ` : '';
  if (e.unit !== null && e.interval > 0) {
    const unit = e.unit ? ` ${e.unit}` : '';
    return `${prefix}${formatCounter(e.value)} / ${formatCounter(e.interval)}${unit}`;
  }
  if (e.triggerName) return e.triggerName;
  return e.procedure.estimatedMinutes > 0 ? `~${e.procedure.estimatedMinutes} min` : '';
}

/** Tile headline per level (plan-522 Phase 7). English only, whatever the browser language (Thomas, 2026-10-26). */
export function maintenanceTileTitle(e: MaintenanceMessageEntry): string {
  const label = ['Maintenance', 'Maintenance upcoming', 'Maintenance due', 'Maintenance overdue'][e.level];
  return `${label}: ${e.procedure.name}`;
}

/** Tile severity per level: ok / upcoming = info, due = warning, overdue = error. */
export function maintenanceTileSeverity(level: number): 'info' | 'warning' | 'error' {
  return level >= 3 ? 'error' : level === 2 ? 'warning' : 'info';
}

function useEntries(props: UISlotProps): MaintenanceMessageEntry[] {
  const { viewer } = props;
  const read = (): MaintenanceMessageEntry[] =>
    viewer.getPlugin<MaintenancePluginAPI>('maintenance')?.getMessageEntries?.() ?? [];
  const [entries, setEntries] = useState(read);
  useEffect(() => {
    const update = (): void => setEntries(read());
    update();
    const offDue = viewer.on('maintenance-due-changed' as string, update);
    const offMode = viewer.on('maintenance-mode-changed' as string, update);
    return () => { offDue(); offMode(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewer]);
  return entries;
}

export function MaintenanceMessages(props: UISlotProps) {
  const entries = useEntries(props);
  if (entries.length === 0) return null;
  return (
    <>
      {entries.map((e) => {
        let subtitle = maintenanceTileSubtitle(e);
        if (e.liveBrowserCount) {
          subtitle += ' · counts only while this viewer is open';
        }
        const title = maintenanceTileTitle(e);
        return (
          <Fragment key={e.procedure.name}>
            <TileCard
              title={title}
              subtitle={subtitle}
              severity={maintenanceTileSeverity(e.level)}
              icon="build"
              timestamp={e.due ? 'Now' : ''}
              componentPath={e.sourcePath || undefined}
              onAction={() => props.viewer.emit('enter-maintenance' as string, { procedure: e.procedure.name })}
            />
          </Fragment>
        );
      })}
    </>
  );
}

/** UI pseudo-plugin the MaintenancePlugin registers while tiles are possible. */
export const MAINTENANCE_MESSAGES_UI: { id: string; slots: UISlotEntry[] } = {
  id: 'maintenance-messages',
  slots: [{ slot: 'messages', component: MaintenanceMessages, order: 15 }],
};
