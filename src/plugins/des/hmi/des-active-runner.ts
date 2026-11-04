// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import type { RVViewer } from '../../../core/rv-viewer';
import type { DESRunner } from '../des-runner';
import type { DESComponent } from '../rv-des-component';
import { DESMode } from '../rv-des-manager';

/** Resolve the active runner; HMI has no legacy or external-source fallback. */
export function getActiveDesRunner(viewer: RVViewer): DESRunner | null {
  const kernel = viewer.simulationKernel;
  if (!kernel || kernel.mode !== 'des') return null;
  return kernel.activeExecutor as unknown as DESRunner;
}

export function nativeModeToSubMode(mode: DESMode): 'animated' | 'fastforward' | 'step' {
  switch (mode) {
    case DESMode.FastForward: return 'fastforward';
    case DESMode.Step: return 'step';
    default: return 'animated';
  }
}

export function desComponentsOf(runner: DESRunner): DESComponent[] {
  return runner.instances().map(i => i.adapter as unknown as DESComponent);
}

export function desComponentAt(runner: DESRunner, path: string): DESComponent | null {
  return desComponentsOf(runner).find(c => c.path === path) ?? null;
}

export function setDesMode(runner: DESRunner, mode: DESMode): void {
  runner.setSubMode(nativeModeToSubMode(mode));
}
