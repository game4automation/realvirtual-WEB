// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { legTweenWindow, tagLegTween, type LegDescriptor } from '../../../core/engine/rv-leg-tween';
import { getDefaultMovementAuthority } from '../../../core/engine/rv-movement-authority';
import { positionAt } from '../../../core/engine/rv-motion-profile';
import { registerHookPayloadCodec } from '../rv-des-hook-payload-codec';

export function registerLegPayloadCodec(): void {
  registerHookPayloadCodec('fleet.leg', {
    encode(value) {
      const window = legTweenWindow(value);
      if (!window) return;
      const { tween: _tween, ...data } = value as Record<string, unknown>;
      return { value: { ...data, leg: { ...window.leg },
        legWindow: { t0: window.t0, t1: window.t1, duration: window.duration } } };
    },
    decode(value, context) {
      if (!value || typeof value !== 'object' || !('leg' in value)) return;
      const source = value as Record<string, unknown>;
      const leg = source.leg as LegDescriptor;
      const window = source.legWindow as { t0: number; t1: number; duration: number };
      const fail = (): never => { throw new Error('fleet.authority: invalid queued leg/window'); };
      if (!leg || typeof leg.vehicleId !== 'string' || !Number.isSafeInteger(leg.planVersion)
        || !window || !Number.isFinite(window.t0) || !Number.isFinite(window.t1)
        || !Number.isFinite(window.duration) || window.duration <= 0
        || window.t1 <= window.t0 || context.time !== window.t1
        || !context.raw || window.t0 > context.raw.simTime || window.t1 < context.raw.simTime
        || 'tween' in source || 'tweens' in source) fail();
      const part = context.raw!.parts.find(p => p.key === 'fleet.authority');
      if (!part) fail();
      const authority = getDefaultMovementAuthority('des');
      const saved = authority.prepareState(part!.state);
      const vehicle = saved.vehicles.get(leg.vehicleId);
      if (!vehicle || vehicle.legEvent !== context.eventId
        || positionAt(vehicle.plan.profile, window.t0) !== leg.fromX
        || window.duration !== vehicle.plan.profile.tEnd - window.t0
        || window.t1 !== window.t0 + window.duration) fail();
      const tween = authority.rebuildLegTween(leg.vehicleId, leg.planVersion, leg.fromX, leg.toX, saved);
      if (!tween || typeof tween !== 'object' || !('tween' in tween)) fail();
      tagLegTween(tween, { leg, t0: window.t0, t1: window.t1, duration: window.duration, renderT: vehicle!.renderT });
      const { leg: _leg, legWindow: _window, ...rest } = source;
      return { value: { ...rest, ...(tween as object) } };
    },
  });
}
