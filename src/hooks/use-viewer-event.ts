// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Generic React hook for subscribing to a typed viewer event and keeping state.
 *
 * Combines `useState` + `useEffect` + `viewer.on(event, ...)` into a single
 * reusable hook. The `select` function extracts the desired value from the
 * event payload. The state updates only when the selected value changes.
 *
 * Usage:
 *   const open = useViewerEvent('drive-chart-toggle', viewer.driveChartOpen, d => d.open);
 *   const filter = useViewerEvent('drive-filter', '', d => d.filter);
 */

import { useState, useEffect, useRef } from 'react';
import { useViewer } from './use-viewer';
import type { ViewerEvents } from '../core/rv-viewer';

/**
 * Subscribe to a typed viewer event and return derived state.
 *
 * @param event   - The ViewerEvents key to subscribe to.
 * @param initial - Initial state value (used before first event fires).
 * @param select  - Selector that extracts state from the event payload.
 * @returns The latest selected value.
 */
export function useViewerEvent<
  K extends string & keyof ViewerEvents,
  T,
>(
  event: K,
  initial: T,
  select: (data: ViewerEvents[K]) => T,
): T {
  const viewer = useViewer();
  const [value, setValue] = useState<T>(initial);
  const selectRef = useRef(select);
  selectRef.current = select;

  useEffect(() => {
    return viewer.on(event, (data: ViewerEvents[K]) => {
      setValue(selectRef.current(data));
    });
  }, [viewer, event]);

  return value;
}
