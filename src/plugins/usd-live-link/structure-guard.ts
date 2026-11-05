// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * structure-guard — the live link's watch over the structure of the mounted
 * snapshot (plan-2239 Phase 3, § 2.6).
 *
 * Isaac Sim holds the hierarchy of the snapshot; every frame carries LOCAL
 * matrices per node index. A re-parent, rename, added or removed exported node
 * would put a matrix under the wrong USD parent, so any structural change
 * freezes the link (no frame, no MU spawn / delete of this generation) and
 * remounts once the changes settle.
 *
 * - {@link StructureGuard}: the per-sample check against the baseline the
 *   export captured in its own synchronous pass (`snapshot.structure`). CSR
 *   fast path, no allocation (`core/usd/structure-baseline.ts`).
 * - {@link StructureWatch}: its own interval (default 200 ms — independent of
 *   the rate gate, sending and the simulation, so a change while paused is
 *   seen too), the immediate check on `editor-structure-changed`, and the
 *   debounce. After the first detection it compares against the LAST OBSERVED
 *   state (re-captured on every detection), and every further change restarts
 *   the debounce: one editor drag = one remount.
 *
 * The session binds one watch to one mount generation and stops it on sync
 * off, model change / clear, dispose and every new generation.
 */

import type { Object3D } from 'three';
import {
  captureStructure,
  describeStructureChange,
  findStructureChange,
  type StructureBaseline,
  type StructureChange,
  type StructureFilter,
} from '../../core/usd/structure-baseline';
import { forEachStageMu, type ClassifiedMu, type StageMuHost } from '../../core/usd/collect-stage-input';

/** The part of an MU the guard reads (the stage's one MU classification). */
export type GuardMu = ClassifiedMu;

export interface StructureGuardConfig {
  /** Baseline captured with the export tree. */
  baseline: StructureBaseline;
  /** Same sets the export used. */
  exclude: ReadonlySet<Object3D>;
  templates: ReadonlySet<Object3D>;
  /** Pre-placed MU nodes of the snapshot (exported, never structural, parent not checked). */
  preplacedNodes: ReadonlySet<Object3D>;
  /**
   * Live MUs — active, pre-placed and their passive loads, walked by the same
   * {@link forEachStageMu} the collector used (spawned MUs come and go; never
   * structural). Return a stable object: it is read inside the check.
   */
  muHost(): StageMuHost;
}

export class StructureGuard {
  private ref: StructureBaseline;
  private readonly skipParent: Uint8Array;
  /** MU node → check stamp of the last MU refresh that saw it (no per-check Set). */
  private readonly muStamp = new WeakMap<Object3D, number>();
  private stamp = 0;
  private musAt = -1;
  /** Created once: the MU refresh allocates no closure. */
  private readonly stampMu = (mu: GuardMu): void => { this.muStamp.set(mu.node, this.stamp); };
  readonly filter: StructureFilter;

  constructor(private readonly cfg: StructureGuardConfig) {
    this.ref = cfg.baseline;
    const nodes = cfg.baseline.nodes;
    this.skipParent = new Uint8Array(nodes.length);
    for (let i = 0; i < nodes.length; i++) if (cfg.preplacedNodes.has(nodes[i])) this.skipParent[i] = 1;
    const preplaced = cfg.preplacedNodes;
    this.filter = {
      exclude: cfg.exclude,
      templates: cfg.templates,
      // Lazy: the live MU list is read only when a node's raw children differ.
      isMu: (o) => {
        if (this.musAt !== this.stamp) this.refreshMus();
        return this.muStamp.get(o) === this.stamp || preplaced.has(o);
      },
    };
  }

  /** The state the next check compares against. */
  get reference(): StructureBaseline { return this.ref; }

  /** First changed node index against the reference, or -1. Allocation-free. */
  checkIndex(): number {
    this.stamp++;
    return findStructureChange(this.ref, this.filter, this.skipParent);
  }

  /**
   * The change for the status line (diagnostics, only after a detection): a
   * re-parent / removal / rename anywhere wins over the child-count change it
   * causes at the (earlier) parent; otherwise the change at `index`.
   */
  describe(index: number): StructureChange {
    const { nodes, parentRef, names } = this.ref;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if ((n.parent !== parentRef[i] && this.skipParent[i] !== 1) || n.name !== names[i]) {
        return describeStructureChange(this.ref, this.filter, i, this.skipParent);
      }
    }
    return describeStructureChange(this.ref, this.filter, index, this.skipParent);
  }

  /** Make the current live state the reference ("last observed"). */
  rebase(): void {
    this.stamp++;
    this.ref = captureStructure(this.ref.nodes, this.filter);
  }

  /** Passive loads hang under their carrier's node and are not in the live list (plan-516). */
  private refreshMus(): void {
    this.musAt = this.stamp;
    forEachStageMu(this.cfg.muHost(), this.stampMu);
  }
}

/** Status-line form of a change: `re-parent: Gripper`. */
export function formatStructureChange(change: StructureChange): string {
  return `${change.kind}: ${change.name || '(unnamed)'}`;
}

export interface StructureWatchOptions {
  /** Interval of the own check timer, ms. */
  checkMs: number;
  /** Quiet time after the last detected change before {@link onSettled}, ms. */
  debounceMs: number;
  /** First detection: freeze the link now. */
  onChange(change: StructureChange): void;
  /** No further change for `debounceMs`: remount. The watch has stopped. */
  onSettled(): void;
}

export class StructureWatch {
  private interval: ReturnType<typeof setInterval> | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private changed = false;
  private stopped = false;

  constructor(private readonly guard: StructureGuard, private readonly opts: StructureWatchOptions) {}

  /** True once a change was detected (the link is frozen until the remount). */
  get hasChanged(): boolean { return this.changed; }
  get isStopped(): boolean { return this.stopped; }

  /** Start the own check timer. */
  start(): void {
    if (this.stopped || this.interval !== null) return;
    this.interval = setInterval(() => this.tick(), Math.max(1, this.opts.checkMs));
  }

  /** Check now (`editor-structure-changed`, the mount's own check points). True when changed. */
  checkNow(): boolean {
    this.tick();
    return this.changed;
  }

  /** Cancel the timers; nothing fires afterwards. */
  stop(): void {
    this.stopped = true;
    if (this.interval !== null) clearInterval(this.interval);
    if (this.debounce !== null) clearTimeout(this.debounce);
    this.interval = null;
    this.debounce = null;
  }

  private tick(): void {
    if (this.stopped) return;
    const i = this.guard.checkIndex();
    if (i < 0) return;
    const change = this.guard.describe(i);
    // From now on compare against what was just observed.
    this.guard.rebase();
    const first = !this.changed;
    this.changed = true;
    if (this.debounce !== null) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.settle(), Math.max(0, this.opts.debounceMs));
    if (first) this.opts.onChange(change);
  }

  private settle(): void {
    if (this.stopped) return;
    this.stop();
    this.opts.onSettled();
  }
}
