// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { Vector2 } from 'three';

/** Pre-allocated output — callers should NOT store the returned reference. */
const _ndc = new Vector2();

/**
 * Convert pointer client coordinates to Normalized Device Coordinates [-1, +1].
 * Accounts for canvas offset via getBoundingClientRect().
 */
export function pointerToNDC(
  clientX: number,
  clientY: number,
  domElement: HTMLElement,
  out: Vector2 = _ndc,
): Vector2 {
  return ndcFromRect(clientX, clientY, domElement.getBoundingClientRect(), out);
}

/**
 * The same conversion from an ALREADY MEASURED rect.
 *
 * A pointer handler that also needs the rect — for a bounds check, or to refuse
 * a zero-sized canvas — must not pay for a second `getBoundingClientRect()`:
 * that is a forced layout on every `pointermove`. So the measurement and the
 * arithmetic are separable, and {@link pointerToNDC} is this function plus the
 * measurement (plan-461 R8).
 */
export function ndcFromRect(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  out: Vector2 = _ndc,
): Vector2 {
  out.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  out.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  return out;
}
