// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * React hooks for the Generic Instruction Overlay.
 *
 * Convenience wrappers around `instruction-store`'s `useInstructions()`.
 * Most consumers only need `useInstructions()`; the filtered variants are
 * useful for plugin-owned panels that want to show only their own overlays.
 */

import { useMemo } from 'react';
import {
  useInstructions,
  type Instruction,
} from '../core/hmi/instruction-store';

/** Re-export — most consumers import from here for cleaner paths. @public @stable v1 */
export { useInstructions };

/**
 * Look up a single instruction by id. Returns `undefined` if not present.
 * @public @stable v1
 */
export function useInstruction(id: string): Instruction | undefined {
  const instructions = useInstructions();
  return useMemo(() => instructions.find(i => i.id === id), [instructions, id]);
}

/**
 * Filter instructions by `source` tag. Useful for plugin-specific overlays.
 * Returned array is memoised per-source for reference stability.
 * @public @stable v1
 */
export function useInstructionsBySource(source: string): readonly Instruction[] {
  const instructions = useInstructions();
  return useMemo(() => instructions.filter(i => i.source === source), [instructions, source]);
}
