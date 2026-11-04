// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * AlignPanelHost — `overlay` slot entry of the planner Align tool (plan-779).
 * Renders nothing until the tool is opened once; the panel itself (and with
 * it the pick runtime) is a lazily loaded chunk.
 */

import { lazy, Suspense, useSyncExternalStore } from 'react';
import { getAlignSnapshot, subscribeAlign } from './align-state';

const LazyAlignPanel = lazy(() => import('./AlignPanel').then((m) => ({ default: m.AlignPanel })));

export function AlignPanelHost() {
  const snap = useSyncExternalStore(subscribeAlign, getAlignSnapshot);
  if (!snap.open) return null;
  return (
    <Suspense fallback={null}>
      <LazyAlignPanel />
    </Suspense>
  );
}
