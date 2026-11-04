// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-fill-addresses — "Fill addresses from controller" (plan-2025 F11).
 *
 * Pure: no React, no store, no fetch. Given the model's PLC signals, the interface as CONNECT holds
 * it and the result of a controller browse (`POST /discover/{id}/start`), it says per model signal
 * what a fill would do — and builds the ONE batch of `signal.upsert{addressMode: fillEmpty}` ops.
 *
 * ## The rules (plan-589, binding)
 *
 * - **Name = symbol, exact.** A model signal couples to the discovered signal whose `symbolKey` is
 *   ordinally equal to the model signal's runtime name. Nothing else ever couples: a quoting or
 *   case variant (`"DB1".Start` vs `DB1.Start`) is shown as `name-variant` with the other spelling as
 *   a suggestion and is NOT written — renaming is a human decision.
 * - **The address lives in CONNECT.** What is written is the discovery's `protocolAddress`, verbatim,
 *   into `SignalConfig.ProtocolAddress` — never into the model, never into a comment.
 * - **FillEmpty.** An address the interface already has is the commissioned truth. A different one
 *   is reported as `kept` and left alone; the gateway enforces the same rule on its side.
 */

import { normaliseTagName, type ModelPlcSignal } from './rv-plc-automap';
import type {
  ConnectConfigOp,
  ConnectConfigPlanBase,
  ConnectInterface,
  ConnectSignalSchema,
  DiscoveredSignal,
} from '../hmi/connect-store';

/** What a fill does (or does not do) for one model signal. */
export type FillRowStatus =
  /** The interface has the signal without an address — the address is filled in. */
  | 'fill'
  /** The interface has no such signal — it is created with the model's wire type and the address. */
  | 'create'
  /** The interface already carries exactly this address. */
  | 'already'
  /** The interface carries a DIFFERENT address — kept (FillEmpty), shown for a human decision. */
  | 'kept'
  /** Only a quoting / case variant of the name exists on the controller — a suggestion, never written. */
  | 'name-variant'
  /** The controller reports no symbol of this name. */
  | 'not-found'
  /** The controller reports the symbol but no address for it (not directly bindable). */
  | 'no-address'
  /** The controller symbol has the other direction than the model signal. */
  | 'direction-conflict'
  /** Two controller symbols with this exact key, or the name lives in more than one container. */
  | 'ambiguous'
  /** The name is already configured on ANOTHER interface — creating it here would collide. */
  | 'bound-elsewhere';

export const FILL_ROW_STATUSES: readonly FillRowStatus[] = [
  'fill', 'create', 'already', 'kept', 'name-variant', 'not-found', 'no-address',
  'direction-conflict', 'ambiguous', 'bound-elsewhere',
];

/** Statuses a fill writes. Everything else is information. */
export const FILL_WRITE_STATUSES: ReadonlySet<FillRowStatus> = new Set<FillRowStatus>(['fill', 'create']);

/** One row of the preview. */
export interface FillRow {
  /** Model signal runtime name (= CONNECT signal name). */
  name: string;
  /** Model wire type (`PLCOutputBool`, …). */
  modelType: string;
  status: FillRowStatus;
  /** The address the controller reports (fill / create / already / kept / direction-conflict). */
  protocolAddress?: string;
  /** The address the interface already carries (kept). */
  existingAddress?: string;
  /** MQTT topic container of an existing entry; absent = the interface-level list. */
  topic?: string;
  /** Protocol data type written on create (only when the interface type accepts it). */
  dataType?: string;
  /** name-variant: the controller's spelling. */
  suggestion?: string;
  /** Human-readable reason for the non-written statuses. */
  reason?: string;
}

export interface FillAddressPlan {
  interfaceId: string;
  rows: FillRow[];
  counts: Record<FillRowStatus, number>;
  /** Controller symbols no model signal claims (shown as a number only). */
  controllerOnly: number;
  /** Size of the browse the plan was made from. */
  discovered: number;
  /** Revision / instance / gateway the plan was computed on (set by the store; Apply sends exactly this). */
  base?: ConnectConfigPlanBase;
  /** The CONNECT size limit the batch breaks (set by the store), null/absent = within the limits. */
  limitError?: string | null;
}

/** Inputs of {@link planFillAddresses}. */
export interface FillAddressInput {
  iface: ConnectInterface;
  model: readonly ModelPlcSignal[];
  discovered: readonly DiscoveredSignal[];
  /** Every OTHER configured interface (global name uniqueness). */
  otherInterfaces?: readonly ConnectInterface[];
  /** Signal schema of the interface type (data type list); null = unknown, the data type travels unchecked. */
  schema?: ConnectSignalSchema | null;
}

/**
 * Is "Fill addresses from controller" offered for an interface type? Exactly where the gateway says
 * the worker can browse (`SignalSchemaInfo.SupportsDiscovery`) — FANUC, for instance, cannot — and
 * never for a model-managed (FMI) interface, whose signals come from the FMU.
 */
export function supportsFillAddresses(schema: ConnectSignalSchema | null | undefined, modelManaged: boolean): boolean {
  return !modelManaged && schema?.supportsDiscovery === true;
}

/** `PLCInput…` → input, everything else output (PLC convention: an output is read by the viewer). */
function directionOfType(type: string): 'input' | 'output' {
  return type.startsWith('PLCInput') ? 'input' : 'output';
}

/** The spelling under which two names count as a variant of each other (quotes, outer blanks, case). */
function variantKey(name: string): string {
  return normaliseTagName(name).toLowerCase();
}

/** The schema's spelling of a protocol data type, or undefined when the schema does not allow it. */
export function schemaDataType(dataType: string | undefined, schema: ConnectSignalSchema | null | undefined): string | undefined {
  const value = dataType?.trim();
  if (!value) return undefined;
  const allowed = schema?.dataTypes ?? [];
  if (allowed.length === 0) return value;
  return allowed.find(d => d === value) ?? allowed.find(d => d.toLowerCase() === value.toLowerCase());
}

function emptyCounts(): Record<FillRowStatus, number> {
  const out = {} as Record<FillRowStatus, number>;
  for (const s of FILL_ROW_STATUSES) out[s] = 0;
  return out;
}

/** Every signal name of an interface, flat and per topic. */
function namesOf(iface: ConnectInterface): Set<string> {
  const out = new Set<string>();
  for (const s of iface.signals ?? []) out.add(s.name);
  for (const t of iface.topics ?? []) for (const s of t.signals ?? []) out.add(s.name);
  return out;
}

/** Plan a fill (plan-2025 F11). Deterministic: rows follow the model order. */
export function planFillAddresses(input: FillAddressInput): FillAddressPlan {
  const { iface, model, discovered, schema } = input;
  const counts = emptyCounts();
  const rows: FillRow[] = [];

  const byKey = new Map<string, DiscoveredSignal[]>();
  const byVariant = new Map<string, DiscoveredSignal[]>();
  for (const d of discovered) {
    const key = d.symbolKey ?? '';
    if (!key) continue;
    const exact = byKey.get(key) ?? [];
    exact.push(d);
    byKey.set(key, exact);
    const vk = variantKey(key);
    const variants = byVariant.get(vk) ?? [];
    variants.push(d);
    byVariant.set(vk, variants);
  }

  // Where each name lives on THIS interface: the flat list and/or topics.
  const flat = new Map<string, { address: string; type: string }>();
  for (const s of iface.signals ?? []) if (!flat.has(s.name)) flat.set(s.name, { address: s.protocolAddress ?? '', type: s.type ?? '' });
  const inTopics = new Map<string, Array<{ topic: string; address: string; type: string }>>();
  for (const t of iface.topics ?? []) {
    for (const s of t.signals ?? []) {
      const list = inTopics.get(s.name) ?? [];
      list.push({ topic: t.topic, address: s.protocolAddress ?? '', type: s.type ?? '' });
      inTopics.set(s.name, list);
    }
  }
  const elsewhere = new Set<string>();
  for (const other of input.otherInterfaces ?? []) {
    if (other.id === iface.id) continue;
    for (const name of namesOf(other)) elsewhere.add(name);
  }

  const claimed = new Set<DiscoveredSignal>();
  const seen = new Set<string>();
  for (const m of model) {
    if (!m.name || seen.has(m.name)) continue;
    seen.add(m.name);
    const push = (row: Omit<FillRow, 'name' | 'modelType'>): void => {
      rows.push({ name: m.name, modelType: m.type, ...row });
      counts[row.status]++;
    };

    const hits = byKey.get(m.name) ?? [];
    if (hits.length > 1) {
      hits.forEach(h => claimed.add(h));
      push({ status: 'ambiguous', reason: `The controller reports ${hits.length} symbols named '${m.name}'` });
      continue;
    }
    if (hits.length === 0) {
      const variants = (byVariant.get(variantKey(m.name)) ?? []).filter(v => v.symbolKey !== m.name);
      if (variants.length > 0) {
        push({
          status: 'name-variant',
          suggestion: variants.map(v => v.symbolKey).join(', '),
          reason: 'Only a different spelling exists on the controller — rename one side to couple them',
        });
      } else {
        push({ status: 'not-found' });
      }
      continue;
    }

    const hit = hits[0];
    claimed.add(hit);
    const address = hit.protocolAddress ?? '';
    if (!address) {
      push({ status: 'no-address', reason: 'The controller reports this symbol without a bindable address' });
      continue;
    }
    if (hit.direction !== 'unknown' && hit.direction !== directionOfType(m.type)) {
      push({
        status: 'direction-conflict', protocolAddress: address,
        reason: `The controller symbol is a PLC ${hit.direction}, the model signal is ${m.type}`,
      });
      continue;
    }

    const topics = inTopics.get(m.name) ?? [];
    const inFlat = flat.has(m.name);
    if (topics.length > 1 || (topics.length === 1 && inFlat)) {
      push({ status: 'ambiguous', protocolAddress: address, reason: `'${m.name}' lives in more than one container of this interface` });
      continue;
    }
    const place: { topic?: string; address: string; type: string } | null =
      topics.length === 1 ? topics[0] : inFlat ? flat.get(m.name)! : null;
    if (!place) {
      if (elsewhere.has(m.name)) {
        push({ status: 'bound-elsewhere', protocolAddress: address, reason: `'${m.name}' is already configured on another interface` });
        continue;
      }
      const dataType = schemaDataType(hit.dataType, schema);
      push({ status: 'create', protocolAddress: address, ...(dataType ? { dataType } : {}) });
      continue;
    }
    const topic = place.topic !== undefined ? { topic: place.topic } : {};
    // The configured CONNECT signal has the other direction: a fill would hand a PLC input's address
    // to an output (or vice versa) — fillEmpty keeps the configured type, so this is never written.
    if (place.type && directionOfType(place.type) !== directionOfType(m.type)) {
      push({
        status: 'direction-conflict', protocolAddress: address, ...topic,
        ...(place.address ? { existingAddress: place.address } : {}),
        reason: `The CONNECT signal is configured as ${place.type}, the model signal is ${m.type}`,
      });
      continue;
    }
    if (!place.address.trim()) push({ status: 'fill', protocolAddress: address, ...topic });
    else if (place.address === address) push({ status: 'already', protocolAddress: address, ...topic });
    else push({ status: 'kept', protocolAddress: address, existingAddress: place.address, ...topic });
  }

  let controllerOnly = 0;
  for (const d of discovered) if (d.symbolKey && !claimed.has(d)) controllerOnly++;
  return { interfaceId: iface.id, rows, counts, controllerOnly, discovered: discovered.length };
}

/**
 * The ONE batch a fill writes: a `signal.upsert` with `addressMode: fillEmpty` per `fill` / `create`
 * row. Create rows carry the model's wire type (and the protocol data type when known); fill rows
 * carry nothing but the address, so `record`, `comment`, type and OPC UA fields stay as configured.
 */
export function fillAddressOps(plan: FillAddressPlan): ConnectConfigOp[] {
  const ops: ConnectConfigOp[] = [];
  for (const row of plan.rows) {
    if (!FILL_WRITE_STATUSES.has(row.status) || !row.protocolAddress) continue;
    ops.push({
      op: 'signal.upsert',
      interfaceId: plan.interfaceId,
      ...(row.topic !== undefined ? { topic: row.topic } : {}),
      name: row.name,
      protocolAddress: row.protocolAddress,
      addressMode: 'fillEmpty',
      ...(row.status === 'create'
        ? { type: row.modelType, record: false, ...(row.dataType ? { dataType: row.dataType } : {}) }
        : {}),
    });
  }
  return ops;
}
