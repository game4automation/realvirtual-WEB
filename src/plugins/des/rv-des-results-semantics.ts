// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Results-semantics version per DES component type.
 *
 * Bump a type's version whenever a fix changes what its statistics MEAN (counts, throughput, KPIs),
 * so results stored under the old meaning stop showing as current next to new ones. The experiment
 * Base key folds in every entry > 1 of a type present in the scene: models with that type get a new
 * key (their stored results read "base changed"), every other model keeps its key byte for byte.
 * A type not listed is version 1. Never lower or remove an entry.
 *
 * History:
 * - RobotHandling 2: each hand-over counted once instead of twice (282f2e39).
 *
 * Pure data, no imports: safe for any loader to read.
 */
export const DES_RESULTS_SEMANTICS: Readonly<Record<string, number>> = Object.freeze({
  RobotHandling: 2,
});

/**
 * The versioned (> 1) entries of the given component types, sorted by type; empty when none applies.
 */
export function resultsSemanticsOf(types: Iterable<string>): Array<[string, number]> {
  const out = new Map<string, number>();
  for (const type of types) {
    const version = Object.prototype.hasOwnProperty.call(DES_RESULTS_SEMANTICS, type) ? DES_RESULTS_SEMANTICS[type] : 1;
    if (version > 1) out.set(type, version);
  }
  return [...out].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
}
