// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * InstructionRuntimeStore — central registry of active runtime instructions.
 *
 * Single source of truth for which CustomRuntimeInstruction cards are currently
 * shown. RVCustomRuntimeInstruction components report into it (`setActive`); the
 * instruction panel reads from it (`getActive` / `subscribe`,
 * useSyncExternalStore-compatible).
 *
 * Modeled on ErrorStore (rv-error-store.ts), but each entry carries a multi-step
 * payload (instruction text + optional camera target + optional doc URL per step)
 * and an explicit `dismissed` flag — a dismissed entry stays in the map (so a
 * signal that is still high doesn't immediately re-show it) but is filtered out of
 * `getActive()`. The owning component resets `dismissed` on the next rising edge.
 *
 * Lifecycle: instantiated once per RVViewer (a singleton that survives model
 * loads). Emptied on model switch via the panel plugin's `onModelCleared` hook
 * (`clear()`), NOT via per-component dispose chains.
 */

/** A single step of an instruction card. */
export interface InstructionStep {
  /** Instruction text shown for this step. */
  instruction: string;
  /** Node path of the FIRST target (View button focus / legacy single-target).
   *  Kept for backward compatibility — prefer `targetPaths` for multi-target. */
  targetPath: string | null;
  /** Node paths of ALL targets highlighted in parallel for this step.
   *  Empty when the step has no target. `targetPath` mirrors `targetPaths[0]`. */
  targetPaths: string[];
  /** Document/URL opened by the URL button, or null when absent. */
  url: string | null;
  /**
   * Subset of `targetPaths` for which no node exists in the loaded model
   * (plan-734 F6). Resolved ONCE in the component's `onSceneReady`, which is
   * the first moment the registry is final — after alias registration AND after
   * kinematic re-parenting has moved whatever it moves.
   *
   * Optional so the many hand-built `InstructionStep` literals across the
   * codebase and its tests stay valid; `undefined` means "not resolved", which
   * the card renders exactly like "nothing missing".
   *
   * Deliberately NOT re-resolved later: if the layout planner places the
   * missing asset after the load, the step stays marked. A model switch runs
   * `init()` + `onSceneReady()` afresh and gets it right there.
   */
  unresolvedTargetPaths?: string[];
}

/** An active (or dismissed-but-still-signalled) instruction entry, keyed by node path. */
export interface InstructionEntry {
  /** Node path of the owning component (the registry key). */
  path: string;
  /** Instruction type — drives title, icon and color in the panel. */
  type: 'info' | 'maintenance' | 'warning' | 'error' | 'success';
  /** Whether the user may close the card via a close button. */
  dismissible: boolean;
  /** When true, clicking the message isolates the step's targets (web only). */
  isolate: boolean;
  /** True once the user dismissed it — filtered out of getActive() until reset. */
  dismissed: boolean;
  /** Ordered steps to display. */
  steps: InstructionStep[];
  /** Activation timestamp (performance-time) — used for chronological sort. */
  since: number;
  /** Wall-clock activation time (Date.now() ms) — shown as time/date on the card. */
  at: number;
}

export class InstructionRuntimeStore {
  /** path → entry. Holds active AND dismissed-but-signalled entries. */
  private _entries = new Map<string, InstructionEntry>();
  private _listeners = new Set<() => void>();
  /** Cached sorted snapshot of NON-dismissed entries (stable identity for React). */
  private _snapshot: InstructionEntry[] = [];
  private _snapshotDirty = true;

  /**
   * Register/update an instruction entry as active (rising edge / static show).
   * Replaces any existing entry for the same path. Always clears `dismissed`
   * (a fresh activation un-dismisses). Notifies subscribers.
   */
  setActive(path: string, entry: InstructionEntry): void {
    const next: InstructionEntry = {
      ...entry,
      path,
      dismissed: false,
      since: entry.since || performance.now(),
    };
    this._entries.set(path, next);
    this._snapshotDirty = true;
    this._notify();
  }

  /** Remove a single entry (falling edge / dispose). No-op if absent. */
  remove(path: string): void {
    if (!this._entries.has(path)) return;
    this._entries.delete(path);
    this._snapshotDirty = true;
    this._notify();
  }

  /**
   * Mark an entry dismissed (user closed the card). The entry stays in the map
   * so a still-high signal does not immediately re-show it; it is filtered out of
   * getActive(). No-op if absent or already dismissed.
   */
  dismiss(path: string): void {
    const existing = this._entries.get(path);
    if (!existing || existing.dismissed) return;
    existing.dismissed = true;
    this._snapshotDirty = true;
    this._notify();
  }

  /** Remove all entries (e.g. on model switch). Notifies only if non-empty. */
  clear(): void {
    if (this._entries.size === 0) return;
    this._entries.clear();
    this._snapshotDirty = true;
    this._notify();
  }

  /** Active (non-dismissed) entries, sorted chronologically (oldest first). */
  getActive = (): InstructionEntry[] => {
    if (this._snapshotDirty) {
      this._snapshot = Array.from(this._entries.values())
        .filter((e) => !e.dismissed)
        .sort((a, b) => a.since - b.since);
      this._snapshotDirty = false;
    }
    return this._snapshot;
  };

  /** Raw entry by path (test/inspection helper — includes dismissed entries). */
  getEntry(path: string): InstructionEntry | undefined {
    return this._entries.get(path);
  }

  /** Number of currently active (non-dismissed) entries. */
  getCount(): number {
    return this.getActive().length;
  }

  /** Subscribe to list changes. Returns an unsubscribe function. */
  subscribe = (cb: () => void): (() => void) => {
    this._listeners.add(cb);
    return () => {
      this._listeners.delete(cb);
    };
  };

  private _notify(): void {
    for (const cb of this._listeners) cb();
  }
}
