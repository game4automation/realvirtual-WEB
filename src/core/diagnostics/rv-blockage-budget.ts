// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** Structural model access keeps the resolver independent of Three and the viewer. */
export interface BudgetNode {
  name: string;
  parent: BudgetNode | null;
  userData: Record<string, any>;
}
export interface BlockageBudget {
  MaxWaitSec: number;
  MaxIdleSec: number;
  WarmupSec: number;
  ExpectedWaits: readonly string[];
  ExpectFlow: boolean;
  Severity: 'error' | 'warning' | 'info';
  Exempt: boolean;
  Scope: 'node' | 'subtree';
  SignalSuppress?: unknown;
  SignalBlockageFound?: unknown;
}
export const DEFAULT_BLOCKAGE_BUDGET: Readonly<BlockageBudget> = Object.freeze({
  MaxWaitSec: 60, MaxIdleSec: 120, WarmupSec: 30,
  ExpectedWaits: Object.freeze(['charge', 'setup', 'failure', 'empty']),
  ExpectFlow: false, Severity: 'warning', Exempt: false, Scope: 'subtree',
});
export interface ResolvedBudget extends BlockageBudget {
  budgetSource: string;
  sources: Readonly<Record<string, string>>;
  suppressed: boolean;
}
export function budgetNodePath(node: BudgetNode): string {
  const parts: string[] = [];
  for (let n: BudgetNode | null = node; n?.parent; n = n.parent) parts.push(n.name);
  return parts.reverse().join('/') || node.name;
}
export class BudgetResolver {
  constructor(private readonly options: {
    nodeForUnit?: (id: string) => BudgetNode | null | undefined;
    pathOf?: (node: BudgetNode) => string;
    defaults?: Partial<BlockageBudget>;
    readSignal?: (ref: unknown, node: BudgetNode) => boolean;
    budgetNodes?: () => readonly BudgetNode[];
    writeSignal?: (ref: unknown, node: BudgetNode, value: boolean, now: number) => void;
  } = {}) {}

  resolve(unit: string | BudgetNode, skipOwn = false): ResolvedBudget {
    const node = typeof unit === 'string' ? this.options.nodeForUnit?.(unit) : unit;
    const defaults = { ...DEFAULT_BLOCKAGE_BUDGET, ...this.options.defaults };
    const result: ResolvedBudget = { ...defaults, ExpectedWaits: [...defaults.ExpectedWaits],
      budgetSource: 'default', sources: {}, suppressed: false };
    const sources: Record<string, string> = {};
    const seen = new Set<string>();
    for (let current = node; current; current = current.parent) {
      const component = current.userData.realvirtual?.BlockageBudget as Partial<BlockageBudget> | undefined;
      if (!component || (skipOwn && current === node)) continue;
      const source = this.options.pathOf?.(current) ?? budgetNodePath(current);
      // Suppression and exemptions protect the entire subtree, even against child overrides.
      if (component.Exempt === true) result.Exempt = true;
      if (component.SignalSuppress && this.options.readSignal?.(component.SignalSuppress, current)) result.suppressed = true;
      if (current !== node && component.Scope === 'node') continue;
      for (const key of Object.keys(defaults) as (keyof BlockageBudget)[]) {
        if (key === 'Exempt' || key === 'SignalSuppress' || key === 'SignalBlockageFound') continue;
        const value: unknown = component[key];
        if (value === undefined || value === null || value === '' || seen.has(key)) continue;
        (result as unknown as Record<string, unknown>)[key] = Array.isArray(value) ? [...value] : value;
        sources[key] = source;
        seen.add(key);
      }
    }
    for (const key of Object.keys(defaults)) sources[key] ??= 'default';
    result.sources = sources;
    result.budgetSource = sources.MaxIdleSec;
    return result;
  }
  nodePath(unitId: string): string | undefined {
    const node = this.options.nodeForUnit?.(unitId);
    return node ? this.options.pathOf?.(node) ?? budgetNodePath(node) : undefined;
  }
  exemptSubtrees(): number {
    return (this.options.budgetNodes?.() ?? []).filter(node => {
      if (node.userData.realvirtual?.BlockageBudget?.Exempt !== true) return false;
      for (let parent = node.parent; parent; parent = parent.parent) {
        if (parent.userData.realvirtual?.BlockageBudget?.Exempt === true) return false;
      }
      return true;
    }).length;
  }
  expectFlow = (sink: { node: BudgetNode }): boolean => this.resolve(sink.node).ExpectFlow;
  /** Sample-time signal publication; each declaration owns its output, including clearing it. */
  publishFindings(unitIds: readonly string[], now: number): void {
    if (!this.options.writeSignal) return;
    const foundNodes = unitIds.map(id => this.options.nodeForUnit?.(id)).filter((n): n is BudgetNode => !!n);
    for (const node of this.options.budgetNodes?.() ?? []) {
      const component = node.userData.realvirtual?.BlockageBudget as Partial<BlockageBudget> | undefined;
      if (!component?.SignalBlockageFound) continue;
      const found = foundNodes.some(foundNode => {
        for (let current: BudgetNode | null = foundNode; current; current = current.parent) {
          if (current === node) return true;
          if (component.Scope === 'node') break;
        }
        return false;
      });
      this.options.writeSignal(component.SignalBlockageFound, node, found, now);
    }
  }
  isExpectedWait(budget: ResolvedBudget, kind: string): boolean {
    const normalized = kind.replace(/^fleet:/, '').toLowerCase();
    return budget.ExpectedWaits.some(k => k.replace(/^fleet:/, '').toLowerCase() === normalized);
  }
}
