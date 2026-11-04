// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** Type declarations for gen-feature-chunks.mjs (plan-652). */

import type { Plugin } from 'vite';

export interface PlainChunk {
  fileName: string;
  isEntry: boolean;
  facadeModuleId: string | null;
  imports: string[];
  bytes: number;
}

export function featureIdOf(facadeModuleId: string | null | undefined): string | null;
export function featureChunksFromBundle(chunks: PlainChunk[]): Record<string, { files: string[]; bytes: number }>;
export function rvFeatureChunksPlugin(): Plugin;
