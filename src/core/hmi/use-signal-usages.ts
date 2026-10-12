// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * use-signal-usages.ts — the HMI side of the signal cross-reference list (plan-566).
 *
 * The engine's `SignalUsageService` (`viewer.signalUsage`) knows components,
 * logic steps, operator panels and the PLC seam. The three sources that live
 * ABOVE the engine are wired here, once per viewer, by the first consumer:
 *
 *  - `bindings`        — the binding inventory (incl. orphaned links); the
 *                        listener follows the per-model binding manager;
 *  - `connect-bridges` — CONNECT 1:1 mappings and mirror rules from the
 *                        connect-store cache (loaded on demand while connected);
 *  - `scene-store`     — no usages of its own: every committed SceneStore
 *                        change (setField, add/remove node, undo / redo)
 *                        invalidates the index (R4).
 *
 * Plus the hooks the UI reads and the one navigation rule every surface uses.
 */

import { useSyncExternalStore } from 'react';
import type { RVViewer } from '../rv-viewer';
import type { SignalBindingManager } from '../engine/rv-signal-binding-manager';
import {
  collectBindingUsages,
  collectConnectBridgeUsages,
  type SignalUsage,
  type SignalUsageService,
} from '../engine/rv-signal-usage-index';
import { collectBindingInventory } from '../../plugins/signal-bind/binding-inventory';
import {
  getConnectBridges,
  getConnectSnapshot,
  reloadConnectBridges,
  requestConnectBridgeReveal,
  subscribeConnectBridges,
  subscribeConnectStore,
} from './connect-store';
import { getSceneStore } from './scene/scene-store-singleton';
import { getPlcNavigation } from '../plc-control';
import { navigateToRef } from './rv-reference-display';
import { getStoredConnectPanelWidth } from './layout-constants';

const EMPTY: readonly SignalUsage[] = Object.freeze([]);

/** The viewer slice this module needs (structural, so test viewers can provide it). */
type UsageViewer = Pick<RVViewer, 'signalUsage'> & Partial<Pick<RVViewer, 'signalBindingManager' | 'signalStore' | 'leftPanelManager'>>;

const wired = new WeakSet<SignalUsageService>();

/**
 * Registers the HMI-level providers on the viewer's usage service. Idempotent;
 * every consumer (hooks, MCP tool) calls it before reading.
 */
export function ensureSignalUsageWiring(viewer: UsageViewer | null | undefined): SignalUsageService | null {
  const service = viewer?.signalUsage;
  if (!service) return null;
  if (wired.has(service)) return service;
  wired.add(service);

  // Bindings — the manager is recreated per model, so the listener follows it.
  let manager: SignalBindingManager | null = null;
  let offManager: (() => void) | null = null;
  service.registerProvider('bindings', {
    collect: (sink) => {
      const current = viewer!.signalBindingManager ?? null;
      if (current !== manager) {
        offManager?.();
        manager = current;
        offManager = current ? current.addBindingsChangedListener(() => service.invalidate()) : null;
      }
      if (!current) return;
      collectBindingUsages(collectBindingInventory(viewer as RVViewer), sink);
    },
  }, () => () => { offManager?.(); offManager = null; manager = null; });

  // CONNECT bridges — the cache is loaded on demand while connected.
  service.registerProvider('connect-bridges', {
    collect: (sink) => {
      const snap = getConnectSnapshot();
      const bridges = getConnectBridges();
      if (snap.state === 'connected' && !bridges.loaded) void reloadConnectBridges();
      collectConnectBridgeUsages(bridges, snap.interfaces, sink);
    },
  }, (onChange) => {
    let interfaces = getConnectSnapshot().interfaces;
    const offStore = subscribeConnectStore(() => {
      const next = getConnectSnapshot().interfaces;
      if (next === interfaces) return; // status polls change the snapshot constantly — only the signal lists matter
      interfaces = next;
      onChange();
    });
    const offBridges = subscribeConnectBridges(onChange);
    return () => { offStore(); offBridges(); };
  });

  // SceneStore — every committed op (incl. undo / redo) invalidates. The store
  // may be created after the first consumer, so the subscription is retried at build time.
  let offScene: (() => void) | null = null;
  let sceneStore: unknown = null;
  service.registerProvider('scene-store', {
    collect: () => {
      const store = getSceneStore();
      if (!store || store === sceneStore) return;
      offScene?.();
      sceneStore = store;
      offScene = store.subscribe(() => service.invalidate());
    },
  }, () => () => { offScene?.(); offScene = null; sceneStore = null; });

  return service;
}

const noopSubscribe = (): (() => void) => () => {};
const zero = (): number => 0;

/** Re-renders on every usage-index change; returns the current version (0 without a service). */
export function useSignalUsageVersion(viewer: UsageViewer | null | undefined): number {
  const service = ensureSignalUsageWiring(viewer);
  return useSyncExternalStore(service ? service.subscribe : noopSubscribe, service ? service.getVersion : zero);
}

/** Usages of one signal, live. `[]` without a viewer, a service or a name. */
export function useSignalUsages(viewer: UsageViewer | null | undefined, name: string | null | undefined): readonly SignalUsage[] {
  useSignalUsageVersion(viewer);
  const service = viewer?.signalUsage;
  if (!service || !name) return EMPTY;
  return service.usages(name);
}

/** Number of usages of one signal, live. */
export function useSignalUsageCount(viewer: UsageViewer | null | undefined, name: string | null | undefined): number {
  return useSignalUsages(viewer, name).length;
}

/** The signal name a node path registers, or null when the node is not a signal. */
export function signalNameForPath(viewer: Partial<Pick<RVViewer, 'signalStore'>> | null | undefined, path: string | null | undefined): string | null {
  const store = viewer?.signalStore;
  if (!store || !path) return null;
  return store.exactNameForPath(path) ?? store.nameForPath(path) ?? null;
}

/** True when a click on the usage can go somewhere (R2: PLC only with the PLC plugin). */
export function isSignalUsageNavigable(usage: SignalUsage): boolean {
  switch (usage.kind) {
    case 'plc-program':
      return !!usage.plcProgramPath && usage.line !== undefined && getPlcNavigation() !== null;
    case 'connect-mapping':
      return !!usage.connectBridgeKey;
    default:
      return !!usage.nodePath;
  }
}

/**
 * Jumps to a usage: the node (hierarchy + inspector) for component fields,
 * logic steps, operator panels and bindings; the PLC editor at the line for an
 * ST usage; the CONNECT panel at the bridge row for a CONNECT bridge.
 */
export function navigateToSignalUsage(viewer: RVViewer | null, usage: SignalUsage): void {
  if (!viewer || !isSignalUsageNavigable(usage)) return;
  if (usage.kind === 'plc-program') {
    getPlcNavigation()?.revealLine(usage.plcProgramPath!, usage.line!);
    return;
  }
  if (usage.kind === 'connect-mapping') {
    viewer.leftPanelManager?.open('connect', getStoredConnectPanelWidth());
    requestConnectBridgeReveal(usage.connectBridgeKey!);
    return;
  }
  navigateToRef(viewer, usage.nodePath!);
}
