// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * private-plugins.ts — No-op stub for public builds.
 *
 * When the private folder (realvirtual-WebViewer-Private~) is absent,
 * Vite resolves `@rv-private/private-plugins` to this stub.
 * Both functions are empty — no private plugins to prefetch or register — but
 * the SIGNATURES are the same contract the private entry and the generated
 * customer entry export (plan-598, `src/core/rv-private-features.ts`).
 */

import type { RVViewer } from '../core/rv-viewer';
import { NO_PREFETCHED_FEATURES, type PrivateFeatureModules } from '../core/rv-private-features';

export function prefetchPrivateFeatures(): PrivateFeatureModules {
  return NO_PREFETCHED_FEATURES;
}

export async function registerPrivatePlugins(_viewer: RVViewer, _mods?: PrivateFeatureModules): Promise<void> {
  // No private plugins available in public build
}
