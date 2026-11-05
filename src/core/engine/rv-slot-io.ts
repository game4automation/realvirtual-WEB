// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-slot-io.ts — direct values for signal slots that are not wired to a signal.
 *
 * A component's signal slot (a schema `componentRef + signal` field) normally
 * holds a resolved SignalStore address. When the GLB leaves it empty — the
 * usual case when an external signal is connected only in the viewer — the
 * binding manager has no store signal to relay into. SlotIO is the generic
 * stand-in: per component INSTANCE (WeakMap, nothing on the instance itself) it
 * holds the directly commanded values of such slots and the last feedback
 * values a component produced, so the resolver can offer the slot as
 * `direct-property` / `direct-feedback` without creating a store signal and
 * without writing an address into the field.
 *
 * A component opts in per field with {@link slotDeclare}; the resolver offers
 * ONLY declared fields. Three access kinds:
 *
 * | access     | slot           | component side                         | binding side |
 * |------------|----------------|----------------------------------------|--------------|
 * | `setter`   | PLCOutput      | a setter applied on every command       | command / neutralize |
 * | `poll`     | PLCOutput      | {@link slotRead} / {@link slotTryRead} per tick | command / neutralize |
 * | `feedback` | PLCInput       | {@link slotWrite} per tick              | listener + read |
 *
 * Every accessor takes the field's ADDRESS as well: a wired slot keeps reading
 * and writing the store exactly as before, the direct value is only consulted
 * when the address is empty. Neutralize removes the direct value, so a `poll`
 * slot falls back to the default the component reads for an unbound slot and a
 * `setter` slot runs its `neutral` callback (the wiring helpers derive it from
 * the slot's PLC type).
 *
 * A `setter` slot that was declared with a re-apply registry replays its last
 * direct value on `reapplyAll()` (reset / reconnect), like a wired input
 * replays the current store level.
 */

import type { SignalStore, SignalWriter } from './rv-signal-store';
import type { SignalApplyContext, SignalReapplyRegistry } from './rv-signal-reapply-registry';
import type { FeedbackSource } from './rv-binding-slot-resolver';

/** How a component consumes or produces a declared slot. */
export type SlotAccess = 'setter' | 'poll' | 'feedback';

/** Options of {@link slotDeclare}. */
export interface SlotDeclareOptions {
  /** `setter`: applies a directly commanded value (also on replay, with `ctx.replay`). */
  apply?: (value: boolean | number, ctx?: SignalApplyContext) => void;
  /** `setter`: restores the unbound state when the binding is neutralized. */
  neutral?: () => void;
  /** `setter`: registry the last direct value is replayed through. */
  reapply?: SignalReapplyRegistry | null;
  /** `feedback`: value reported before the component produced one (default 0). */
  initial?: boolean | number;
}

/** A slot reference the wiring helpers take to declare an unwired field. */
export interface SlotRef {
  /** Component instance owning the field. */
  instance: object;
  /** Schema field name (= slot name). */
  field: string;
  /** Value applied on neutralize; omitted = the helper's default for its PLC type. */
  unbound?: boolean | number;
}

interface SlotEntry {
  access: SlotAccess;
  /** Directly commanded value (`setter` / `poll`); undefined = none. */
  direct: boolean | number | undefined;
  apply: ((value: boolean | number, ctx?: SignalApplyContext) => void) | null;
  neutral: (() => void) | null;
  reapply: SignalReapplyRegistry | null;
  unregisterReplay: (() => void) | null;
  /** Last feedback value (`feedback`). */
  value: boolean | number;
  listeners: (() => void)[];
  source: FeedbackSource | null;
}

const slots = new WeakMap<object, Map<string, SlotEntry>>();
export const slotCommandListeners = new Set<() => void>();
/** Fields a component deliberately leaves unbindable, with the reason the resolver reports. */
const refusals = new WeakMap<object, Map<string, string>>();

function entryOf(instance: object, field: string): SlotEntry | undefined {
  return slots.get(instance)?.get(field);
}

/**
 * Declare `field` of `instance` as directly bindable. A repeated declaration
 * (re-init) updates the configuration and keeps the direct value and the
 * listeners of bindings that already hold the slot.
 */
export function slotDeclare(
  instance: object,
  field: string,
  access: SlotAccess,
  options: SlotDeclareOptions = {},
): void {
  let fields = slots.get(instance);
  if (!fields) {
    fields = new Map();
    slots.set(instance, fields);
  }
  const existing = fields.get(field);
  if (existing) {
    // A replay registered through a previous registry must not outlive it.
    if (existing.unregisterReplay && existing.reapply !== (options.reapply ?? null)) {
      existing.unregisterReplay();
      existing.unregisterReplay = null;
    }
    existing.access = access;
    existing.apply = options.apply ?? null;
    existing.neutral = options.neutral ?? null;
    existing.reapply = options.reapply ?? null;
    if (existing.access === 'setter' && existing.direct !== undefined) armReplay(existing, field);
    return;
  }
  fields.set(field, {
    access,
    direct: undefined,
    apply: options.apply ?? null,
    neutral: options.neutral ?? null,
    reapply: options.reapply ?? null,
    unregisterReplay: null,
    value: options.initial ?? 0,
    listeners: [],
    source: null,
  });
}

/**
 * Drop the declaration of `field` (or of every field of `instance`) — called on
 * component dispose. Bindings holding the slot keep stale command / listener
 * closures and must be rebuilt (re-resolved) after the component is re-created.
 */
export function slotUndeclare(instance: object, field?: string): void {
  if (field === undefined) refusals.delete(instance);
  else refusals.get(instance)?.delete(field);
  const fields = slots.get(instance);
  if (!fields) return;
  const drop = (entry: SlotEntry): void => {
    entry.unregisterReplay?.();
    entry.unregisterReplay = null;
    entry.listeners.length = 0;
  };
  if (field === undefined) {
    for (const entry of fields.values()) drop(entry);
    slots.delete(instance);
    return;
  }
  const entry = fields.get(field);
  if (!entry) return;
  drop(entry);
  fields.delete(field);
}

/**
 * Leave an unwired `field` deliberately unbindable — e.g. a slot whose value the
 * component ignores in its current configuration. Nothing is declared; the
 * resolver keeps the row `unavailable` and reports `reason`. Cleared by
 * {@link slotUndeclare}.
 */
export function slotRefuse(instance: object, field: string, reason: string): void {
  let fields = refusals.get(instance);
  if (!fields) {
    fields = new Map();
    refusals.set(instance, fields);
  }
  fields.set(field, reason);
}

/** The reason a field was refused with {@link slotRefuse}, or null. */
export function slotRefusal(instance: object, field: string): string | null {
  return refusals.get(instance)?.get(field) ?? null;
}

/** Access kind of a declared field, or null when it is not declared. */
export function slotDeclared(instance: object, field: string): SlotAccess | null {
  return entryOf(instance, field)?.access ?? null;
}

/** Command a direct value into a declared `setter` / `poll` slot (binding side). */
export function slotCommand(instance: object, field: string, value: boolean | number): void {
  const entry = entryOf(instance, field);
  if (!entry || entry.access === 'feedback') return;
  entry.direct = value;
  if (entry.access === 'setter') {
    entry.apply?.(value);
    armReplay(entry, field);
  }
  for (const cb of slotCommandListeners) cb();
}

/** Register the setter slot's replay of its last direct value (once). */
function armReplay(entry: SlotEntry, field: string): void {
  if (!entry.reapply || entry.unregisterReplay) return;
  entry.unregisterReplay = entry.reapply.register(`slot:${field}`, (ctx) => {
    if (entry.direct !== undefined) entry.apply?.(entry.direct, ctx);
  });
}

/** Remove the direct value of a `setter` / `poll` slot — the unbound default applies again. */
export function slotNeutralize(instance: object, field: string): void {
  const entry = entryOf(instance, field);
  if (!entry || entry.access === 'feedback') return;
  entry.direct = undefined;
  if (entry.access !== 'setter') return;
  entry.unregisterReplay?.();
  entry.unregisterReplay = null;
  entry.neutral?.();
  for (const cb of slotCommandListeners) cb();
}

/**
 * Is a slot address WIRED? Typed `string | null`, but a slot the reference
 * resolution could not turn into a path still holds the raw object (malformed
 * or unresolved reference) — that is unwired, exactly as the signal wiring
 * classifies it, never a path handed to the store.
 */
function isWired(address: unknown): address is string {
  return typeof address === 'string' && address.length > 0;
}

/**
 * Numeric read of a PLCOutput slot: the wired signal when `address` is set,
 * else the direct value, else `fallback`. Coerces like `getFloatByPath`.
 */
export function slotRead(
  store: SignalStore,
  instance: object,
  field: string,
  address: string | null,
  fallback: number,
): number {
  if (isWired(address)) return store.getFloatByPath(address);
  const direct = entryOf(instance, field)?.direct;
  if (direct === undefined) return fallback;
  return typeof direct === 'number' ? direct : 0;
}

/** Boolean read of a PLCOutput slot — same rule as {@link slotRead}, coerced like `getBoolByPath`. */
export function slotReadBool(
  store: Pick<SignalStore, 'getBoolByPath'>,
  instance: object,
  field: string,
  address: string | null,
  fallback: boolean,
): boolean {
  if (isWired(address)) return store.getBoolByPath(address);
  const direct = entryOf(instance, field)?.direct;
  if (direct === undefined) return fallback;
  return direct === true;
}

/**
 * Raw read for slots that leave the component untouched while unbound: the
 * wired store value, else the direct value, else `undefined` ("keep as is").
 */
export function slotTryRead(
  store: SignalStore,
  instance: object,
  field: string,
  address: string | null,
): boolean | number | undefined {
  if (isWired(address)) return store.getByPath(address);
  return entryOf(instance, field)?.direct;
}

/**
 * Publish a feedback value: into the wired signal when `address` is set, and
 * into the slot's cache when it is declared. Listeners are notified when the
 * cached value changes — on every tick that changes it, moving or not.
 */
export function slotWrite(
  instance: object,
  field: string,
  address: string | null,
  value: boolean | number,
  writer: Pick<SignalWriter, 'setByPath'> | null,
): void {
  if (isWired(address) && writer) writer.setByPath(address, value);
  const entry = entryOf(instance, field);
  if (!entry || entry.access !== 'feedback' || entry.value === value) return;
  entry.value = value;
  const listeners = entry.listeners;
  for (let i = 0; i < listeners.length; i++) listeners[i]();
}

/** Last feedback value of a declared `feedback` slot (undefined when not declared). */
export function slotFeedbackValue(instance: object, field: string): boolean | number | undefined {
  const entry = entryOf(instance, field);
  return entry && entry.access === 'feedback' ? entry.value : undefined;
}

/** Cache access for silent feedback restore. */
export function slotFeedbackState(instance: object): ReadonlyMap<string,
  { readonly access: SlotAccess; value: boolean | number }> | undefined {
  return slots.get(instance);
}

/**
 * True when the slot carries a value from outside: wired to a signal, holding a
 * direct value, or (feedback) read by a binding.
 */
export function slotBound(instance: object, field: string, address: string | null): boolean {
  if (isWired(address)) return true;
  const entry = entryOf(instance, field);
  if (!entry) return false;
  return entry.access === 'feedback' ? entry.listeners.length > 0 : entry.direct !== undefined;
}

/**
 * The {@link FeedbackSource} the binding manager samples a declared `feedback`
 * slot through. One object per slot, so a listener fires only for its own field.
 */
export function slotFeedbackSource(instance: object, field: string): FeedbackSource | null {
  const entry = entryOf(instance, field);
  if (!entry || entry.access !== 'feedback') return null;
  if (!entry.source) {
    entry.source = {
      addFeedbackListener(cb) {
        if (!entry.listeners.includes(cb)) entry.listeners.push(cb);
      },
      removeFeedbackListener(cb) {
        const index = entry.listeners.indexOf(cb);
        if (index >= 0) entry.listeners.splice(index, 1);
      },
      readFeedbackSlot: () => entry.value,
    };
  }
  return entry.source;
}
