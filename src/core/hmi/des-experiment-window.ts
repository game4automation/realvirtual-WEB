// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Opener registry of the DES experiment window (plan-2211 G5/S9). The core "Experiments"
 * buttons ask the registered provider; without one they show `CommercialFeatureNotice`.
 * Re-exported by `plugins/des/des-experiment-seam.ts`.
 */
/**
 * Open state of the experiment window as the core button shows it. `ready` is true once the
 * window's chunk is loaded: the memoized host re-renders only on a changed snapshot, so a window
 * opened before its chunk arrived needs this change to appear.
 */
export interface DesExperimentWindowState { readonly open: boolean; readonly error?: string; readonly ready?: boolean }
/**
 * Opens the experiment manager window. Registered by the commercial module; the core
 * "Experiments" button asks it on click and shows `CommercialFeatureNotice` when none is
 * registered. `Host` is mounted once by the DES toolbar and renders the window (its own chunk).
 */
export interface DesExperimentWindowProvider {
  toggle(): void;
  subscribe(listener: () => void): () => void;
  /** Must return the same object until the state changes (useSyncExternalStore). */
  getState(): DesExperimentWindowState;
  Host?: import('react').ComponentType<import('../rv-ui-plugin').UISlotProps>;
}
let windowProvider: DesExperimentWindowProvider | null = null;
const windowProviderListeners = new Set<() => void>();
/** Register the window opener; returns the unregister function. */
export function registerDesExperimentWindowProvider(provider: DesExperimentWindowProvider): () => void {
  windowProvider = provider;
  for (const fn of [...windowProviderListeners]) fn();
  return () => {
    if (windowProvider !== provider) return;
    windowProvider = null;
    for (const fn of [...windowProviderListeners]) fn();
  };
}
/** The registered opener, or null (community build). */
export function desExperimentWindowProvider(): DesExperimentWindowProvider | null { return windowProvider; }
/** Subscribe to opener (un)registration. */
export function subscribeDesExperimentWindowProvider(listener: () => void): () => void {
  windowProviderListeners.add(listener);
  return () => { windowProviderListeners.delete(listener); };
}
