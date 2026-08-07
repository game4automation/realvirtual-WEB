// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * auto-bind.ts — derive automatic 1:1 signal links.
 *
 * A CONNECT signal that carries EXACTLY the model-internal signal name
 * (`ResolvedSlot.targetName`) is literally the same SignalStore entry — the same
 * signal. Where names differ, the auto-matcher's `exact` stage still matches the
 * friendly slot/alias name (e.g. a PLC signal named `Flow.Run` for the `Flow.Run`
 * slot). Both are treated as "the same signal" and linked WITHOUT any user action.
 *
 * These derived links are NOT persisted: they are recomputed on every load /
 * CONNECT change, so they never go stale and never need re-linking. Manual
 * mappings (persisted in the scene) always win — a slot the user bound by hand is
 * never overridden by an auto-bind.
 */

import type { ResolvedSlot } from '../../core/engine/rv-binding-slot-resolver';
import { suggestForSlot } from './auto-matcher';
import { mapDiscoveredDirection } from './signal-bind-store';

/** A CONNECT signal available for auto-binding. */
export interface AutoBindSignal {
  name: string;
  interfaceId?: string;
  topic?: string;
  direction: 'input' | 'output' | 'unknown';
}

export interface AutoBindSuggestion {
  slot: string;
  signal: string;
  interfaceId: string;
  topic?: string;
  direction: 'plcInput' | 'plcOutput';
}

type LegacyAutoBind = AutoBindSuggestion & { enabled: true };

/**
 * Derive automatic bindings for an element's slots. Slots already covered by a
 * manual mapping are skipped (manual wins). Returns derived mappings only.
 */
export function computeAutoBindSuggestions(
  slots: readonly ResolvedSlot[],
  manualSlots: ReadonlySet<string>,
  signals: readonly AutoBindSignal[],
): AutoBindSuggestion[] {
  if (signals.length === 0) return [];
  const names = signals.map(s => s.name);
  const nameSet = new Set(names);
  const sourceBy = new Map(signals.map(s => [s.name, s] as const));

  const out: AutoBindSuggestion[] = [];
  for (const slot of slots) {
    if (manualSlots.has(slot.slot)) continue;

    let signal: string | null = null;
    // (1) Exact internal store-name match → truly the same signal.
    if (slot.targetName && nameSet.has(slot.targetName)) {
      signal = slot.targetName;
    } else {
      // (2) Exact friendly slot/alias match via the matcher's stage 1.
      const top = suggestForSlot(
        { slot: slot.slot, type: slot.type, direction: slot.direction, aliases: slot.aliases },
        names,
        1,
      )[0];
      if (top && top.stage === 'exact') signal = top.signal;
    }
    if (!signal) continue;

    const source = sourceBy.get(signal);
    if (!source) continue;
    const dir = mapDiscoveredDirection(source.direction, slot.direction);
    out.push({ slot: slot.slot, signal, interfaceId: source.interfaceId ?? '', topic: source.topic, direction: dir });
  }
  return out;
}

/**
 * @deprecated Compatibility-only result shape for existing integrations. The
 * productive UI uses computeAutoBindSuggestions and requires confirmation.
 */
export function computeAutoBinds(
  slots: readonly ResolvedSlot[],
  manualSlots: ReadonlySet<string>,
  signals: readonly AutoBindSignal[],
): LegacyAutoBind[] {
  return computeAutoBindSuggestions(slots, manualSlots, signals).map((suggestion) => ({
    ...suggestion,
    enabled: true,
  }));
}

/**
 * Compatibility helper: automatic suggestions are never merged into active mappings.
 * Callers must present {@link computeAutoBindSuggestions} and persist only a user-confirmed choice.
 */
export function mergeWithAutoBinds(
  manual: readonly import('../layout-planner/rv-layout-store').SignalMapping[],
  slots: readonly ResolvedSlot[],
  signals: readonly AutoBindSignal[],
): import('../layout-planner/rv-layout-store').SignalMapping[] {
  const manualSlots = new Set(manual.map((mapping) => mapping.slot));
  return [...manual.map((mapping) => ({ ...mapping })), ...computeAutoBinds(slots, manualSlots, signals)];
}
