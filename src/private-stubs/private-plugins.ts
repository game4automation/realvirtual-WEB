// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * private-plugins.ts — No-op stub for public builds.
 *
 * When the private folder (realvirtual-WebViewer-Private~) is absent,
 * Vite resolves `@rv-private/private-plugins` to this stub.
 * The function body is empty — no private plugins to register.
 */

import type { RVViewer } from '../core/rv-viewer';

export function registerPrivatePlugins(_viewer: RVViewer): void {
  // No private plugins available in public build
}
