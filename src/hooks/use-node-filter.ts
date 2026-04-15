// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * React hook for unified node filtering state.
 * Subscribes to viewer 'node-filter' events and returns current filter + filtered nodes.
 */

import { useState, useEffect, useCallback } from 'react';
import { useViewer } from './use-viewer';
import type { NodeSearchResult } from '../core/engine/rv-node-registry';

export interface NodeFilterState {
  filter: string;
  filteredNodes: NodeSearchResult[];
  tooMany: boolean;
}

/** Returns the current node filter state and a setter. */
export function useNodeFilter(): NodeFilterState & { setFilter: (term: string) => void } {
  const viewer = useViewer();
  const [state, setState] = useState<NodeFilterState>({
    filter: viewer.nodeFilter,
    filteredNodes: viewer.filteredNodes,
    tooMany: false,
  });

  useEffect(() => {
    const off = viewer.on('node-filter', (data: NodeFilterState) => {
      setState(data);
    });
    return off;
  }, [viewer]);

  const setFilter = useCallback(
    (term: string) => viewer.filterNodes(term),
    [viewer],
  );

  return { ...state, setFilter };
}
