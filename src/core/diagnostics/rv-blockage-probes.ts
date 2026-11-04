// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import type { ProgressEntry } from './rv-progress-ledger';
import type { WaitEdge } from './rv-wait-registry';
import type { BudgetResolver } from './rv-blockage-budget';

export type BlockageClass = 'deadlock' | 'stall';
export interface FindingCheck { name: string; ok: boolean; detail: string }
export interface BlockageFinding {
  readonly cls: BlockageClass;
  readonly chain: readonly string[];
  readonly cycles?: readonly (readonly string[])[];
  readonly waiterId: string;
  readonly idleSec: number;
  readonly progressCount: number;
  readonly budgetSource: string;
  readonly checks: readonly FindingCheck[];
  readonly nodePath?: string;
}
type Link = { to: string; edge: WaitEdge };
type Graph = Map<string, Link[]>;
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const edgeKey = (e: WaitEdge): string => JSON.stringify([e.waiterId, e.resourceId, e.kind,
  [...e.ownerIds].sort(), e.analysed, String(e.sinceSimSec), e.nodePath ?? '', e.notAnalysedReason ?? '']);
function graphOf(edges: readonly WaitEdge[]): Graph {
  const pairs = new Map<string, Map<string, WaitEdge>>();
  for (const edge of edges) {
    if (!edge.analysed) continue;
    if (!pairs.has(edge.waiterId)) pairs.set(edge.waiterId, new Map());
    for (const owner of edge.ownerIds) {
      if (!pairs.has(owner)) pairs.set(owner, new Map());
      const links = pairs.get(edge.waiterId)!;
      const previous = links.get(owner);
      if (!previous || compare(edge.resourceId, previous.resourceId) < 0 ||
        (edge.resourceId === previous.resourceId && compare(edgeKey(edge), edgeKey(previous)) < 0)) links.set(owner, edge);
    }
  }
  return new Map([...pairs].sort(([a], [b]) => compare(a, b)).map(([id, links]) =>
    [id, [...links].sort(([a], [b]) => compare(a, b)).map(([to, edge]) => ({ to, edge }))]));
}

/** Iterative Tarjan: component discovery is never subject to the cycle cap. */
function componentsOf(graph: Graph): string[][] {
  let serial = 0;
  const index = new Map<string, number>(), low = new Map<string, number>();
  const active = new Set<string>(), stack: string[] = [], result: string[][] = [];
  for (const start of graph.keys()) {
    if (index.has(start)) continue;
    const frames: { id: string; next: number }[] = [];
    const enter = (id: string) => {
      index.set(id, serial); low.set(id, serial++); stack.push(id); active.add(id);
      frames.push({ id, next: 0 });
    };
    enter(start);
    while (frames.length) {
      const frame = frames[frames.length - 1], links = graph.get(frame.id)!;
      if (frame.next < links.length) {
        const { to } = links[frame.next++];
        if (!index.has(to)) enter(to);
        else if (active.has(to)) low.set(frame.id, Math.min(low.get(frame.id)!, index.get(to)!));
        continue;
      }
      frames.pop();
      if (frames.length) {
        const parent = frames[frames.length - 1].id;
        low.set(parent, Math.min(low.get(parent)!, low.get(frame.id)!));
      }
      if (low.get(frame.id) === index.get(frame.id)) {
        const members: string[] = [];
        let id: string;
        do { id = stack.pop()!; active.delete(id); members.push(id); } while (id !== frame.id);
        members.sort(compare);
        if (members.length > 1 || graph.get(members[0])!.some(l => l.to === members[0])) result.push(members);
      }
    }
  }
  return result.sort((a, b) => compare(a[0], b[0]));
}
export interface CycleComponent {
  readonly members: readonly string[];
  readonly cycles: readonly (readonly string[])[];
  readonly truncated: boolean;
}
function enumerateComponent(graph: Graph, members: string[]): CycleComponent {
  const allowed = new Set(members), cycles: string[][] = [];
  let truncated = false;
  outer: for (const start of members) {
    const path = [start], resources: string[] = [], visited = new Set(path);
    const frames = [{ id: start, next: 0 }];
    while (frames.length) {
      const frame = frames[frames.length - 1], links = graph.get(frame.id)!;
      if (frame.next === links.length) {
        frames.pop(); visited.delete(path.pop()!); resources.pop(); continue;
      }
      const link = links[frame.next++];
      if (link.to === start) {
        if (cycles.length === 1000) { truncated = true; break outer; }
        const chain: string[] = [];
        path.forEach((id, i) => chain.push(id, i === path.length - 1 ? link.edge.resourceId : resources[i]));
        chain.push(start); cycles.push(chain);
      } else if (allowed.has(link.to) && link.to > start && !visited.has(link.to)) {
        path.push(link.to); resources.push(link.edge.resourceId); visited.add(link.to);
        frames.push({ id: link.to, next: 0 });
      }
    }
  }
  const key = (c: readonly string[]) => c.slice(0, -1).filter((_, i) => i % 2 === 0).join('\0') + '\u0001' + c.filter((_, i) => i % 2 === 1).join('\0');
  cycles.sort((a, b) => compare(key(a), key(b)));
  return { members, cycles, truncated };
}
export function enumerateCycles(edges: readonly WaitEdge[]): {
  cycles: readonly (readonly string[])[]; components: readonly CycleComponent[]; truncated: boolean;
} {
  const graph = graphOf(edges);
  const components = componentsOf(graph).map(members => enumerateComponent(graph, members));
  return { cycles: components.flatMap(c => c.cycles), components, truncated: components.some(c => c.truncated) };
}

export function probeBlockages(input: {
  candidates: readonly Readonly<ProgressEntry>[]; edges: readonly WaitEdge[]; budgets: BudgetResolver; now: number;
}): readonly BlockageFinding[] {
  const { budgets, now } = input;
  const edges = [...input.edges].sort((a, b) => compare(edgeKey(a), edgeKey(b)));
  const byWaiter = new Map<string, WaitEdge[]>();
  for (const edge of edges) { const list = byWaiter.get(edge.waiterId) ?? []; list.push(edge); byWaiter.set(edge.waiterId, list); }
  const eligible = new Map(input.candidates.filter(entry => {
    const b = budgets.resolve(entry.unitId);
    return entry.state === 'armed' && !b.Exempt && !b.suppressed && now >= b.WarmupSec &&
      now - entry.lastChangeSec >= b.MaxIdleSec && !(byWaiter.get(entry.unitId) ?? []).some(e => budgets.isExpectedWait(b, e.kind));
  }).map(e => [e.unitId, e]));
  const findings: BlockageFinding[] = [], cyclic = new Set<string>();
  const check = (name: string, ok: boolean, detail: string): FindingCheck => ({ name, ok, detail });
  for (const component of enumerateCycles(edges).components) {
    // A transient cycle is not an independent stall: wait for every member's
    // evidence. Otherwise one progressing member would turn a rejected
    // deadlock into a misleading stall for its older neighbour (plan 9.8).
    component.members.forEach(id => cyclic.add(id));
    if (!component.members.every(id => eligible.has(id))) continue;
    const memberSet = new Set(component.members);
    const internal = edges.filter(e => e.analysed && memberSet.has(e.waiterId) && e.ownerIds.some(id => memberSet.has(id)));
    const starts = internal.map(e => e.sinceSimSec).filter(Number.isFinite);
    // A wait can begin while approaching a resource, before a cycle forms.
    // The stable cycle cannot predate the last member movement. Restart its
    // observation window there rather than rejecting that component forever.
    const cycleStart = Math.max(...starts, ...component.members.map(id => eligible.get(id)!.lastChangeSec));
    if (component.members.some(id => now - cycleStart < budgets.resolve(id).MaxIdleSec)) continue;
    const first = eligible.get(component.members[0])!, budget = budgets.resolve(first.unitId);
    const checks = [check('cycle-length', true, `${component.members.length} members`),
      check('all-members-armed', true, component.members.join(', ')),
      check('no-member-progressed', true, `No member progress since ${cycleStart} s${starts.length < internal.length ? '; some wait starts unknown' : ''}`),
      check('budget-exceeded', true, 'Every member exceeded its idle budget')];
    if (component.truncated) checks.push(check('cycles-truncated', false, 'More than 1000 cycles; capped per component'));
    findings.push({ cls: 'deadlock', waiterId: first.unitId, chain: component.cycles[0], cycles: component.cycles,
      idleSec: Math.min(...component.members.map(id => now - eligible.get(id)!.lastChangeSec)), progressCount: first.count,
      budgetSource: budget.budgetSource, checks, ...(internal[0]?.nodePath ? { nodePath: internal[0].nodePath } : {}) });
  }
  for (const [id, entry] of [...eligible].sort(([a], [b]) => compare(a, b))) {
    if (cyclic.has(id)) continue;
    const budget = budgets.resolve(id), waits = byWaiter.get(id) ?? [], edge = waits[0];
    const checks: FindingCheck[] = [];
    if (edge) {
      for (const e of waits) {
        checks.push(check('wait-edge', true, `${e.resourceId}: ${e.kind}; since ${Number.isFinite(e.sinceSimSec) ? `${e.sinceSimSec} s` : 'unknown'}`),
          check('holders', true, [...e.ownerIds].sort().join(', ') || 'free'), check('edge-analysed', e.analysed, e.kind));
        if (!e.analysed) checks.push(check('edge-not-analysed', false,
          e.notAnalysedReason ?? (!e.waiterId ? 'holder-only' : 'capacity>1 | external-holder | holder-only')));
        checks.push(check('wait-budget-exceeded', Number.isFinite(e.sinceSimSec) && now - e.sinceSimSec >= budget.MaxWaitSec, `${budget.MaxWaitSec} s`));
      }
    } else checks.push(check('no-wait-edge', true, 'No wait edge reported'));
    checks.push(check('no-progress', true, `${entry.count}; idle ${now - entry.lastChangeSec} s`),
      check('budget-exceeded', true, `${budget.MaxIdleSec} s`));
    findings.push({ cls: 'stall', waiterId: id, chain: edge ? [id, edge.resourceId, ...[...edge.ownerIds].sort()] : [id],
      idleSec: now - entry.lastChangeSec, progressCount: entry.count, budgetSource: budget.budgetSource, checks,
      ...(edge?.nodePath ? { nodePath: edge.nodePath } : {}) });
  }
  return findings;
}
