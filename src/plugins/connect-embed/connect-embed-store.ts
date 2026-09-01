// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import type { RVAppConfig } from '../../core/rv-app-config';
import type { ModeManager } from '../../core/rv-mode-manager';

// `CONNECT_EMBED_DEMO_MODEL` used to live here — one more independent
// definition of "the demo model", carried by a store that has no business
// knowing what a GLB is. Since plan-726 the CONNECT bundle ships the same
// `project.json` as every other channel, and what the demo opens comes out of
// that manifest (`connect-embed-actions.ts`).

/** Runtime states of the CONNECT embedded-demo gate. */
export type ConnectEmbedState = 'gated-empty' | 'loading' | 'demo-running' | 'load-error';

/** Immutable snapshot consumed by the React shell and boot orchestration. */
export interface ConnectEmbedSnapshot {
  enabled: boolean;
  state: ConnectEmbedState;
  error: string | null;
}

type Listener = () => void;
type ConnectEmbedModeManager = Pick<ModeManager, 'lock' | 'unlock'>;

const listeners = new Set<Listener>();
let modeManager: ConnectEmbedModeManager | null = null;
let snapshot: ConnectEmbedSnapshot = {
  enabled: false,
  state: 'gated-empty',
  error: null,
};

function notify(): void {
  for (const listener of listeners) listener();
}

function applyModePolicy(): void {
  if (!snapshot.enabled || !modeManager) return;
  if (snapshot.state === 'demo-running') modeManager.unlock();
  else modeManager.lock('hmi');
}

function setState(state: ConnectEmbedState, error: string | null = null): void {
  if (!snapshot.enabled) return;
  if (snapshot.state === state && snapshot.error === error) return;
  snapshot = { ...snapshot, state, error };
  applyModePolicy();
  notify();
}

/** True when settings.json explicitly activates the `connect-embed` context. */
export function isConnectEmbedConfigured(config: RVAppConfig): boolean {
  return config.ui?.initialContexts?.includes('connect-embed') === true;
}

/** Initialize a fresh, non-persisted gate snapshot from app configuration. */
export function initializeConnectEmbedStore(config: RVAppConfig): boolean {
  const enabled = isConnectEmbedConfigured(config);
  modeManager = null;
  snapshot = { enabled, state: 'gated-empty', error: null };
  notify();
  return enabled;
}

/** Attach the viewer mode manager and immediately enforce the current gate state. */
export function attachConnectEmbedModeManager(manager: ConnectEmbedModeManager): void {
  if (!snapshot.enabled) return;
  modeManager = manager;
  applyModePolicy();
}

/** Subscribe to immutable gate snapshots. */
export function subscribeConnectEmbedStore(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Read the current immutable gate snapshot. */
export function getConnectEmbedSnapshot(): ConnectEmbedSnapshot {
  return snapshot;
}

/** Enter loading once; returns false for re-entrant clicks or disabled deployments. */
export function beginConnectEmbedDemoLoad(): boolean {
  if (!snapshot.enabled || (snapshot.state !== 'gated-empty' && snapshot.state !== 'load-error')) {
    return false;
  }
  setState('loading');
  return true;
}

/** Complete the typed model-load contract and unlock the full HMI. */
export function completeConnectEmbedDemoLoad(): void {
  if (snapshot.state === 'loading') setState('demo-running');
}

/** Surface a typed model-load failure inside the minimal shell. */
export function failConnectEmbedDemoLoad(error: string): void {
  if (snapshot.state === 'loading') setState('load-error', error);
}

/** Return to the locked, non-persisted empty state after closing the demo. */
export function resetConnectEmbedDemo(): void {
  setState('gated-empty');
}

/** True while the structural minimal-shell branch must replace normal HMI chrome. */
export function isConnectEmbedMinimalShell(snap: ConnectEmbedSnapshot = snapshot): boolean {
  return snap.enabled && snap.state !== 'demo-running';
}
