// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * useCameraStartPos — Reactive status for the per-model camera start view.
 *
 * Subscribes to four events to keep the UI in sync:
 *  - viewer 'model-loaded' / 'model-cleared' (model switch)
 *  - window 'storage' (cross-tab save/clear)
 *  - window CAMERA_START_CHANGED_EVENT (same-tab save/clear via store)
 */

import { useEffect, useState } from 'react';
import type { RVViewer } from '../core/rv-viewer';
import { deriveModelKey } from '../plugins/camera-startpos-plugin';
import { loadStartPos, hasStartPos } from '../core/hmi/camera-startpos-store';
import { CAMERA_START_CHANGED_EVENT } from '../core/hmi/camera-startpos-types';

export interface CameraStartPosStatus {
  modelKey: string | null;
  has: boolean;
  source: 'user' | 'author' | null;
  savedAt: number | null;
}

export function useCameraStartPos(viewer: RVViewer): CameraStartPosStatus {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const rerender = () => setTick(t => t + 1);

    // ViewerEvents.model-loaded has payload { result: LoadResult } — we ignore it.
    const onLoaded = (_data?: unknown) => rerender();
    const onCleared = (_data?: unknown) => rerender();
    const offLoaded = viewer.on('model-loaded', onLoaded);
    const offCleared = viewer.on('model-cleared', onCleared);

    // Cross-tab sync (storage fires in OTHER tabs only)
    const onStorage = (e: StorageEvent) => {
      if (!e.key || e.key.startsWith('rv-camera-start:')) rerender();
    };
    window.addEventListener('storage', onStorage);

    // Same-tab save/clear (custom event dispatched by store)
    const onChange = () => rerender();
    window.addEventListener(CAMERA_START_CHANGED_EVENT, onChange);

    return () => {
      offLoaded();
      offCleared();
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(CAMERA_START_CHANGED_EVENT, onChange);
    };
  }, [viewer]);

  void tick; // re-render trigger
  const modelKey = deriveModelKey(viewer.pendingModelUrl ?? viewer.currentModelUrl);
  if (!modelKey) return { modelKey: null, has: false, source: null, savedAt: null };

  const has = hasStartPos(modelKey);
  if (!has) return { modelKey, has: false, source: null, savedAt: null };

  const preset = loadStartPos(modelKey);
  return {
    modelKey,
    has: true,
    source: preset?.source ?? null,
    savedAt: preset?.savedAt ?? null,
  };
}
