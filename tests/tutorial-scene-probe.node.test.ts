// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import {
  gpuVerdict,
  sceneVerdict,
} from '../scripts/tutorial/lib/scene-probe.mjs';

describe('scene-probe', () => {
  it('Test_SceneVerdict_ReadyWithModelRoot_Ok', () => {
    expect(sceneVerdict(
      { ready: true, modelRoot: 'Machine', doc: 'main', elapsedMs: 100 },
      { doc: 'main', timeoutMs: 60000 },
    )).toEqual({ verdict: 'ok', modelRoot: 'Machine', doc: 'main' });
  });

  // `whenSceneReady()` resolves on the already settled promise of the empty start scene ~1.1-1.4 s
  // before `currentModelRoot` appears (measured). "ready, no model root" is therefore a WAITING
  // state while the budget lasts, and terminal only once it is exhausted.
  it('Test_SceneVerdict_ReadyButNoModelRoot_KeepsWaitingUntilTimeout', () => {
    expect(sceneVerdict(
      { ready: true, modelRoot: null, doc: 'main', elapsedMs: 100 },
      { doc: 'main', timeoutMs: 60000 },
    )).toMatchObject({ verdict: 'waiting' });
  });

  it('Test_SceneVerdict_ReadyButNoModelRoot_BudgetExhausted_Error', () => {
    expect(sceneVerdict(
      { ready: true, modelRoot: null, doc: 'main', elapsedMs: 60000 },
      { doc: 'main', timeoutMs: 60000 },
    )).toMatchObject({ verdict: 'error', diagnosis: 'step-error' });
  });

  it('Test_SceneVerdict_WrongDocument_KeepsWaitingUntilTimeout', () => {
    expect(sceneVerdict(
      { ready: true, modelRoot: 'Machine', doc: 'other', elapsedMs: 100 },
      { doc: 'main', timeoutMs: 60000 },
    )).toMatchObject({ verdict: 'waiting' });
  });

  it('Test_SceneVerdict_WrongDocument_BudgetExhausted_Error', () => {
    expect(sceneVerdict(
      { ready: true, modelRoot: 'Machine', doc: 'other', elapsedMs: 60000 },
      { doc: 'main', timeoutMs: 60000 },
    )).toMatchObject({ verdict: 'error', diagnosis: 'step-error' });
  });

  it('Test_SceneVerdict_BudgetExhausted_ErrorWithHint', () => {
    expect(sceneVerdict(
      { ready: false, elapsedMs: 60000 },
      { timeoutMs: 60000 },
    )).toMatchObject({ verdict: 'error', diagnosis: 'step-error', reason: expect.stringContaining('60000 ms') });
  });

  it('Test_SceneVerdict_NotStartedYet_KeepsWaitingUntilTimeout', () => {
    expect(sceneVerdict(
      { ready: false, elapsedMs: 59999 },
      { timeoutMs: 60000 },
    )).toMatchObject({ verdict: 'waiting' });
  });

  it('Test_GpuVerdict_SwiftShader_Error', () => {
    expect(gpuVerdict(
      { hasWebglCanvas: true, renderer: 'ANGLE (Google, Vulkan SwiftShader)' },
      { gpuCheck: 'require', motionCheck: 'require' },
    )).toMatchObject({ verdict: 'error', exitCode: 1, diagnosis: 'step-error' });
  });

  it('Test_GpuVerdict_NoContext_Error', () => {
    expect(gpuVerdict(
      { hasWebglCanvas: false, renderer: null },
      { gpuCheck: 'require', motionCheck: 'require' },
    )).toMatchObject({ verdict: 'error', exitCode: 1, diagnosis: 'step-error' });
  });

  it('Test_GpuVerdict_HardwareRenderer_Ok', () => {
    expect(gpuVerdict(
      { hasWebglCanvas: true, renderer: 'NVIDIA GeForce RTX 4090' },
      { gpuCheck: 'require', motionCheck: 'require' },
    )).toMatchObject({ verdict: 'ok', hasCanvas: true });
  });

  it('Test_GpuVerdict_Off_SkipsCheck', () => {
    expect(gpuVerdict(
      { hasWebglCanvas: false, renderer: null },
      { gpuCheck: 'off', motionCheck: 'off' },
    )).toMatchObject({ verdict: 'skipped', hasCanvas: false, motionCheck: 'off' });
  });

  it('Test_GpuVerdict_MotionCheckOff_WithViewerOrGpuCheck_Exit2', () => {
    expect(gpuVerdict(
      { hasWebglCanvas: true, renderer: 'NVIDIA GeForce RTX 4090' },
      { gpuCheck: 'off', motionCheck: 'off' },
    )).toMatchObject({ verdict: 'error', exitCode: 2, diagnosis: 'motion-check-off-with-viewer' });
    expect(gpuVerdict(
      { hasWebglCanvas: false, renderer: null },
      { gpuCheck: 'require', motionCheck: 'off' },
    )).toMatchObject({ verdict: 'error', exitCode: 2, diagnosis: 'motion-check-off-with-viewer' });
  });

  it('Test_GpuVerdict_EpochZeroDiagnosis_WithoutViewer_Exit2', () => {
    expect(gpuVerdict(
      { hasWebglCanvas: false, renderer: null },
      { gpuCheck: 'require', motionCheck: 'require', epochZeroDiagnosis: true },
    )).toMatchObject({ verdict: 'error', exitCode: 2, diagnosis: 'epoch-zero-diagnosis-needs-viewer' });
    expect(gpuVerdict(
      { hasWebglCanvas: true, renderer: 'NVIDIA GeForce RTX 4090' },
      { gpuCheck: 'off', motionCheck: 'require', epochZeroDiagnosis: true },
    )).toMatchObject({ verdict: 'error', exitCode: 2, diagnosis: 'epoch-zero-diagnosis-needs-viewer' });
  });
});
