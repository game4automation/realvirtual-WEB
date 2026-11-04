// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * des-flow-order.ts -- material-flow ordering + kind classification for DES
 * components. Shared by the stats chart (rows in flow order) and the runner's
 * `statistics()` (MCP), so both present components the same way.
 */

import type { DESComponent } from './rv-des-component';

/** Component kind for grouping/filtering — prefers `def.statsKind`, then the material-flow `def.kind`,
 *  falls back to the DES class `type` (stripped of the 'DES' prefix). */
export function kindOf(c: DESComponent): string {
  const def = (c as unknown as { def?: { kind?: string; statsKind?: string } }).def;
  if (def?.statsKind) return def.statsKind;
  if (def?.kind) return def.kind;
  const t = (c.constructor as { type?: string }).type;
  return t ? t.replace(/^DES/, '').toLowerCase() : 'component';
}

/**
 * Order components by material flow: BFS from the sources (or any component with
 * no predecessors) along `nextComponents`, so sources sit first and sinks last.
 * Unreached components are appended in their original order.
 */
export function sortByMaterialFlow(components: DESComponent[]): DESComponent[] {
  const seen = new Set<DESComponent>();
  const ordered: DESComponent[] = [];
  const isStart = (c: DESComponent) =>
    kindOf(c) === 'source' || (c.previousComponents?.length ?? 0) === 0;
  const queue: DESComponent[] = components.filter(isStart);
  for (const c of queue) seen.add(c);
  while (queue.length) {
    const c = queue.shift()!;
    ordered.push(c);
    for (const n of c.nextComponents ?? []) {
      if (!seen.has(n) && components.includes(n)) { seen.add(n); queue.push(n); }
    }
  }
  for (const c of components) if (!seen.has(c)) ordered.push(c);
  return ordered;
}
