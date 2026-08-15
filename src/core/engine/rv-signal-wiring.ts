// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-signal-wiring.ts — Helpers for wiring signal subscriptions.
 *
 * Eliminates the repetitive 7-line pattern:
 *   guard addr → store initial → subscribe → coerce → debug log
 *
 * Since plan-427 every helper ALSO registers the slot in an optional
 * {@link SignalReapplyRegistry}, so the current level can be re-applied after
 * `resetSimulation()` and after a reconnect. Passing no registry keeps the old
 * behaviour exactly (feature simply inactive — that is what unit tests use).
 *
 * Three flavours, differing only in how the store value reaches the setter:
 *
 * | helper             | coercion         | initial read                    | replay |
 * |--------------------|------------------|---------------------------------|--------|
 * | `wireBoolSignal`   | `=== true`       | always (`false` when unresolved)| always |
 * | `wireValueSignal`  | raw pass-through | only when the path resolves     | once a value has been delivered |
 * | `wireNumberSignal` | `Number(v)`      | NEVER — the authored value stands until the PLC writes | once a value has been delivered |
 *
 * The number variant is the odd one out on purpose: a `TargetSpeed` signal that
 * the PLC has not written yet reads as `0`, and applying that at wire time (or
 * replaying it after a reset) would overwrite the drive's authored speed and
 * leave it standing still. A re-apply restores the level a component HAD — for
 * a slot that never delivered one there is nothing to restore.
 *
 * LIMITATION (unchanged by these helpers): `subscribeByPath` on a path that is
 * not registered yet returns a permanent no-op handle (`rv-signal-store.ts`), so
 * a signal registered LATER never activates the CHANGE subscription. That is
 * the existing behaviour of every direct `subscribeByPath` caller; the helpers
 * do not make it worse and do not pretend to fix it. A late path therefore also
 * stays out of the replay for the two "delivered once" helpers — they were
 * never armed. `wireBoolSignal` does re-resolve on every replay (its `false`
 * initial read arms it), so a late-registered bool is picked up by the next
 * reset/reconnect pass.
 *
 * Every replay PULLS the current store value; nothing cached at wire time is
 * ever replayed, and an address that is still unresolved is skipped rather than
 * turned into a NaN write.
 */

import type { SignalStore } from './rv-signal-store';
import type { NodeRegistry, ComponentRef } from './rv-node-registry';
import type { SignalApplyContext, SignalReapplyRegistry } from './rv-signal-reapply-registry';
import { debug } from './rv-debug';

const NOOP = () => {};

export interface WireResult {
  /** Resolved signal address, or null if wiring was skipped */
  addr: string | null;
  /** Call to drop BOTH the store subscription and the re-apply registry slot */
  unsubscribe: () => void;
}

const EMPTY: WireResult = { addr: null, unsubscribe: NOOP };

/** Bundle the store unsubscribe and the registry unregister into one handle. */
function combine(unsubStore: () => void, unsubReapply: () => void): () => void {
  if (unsubReapply === NOOP) return unsubStore;
  return () => { unsubStore(); unsubReapply(); };
}

/**
 * Subscribe to a resolved signal address and bind its boolean value via a setter.
 * No-op if addr is null/undefined/non-string.
 *
 * - Sets initial value from store immediately
 * - Subscribes for future changes
 * - Registers a re-apply slot when a registry is supplied
 * - Optionally logs a debug message
 *
 * @param store   SignalStore instance
 * @param addr    Resolved signal address (after resolveComponentRefs)
 * @param setter  Called with the boolean value on initial read, every change,
 *                and on every re-apply (then with `ctx.replay === true`)
 * @param label   Optional debug label (address is appended automatically)
 * @param reapply Optional viewer-owned re-apply registry (`ComponentContext.reapply`)
 */
export function wireBoolSignal(
  store: SignalStore,
  addr: string | null | undefined,
  setter: (value: boolean, ctx?: SignalApplyContext) => void,
  label?: string,
  reapply?: SignalReapplyRegistry,
): WireResult {
  if (!addr || typeof addr !== 'string') return EMPTY;

  setter(store.getBoolByPath(addr));

  const unsub = store.subscribeByPath(addr, (value) => {
    setter(value === true);
  });

  const unsubReapply = reapply
    ? reapply.register(addr, (ctx) => setter(store.getBoolByPath(addr), ctx))
    : NOOP;

  if (label) debug('loader', `  ${label}="${addr}"`);

  return { addr, unsubscribe: combine(unsub, unsubReapply) };
}

/**
 * Subscribe to a resolved signal address and bind its NUMERIC value via a setter.
 *
 * For the Float/Int input slots (`Speed`, `Accelaration`, `Destination`,
 * `TargetSpeed`). Two contracts set it apart from {@link wireBoolSignal}:
 *
 * 1. **No initial read.** A numeric slot commands a magnitude the component
 *    otherwise takes from its authored value — `Drive.TargetSpeed`,
 *    `Drive.Acceleration`. Applying the store's registered `0` at wire time
 *    would silently overwrite the authored speed of every drive whose signal
 *    the PLC has not written yet, and the drive would never move. This mirrors
 *    the behaviour of the direct `subscribeByPath` calls the helper replaced.
 * 2. **The replay is ARMED by the first real delivery** (see `armed` below).
 *    Until the slot has actually carried a value, there is no level to restore,
 *    so a reset must not invent one.
 *
 * An unresolved path (`getByPath() === undefined`) is skipped throughout —
 * `Number(undefined)` is `NaN`, and a NaN destination poisons a drive silently
 * (plan-427 F9).
 *
 * @param store   SignalStore instance
 * @param addr    Resolved signal address (after resolveComponentRefs)
 * @param setter  Called with the numeric value on every change and on replay
 * @param label   Optional debug label
 * @param reapply Optional viewer-owned re-apply registry
 */
export function wireNumberSignal(
  store: SignalStore,
  addr: string | null | undefined,
  setter: (value: number, ctx?: SignalApplyContext) => void,
  label?: string,
  reapply?: SignalReapplyRegistry,
): WireResult {
  return wireRawSignal(
    store, addr,
    (value, ctx) => { setter(Number(value), ctx); },
    label, reapply, /* readInitial */ false,
  );
}

/**
 * Subscribe to a resolved signal address and pass the RAW store value through.
 *
 * The variant for consumers that do their own coercion or must not coerce at
 * all — `ConnectSignal` copies bool AND numeric values verbatim, the WebSensor /
 * WebDiagnostics family narrows per bound slot. The initial read fires when the
 * path resolves and is skipped when it does not, which is exactly the
 * `if (current !== undefined)` guard these components carried by hand before
 * the migration.
 */
export function wireValueSignal(
  store: SignalStore,
  addr: string | null | undefined,
  setter: (value: boolean | number, ctx?: SignalApplyContext) => void,
  label?: string,
  reapply?: SignalReapplyRegistry,
): WireResult {
  return wireRawSignal(store, addr, setter, label, reapply, /* readInitial */ true);
}

/**
 * Shared body of {@link wireValueSignal} and {@link wireNumberSignal}.
 *
 * `armed` is the guard that keeps a re-apply honest: the registry restores the
 * level a component HAD, so a slot that never delivered one has nothing to
 * restore. With `readInitial` the very first read arms it immediately (the
 * display components behave exactly as before); without it, the first genuine
 * change does.
 */
function wireRawSignal(
  store: SignalStore,
  addr: string | null | undefined,
  setter: (value: boolean | number, ctx?: SignalApplyContext) => void,
  label: string | undefined,
  reapply: SignalReapplyRegistry | undefined,
  readInitial: boolean,
): WireResult {
  if (!addr || typeof addr !== 'string') return EMPTY;

  let armed = false;

  if (readInitial) {
    const initial = store.getByPath(addr);
    if (initial !== undefined) { armed = true; setter(initial); }
  }

  const unsub = store.subscribeByPath(addr, (value) => {
    armed = true;
    setter(value);
  });

  const unsubReapply = reapply
    ? reapply.register(addr, (ctx) => {
        if (!armed) return;
        const current = store.getByPath(addr);
        if (current !== undefined) setter(current, ctx);
      })
    : NOOP;

  if (label) debug('loader', `  ${label}="${addr}"`);

  return { addr, unsubscribe: combine(unsub, unsubReapply) };
}

/**
 * Scale a drive feedback position for the PLC.
 *
 * Shared by the Drive_* behaviors (Drive_Simple, Drive_Speed,
 * Drive_DestinationMotor): `(pos - offset) / scale` when scaling is enabled
 * (with a Scale=0 guard so a zero divisor never produces ±Infinity), the raw
 * position otherwise.
 */
export function scaleFeedbackPosition(
  pos: number,
  enabled: boolean,
  scale: number,
  offset: number,
): number {
  if (!enabled) return pos;
  return (pos - offset) / (scale || 1);
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
 * @param reapply   Optional viewer-owned re-apply registry (plan-427)
 */
export function wireRefBoolSignal(
  registry: NodeRegistry,
  store: SignalStore,
  ref: ComponentRef | null | undefined,
  setter: (value: boolean, ctx?: SignalApplyContext) => void,
  label?: string,
  reapply?: SignalReapplyRegistry,
): WireResult {
  if (!ref) return EMPTY;
  const resolved = registry.resolve(ref);
  if (!resolved.signalAddress) return EMPTY;
  return wireBoolSignal(store, resolved.signalAddress, setter, label, reapply);
}
