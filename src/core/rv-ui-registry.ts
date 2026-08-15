// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * UIPluginRegistry — Collects UI slot entries from plugins
 * and provides lookup by slot name.
 *
 * Reactive: supports useSyncExternalStore via subscribe/getSnapshot
 * so React re-renders when plugins are registered or unregistered.
 */

import type { UISlot, UISlotEntry } from './rv-ui-plugin';
import { modeContext } from './rv-mode-manager';

/** @internal — a registered slot plus the keys that keep its position stable. */
interface RegisteredSlot {
  /** The registry's OWN copy of the plugin's entry (never the plugin's object). */
  readonly entry: UISlotEntry;
  /** Monotonic registration sequence of the owning plugin (stable across re-register). */
  readonly seq: number;
  /** Declaration index within the plugin's own `slots` array. */
  readonly index: number;
}

export class UIPluginRegistry {
  private _slots: RegisteredSlot[] = [];
  private _version = 0;
  private _listeners = new Set<() => void>();
  /**
   * First-registration sequence per plugin ID (plan-435 §2.7 point 2).
   *
   * Kept ACROSS unregister/register so a plugin switched off and on again
   * lands back in its original position inside its `order` group instead of
   * behind everyone else on the same level. Never reused, never reset.
   */
  private _seqByPlugin = new Map<string, number>();
  private _nextSeq = 0;

  /** Notify all subscribers that the registry changed. */
  private _notify(): void {
    this._version++;
    for (const listener of this._listeners) listener();
  }

  /** Subscribe to registry changes (for useSyncExternalStore). */
  subscribe = (listener: () => void): (() => void) => {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  };

  /** Snapshot version (for useSyncExternalStore). */
  getSnapshot = (): number => this._version;

  /**
   * Register slot entries from a plugin (slots may be undefined).
   *
   * If the plugin declares `modes` (plan-198), each of its slot entries is
   * auto-gated to those modes' UI contexts: a `shownOnlyInAny: ['mode:<id>', …]`
   * rule is written into the entry's `visibilityRule`, and a `visibilityId` is
   * assigned if absent (HMIShell only applies a rule when `visibilityId` is
   * set). Plugins with no `modes` (shared) are untouched — backward compatible.
   *
   * Exactly what survives (the assignment below is a spread, not a merge):
   * - OTHER rule keys are PRESERVED — a pre-existing `shownOnlyIn`/`hiddenIn`
   *   on the entry survives and is AND-combined at evaluation time by
   *   `evaluateVisibilityRule`.
   * - A pre-existing `shownOnlyInAny` on the entry is REPLACED, not combined.
   *   The plugin's `modes` win outright; the entry's own OR-list is lost.
   *
   * This is the ONLY place where `modes` becomes UI visibility, and it never
   * reads `core` — see rv-plugin.ts `core?` and doc-ui-visibility.md.
   *
   * IDEMPOTENT (plan-435 §2.7): a second `register()` for the same plugin ID
   * replaces its entries instead of duplicating them — the user toggle calls
   * this every time a plugin is switched back on.
   *
   * NON-MUTATING (plan-435 §2.7 point 3): the plugin's own slot objects are
   * never touched. The registry normalises a shallow COPY of each entry, so
   * registering twice always starts from the plugin's pristine declaration
   * and a pre-existing `shownOnlyInAny` is not progressively overwritten in
   * the plugin's own data.
   */
  register(plugin: { id?: string; slots?: UISlotEntry[]; modes?: string[] }): void {
    if (!plugin.slots || plugin.slots.length === 0) return;
    const pluginId = (plugin as Record<string, unknown>).id as string | undefined;
    // Idempotency: drop whatever this plugin registered before.
    if (pluginId !== undefined) this.unregister(pluginId);
    const modeAny = plugin.modes && plugin.modes.length > 0
      ? plugin.modes.map((m) => modeContext(m))
      : null;
    plugin.slots.forEach((entry, i) => {
      const copy: UISlotEntry = { ...entry };
      copy.pluginId = pluginId ?? copy.pluginId;
      if (modeAny) {
        copy.visibilityRule = { ...copy.visibilityRule, shownOnlyInAny: modeAny };
        if (!copy.visibilityId) {
          copy.visibilityId = `mode-slot:${pluginId ?? 'unknown'}:${copy.slot}:${i}`;
        }
      }
      this._slots.push({ entry: copy, seq: this._seqFor(copy.pluginId), index: i });
    });
    this._sort();
    this._notify();
  }

  /**
   * Stable sequence number for a plugin ID. Assigned on first registration and
   * remembered forever, so a re-registered plugin keeps its relative position.
   * Anonymous entries (no ID at all) get a fresh sequence every time.
   */
  private _seqFor(pluginId: string | undefined): number {
    if (pluginId === undefined) return this._nextSeq++;
    let seq = this._seqByPlugin.get(pluginId);
    if (seq === undefined) {
      seq = this._nextSeq++;
      this._seqByPlugin.set(pluginId, seq);
    }
    return seq;
  }

  /** Sort by (order, seq, declaration index) — see `_seqByPlugin`. */
  private _sort(): void {
    this._slots.sort((a, b) => {
      const byOrder = (a.entry.order ?? 100) - (b.entry.order ?? 100);
      if (byOrder !== 0) return byOrder;
      if (a.seq !== b.seq) return a.seq - b.seq;
      return a.index - b.index;
    });
  }

  /** Remove all slot entries belonging to a plugin. */
  unregister(pluginId: string): void {
    const before = this._slots.length;
    this._slots = this._slots.filter((s) => s.entry.pluginId !== pluginId);
    if (this._slots.length !== before) this._notify();
  }

  /** All components registered for a given slot. */
  getSlotComponents(slot: UISlot): UISlotEntry[] {
    return this._slots.filter((s) => s.entry.slot === slot).map((s) => s.entry);
  }

  /** All settings-tab entries. */
  getSettingsTabs(): UISlotEntry[] {
    return this.getSlotComponents('settings-tab');
  }
}
