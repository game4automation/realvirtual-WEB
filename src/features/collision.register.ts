// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

// plan-781 F21: collision detection loads on demand (pattern of signal-connector.register.ts).
// Every viewer declares it; the load path awaits `component:CollisionRole` before the build
// (a Source with `CollisionRoleForMUs` ≠ None counts too). `collision.watch` activates it;
// `collision.status` / `collision.reset` answer without loading it. Type-only imports.
import type { FeatureLoader } from '../core/rv-feature-loader';

export const COLLISION_FEATURE = 'collision';

export function defineCollisionFeature(features: FeatureLoader): void {
  features.define({
    id: COLLISION_FEATURE,
    label: 'Collision detection',
    activation: ['component:CollisionRole', 'command:collision.watch'],
    origin: 'core',
    load: () => import('./collision.body'),
  });
}
