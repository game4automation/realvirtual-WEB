// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Type declarations for `scene-probe.mjs` (plan-2004). Required for TS7016 — the node tests
 * import the module statically from TypeScript. Keep in step with the .mjs by hand.
 */

export interface SceneRaw { ready?: boolean; modelRoot?: string | null; doc?: string | null; elapsedMs?: number }
export interface GpuRaw { hasWebglCanvas?: boolean; renderer?: string | null }

export function sceneVerdict(
  raw: SceneRaw | null | undefined,
  options?: { doc?: string; timeoutMs?: number },
): { verdict: 'ok' | 'waiting' | 'error'; diagnosis?: string; reason?: string; modelRoot?: string; doc?: string | null };

export function gpuVerdict(
  raw: GpuRaw | null | undefined,
  options?: { gpuCheck?: 'require' | 'off'; motionCheck?: 'require' | 'off'; epochZeroDiagnosis?: boolean },
): {
  verdict: 'ok' | 'skipped' | 'error';
  exitCode?: 1 | 2;
  diagnosis?: string;
  reason?: string;
  hasCanvas: boolean;
  renderer: string | null;
  motionCheck?: 'require' | 'off';
};
