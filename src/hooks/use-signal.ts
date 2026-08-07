// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * React hooks for reactive PLC signal binding.
 *
 * Usage:
 *   const speed = useSignal('PLC1.DB100.DBD0');       // reactive read
 *   const setStart = useSignalWrite('ConveyorStart');  // write function
 *   setStart(true);
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useViewer } from './use-viewer';
import {
  createSignalWriter,
  type SignalStore,
  type SignalWriter,
} from '../core/engine/rv-signal-store';

/** Subscribe to a signal value. Re-renders only when the value changes. */
export function useSignal(addr: string): boolean | number | undefined {
  const viewer = useViewer();
  const [value, setValue] = useState<boolean | number | undefined>(
    () => viewer.signalStore?.get(addr),
  );

  useEffect(() => {
    const store = viewer.signalStore;
    if (!store) {
      setValue(undefined);
      return;
    }

    // Sync initial value (store may have been populated after first render)
    setValue(store.get(addr));

    return store.subscribe(addr, setValue);
  }, [viewer, addr]);

  // Re-subscribe when signalStore changes (model load/clear)
  useEffect(() => {
    const onLoaded = () => {
      const store = viewer.signalStore;
      if (store) setValue(store.get(addr));
    };
    const onCleared = () => setValue(undefined);

    const offLoaded = viewer.on('model-loaded', onLoaded);
    const offCleared = viewer.on('model-cleared', onCleared);
    return () => { offLoaded(); offCleared(); };
  }, [viewer, addr]);

  return value;
}

/** Returns a function to write a signal value. Stable across re-renders. */
export function useSignalWrite(addr: string): (v: boolean | number) => void {
  const viewer = useViewer();
  const addrRef = useRef(addr);
  const writerStoreRef = useRef<SignalStore | null>(null);
  const writerRef = useRef<SignalWriter | null>(null);
  addrRef.current = addr;

  return useCallback(
    (v: boolean | number) => {
      const store = viewer.signalStore;
      if (!store) return;
      if (writerStoreRef.current !== store) {
        writerStoreRef.current = store;
        writerRef.current = createSignalWriter(store, 'hmi:use-signal', 'hmi');
      }
      writerRef.current!.set(addrRef.current, v);
    },
    [viewer],
  );
}
