// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * binding-inventory — one answer to "what is bound to what right now", for the
 * three surfaces that ask it (plan-425).
 *
 * The overview panel (F7), the `web_signal_bindings_list` MCP tool (F5) and the
 * repair action behind the orphan notice (F3) are the same question asked by a
 * human, by a language model and by a button. Answering it three times would
 * guarantee they eventually disagree — and the one that a model reads while
 * binding in series is the worst one to have drift.
 *
 * Everything here is derived. No state is kept: the manager owns the bindings,
 * the persistence adapters own the mappings, and this module only reads them and
 * writes back through the SAME upsert/persist path the UI drop uses.
 *
 * ## Slot identity
 *
 * A row is identified by `componentPath + slot` (+ `kind`), never by
 * `targetId + slot`. A Planner placement aggregates its whole subtree, so one
 * target can carry the same slot NAME on several components — which is exactly
 * the situation in which a mutation addressed by target and slot alone would hit
 * the wrong one. The manager's own binding key is `componentPath + slot`; this
 * is that key, published.
 */

import type { RVViewer } from '../../core/rv-viewer';
import type { SignalMapping } from '../layout-planner/rv-layout-store';
import type { SlotLiveness } from '../../core/engine/rv-signal-binding-manager';
import { enumerateAllBindableTargets } from './bindable-targets';
import { createSignalBindingPersistence } from './signal-binding-persistence';
import { signalBindTargetId, type SignalBindTarget } from './signal-bind-target';
import { mappingMatchesRow } from './slot-row-models';

/** One bindable slot with whatever is (or is not) on it. */
export interface BindingInventoryRow {
  targetId: string;
  targetLabel: string;
  targetKind: 'placed' | 'node';
  /** Canonical slot identity, half 1. */
  componentPath: string;
  /** Canonical slot identity, half 2. */
  slot: string;
  kind: 'mapped-signal' | 'direct-property' | 'direct-feedback';
  componentType?: string;
  label?: string;
  type: 'bool' | 'float' | 'int';
  direction: 'plcOutput' | 'plcInput';
  /** The external signal on this slot, when there is one. */
  signal?: string;
  sourceKind?: 'connect' | 'internal';
  interfaceId?: string;
  liveness?: SlotLiveness;
  /** The slot signal's own comment, for a model matching names to meanings. */
  comment?: string;
}

/** A saved link that did not bind, and what could be done about it. */
export interface BindingInventoryOrphan {
  targetId: string;
  targetLabel: string;
  slot: string;
  componentPath?: string;
  componentType?: string;
  signal: string;
  /** Present exactly when a single-candidate repair is available. */
  candidateComponentPath?: string;
  /** Present exactly when it is not. */
  reason?: string;
}

export interface BindingInventory {
  rows: BindingInventoryRow[];
  orphans: BindingInventoryOrphan[];
}

interface TargetLike {
  id: string;
  kind: 'placed' | 'node';
  target: SignalBindTarget;
  node: { name?: string };
}

function labelOf(entry: TargetLike): string {
  return entry.target.label || entry.node.name || entry.id;
}

/**
 * Every bindable slot in the scene, plus every saved link that failed to bind.
 *
 * Slots come from the resolver (via the manager) so the set is identical to what
 * the inspector rows show; mappings come from the persistence adapter so a link
 * saved but not yet applied is still visible as an orphan rather than vanishing.
 */
export function collectBindingInventory(viewer: RVViewer): BindingInventory {
  const manager = viewer.signalBindingManager;
  if (!manager) return { rows: [], orphans: [] };
  const store = viewer.signalStore;
  const rows: BindingInventoryRow[] = [];
  const orphans: BindingInventoryOrphan[] = [];

  for (const entry of enumerateAllBindableTargets(viewer)) {
    const targetLabel = labelOf(entry);
    const mappings = createSignalBindingPersistence(viewer, entry.target).read();
    for (const slot of manager.getElementSlots(entry.id, entry.node)) {
      if (slot.kind === 'unavailable') continue;
      const mapping = mappings.find((m) => mappingMatchesRow(m, {
        slot: slot.slot, componentPath: slot.componentPath, kind: slot.kind,
      }));
      const targetName = slot.kind === 'mapped-signal' ? slot.targetName : undefined;
      rows.push({
        targetId: entry.id,
        targetLabel,
        targetKind: entry.kind,
        componentPath: slot.componentPath,
        slot: slot.slot,
        kind: slot.kind,
        ...(slot.componentType !== undefined ? { componentType: slot.componentType } : {}),
        ...(slot.label !== undefined ? { label: slot.label } : {}),
        type: slot.type,
        direction: slot.direction,
        ...(mapping ? {
          signal: mapping.signal,
          sourceKind: mapping.sourceKind ?? 'connect',
          ...(mapping.interfaceId !== undefined ? { interfaceId: mapping.interfaceId } : {}),
          liveness: manager.getBindingLiveness(entry.id, slot.slot, slot.componentPath),
        } : {}),
        // The comment travels with the slot's own model signal — the phrase a
        // matching model needs most and the one thing a slot NAME never says.
        ...(targetName && store?.getSignalMeta(targetName)?.comment
          ? { comment: store.getSignalMeta(targetName)!.comment }
          : {}),
      });
    }

    for (const unresolved of manager.getUnresolvedMappings(entry.id)) {
      orphans.push({
        targetId: entry.id,
        targetLabel,
        slot: unresolved.mapping.slot,
        ...(unresolved.mapping.componentPath !== undefined
          ? { componentPath: unresolved.mapping.componentPath } : {}),
        ...(unresolved.mapping.componentType !== undefined
          ? { componentType: unresolved.mapping.componentType } : {}),
        signal: unresolved.mapping.signal,
        ...(unresolved.candidateComponentPath !== undefined
          ? { candidateComponentPath: unresolved.candidateComponentPath } : {}),
        ...(unresolved.reason !== undefined ? { reason: unresolved.reason } : {}),
      });
    }
  }
  return { rows, orphans };
}

/** Number of orphans a single click could put back — what the notice offers. */
export function countRepairableOrphans(inventory: BindingInventory): number {
  return inventory.orphans.filter((o) => o.candidateComponentPath !== undefined).length;
}

/**
 * The list to PERSIST after an apply: what bound, normalised, plus what did not,
 * untouched.
 *
 * `applyMappings()` returns only the mappings it could bind, so persisting its
 * result directly deletes every broken link on the same target. That is exactly
 * the wrong outcome here — orphaned bindings are deliberately KEPT
 * (`orphaned-bindings.ts`: loading the previous model makes them live again),
 * and a repair that silently discarded the OTHER broken links while fixing one
 * would be the most expensive possible way to offer help.
 *
 * Order is preserved on both sides: `applyMappings` filters without reordering,
 * so walking the requested list against a pointer into the applied one lines
 * them up without needing a synthetic key. The match still has to include
 * `componentPath`, because slot name and signal alone are NOT unique — an
 * aggregate target routinely carries the same signal on the same slot name of
 * two components, and matching on those two would consume the wrong entry and
 * shift everything after it by one.
 */
export function mergeAppliedMappings(
  requested: readonly SignalMapping[],
  applied: readonly SignalMapping[],
): SignalMapping[] {
  const out: SignalMapping[] = [];
  let next = 0;
  for (const mapping of requested) {
    const candidate = applied[next];
    if (candidate
      && candidate.slot === mapping.slot
      && candidate.signal === mapping.signal
      && (mapping.componentPath === undefined
        || candidate.componentPath === mapping.componentPath)) {
      out.push({ ...candidate });
      next++;
    } else {
      out.push({ ...mapping });
    }
  }
  return out;
}

/**
 * Re-point one orphaned mapping at the slot the second pass found, and bind it.
 *
 * Only ever called with a candidate a HUMAN confirmed. The second pass itself
 * never reaches here (rv-binding-repair explains why an apparently unique match
 * is not proof of identity), so this function does not re-derive the candidate —
 * it applies the decision it was handed.
 *
 * @returns true when the mapping was rewritten and re-applied.
 */
export function repairOrphanedBinding(
  viewer: RVViewer,
  orphan: Pick<BindingInventoryOrphan, 'targetId' | 'slot' | 'componentPath' | 'signal' | 'candidateComponentPath'>,
): boolean {
  const manager = viewer.signalBindingManager;
  if (!manager || !orphan.candidateComponentPath) return false;
  const entry = enumerateAllBindableTargets(viewer).find((t) => t.id === orphan.targetId);
  if (!entry) return false;
  const persistence = createSignalBindingPersistence(viewer, entry.target);
  const mappings = persistence.read();
  const index = mappings.findIndex((m) =>
    m.slot === orphan.slot
    && m.componentPath === orphan.componentPath
    && m.signal === orphan.signal);
  if (index < 0) return false;
  const next = mappings.map((m, i) =>
    (i === index ? { ...m, componentPath: orphan.candidateComponentPath! } : { ...m }));
  const applied = manager.applyMappings(signalBindTargetId(entry.target), entry.node, next);
  // Normalised where it bound (applyMappings resolves interfaceId and kind),
  // untouched where it did not — repairing THIS link must not delete the other
  // broken ones. See mergeAppliedMappings.
  persistence.write(mergeAppliedMappings(next, applied));
  return true;
}

/** Apply every unambiguous repair. Returns how many were made. */
export function repairAllOrphanedBindings(viewer: RVViewer): number {
  let repaired = 0;
  for (const orphan of collectBindingInventory(viewer).orphans) {
    if (!orphan.candidateComponentPath) continue;
    if (repairOrphanedBinding(viewer, orphan)) repaired++;
  }
  return repaired;
}
