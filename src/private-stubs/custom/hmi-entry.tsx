// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * hmi-entry.tsx — Public stub for HMI initialization.
 *
 * When the private folder is absent, Vite resolves
 * `@rv-private/custom/hmi-entry` to this stub.
 * It mounts App.tsx from core/hmi/ (minimal shell: TopBar + BottomBar + SlotRenderer).
 */

import { createRoot } from 'react-dom/client';
import { RVViewerProvider } from '../../hooks/use-viewer';
import { App } from '../../core/hmi/App';
import { RootErrorBoundary } from '../../core/hmi/RootErrorBoundary';
import type { RVViewer } from '../../core/rv-viewer';

export function initHMI(viewer: RVViewer): void {
  const container = document.getElementById('react-root');
  if (!container) {
    console.warn('[HMI] No #react-root element found, skipping HMI init');
    return;
  }
  const root = createRoot(container);
  root.render(
    // One boundary around the whole HMI (plan-2022 P0): a render error shows a rebuild card
    // instead of unmounting every panel and leaving only the 3D scene.
    <RootErrorBoundary>
      <RVViewerProvider value={viewer}>
        <App />
      </RVViewerProvider>
    </RootErrorBoundary>,
  );
}
