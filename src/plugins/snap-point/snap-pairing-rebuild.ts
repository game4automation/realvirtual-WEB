// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Geometry-based snap-pairing reconstruction — moved to `src/core/connect/snap-pairing.ts` (plan-633 F2).
 *
 * Re-export so existing imports and tests keep working unchanged. New code
 * imports from `src/core/connect/` directly.
 */

export * from '../../core/connect/snap-pairing';
