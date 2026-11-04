// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import type { RVViewer } from '../../src/core/rv-viewer';
import { physicsRegistry } from '../../src/core/engine/rv-physics-registry';
import { resetSmoothMotionDegradation, smoothMotionRegistry } from '../../src/core/engine/rv-smooth-motion-port';
import { RapierPhysicsProvider } from '@rv-private/physics/rv-rapier-provider';
import { PhysicsZonePlugin } from '@rv-private/plugins/physics-zone-plugin';
import { registerSmoothMotionProvider } from '@rv-private/smooth-motion/rv-smooth-motion-provider';
export async function installPhysics(v: RVViewer) {
  const provider = new RapierPhysicsProvider();
  await provider.init();
  if (!provider.ready) throw new Error('Physics: provider not ready (expected Rapier WASM ready)');
  physicsRegistry.register(provider);
  const plugin = new PhysicsZonePlugin();
  v.use(plugin, 'internal');
  return plugin;
}
// Registers the jerk-limited smooth-motion provider exactly like the app does (private-plugins.ts
// awaits it before the first loadModel), so harness drives run the same S-curve as the viewer
// (plan-2219 E14). Call BEFORE loading the model; the returned reset drops the module-global
// registry again so later test files start from the community trapezoid default.
export async function installSmoothMotion(): Promise<() => void> {
  const ok = await registerSmoothMotionProvider();
  if (!ok) throw new Error(`Smooth motion: provider not ready (expected WASM core loaded, got ${smoothMotionRegistry.failureDetail})`);
  return () => {
    smoothMotionRegistry.reset();
    resetSmoothMotionDegradation();
  };
}
