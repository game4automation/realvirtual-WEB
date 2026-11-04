// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

// Non-participant: DES only declares movedNodes. fixedUpdate is continuous-only;
// setup positions the stationary chain at startPhase, with no DES advancement.
export const overheadRunState = [] as const;
export const overheadServices = [] as const;
// Resolved model path/carriers and configuration are recreated by setup.
export const overheadDerived = ['path', 'carriers', 'pitchM', 'startPhaseM', 'targetSpeed', 'acceleration', 'useAcceleration'] as const;
// Phase and speed advance only in continuous.fixedUpdate. Pose temporaries
// are scratch, including the constant up vector used by continuous placement.
export const overheadScratch = ['sChainM', 'v', '_pos', '_tan', '_flat', '_up', '_quat'] as const;
