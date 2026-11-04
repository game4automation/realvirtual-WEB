// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

export interface LegDescriptor {
  vehicleId: string;
  planVersion: number;
  fromX: number;
  toX: number;
}
export interface LegTweenWindow {
  leg: LegDescriptor;
  t0: number;
  t1: number;
  duration: number;
  /** Runtime-only restore sample, obtained from the saved vehicle. */
  renderT?: number;
}

// Metadata follows the inner TweenSpec through Arrival and Replan(stop).
// Runtime sampler/target/closures never enter the wire representation.
const legs = new WeakMap<object, LegTweenWindow>();
export function tagLegTween(value: unknown, window: LegTweenWindow): void {
  if (value && typeof value === 'object' && 'tween' in value) {
    const tween = value.tween;
    if (tween && typeof tween === 'object') legs.set(tween, window);
  }
}
export function legTweenWindow(value: unknown): LegTweenWindow | undefined {
  if (!value || typeof value !== 'object' || !('tween' in value)) return;
  const tween = value.tween;
  return tween && typeof tween === 'object' ? legs.get(tween) : undefined;
}
