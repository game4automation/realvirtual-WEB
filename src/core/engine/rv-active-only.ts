// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ActiveOnly — Port of Unity's realvirtualBehavior.ActiveOnly enum.
 *
 * Controls whether a component participates in simulation based on the
 * viewer's global connection state.
 */

/** Unity's ActiveOnly enum values (serialized as strings in GLB extras). */
export type ActiveOnly = 'Always' | 'Connected' | 'Disconnected' | 'Never' | 'DontChange';

/** Valid ActiveOnly values for runtime validation. */
const VALID_VALUES: readonly ActiveOnly[] = ['Always', 'Connected', 'Disconnected', 'Never', 'DontChange'];

/**
 * Parse ActiveOnly from GLB extras data.
 * Falls back to 'Always' if the field is missing or invalid.
 */
export function parseActiveOnly(data: Record<string, unknown>): ActiveOnly {
  const raw = data['Active'] as string | undefined;
  return VALID_VALUES.includes(raw as ActiveOnly) ? (raw as ActiveOnly) : 'Always';
}

/**
 * Evaluate whether a component should be active given its ActiveOnly mode
 * and the viewer's current connection state.
 *
 * Matches Unity's ChangeConnectionMode() logic in realvirtualBehavior.cs.
 */
export function isActiveForState(active: ActiveOnly, isConnected: boolean): boolean {
  switch (active) {
    case 'Always':       return true;
    case 'Connected':    return isConnected;
    case 'Disconnected': return !isConnected;
    case 'Never':        return false;
    case 'DontChange':   return true; // don't modify — treat as always active
  }
}
