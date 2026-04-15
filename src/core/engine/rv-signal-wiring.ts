// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-signal-wiring.ts — Helpers for wiring boolean signal subscriptions.
 *
 * Eliminates the repetitive 7-line pattern:
 *   guard addr → store initial → subscribe → coerce to bool → debug log
 */

import type { SignalStore } from './rv-signal-store';
import type { NodeRegistry, ComponentRef } from './rv-node-registry';
import { debug } from './rv-debug';

const NOOP = () => {};

export interface WireResult {
  /** Resolved signal address, or null if wiring was skipped */
  addr: string | null;
  /** Call to unsubscribe from the signal */
  unsubscribe: () => void;
}

const EMPTY: WireResult = { addr: null, unsubscribe: NOOP };

/**
 * Subscribe to a resolved signal address and bind its boolean value via a setter.
 * No-op if addr is null/undefined/non-string.
 *
 * - Sets initial value from store immediately
 * - Subscribes for future changes
 * - Optionally logs a debug message
 *
 * @param store   SignalStore instance
 * @param addr    Resolved signal address (after resolveComponentRefs)
 * @param setter  Called with the boolean value on initial read and every change
 * @param label   Optional debug label (address is appended automatically)
 */
export function wireBoolSignal(
  store: SignalStore,
  addr: string | null | undefined,
  setter: (value: boolean) => void,
  label?: string,
): WireResult {
  if (!addr || typeof addr !== 'string') return EMPTY;

  setter(store.getBoolByPath(addr));

  const unsub = store.subscribeByPath(addr, (value) => {
    setter(value === true);
  });

  if (label) debug('loader', `  ${label}="${addr}"`);

  return { addr, unsubscribe: unsub };
}

/**
 * Resolve a raw ComponentRef to a signal address, then wire as boolean.
 * No-op if ref is null/undefined or does not resolve to a signal address.
 *
 * @param registry  NodeRegistry for ComponentRef resolution
 * @param store     SignalStore instance
 * @param ref       Raw ComponentRef from GLB extras
 * @param setter    Called with the boolean value on initial read and every change
 * @param label     Optional debug label
 */
export function wireRefBoolSignal(
  registry: NodeRegistry,
  store: SignalStore,
  ref: ComponentRef | null | undefined,
  setter: (value: boolean) => void,
  label?: string,
): WireResult {
  if (!ref) return EMPTY;
  const resolved = registry.resolve(ref);
  if (!resolved.signalAddress) return EMPTY;
  return wireBoolSignal(store, resolved.signalAddress, setter, label);
}
