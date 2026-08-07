// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * LayoutLibraryPanelHost — the always-mounted overlay slot entry that decides
 * whether the (lazily loaded) LayoutLibraryPanel is on screen at all.
 *
 * Why a host at all (plan-344 Phase 4): `LayoutLibraryPanel` is registered in the
 * `overlay` UI slot and therefore RENDERS on every session, planner or not. Its
 * own `return null` sits after ~20 hooks, so `React.lazy` on it alone would fetch
 * the 47 KB chunk immediately — the split would buy nothing. The gate has to sit
 * in a parent, which is this file.
 *
 * The gate is `hasLoaded || isOpen`, NOT a plain `isOpen &&`. The panel holds
 * real user state (active tab, search text, chip filter, half-filled Add/Edit
 * dialogs) and its own body only hides itself when closed. Unmounting it on every
 * close would quietly discard all of that — a behaviour regression wearing a
 * performance patch's clothes. So: nothing is loaded until the library is opened
 * the first time; from then on the panel stays mounted exactly as before.
 *
 * One exception has to be handled here rather than inside the panel: on the
 * compact layout the closed state is not "nothing", it is the small
 * {@link MobileLibraryTab} reveal tab. That tab is the ONLY way a phone user can
 * open the library, so it must be reachable before the chunk exists — hence it is
 * imported eagerly from its own tiny module.
 */

import { useState, useEffect, useSyncExternalStore, lazy } from 'react';
import { useViewer } from '../../hooks/use-viewer';
import { useMobileLayout } from '../../hooks/use-mobile-layout';
import { useActiveContexts } from '../../core/hmi/ui-context-store';
import { LAYOUT_PANEL_WIDTH } from '../../core/hmi/layout-constants';
import { LazyPanelBoundary } from '../../core/hmi/LazyPanelBoundary';
import { MobileLibraryTab } from './MobileLibraryTab';

/** Panel id in the LeftPanelManager — must match `LayoutLibraryPanel`. */
const PANEL_ID = 'layout-planner';

const LayoutLibraryPanel = lazy(() =>
  import('./LayoutLibraryPanel').then((m) => ({ default: m.LayoutLibraryPanel })));

export function LayoutLibraryPanelHost() {
  const viewer = useViewer();
  const lpm = viewer.leftPanelManager;
  // The planner docks RIGHT — read that slot directly so the gate is independent
  // of whatever is open on the left (hierarchy / settings / …).
  const lpmSnapshot = useSyncExternalStore(lpm.subscribe, lpm.getSnapshot);
  const isOpen = lpmSnapshot.right.activePanel === PANEL_ID;
  const isMobile = useMobileLayout();
  const activeContexts = useActiveContexts();

  const [hasLoaded, setHasLoaded] = useState(false);
  useEffect(() => { if (isOpen) setHasLoaded(true); }, [isOpen]);

  if (hasLoaded || isOpen) {
    // Once mounted the panel owns every state, including the mobile reveal tab.
    return (
      <LazyPanelBoundary label="Layout Library">
        <LayoutLibraryPanel />
      </LazyPanelBoundary>
    );
  }

  if (isMobile && activeContexts.has('planner')) {
    return <MobileLibraryTab onOpen={() => lpm.open(PANEL_ID, LAYOUT_PANEL_WIDTH, 'right')} />;
  }

  return null;
}
