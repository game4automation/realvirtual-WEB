// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-drive-utils.ts — the one duck-typed `RVDrive` recogniser (plan-460).
 *
 * `rv-chain.ts` and `rv-ribbon-path.ts` each carried a private, near-identical
 * `asDrive()`. They disagreed on the probe field (`currentPosition` vs
 * `currentSpeed`), which is exactly the kind of drift a second copy produces.
 * The surviving probe is `currentPosition`: it is the field both the chain and
 * the web actually integrate, and it is present on every drive-shaped object,
 * real or faked.
 *
 * Duck typing rather than `instanceof` is deliberate and predates this file: a
 * `ComponentReference` may resolve to a recorder stand-in or a test double, and
 * an `instanceof` gate would silently drop those.
 */

import type { RVDrive } from './rv-drive';

/** `value` as a drive, or `null` when it is not drive-shaped. */
export function asDrive(value: unknown): RVDrive | null {
  const candidate = value as RVDrive | null;
  return candidate && typeof (candidate as { currentPosition?: unknown }).currentPosition === 'number'
    ? candidate
    : null;
}
