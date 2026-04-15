// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * React hook for subscribing to typed viewer events.
 *
 * Auto-subscribes/unsubscribes via useEffect. The callback ref
 * is kept stable to avoid re-subscriptions on every render.
 *
 * Usage:
 *   useSimulationEvent('sensor-changed', (data) => {
 *     console.log(data.sensorPath, data.occupied);
 *   });
 */

import { useEffect, useRef } from 'react';
import { useViewer } from './use-viewer';
import type { ViewerEvents } from '../core/rv-viewer';

export function useSimulationEvent<K extends string & keyof ViewerEvents>(
  event: K,
  callback: (data: ViewerEvents[K]) => void,
): void {
  const viewer = useViewer();
  const cbRef = useRef(callback);
  cbRef.current = callback;

  useEffect(() => {
    return viewer.on(event, (data: ViewerEvents[K]) => cbRef.current(data));
  }, [viewer, event]);
}
