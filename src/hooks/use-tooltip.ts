// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * React hooks for the generic tooltip system.
 *
 * Usage:
 *   const { visible } = useTooltipState();   // array of visible tooltip bubbles
 *   tooltipStore.show({ id: 'drive', ... });  // from plugin code
 *   tooltipStore.hide('drive');               // hide specific tooltip
 */

import { useSyncExternalStore } from 'react';
import { tooltipStore, type TooltipState } from '../core/hmi/tooltip/tooltip-store';

// Re-export store methods for convenient plugin access
export { tooltipStore } from '../core/hmi/tooltip/tooltip-store';

/** Subscribe to tooltip state changes via useSyncExternalStore. */
export function useTooltipState(): TooltipState {
  return useSyncExternalStore(tooltipStore.subscribe, tooltipStore.getSnapshot);
}
