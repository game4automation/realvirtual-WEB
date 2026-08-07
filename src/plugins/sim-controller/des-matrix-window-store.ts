// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * des-matrix-window-store.ts — shared open-state for THE single DES Experiment
 * Matrix window (`DESExperimentMatrixPanel`, plan-265). Both entry points toggle
 * this store: the "Experiments" button in the DES clock settings and the DES
 * side-tool button registered by the private DES-HMI plugin. Replaces the former
 * `des-experiments-window-store` (tree panel) as the opener target (F1/F13).
 */

import { createStore, type Store } from '../../core/hmi/create-store';

/** Open-state of the Experiment Matrix window. */
export const desMatrixWindowStore: Store<boolean> = createStore<boolean>(false);

/** Open the Experiment Matrix window. */
export function openDesMatrixWindow(): void {
  desMatrixWindowStore.set(() => true);
}

/** Close the Experiment Matrix window. */
export function closeDesMatrixWindow(): void {
  desMatrixWindowStore.set(() => false);
}

/** Toggle the Experiment Matrix window. */
export function toggleDesMatrixWindow(): void {
  desMatrixWindowStore.set((open) => !open);
}
