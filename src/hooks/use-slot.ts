// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * React hook for getting UI slot entries.
 *
 * Reactive: re-evaluates when plugins are registered/unregistered.
 *
 * Usage:
 *   const kpiEntries = useSlot('kpi-bar');
 *   kpiEntries.map(e => <e.component key={...} viewer={viewer} />);
 */

import { useMemo, useSyncExternalStore } from 'react';
import { useViewer } from './use-viewer';
import type { UISlot, UISlotEntry } from '../core/rv-ui-plugin';

/** Returns all UI slot entries for the given slot name. Re-renders on registry changes. */
export function useSlot(slot: UISlot): UISlotEntry[] {
  const viewer = useViewer();
  const version = useSyncExternalStore(
    viewer.uiRegistry.subscribe,
    viewer.uiRegistry.getSnapshot,
  );
  return useMemo(
    () => viewer.uiRegistry.getSlotComponents(slot),
    [viewer, slot, version],
  );
}
