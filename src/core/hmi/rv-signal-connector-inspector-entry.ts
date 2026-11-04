// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

// plan-2227: the EAGER part of the SignalConnector inspector. The section itself
// (rv-signal-connector-inspector.tsx) loads the first time a connector is selected.

import { useEffect, useState, useSyncExternalStore } from 'react';
import { getActiveAssetContext, getActiveAssetVersion, subscribeActiveAsset } from '../editor/active-asset-store';

type InspectorModule = typeof import('./rv-signal-connector-inspector');

let _module: InspectorModule | null = null;
let _loading: Promise<InspectorModule> | null = null;

function loadInspectorModule(): Promise<InspectorModule> {
  if (!_loading) {
    _loading = import('./rv-signal-connector-inspector').then((m) => { _module = m; return m; });
    _loading.catch(() => { _loading = null; });
  }
  return _loading;
}

/** True for a `SignalConnector` section (also a `_N`-deduped key). */
export function isSignalConnectorSection(componentType: string): boolean {
  return componentType.replace(/_\d+$/, '') === 'SignalConnector';
}

export function nodeHasSignalConnector(rv: Record<string, unknown> | undefined): boolean {
  if (!rv) return false;
  for (const key in rv) if (isSignalConnectorSection(key)) return true;
  return false;
}

/** The section module while a connector is selected, null until it arrived (section stays generic). */
export function useSignalConnectorInspectorModule(enabled: boolean): InspectorModule | null {
  const [mod, setMod] = useState<InspectorModule | null>(_module);
  useEffect(() => {
    if (!enabled || mod) return;
    let alive = true;
    void loadInspectorModule().then((m) => { if (alive) setMod(m); }, () => {});
    return () => { alive = false; };
  }, [enabled, mod]);
  return enabled ? mod : null;
}

function subscribeActiveDocument(onChange: () => void): () => void {
  let offDoc: (() => void) | null = null;
  const follow = (): void => {
    offDoc?.();
    offDoc = getActiveAssetContext()?.doc.document.subscribe(onChange) ?? null;
  };
  follow();
  const offAsset = subscribeActiveAsset(() => { follow(); onChange(); });
  return () => { offAsset(); offDoc?.(); };
}

const activeDocumentRevision = (): string => `${getActiveAssetVersion()}:${getActiveAssetContext()?.doc.revision ?? -1}`;
const subscribeNothing = (): (() => void) => () => {};
const noRevision = (): string => '';

/**
 * Editor document revision while `enabled`: a Mode change runs as a command, and a
 * document not bound to the SceneStore announces field ops to no one — re-read on
 * every commit, undo and redo. Disabled: no subscription, constant snapshot.
 */
export function useSignalConnectorDocumentRevision(enabled: boolean): string {
  return useSyncExternalStore(
    enabled ? subscribeActiveDocument : subscribeNothing,
    enabled ? activeDocumentRevision : noRevision,
  );
}
