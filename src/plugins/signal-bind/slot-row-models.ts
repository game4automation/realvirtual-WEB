// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * slot-row-models.ts — the SINGLE row-model builder for signal-slot surfaces
 * (plan-325 F8/9.10): the 3D badge popover and the inline inspector rows both
 * derive their `SlotRow[]` from this module, so both surfaces always present
 * identical slot sets and identical states (same resolver, same mapping match,
 * same authority/liveness derivation).
 */

import type { Object3D } from 'three';
import type { RVViewer } from '../../core/rv-viewer';
import type { SignalBindingManager } from '../../core/engine/rv-signal-binding-manager';
import type { SignalStore } from '../../core/engine/rv-signal-store';
import {
  deriveSlotAuthority,
  getSlotAuthority,
  isRemoteOwnershipActive,
  type SlotAuthority,
} from '../../core/engine/rv-slot-authority';
import {
  mappingSourceKind,
  type SignalMapping,
} from '../layout-planner/rv-layout-store';
import type { BindableRowKind, PickerSignal, SlotRow } from '../../core/hmi/rv-signal-slot-row';
import { mapDiscoveredDirection } from './signal-bind-store';

/** Probe writer for the row-level canWriteSlot() reason — a generic
 *  local-simulation identity (the perspective the row explains). */
export const LOCAL_SIM_PROBE = { writerId: 'ui:authority-probe', writerKind: 'component' as const };

/** Legacy-tolerant mapping↔row match (same predicate the popover always used). */
export function mappingMatchesRow(
  mapping: SignalMapping,
  row: Pick<SlotRow, 'slot' | 'componentPath' | 'kind'>,
): boolean {
  const kind = row.kind ?? 'mapped-signal';
  return (mapping.kind ?? 'mapped-signal') === kind
    && mapping.slot === row.slot
    && (mapping.componentPath === row.componentPath
      || (mapping.componentPath === undefined && kind === 'mapped-signal'));
}

/**
 * Write authority of a slot WITHOUT an active binding (plan-320 Phase 5).
 *
 * A SlotId — and with it a claim entry and a slot↔channel index entry — only
 * exists while a binding is live, so neither `getSlotAuthority()` nor
 * `canWriteSlot()` can answer for an unbound slot: the claim registry never
 * learned about it, and the store's force escalation runs off the channel index
 * it is missing from. The state is fully derivable from raw data nonetheless,
 * which is what the pure `deriveSlotAuthority()` exists for: without a claim the
 * component simulates the missing PLC, UNLESS the operator forces the slot's own
 * model signal — a force needs no binding and would otherwise stay invisible.
 *
 * The reasons match the canWriteSlot() taxonomy for a local-simulation writer
 * ('authority-forced' when a force holds the write off, 'ok' otherwise), so both
 * paths feed AUTHORITY_REASON_TEXT from the same vocabulary.
 */
function unboundSlotAuthority(
  store: SignalStore | null | undefined,
  targetName: string | undefined,
): { authority: SlotAuthority; authorityReason: string } {
  const forced = !!targetName && !!store?.isForced(targetName);
  return {
    authority: deriveSlotAuthority({ hasComponent: true, bound: false, forced }),
    authorityReason: forced ? 'authority-forced' : 'ok',
  };
}

/**
 * Build the display row models for one bind target. Adds per-row mapping,
 * liveness, chain source (internal assignment → its CONNECT mapping) and the
 * plan-320 authority state.
 */
export function buildSlotRowModels(
  viewer: Pick<RVViewer, 'signalStore'>,
  mgr: SignalBindingManager,
  targetId: string,
  node: Object3D,
  mappings: readonly SignalMapping[],
): SlotRow[] {
  const resolved = mgr.getElementSlots(targetId, node);
  const remoteOwned = isRemoteOwnershipActive();
  const store = viewer.signalStore;
  return resolved.map((r): SlotRow => {
    if (r.kind === 'unavailable') return { kind: 'unavailable', slot: r.slot, label: r.label, reason: r.reason };
    const mapping = mappings.find((m) => mappingMatchesRow(m, r));
    const targetName = r.kind === 'mapped-signal' ? r.targetName : undefined;
    // plan-320 Phase 5: authority + canWriteSlot reason on EVERY slot row. A
    // bound slot answers from its claim; an unbound one is derived, because a
    // force needs no binding (see unboundSlotAuthority).
    const slotId = mgr.getSlotId(targetId, r.slot, r.componentPath);
    const { authority, authorityReason } = slotId
      ? {
        authority: getSlotAuthority(slotId),
        authorityReason: store?.canWriteSlot(slotId, LOCAL_SIM_PROBE).reason,
      }
      : unboundSlotAuthority(store, targetName);
    // A bare 'component' on an unassigned row would only restate "– not linked",
    // so the claimless default shows solely where it qualifies a real
    // assignment. 'bound' and 'forced' always show — 'forced' being the state
    // that was invisible on unbound slots before.
    const showAuthority = authority !== 'none'
      && (authority !== 'component' || !!mapping || !!targetName);
    const liveness = mapping
      ? mgr.getBindingLiveness(targetId, r.slot, r.componentPath)
      : undefined;
    const chainSource = mapping && mappingSourceKind(mapping) === 'internal'
      ? mgr.getConnectSourceForTarget(mapping.signal)
      : undefined;
    return {
      kind: r.kind,
      componentPath: r.componentPath,
      componentType: r.componentType,
      slot: r.slot,
      label: r.label,
      type: r.type,
      direction: r.direction,
      aliases: r.aliases,
      targetName,
      ...(showAuthority ? { authority, remoteOwned, authorityReason } : {}),
      mapping,
      liveness,
      chainSource,
    };
  });
}

/**
 * Internal model signals offered as binding sources (plan-325 F3): every
 * SignalStore entry WITHOUT a CONNECT provider registration. The slot's own
 * target signal is excluded per picker-open (self-binding exclusion) by the
 * caller via `excludeName`.
 */
export function collectInternalSignals(
  store: SignalStore,
  excludeName?: string,
): PickerSignal[] {
  const out: PickerSignal[] = [];
  for (const name of store.getAll().keys()) {
    if (name === excludeName) continue;
    if (store.getSignalProviders(name).length > 0) continue; // CONNECT-provided
    const t = store.getType(name) ?? '';
    const meta = store.getSignalMeta(name);
    out.push({
      name,
      direction: t.startsWith('PLCOutput') ? 'output' : t.startsWith('PLCInput') ? 'input' : 'unknown',
      dataType: t || undefined,
      address: meta?.address,
      comment: meta?.comment,
      origin: 'internal',
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * Upsert the mapping for `row` from a picked/dropped source signal.
 * CONNECT sources need provider identity (interfaceId); internal sources
 * persist as `sourceKind:'internal'` with the SignalStore name (F9 relay — the
 * raw componentRef field in the GLB extras is NEVER rewritten).
 * Returns null when the pick is not bindable (conflict / missing identity).
 */
export function upsertMappingForRow(
  mappings: readonly SignalMapping[],
  row: Pick<SlotRow, 'slot' | 'componentPath' | 'kind' | 'direction'>,
  source: PickerSignal,
): SignalMapping[] | null {
  if (source.conflict) return null;
  const kind = (row.kind ?? 'mapped-signal') as BindableRowKind;
  const internal = source.origin === 'internal';
  if (!internal && !source.interfaceId) return null;
  const direction = mapDiscoveredDirection(source.direction, row.direction ?? 'plcInput');
  const others = mappings.filter((m) => !mappingMatchesRow(m, row));
  const next: SignalMapping = internal
    ? {
      kind,
      componentPath: row.componentPath,
      slot: row.slot,
      sourceKind: 'internal',
      signal: source.name,
      direction,
      enabled: true,
    }
    : {
      kind,
      componentPath: row.componentPath,
      slot: row.slot,
      signal: source.name,
      interfaceId: source.interfaceId,
      topic: source.topic,
      direction,
      enabled: true,
    };
  return [...others, next];
}

/** Remove the mapping for `row` (unlink). */
export function removeMappingForRow(
  mappings: readonly SignalMapping[],
  row: Pick<SlotRow, 'slot' | 'componentPath' | 'kind'>,
): SignalMapping[] {
  return mappings.filter((m) => !mappingMatchesRow(m, row));
}
