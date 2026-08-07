// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { useState } from 'react';

export const ROW_HEIGHT_FINE = 20;
export const ROW_HEIGHT_COARSE = 44;

export type PointerMatchMedia = (query: string) => Pick<MediaQueryList, 'matches'>;

/** Resolve the fixed hierarchy row height for the current primary pointer. */
export function resolvePointerRowHeight(matchMedia?: PointerMatchMedia): number {
  const resolver = matchMedia
    ?? (typeof window !== 'undefined' ? window.matchMedia.bind(window) : undefined);
  return resolver?.('(pointer: coarse)').matches ? ROW_HEIGHT_COARSE : ROW_HEIGHT_FINE;
}

/** Resolve pointer density once per hierarchy mount to keep virtualizer math fixed. */
export function usePointerRowHeight(): number {
  const [rowHeight] = useState(() => resolvePointerRowHeight());
  return rowHeight;
}
