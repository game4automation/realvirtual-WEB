// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2237 F3 — the take-wide time-command watch of the recording seam (`?recording=1` only).
 * Loaded together with the seam, never at startup (the demo entry chunk has a byte budget).
 */

import type { RVViewer } from '../rv-viewer';
import { commandRegistry } from '../hmi/rv-command-registry';

/** plan-2237: whether a command could run now, read WITHOUT executing it. */
export type CommandState = { known: false } | { known: true; enabled: boolean; reason: string | null };

/** A time-relevant dispatch seen anywhere (recorder, UI click, shortcut). */
export type TimeEvent = { id: string; phase: 'dispatch' | 'done'; ok?: boolean };

export type TimeWatch = ReturnType<typeof createTimeWatch>;

export function createTimeWatch(viewer: RVViewer) {
  let events: TimeEvent[] = [];
  let stop: (() => void) | undefined;
  return {
    /**
     * Watch the given command ids for the whole take, whoever dispatches them — the start
     * (`dispatchHook`) and the completion (`onExecuted`), so an asynchronous command's frames in
     * between are known even when a UI click or a shortcut started it.
     */
    armTimeWatch(ids: readonly string[]): void {
      stop?.();
      events = [];
      const wanted = new Set(ids);
      const hook = (id: string) => { if (wanted.has(id)) events.push({ id, phase: 'dispatch' }); };
      commandRegistry.dispatchHook = hook;
      const offStart = () => { if (commandRegistry.dispatchHook === hook) commandRegistry.dispatchHook = null; };
      const offDone = commandRegistry.onExecuted(({ id, result }) => {
        if (wanted.has(id)) events.push({ id, phase: 'done', ok: result.ok });
      });
      stop = () => { offStart(); offDone(); };
    },
    /**
     * plan-2237 F9: the registry's own verdict on a command — unknown, or `enabled()` with its reason —
     * so the recorder can name an unavailable or disabled command BEFORE it looks for its button.
     * Read-only: the implementation is preloaded, never run.
     */
    async commandState(id: string, args?: unknown): Promise<CommandState> {
      if (!commandRegistry.get(id)) return { known: false };
      await commandRegistry.preload([id]);
      const verdict = commandRegistry.enabled(id, args ?? {}, viewer);
      return verdict === true ? { known: true, enabled: true, reason: null } : { known: true, enabled: false, reason: verdict.reason };
    },
    /** Drains the events seen since the last call. */
    takeTimeWatch(): TimeEvent[] {
      const taken = events;
      events = [];
      return taken;
    },
  };
}
