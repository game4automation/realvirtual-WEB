// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * search-diagnose-registry — provider slot for the "Ask AI" documentation
 * search in the global search bar (plan-283).
 *
 * The private SearchAiPlugin registers a {@link DiagnoseProvider} here after a
 * successful CONNECT capability probe (`/health` → `diagnose: true`); the
 * public search UI only ever asks this registry. An empty registry IS the
 * no-op fallback — no button, no call, no CONNECT knowledge in the search bar.
 * Follows the codebase's registry-over-hard-wiring preference
 * (componentActionRegistry, fieldRendererRegistry, …).
 */

import { useSyncExternalStore } from 'react';
import type { DiagnoseProvider } from './diagnose-provider';

let _provider: DiagnoseProvider | null = null;
const _listeners = new Set<() => void>();
let _version = 0;

/** Register the search diagnose provider. Returns an unregister function. */
export function registerSearchDiagnoseProvider(provider: DiagnoseProvider): () => void {
  _provider = provider;
  _bump();
  return () => {
    if (_provider === provider) {
      _provider = null;
      _bump();
    }
  };
}

/** The registered provider, or null (AI search unavailable). */
export function getSearchDiagnoseProvider(): DiagnoseProvider | null {
  return _provider;
}

/** useSyncExternalStore plumbing. */
export function subscribeSearchDiagnoseProvider(listener: () => void): () => void {
  _listeners.add(listener);
  return () => { _listeners.delete(listener); };
}

export function getSearchDiagnoseProviderSnapshot(): number {
  return _version;
}

/** Reactively reports whether the optional diagnosis provider is registered. */
export function useSearchDiagnosisAvailable(): boolean {
  useSyncExternalStore(
    subscribeSearchDiagnoseProvider,
    getSearchDiagnoseProviderSnapshot,
  );
  return getSearchDiagnoseProvider() !== null;
}

function _bump(): void {
  _version++;
  for (const fn of _listeners) fn();
}
