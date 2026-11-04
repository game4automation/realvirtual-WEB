// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * scanAndRegisterSnaps (per-owner snap scan) — moved to `src/core/connect/snap-scanner.ts` (plan-633 F2).
 *
 * Re-export so existing imports and tests keep working unchanged. New code
 * imports from `src/core/connect/` directly.
 */

export * from '../../core/connect/snap-scanner';
