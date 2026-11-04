// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import type { PlanningRegistry } from '../../core/planning/rv-planning-registry';
import type { StatsSectionRegistrar } from '../../core/stats/rv-stats-registry';

/** Hub tab title of a planning owner: its planning title without the "Planning · " prefix. */
export function planningKpiSectionTitle(planningTitle: string): string {
  return planningTitle.replace(/^Planning\s*·\s*/, '') || planningTitle;
}

/** Mirror planning owners into the hub; the hub owns value polling. */
export function registerPlanningKpiSections(registry: PlanningRegistry, stats: StatsSectionRegistrar): () => void {
  const sections = new Map<string, { title: string; measured: boolean; off: () => void }>();
  const sync = () => {
    const kpis = registry.kpis();
    const owners = registry.getSnapshot().owners.filter(({ owner }) => kpis.some(k => k.owner === owner));
    for (const [owner, section] of sections) {
      if (!owners.some(o => o.owner === owner)) {
        section.off();
        sections.delete(owner);
      }
    }
    for (const { owner, title } of owners) {
      const measured = kpis.some(k => k.owner === owner && k.kind === 'measured');
      const previous = sections.get(owner);
      if (previous?.title === title && previous.measured === measured) continue;
      previous?.off();
      const off = stats.register({
        id: `planning.kpis:${owner}`, title: planningKpiSectionTitle(title), order: 30,
        description: measured ? 'Some values are measured — not deterministic.' : undefined,
        isAvailable: () => registry.getSnapshot().owners.some(o => o.owner === owner)
          && registry.kpis().some(k => k.owner === owner),
        subscribe: cb => registry.subscribe(cb),
        rows: () => registry.kpis().filter(k => k.owner === owner).map(k => ({
          key: k.key,
          label: k.kind === 'measured' ? `${k.label} (measured)` : k.label,
          value: k.value !== null && k.decimals !== undefined ? Number(k.value.toFixed(k.decimals)) : k.value,
          unit: k.unit,
        })),
      });
      sections.set(owner, { title, measured, off });
    }
  };
  const unsubscribe = registry.subscribe(sync);
  sync();
  return () => {
    unsubscribe();
    for (const section of sections.values()) section.off();
    sections.clear();
  };
}
