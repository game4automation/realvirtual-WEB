// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-iface-signal-slots — the SIGNAL PLACES of a CONNECT interface (plan-589 §2.3).
 *
 * A CONNECT interface does not hold one flat signal list. It holds a flat `signals` array AND, for
 * MQTT, one array per topic (`topics[].signals`), and the two are not interchangeable: the same
 * name may exist in two different topics, and whether a place needs a `protocolAddress` depends on
 * its container (and, inside a topic, on the topic's MODE). An `IfaceSignalSlot` is that place made
 * addressable — interface + optional topic + mode + the signal's own fields — so the dialog, the
 * inspector and (phase 3) the reconcile report all speak about the same thing.
 *
 * **Why this file and not `connect-store.ts`:** everything here is pure and React-free, and the
 * reconcile report of phase 3 (`rv-signal-reconcile.ts`, same folder) is the main consumer. It
 * imports the connect types TYPE-ONLY, so nothing of the store's module graph (fetch, subscriptions,
 * debounce) is pulled into a reconcile run or a node test.
 */

import type {
  AddressRule,
  ConnectInterface,
  ConnectInterfaceSignal,
  ConnectSignalSchema,
  MqttTopicMode,
} from '../hmi/connect-store';

export type { AddressRule };

/**
 * One signal place of an interface: WHERE a signal lives, plus what it currently says.
 *
 * `topic` absent = the interface-level `signals` container. `topic` present = that topic's own
 * `signals` array, and `mode` is the topic's payload mode (the thing that decides the address rule).
 * `name` is the CONNECT signal name — the key the model couples to.
 */
export interface IfaceSignalSlot {
  interfaceId: string;
  /** MQTT topic container, or undefined for the interface-level `signals` list. */
  topic?: string;
  /** Payload mode of `topic`; undefined for the flat container (or an unknown-mode topic). */
  mode?: MqttTopicMode;
  name: string;
  /** rv wire type (`PLCOutputBool`, …) as CONNECT stores it. */
  type: string;
  dataType?: string;
  protocolAddress?: string;
}

/**
 * Every signal place of `iface`, flat container first, then one block per topic in config order.
 *
 * Deliberately NOT de-duplicated by name: two topics carrying the same name are two distinct
 * places, and collapsing them is exactly the bug this type exists to prevent.
 */
export function collectInterfaceSlots(iface: ConnectInterface): IfaceSignalSlot[] {
  const out: IfaceSignalSlot[] = [];
  for (const sig of iface.signals ?? []) out.push(slotOf(iface.id, sig));
  for (const topic of iface.topics ?? []) {
    for (const sig of topic.signals ?? []) out.push(slotOf(iface.id, sig, topic.topic, topic.mode));
  }
  return out;
}

/**
 * The slot of one signal in one container.
 *
 * Written with assignments rather than conditional spreads on purpose: the reconcile report of
 * phase 3 calls this once per signal place, and the §1 budget case (20 000 signals × 5
 * interfaces) makes the throw-away objects of `...(x ? {y} : {})` measurable.
 */
function slotOf(
  interfaceId: string,
  sig: ConnectInterfaceSignal,
  topic?: string,
  mode?: MqttTopicMode,
): IfaceSignalSlot {
  const slot: IfaceSignalSlot = { interfaceId, name: sig.name, type: sig.type };
  if (topic !== undefined) slot.topic = topic;
  if (mode !== undefined) slot.mode = mode;
  if (sig.dataType) slot.dataType = sig.dataType;
  if (sig.protocolAddress) slot.protocolAddress = sig.protocolAddress;
  return slot;
}

/**
 * The address rule of `slot`, or `null` when the schema does not state one.
 *
 * `null` is NOT a synonym for `'none'`: it means the gateway never said, so no consumer may turn it
 * into a requirement or a warning (plan-589 §5.4 — older gateways must keep working unchanged).
 * `'none'`, by contrast, is a stated fact about an MQTT Json topic.
 *
 * A slot inside a topic whose mode the schema does not mention also answers `null` — a mode this
 * gateway has no rule for is "never said", not "no address needed".
 */
export function addressRuleFor(
  slot: Pick<IfaceSignalSlot, 'topic' | 'mode'>,
  schema?: ConnectSignalSchema | null,
): AddressRule | null {
  const rule = schema?.addressRule;
  if (!rule) return null;
  if (slot.topic === undefined) return rule.signals ?? null;
  if (slot.mode === undefined) return null;
  return rule.topicModes?.[slot.mode] ?? null;
}

/**
 * Whether this place MUST carry a `protocolAddress`. Only a stated `required` does; an unstated
 * rule and the three permissive rules do not.
 */
export function addressRequiredFor(
  slot: Pick<IfaceSignalSlot, 'topic' | 'mode'>,
  schema?: ConnectSignalSchema | null,
): boolean {
  return addressRuleFor(slot, schema) === 'required';
}

/**
 * Siemens symbolic process-image address syntax (`%IW13`, `%I3.1`, `96.0`, `%QX2.7`), mirroring the
 * gateway's `S7SymbolicAddress` regex. Used by the signal dialog for an MQTT ProcessImage slot,
 * where `POST /signals/validate` cannot help: that endpoint validates an MQTT address as a TOPIC
 * (`AddressValidation.cs` → `ValidateMqttTopic`), while a ProcessImage signal carries a byte offset.
 *
 * Syntax only. The DataType cross-check (`%IW13` declared Bool) stays on the gateway, which does it
 * at compile time for the whole tag table.
 */
const PROCESS_IMAGE_ADDRESS_RE = /^%?[IQMEA]?[BWDX]?\d+(?:\.[0-7])?$/i;

/** Whether `address` is a syntactically valid Siemens process-image address. */
export function isProcessImageAddress(address: string): boolean {
  return PROCESS_IMAGE_ADDRESS_RE.test(address.trim());
}
