// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { lazy, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useViewer } from '../../hooks/use-viewer';
import { ensureInterfaceTypes, getConnectSnapshot, reloadConnectBridges, subscribeConnectStore } from './connect-store';
import { LazyPanelBoundary } from './LazyPanelBoundary';
import { markConnectPanelFailed, markConnectPanelIdle, markConnectPanelPending, markConnectPanelUnmounted } from './connect-panel-readiness';

type ConnectPanelModule = typeof import('./ConnectPanel');

const defaultLoader = (): Promise<ConnectPanelModule> => import('./ConnectPanel');
let loader: () => Promise<ConnectPanelModule> = defaultLoader;
let modulePromise: Promise<ConnectPanelModule> | null = null;

/** Test seam: replaces the chunk import with a controllable one; `null` restores the real import. */
export function setConnectPanelLoaderForTests(next: (() => Promise<ConnectPanelModule>) | null): void {
  loader = next ?? defaultLoader;
  modulePromise = null;
}

function loadConnectPanelModule(): Promise<ConnectPanelModule> {
  return modulePromise ??= loader().catch((error: unknown) => {
    modulePromise = null;
    throw error;
  });
}

/** Fetch the chunk without mounting any panel UI. A real open can retry a failed preload. */
export async function preloadConnectPanel(): Promise<void> {
  try {
    await loadConnectPanelModule();
  } catch (error) {
    console.warn('[ConnectPanelHost] Failed to preload CONNECT panel:', error);
  }
}

/** Effects that must run even before the panel has ever been requested. */
export function useConnectPanelBootEffects(): void {
  const snap = useSyncExternalStore(subscribeConnectStore, getConnectSnapshot);
  const preloaded = useRef(false);
  useEffect(() => { void ensureInterfaceTypes(); }, [snap.state, snap.availableTypes]);
  useEffect(() => {
    if (snap.state === 'connected') void reloadConnectBridges();
  }, [snap.state === 'connected']);
  useEffect(() => {
    if (snap.state === 'connected' && !preloaded.current) {
      preloaded.current = true;
      void preloadConnectPanel();
    }
  }, [snap.state]);
}

export function ConnectPanelHost() {
  const viewer = useViewer();
  const lpm = viewer.leftPanelManager;
  const panelSnap = useSyncExternalStore(lpm.subscribe, lpm.getSnapshot);
  const snap = useSyncExternalStore(subscribeConnectStore, getConnectSnapshot);
  const open = panelSnap.activePanel === 'connect';
  const wanted = open || !!snap.editInterfaceId;
  const [hasLoaded, setHasLoaded] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [wasOpen, setWasOpen] = useState(open);
  const failed = useRef(false);
  useEffect(() => { if (wanted) setHasLoaded(true); }, [wanted]);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open && failed.current) {
      failed.current = false;
      setAttempt(attempt + 1);
    }
  }

  const LazyConnectPanel = useMemo(() => lazy(() => loadConnectPanelModule()
    .then((m) => ({ default: m.ConnectPanel }))
    .catch((error: unknown) => {
      failed.current = true;
      markConnectPanelFailed(error);
      modulePromise = null;
      throw error;
    })), [attempt]);

  useConnectPanelBootEffects();
  useEffect(() => markConnectPanelUnmounted, []);
  useLayoutEffect(() => {
    if (open) markConnectPanelPending();
    else markConnectPanelIdle();
  }, [open, attempt]);

  return (hasLoaded || wanted) ? (
    <LazyPanelBoundary key={attempt} label="CONNECT panel" visible={open}>
      <LazyConnectPanel />
    </LazyPanelBoundary>
  ) : null;
}
