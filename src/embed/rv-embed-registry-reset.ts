// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { ikSolverRegistry } from '../core/engine/rv-ik-solver';
import { defaultPathNetwork } from '../core/engine/rv-path-network';
import { physicsRegistry } from '../core/engine/rv-physics-registry';
import { defaultSpacingController } from '../core/engine/rv-spacing-controller';
import { resetSlotAuthority } from '../core/engine/rv-slot-authority';
import { defaultZoneRegistry } from '../core/engine/rv-zone-registry';

/**
 * Reset model-scoped state held by engine singletons between sequential embed
 * instances. Provider-independent registries are emptied; the IK provider is
 * retained while its per-model live-solve claims are released.
 */
export function resetEmbedEngineRegistries(): void {
  defaultPathNetwork.clear();
  defaultZoneRegistry.clear();
  defaultSpacingController.clear();
  physicsRegistry.clear();
  ikSolverRegistry.resetLiveSolveClaims();
  resetSlotAuthority();
}
