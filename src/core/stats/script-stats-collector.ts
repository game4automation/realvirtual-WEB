// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Rows that WebComponent scripts publish with `self.statValue(key, value, unit?, group?)`
 * (plan-2011 § 2.7). One collector per viewer registry; it owns the hub section `scripts`
 * ("Scripts", order 90), registered with the first row and removed with the last.
 * Rows are keyed by (script node path, key) — a node carries at most one script — and only
 * the last value is kept. Rows without a group are grouped under their script's node path.
 *
 * Order (plan-2212 Phase 3): owners are listed by node path (code-unit order), within an
 * owner by first publication. A canonical owner order makes the section independent of
 * which script happened to publish first, so a DES restore (which writes every script's
 * rows back) shows exactly what the uninterrupted run shows.
 */
import type { SdkStatRowsBackend } from '../sdk/rv-sdk-self';
import type { StatsRegistry, StatsRow } from './rv-stats-registry';

class ScriptStatsCollector {
  private readonly owners = new Map<string, Map<string, StatsRow>>();
  private unregister?: () => void;

  constructor(private readonly registry: StatsRegistry) {}

  forOwner(ownerPath: string): SdkStatRowsBackend {
    return {
      set: (key, value, unit, group) => {
        let rows = this.owners.get(ownerPath);
        if (!rows) this.owners.set(ownerPath, rows = new Map());
        rows.set(key, {
          key: JSON.stringify([ownerPath, key]), label: key, value, unit,
          group: group ?? ownerPath, owner: ownerPath,
        });
        // The window polls rows at 1 Hz; only section membership needs notification.
        this.unregister ??= this.registry.register({
          id: 'scripts', title: 'Scripts', order: 90,
          rows: () => [...this.owners.entries()]
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .flatMap(([, owner]) => [...owner.values()]),
        });
      },
      clear: () => {
        this.owners.delete(ownerPath);
        if (this.owners.size === 0) {
          this.unregister?.();
          this.unregister = undefined;
        }
      },
    };
  }
}

const collectors = new WeakMap<StatsRegistry, ScriptStatsCollector>();

/** Return the shared script-row collector for this viewer's registry. */
export function getScriptStatsCollector(registry: StatsRegistry): ScriptStatsCollector {
  let collector = collectors.get(registry);
  if (!collector) collectors.set(registry, collector = new ScriptStatsCollector(registry));
  return collector;
}
