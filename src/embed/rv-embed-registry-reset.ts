// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { ikSolverRegistry } from '../core/engine/rv-ik-solver';
import { physicsRegistry } from '../core/engine/rv-physics-registry';
import { resetSlotAuthority } from '../core/engine/rv-slot-authority';
import { resetTrafficRegistries } from '../core/engine/rv-traffic-registries';

/**
 * Reset model-scoped state held by engine singletons between sequential embed
 * instances. The AGV traffic registries go through the SAME reset point as the
 * main viewer's `clearModel()` (plan-647 D1); physics and the slot authority
 * are emptied; the IK provider is retained while its per-model live-solve
 * claims are released.
 */
export function resetEmbedEngineRegistries(): void {
  resetTrafficRegistries();
  physicsRegistry.clear();
  ikSolverRegistry.resetLiveSolveClaims();
  resetSlotAuthority();
}
