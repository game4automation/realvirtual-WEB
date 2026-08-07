// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-path-network.ts — the path segment graph (plan-268 Phase 1).
 *
 * Registry of all `RVPath` routes plus the id-based graph resolution
 * (`successorIds` → `successors` / `predecessors`) and the `selectNextPath`
 * hook dispatch used by the traveler at a path end.
 *
 * The routing hook is DELIBERATELY id-based (`candidateIds: string[]` in,
 * chosen id out) — host objects never cross the hook boundary, so the same
 * signature carries over the QuickJS/ScriptHost value boundary unchanged
 * (plan-268 §2.4 S1). Default routing without a hook: `candidateIds[0]`
 * (plain pass-through).
 *
 * Phase 6 — network-level ROUTER: besides the per-traveler hook (tests /
 * native TS projects, takes precedence) the network carries ONE optional
 * {@link PathNetworkRouter} — the registration target for project scripts
 * (JS-in-GLB `routing.*` handlers, wired by the web-component registry via
 * the SDK routing backend, rv-sdk-paths.ts). It adds two notification
 * channels next to `selectNextPath`:
 *  - `onArrive(pathId, travelerId)` — every completed path end (forward
 *    hand-off + dead-end stop; identical in continuous and DES mode);
 *  - `requestDispatch(travelerId)` — a traveler went idle at a path end
 *    WITHOUT a successor (dead end, forward travel). Fired once per stop —
 *    the minimal dispatch trigger for project fleet logic (plan-268 F6).
 * All dispatches are allocation-free when no router is registered.
 */

import type { RVPath } from './rv-path';

/** Context handed to a `selectNextPath` hook — plain values only (S1). */
export interface SelectNextPathContext {
  /** Id of the traveler (AGV) asking for a route. */
  travelerId: string;
  /** Id of the path whose end was reached. */
  currentPathId: string;
  /** Travel direction: 1 = forward (successors), -1 = backward (predecessors). */
  direction: 1 | -1;
}

/**
 * Project-injectable routing hook (TS-side in Phase 1): pick one of the
 * candidate path ids. Return value outside `candidateIds` (or undefined)
 * falls back to `candidateIds[0]` — the component guarantees mechanics only,
 * routing logic stays project code (plan-268 F6).
 */
export type SelectNextPathHook = (
  candidateIds: string[],
  ctx: SelectNextPathContext,
) => string | undefined;

/**
 * Network-level project router (plan-268 Phase 6). All signatures are
 * id-based plain values (S1) — the SAME object shape a QuickJS script's
 * `routing.*` handlers produce after the host-side callHandler wrap.
 * Per-traveler hooks (`PathTraveler.hooks.selectNextPath`) take precedence
 * over the router's `selectNextPath`.
 */
export interface PathNetworkRouter {
  /** Routing at a path end — see {@link SelectNextPathHook}. */
  selectNextPath?: SelectNextPathHook;
  /** A traveler completed `pathId` (forward hand-off or dead-end stop). */
  onArrive?: (pathId: string, travelerId: string) => void;
  /** A traveler is idle at a dead end (path end without successor). */
  requestDispatch?: (travelerId: string) => void;
}

/**
 * Path graph: id-keyed registry + successor/predecessor resolution.
 * The scene loader's `RVPathComponent` registers into {@link defaultPathNetwork};
 * tests may construct their own isolated network.
 */
export class RVPathNetwork {
  private readonly paths = new Map<string, RVPath>();
  private dirty = false;
  /** The ONE registered project router (null = default routing). */
  private router: PathNetworkRouter | null = null;
  private routerOwner: string | null = null;

  /** Number of registered paths. */
  get size(): number {
    return this.paths.size;
  }

  /** Register (or replace) a path. Marks the graph for re-resolution. */
  register(path: RVPath): void {
    this.paths.set(path.id, path);
    this.dirty = true;
  }

  /** Remove a path by id. Marks the graph for re-resolution. */
  unregister(id: string): void {
    if (this.paths.delete(id)) this.dirty = true;
  }

  /** Look up a path by id (null when unknown). */
  get(id: string): RVPath | null {
    return this.paths.get(id) ?? null;
  }

  /** All registered paths (iteration order = registration order). */
  all(): RVPath[] {
    return [...this.paths.values()];
  }

  /** Drop every path AND the registered router (model-cleared / test reset —
   *  a router from a previous model must never route the next one). */
  clear(): void {
    this.paths.clear();
    this.dirty = false;
    this.router = null;
    this.routerOwner = null;
  }

  // ── Project router (plan-268 Phase 6) ────────────────────────────────────

  /** True while a project router is registered. */
  get hasRouter(): boolean {
    return this.router !== null;
  }

  /**
   * Register THE project router (one at a time — a second registration from a
   * different owner replaces the first with a warning; project scripts should
   * declare routing handlers in exactly one component). Returns an
   * unregister function that only removes THIS registration (identity-checked
   * — safe across hot-reload replace-then-dispose orderings).
   */
  setRouter(router: PathNetworkRouter, owner = 'router'): () => void {
    if (this.router !== null && this.routerOwner !== owner) {
      console.warn(
        `[rv-path-network] router '${owner}' replaces the router registered by ` +
          `'${this.routerOwner}' — only one project router is active at a time`,
      );
    }
    this.router = router;
    this.routerOwner = owner;
    return () => {
      if (this.router === router) {
        this.router = null;
        this.routerOwner = null;
      }
    };
  }

  /** Notify the router of a completed path end. Allocation-free without a router. */
  notifyArrive(pathId: string, travelerId: string): void {
    this.router?.onArrive?.(pathId, travelerId);
  }

  /** Notify the router that `travelerId` idles at a dead end (dispatch trigger). */
  requestDispatch(travelerId: string): void {
    this.router?.requestDispatch?.(travelerId);
  }

  /**
   * (Re)link `successors` / `predecessors` from the id-based `successorIds`.
   * Idempotent + lazy: no-op until a register/unregister marked the graph
   * dirty. Dangling successor ids are tolerated (skipped) — the referenced
   * path may simply not be loaded (yet).
   */
  resolveGraph(): void {
    if (!this.dirty) return;
    this.dirty = false;
    for (const p of this.paths.values()) {
      p.successors.length = 0;
      p.predecessors.length = 0;
    }
    for (const p of this.paths.values()) {
      for (const id of p.successorIds) {
        const s = this.paths.get(id);
        if (!s) continue; // dangling id — tolerated, no crash
        p.successors.push(s);
        s.predecessors.push(p);
      }
    }
  }

  /** Candidate ids at a path end for the given travel direction. */
  candidateIds(path: RVPath, direction: 1 | -1): string[] {
    this.resolveGraph();
    const linked = direction === 1 ? path.successors : path.predecessors;
    return linked.map((p) => p.id);
  }

  /** Number of candidates at a path end — allocation-free (hot-path checks). */
  candidateCount(path: RVPath, direction: 1 | -1): number {
    this.resolveGraph();
    return (direction === 1 ? path.successors : path.predecessors).length;
  }

  /**
   * The next path after `path` in `direction`, dispatched through the
   * optional `selectNextPath` hook (default `candidateIds[0]`). The
   * per-traveler `hook` takes precedence; without one the registered project
   * ROUTER's `selectNextPath` is consulted (plan-268 Phase 6). Null at a
   * dead end (no candidates) — never throws, never returns undefined paths.
   * The hook-less, router-less default is allocation-free (called per tick
   * from the Phase-2 look-ahead walks — no GC in the tick).
   */
  next(
    path: RVPath,
    direction: 1 | -1,
    hook: SelectNextPathHook | undefined,
    travelerId: string,
  ): RVPath | null {
    this.resolveGraph();
    const linked = direction === 1 ? path.successors : path.predecessors;
    if (linked.length === 0) return null;
    let chosen = linked[0];
    if (!hook) hook = this.router?.selectNextPath;
    if (hook) {
      // The id arrays cross the hook boundary by design (plan-268 §2.4 S1) —
      // allocation is confined to the hook path.
      const candidates = linked.map((p) => p.id);
      const picked = hook([...candidates], {
        travelerId,
        currentPathId: path.id,
        direction,
      });
      if (typeof picked === 'string' && candidates.includes(picked)) {
        chosen = this.paths.get(picked) ?? chosen;
      }
      // else: invalid/undefined pick → defensive default candidates[0]
    }
    return chosen;
  }
}

/** The shared network the scene loader's Path components register into. */
export const defaultPathNetwork = new RVPathNetwork();

/** Accessor for the shared network (symmetry with other engine singletons). */
export function getDefaultPathNetwork(): RVPathNetwork {
  return defaultPathNetwork;
}
