// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { useEffect, useRef, useSyncExternalStore } from 'react';
import { Box } from '@mui/material';
import { useViewer } from '../../hooks/use-viewer';
import type { UISlot } from '../rv-ui-plugin';
import { useActiveContexts, isUIElementVisible, registerUIElement } from './ui-context-store';
import { subscribeUIZoom, getUIZoom } from './visual-settings-store';

interface HMIShellProps {
  children: React.ReactNode;
}

/**
 * SlotRenderer — Renders all UI plugin components registered for a given slot.
 * Use alongside (or instead of) hardcoded children in HMIShell.
 *
 * Reactive: re-renders when plugins are registered/unregistered via UIPluginRegistry.
 * Entries with a `visibilityRule` are filtered by the active UI contexts.
 * Entries WITHOUT a `visibilityRule` are ALWAYS visible (invariant).
 */
export function SlotRenderer({ slot }: { slot: UISlot }) {
  const viewer = useViewer();
  // Subscribe to registry changes so we re-render when model plugins load/unload
  useSyncExternalStore(viewer.uiRegistry.subscribe, viewer.uiRegistry.getSnapshot);
  const entries = viewer.uiRegistry.getSlotComponents(slot);
  const contexts = useActiveContexts();

  if (entries.length === 0) return null;

  return (
    <>
      {entries.map((entry, i) => {
        // Register plugin-declared visibility rule if present
        if (entry.visibilityId && entry.visibilityRule) {
          registerUIElement(entry.visibilityId, entry.visibilityRule);
        }

        // Entries without visibilityRule are always visible (invariant)
        if (entry.visibilityId) {
          if (!isUIElementVisible(entry.visibilityId, contexts)) return null;
        }

        const Comp = entry.component;
        return <Comp key={`${slot}-${i}`} viewer={viewer} />;
      })}
    </>
  );
}

export function HMIShell({ children }: HMIShellProps) {
  const boxRef = useRef<HTMLDivElement>(null);

  // Apply zoom directly to DOM — avoids re-rendering the entire child tree on every slider tick.
  useEffect(() => {
    function applyZoom() {
      const el = boxRef.current;
      if (!el) return;
      const z = getUIZoom();
      el.style.zoom = z !== 1 ? String(z) : '';
    }
    applyZoom();
    return subscribeUIZoom(applyZoom);
  }, []);

  return (
    <Box
      ref={boxRef}
      sx={{
        position: 'fixed',
        inset: 0,
        pointerEvents: 'none',
        zIndex: 1000,
        '& > *': {
          pointerEvents: 'auto',
        },
      }}
    >
      {children}
    </Box>
  );
}
