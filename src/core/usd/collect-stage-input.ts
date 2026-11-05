// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import type { Object3D } from 'three';
import type { LoadResult } from '../engine/rv-scene-loader';
import { getMuSource, type RVSource } from '../engine/rv-source';
import type { RuntimeStageInput } from './runtime-stage-export';

export type StageInputModel = Pick<LoadResult, 'root' | 'transportManager'> & Partial<Pick<LoadResult, 'registry'>>;

/**
 * Template table of a model: one entry per distinct MU template node, and the
 * index of every source. Keyed by the source OBJECT — two sources with the
 * same node name stay apart.
 */
export function buildTemplateTable(sources: readonly RVSource[]): {
  templates: Object3D[]; bySource: Map<RVSource, number>;
} {
  const templates: Object3D[] = [];
  const byNode = new Map<Object3D, number>();
  const bySource = new Map<RVSource, number>();
  for (const s of sources) {
    const t = s.muTemplate;
    if (!t) continue;
    let i = byNode.get(t);
    if (i === undefined) { i = templates.length; templates.push(t); byNode.set(t, i); }
    bySource.set(s, i);
  }
  return { templates, bySource };
}

/** Template index of a spawned MU (-1: unknown source or template not in the snapshot). */
export function templateIndexOfMu(mu: object, bySource: ReadonlyMap<RVSource, number>, templatePaths: readonly string[]): number {
  const src = getMuSource(mu);
  const i = src ? bySource.get(src) : undefined;
  return i === undefined || !templatePaths[i] ? -1 : i;
}

/** The part of an MU the stage classification reads. */
export interface ClassifiedMu {
  readonly node: Object3D;
  readonly isInstanced: boolean;
  /** Pre-placed MU = document node (plan-2229 S-Q6): exported, posed by id. */
  readonly preplaced?: boolean;
  /** Passive loads resting on this MU (attached to its node, not in the active list; plan-516). */
  readonly loadedMus?: readonly ClassifiedMu[];
}

/** The slice of the transport manager the stage classification reads. */
export interface StageMuHost {
  /** Active (ticked) MUs — passive loads are NOT in it. */
  readonly mus: readonly ClassifiedMu[];
  readonly preplacedMUs: readonly ClassifiedMu[];
}

/**
 * Visitor of {@link forEachStageMu}: the MU, whether it is pre-placed, and
 * whether it was reached as a passive load (through a carrier's `loadedMus`).
 */
export type StageMuVisitor = (mu: ClassifiedMu, preplaced: boolean, passive: boolean) => void;

/**
 * THE MU classification of the USD stage (plan-2239 § 2.3 / § 2.6): one walk
 * for the collector (what is excluded), the export baseline (via that exclude
 * set) and the live-link structure guard (what is an MU, never structure).
 * Visits every non-instanced MU of the active list, of the pre-placed list
 * and — recursively — every passive load hanging under a carrier (plan-516: a
 * load leaves the active list). Pre-placed = listed in `preplacedMUs` (visited
 * first) or flagged `mu.preplaced`; a node may be visited more than once, and
 * an unflagged pre-placed MU in the active list comes once more with `false`
 * (the collector keeps its own pre-placed set for that). Allocation-free.
 */
export function forEachStageMu(host: StageMuHost, visit: StageMuVisitor): void {
  visitStageMus(host.preplacedMUs, visit, true, false);
  visitStageMus(host.mus, visit, false, false);
}

function visitStageMus(mus: readonly ClassifiedMu[], visit: StageMuVisitor, listedPreplaced: boolean, passive: boolean): void {
  for (let i = 0; i < mus.length; i++) {
    const mu = mus[i];
    if (mu.isInstanced) continue; // pools are InstancedMesh → never exported, never structural
    visit(mu, listedPreplaced || mu.preplaced === true, passive);
    const loads = mu.loadedMus;
    if (loads && loads.length > 0) visitStageMus(loads, visit, false, true);
  }
}

/** An MU of the transmitted inventory: classified, with its id. */
export type InventoryMu = ClassifiedMu & { readonly id: number };

/** The host the inventory reads (the transport manager). */
export type InventoryHost<T extends InventoryMu> = StageMuHost & { readonly mus: readonly T[] };

/**
 * The MU inventory a live stage transmits (plan-2239 review): every active MU
 * (as listed, instanced pools included) plus — by the same
 * {@link forEachStageMu} — every passive load, deduplicated by MU id:
 * - a SPAWNED load is not in the snapshot (the collector excludes it) nor in the
 *   active list, so it would otherwise vanish in the receiver; it is spawned
 *   and posed like any spawned MU and keeps its id while it is loaded or
 *   unloaded (no delete, no second spawn);
 * - a PRE-PLACED load stays a document node (the receiver never spawns it); it
 *   is listed so the sampler's pre-placed path sends its world pose and it
 *   follows its carrier.
 *
 * Scene membership: a load is taken only while its node's parent chain ends in
 * the scene ({@link isInScene}, the rule the sampler applies to pre-placed
 * MUs). A carrier removed by `removeMU()` or a sink detaches its node — its
 * loads ride along out of the scene, drop out of the list and are deleted in
 * the receiver (a pre-placed one through the sampler's detached rule).
 *
 * {@link list} reuses one array (overwritten in place, never emptied: an
 * emptied array reallocates its store), one bound visitor and a per-MU stamp
 * (one MU object = one id; a `Set.clear()` would reallocate its table): no
 * allocation per sample once the sizes settled.
 */
export class LiveMuInventory<T extends InventoryMu = InventoryMu> {
  private readonly out: T[] = [];
  private n = 0;
  private stamp = 0;
  /** MU → stamp of the last list() that took it (dedup without a per-sample set). */
  private readonly seen = new WeakMap<object, number>();
  private readonly addLoad: StageMuVisitor = (mu, _preplaced, passive) => {
    if (!passive || this.seen.get(mu) === this.stamp || !isInScene(mu.node)) return;
    this.seen.set(mu, this.stamp);
    this.put(mu as T);
  };

  constructor(private readonly host: () => InventoryHost<T>) {}

  /** The current inventory (valid until the next call). */
  list(): readonly T[] {
    const host = this.host();
    const active = host.mus;
    this.n = 0;
    // Fast path: no carrier holds a load → exactly the active list, as before.
    if (!hasLoads(host)) {
      for (let i = 0; i < active.length; i++) this.put(active[i]);
    } else {
      const stamp = ++this.stamp;
      for (let i = 0; i < active.length; i++) {
        this.seen.set(active[i], stamp);
        this.put(active[i]);
      }
      forEachStageMu(host, this.addLoad);
    }
    const out = this.out;
    if (out.length > this.n) out.length = this.n;
    return out;
  }

  private put(mu: T): void {
    const out = this.out;
    if (this.n < out.length) out[this.n] = mu;
    else out.push(mu);
    this.n++;
  }
}

/**
 * True when `node`'s parent chain ends in a scene (`isScene`). Walks parents,
 * no allocation. Same rule as the sampler's "pre-placed MU detached" test.
 */
export function isInScene(node: Object3D): boolean {
  let o: Object3D = node;
  while (o.parent) o = o.parent;
  return (o as { isScene?: boolean }).isScene === true;
}

function hasLoads(host: StageMuHost): boolean {
  for (let i = 0; i < host.mus.length; i++) { const l = host.mus[i].loadedMus; if (l && l.length > 0) return true; }
  for (let i = 0; i < host.preplacedMUs.length; i++) { const l = host.preplacedMUs[i].loadedMus; if (l && l.length > 0) return true; }
  return false;
}

export function collectStageInput(model: StageInputModel, options: { timeline?: boolean } = {}): {
  input: RuntimeStageInput; templateIndexBySource: Map<RVSource, number>;
} {
  const tm = model.transportManager;
  const table = buildTemplateTable(tm.sources);
  const exclude = new Set<Object3D>();
  // Spawned MUs — active ones and passive loads alike — never go into the
  // snapshot; a pre-placed MU does (plan-2229 S-Q6), except on a timeline.
  const preplacedNodes = new Set<Object3D>();
  forEachStageMu(tm, ({ node }, preplaced) => {
    if (preplaced) preplacedNodes.add(node);
    if (!options.timeline && (preplaced || preplacedNodes.has(node))) return;
    exclude.add(node);
  });
  const preplaced = tm.preplacedMUs.map((mu) => ({ muId: mu.id, node: mu.node }));
  return {
    input: { root: model.root, templates: table.templates, exclude, preplaced, registry: model.registry },
    templateIndexBySource: table.bySource,
  };
}
