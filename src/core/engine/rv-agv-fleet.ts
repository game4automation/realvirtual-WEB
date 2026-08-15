// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-agv-fleet.ts — the LOW-LEVEL vehicle control surface (plan-921).
 *
 * The deliberately minimal per-vehicle primitive on which project-specific
 * fleet logic (work plans, order pools, charging strategies …) is built —
 * in a TypeScript project plugin, a JS-in-GLB script, or via MCP. The engine
 * ships NO fleet logic of its own (plan-268 F6): exactly one command shape:
 *
 *   task = { destination, serviceSec?, onArrive?, onServiceEnd?, data? }
 *
 * - `destination` — ANY path segment id; the vehicle routes there by shortest
 *   driving distance (`RVPathNetwork.nextHopToward`) and stops at its END.
 * - `serviceSec` — time at the destination ("Zeit am Ziel").
 * - `onArrive` — fired when the dwell STARTS (arrival at the destination end).
 * - `onServiceEnd` — fired when the dwell ENDS. Assigning the next task from
 *   inside this callback chains seamlessly (work-plan style); without a new
 *   task the vehicle goes IDLE and stays parked.
 *
 * Without any task a vehicle CRUISES (successors[0] forever — the pre-task
 * behavior, unchanged). A registered network router (central control) always
 * wins the junction decision over the mechanical shortest-path hop.
 *
 * The registry itself is dumb on purpose: Agv instances register a handle at
 * setup and remove it at teardown; project code enumerates/looks up handles
 * and assigns tasks. Callbacks run synchronously in the simulation tick (or
 * DES event) that completes the phase — schedule follow-up work through the
 * task API, not by blocking.
 */

export type AgvPhase = 'cruising' | 'driving' | 'servicing' | 'idle';

/** One vehicle command — see the module doc for the semantics. */
export interface AgvTask {
  /** Path id of the destination segment (the vehicle stops at its END). */
  destination: string;
  /** Dwell time at the destination in seconds (default 0 = touch-and-go). */
  serviceSec?: number;
  /** Fired at dwell START (arrival at the destination end). */
  onArrive?: (agvId: string, task: AgvTask) => void;
  /** Fired at dwell END — assign the next task here to chain a work plan. */
  onServiceEnd?: (agvId: string, task: AgvTask) => void;
  /** Free-form project payload (order id, station id, …). Not interpreted. */
  data?: unknown;
}

/** The per-vehicle control handle the Agv behavior registers. */
export interface AgvHandle {
  readonly id: string;
  /** Assign (or replace) the current task — takes effect at the next tick /
   *  path boundary; a driving vehicle re-routes at the next junction. */
  assign(task: AgvTask): void;
  /** Drop the task and return to free cruising (successors[0]). */
  clear(): void;
  /** The current task (null = cruising or idle without a task). */
  readonly task: AgvTask | null;
  /** Movement phase — 'idle' means parked after a completed task. */
  readonly phase: AgvPhase;
}

/** Dumb id-keyed handle registry + an idle notification channel. */
export class AgvFleet {
  private readonly handles = new Map<string, AgvHandle>();
  private readonly idleSubs = new Set<(agvId: string) => void>();

  register(handle: AgvHandle): void {
    this.handles.set(handle.id, handle);
  }

  unregister(id: string): void {
    this.handles.delete(id);
  }

  get(id: string): AgvHandle | null {
    return this.handles.get(id) ?? null;
  }

  all(): AgvHandle[] {
    return [...this.handles.values()];
  }

  /**
   * Subscribe to "vehicle became idle" (task completed, no follow-up task) —
   * the minimal dispatch trigger for project fleet logic. Returns the
   * unsubscribe function.
   */
  onIdle(cb: (agvId: string) => void): () => void {
    this.idleSubs.add(cb);
    return () => this.idleSubs.delete(cb);
  }

  /** Called by the Agv behavior when a vehicle enters the idle phase. */
  notifyIdle(agvId: string): void {
    for (const cb of this.idleSubs) {
      try { cb(agvId); } catch (e) { console.error('[agv-fleet] onIdle subscriber failed:', e); }
    }
  }

  /** Test/model-cleared reset: drop every handle and subscriber. */
  clear(): void {
    this.handles.clear();
    this.idleSubs.clear();
  }
}

const defaultFleet = new AgvFleet();

/** The shared fleet registry (project plugins / scripts / MCP control it). */
export function getDefaultAgvFleet(): AgvFleet {
  return defaultFleet;
}
