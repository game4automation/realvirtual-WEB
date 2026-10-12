// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-fmu-constants.ts — the dependency-free part of the `Fmu` component
 * (plan-510): the component key, the lifecycle states and their colours, and
 * a read of an instance's state from its node.
 *
 * Split out of `rv-fmu.ts` so that light HMI helpers (`rv-value-resolver.ts`,
 * `rv-inspector-helpers.ts`) can show the FMU state in the section header
 * WITHOUT importing the whole FMU engine (which pulls in signal construction,
 * every drive module and their component self-registrations). `rv-fmu.ts`
 * re-exports everything here, so existing imports keep working.
 */

import type { Object3D } from 'three';

/** Lifecycle of one FMU instance (plan-498 F4). */
export type FmuState =
  | 'standalone'
  | 'unsupported'
  | 'idle'
  | 'uploading'
  | 'needs-trust'
  | 'starting'
  | 'running'
  | 'error';

/**
 * State → colour of the hierarchy badge and the inspector chip (plan-498 §2.7).
 * ISA-101 calm: grey while nothing runs, blue while it is being brought up,
 * amber when a person has to act, green running, red only for a failure.
 */
export const FMU_STATE_COLORS: Record<FmuState, string> = {
  standalone: '#90a4ae',
  unsupported: '#ffa726',
  idle: '#90a4ae',
  uploading: '#4fc3f7',
  'needs-trust': '#ffa726',
  starting: '#4fc3f7',
  running: '#66bb6a',
  error: '#ef5350',
};

/** The component key. */
export const FMU_TYPE = 'Fmu';

/** `userData` key under which `RVFmu` registers itself on its node. */
export const FMU_USERDATA_KEY = '_rvFmu';

/** The state of the FMU instance on `node`, or null when the node carries none. */
export function fmuStateOf(node: Object3D | null | undefined): FmuState | null {
  const inst = node?.userData?.[FMU_USERDATA_KEY] as { state?: unknown } | undefined;
  const state = inst?.state;
  return typeof state === 'string' && state in FMU_STATE_COLORS ? (state as FmuState) : null;
}
