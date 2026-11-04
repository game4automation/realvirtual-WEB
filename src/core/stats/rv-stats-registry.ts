// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** Viewer-owned statistics contributions; React is a type-only dependency. */
import type { ComponentType } from 'react';
import type { RVViewer } from '../rv-viewer';
import { loadStatsHubSetting, saveStatsHubSetting } from './stats-hub-store';

export interface StatsRow {
  /** Unique within this section. */
  key: string;
  label: string;
  value: number | string | null;
  unit?: string;
  /** Optional group name; enables the hub's grouping control. */
  group?: string;
  owner?: string;
}
export interface StatsSetting {
  /** Globally unique persistence key, for example 'des.badges'. */
  id: string;
  label: string;
  get: () => boolean;
  set: (on: boolean) => void;
  subscribe?: (cb: () => void) => () => void;
  /** Defaults to true. False leaves persistence entirely to the contributor. */
  persist?: boolean;
}
export interface StatsSectionBodyProps { viewer: RVViewer; active: boolean }
export interface StatsSectionSpec {
  id: string;
  title: string;
  /** One-line caption at the top of the section, e.g. what the values mean or where they come from. */
  description?: string;
  order?: number;
  owner?: string;
  isAvailable?: () => boolean;
  /** Notify when availability may have changed, including while the hub is closed. */
  subscribe?: (cb: () => void) => () => void;
  Body?: ComponentType<StatsSectionBodyProps>;
  rows?: () => readonly StatsRow[];
  settings?: readonly StatsSetting[];
}

/** Inject a memory store for hosts without browser storage. */
export interface StatsSettingsStore {
  loadSetting(id: string): boolean | undefined;
  saveSetting(id: string, value: boolean): void;
}
interface Entry {
  spec: StatsSectionSpec;
  sequence: number;
  available: boolean;
  unsubscribe?: () => void;
}

/** Registration surface available to statistics contributors. */
export interface StatsSectionRegistrar {
  register(spec: StatsSectionSpec): () => void;
}

export class StatsRegistry implements StatsSectionRegistrar {
  private entries = new Map<string, Entry>();
  private listeners = new Set<() => void>();
  private sequence = 0;
  private version = 0;

  constructor(private readonly settingsStore: StatsSettingsStore = {
    loadSetting: loadStatsHubSetting, saveSetting: saveStatsHubSetting,
  }) {}

  readonly subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  };
  readonly getSnapshot = (): number => this.version;

  private notify(): void {
    this.version++;
    for (const listener of this.listeners) listener();
  }

  private reapply(entry: Entry): void {
    for (const setting of entry.spec.settings ?? []) {
      if (!entry.available || this.entries.get(entry.spec.id) !== entry || !(entry.spec.isAvailable?.() ?? true)) break;
      if (setting.persist === false) continue;
      const value = this.settingsStore.loadSetting(setting.id);
      if (value !== undefined) setting.set(value);
    }
  }

  /** Exactly one body source; replacing an ID invalidates its old unregister. */
  register(spec: StatsSectionSpec): () => void {
    if (!!spec.Body === !!spec.rows) throw new Error('A statistics section requires exactly one of Body or rows');
    this.entries.get(spec.id)?.unsubscribe?.();
    const entry: Entry = { spec, sequence: this.sequence++, available: spec.isAvailable?.() ?? true };
    this.entries.set(spec.id, entry);
    const check = () => {
      if (this.entries.get(spec.id) !== entry) return;
      const available = spec.isAvailable?.() ?? true;
      if (available === entry.available) return;
      entry.available = available;
      if (available) this.reapply(entry);
      this.notify();
    };
    if (entry.available) this.reapply(entry);
    entry.unsubscribe = spec.subscribe?.(check);
    check();
    this.notify();
    return () => {
      if (this.entries.get(spec.id) !== entry) return;
      this.entries.delete(spec.id);
      entry.unsubscribe?.();
      this.notify();
    };
  }

  list(): readonly StatsSectionSpec[] {
    return [...this.entries.values()]
      .sort((a, b) => (a.spec.order ?? 100) - (b.spec.order ?? 100) || a.sequence - b.sequence)
      .map(entry => entry.spec);
  }
  available(): readonly StatsSectionSpec[] {
    return this.list().filter(spec => spec.isAvailable?.() ?? true);
  }

  /** UI changes use the same persistence seam as availability re-application. */
  setSetting(section: StatsSectionSpec, setting: StatsSetting, value: boolean): void {
    const entry = this.entries.get(section.id);
    if (entry?.spec !== section || !entry.available || !(section.isAvailable?.() ?? true)) return;
    setting.set(value);
    if (setting.persist !== false) this.settingsStore.saveSetting(setting.id, value);
  }
}

/** A registration scope whose sections can be cleared without clearing the base registry. */
export class ScopedStatsRegistry implements StatsSectionRegistrar {
  private readonly unregisters = new Set<() => void>();

  constructor(private readonly base: StatsRegistry) {}

  /** Forward to the base registry and track an idempotent unregister. */
  register(spec: StatsSectionSpec): () => void {
    const unregisterBase = this.base.register(spec);
    const unregister = () => {
      if (!this.unregisters.delete(unregister)) return;
      unregisterBase();
    };
    this.unregisters.add(unregister);
    return unregister;
  }

  /** Unregister every section recorded in this scope. */
  clear(): void {
    for (const unregister of this.unregisters) unregister();
  }

  /** Number of unregister handles still recorded in this scope. */
  get size(): number { return this.unregisters.size; }
}

let activeRegistry: StatsSectionRegistrar | null = null;
/** Active slot for future component context construction. */
export function setActiveStatsRegistry(registry: StatsSectionRegistrar | null): void { activeRegistry = registry; }
export function getActiveStatsRegistry(): StatsSectionRegistrar | null { return activeRegistry; }
