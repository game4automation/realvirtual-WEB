// SPDX-License-Identifier: AGPL-3.0-only
import { it, expect, vi } from 'vitest';
import { VariantsRuntime, type VariantsViewer } from '../../src/plugins/variants/variants-runtime';
import { setExperimentScopeHook } from '../../src/core/material-flow/rv-project-manager';
import { getProblems } from '../../src/core/hmi/problems-store';
import { lineFixture } from './runner-fixture';
it('resolves variant/base/variant scope without a backend and permits DES runs', async () => {
 setExperimentScopeHook(null);
 const { runner, manager } = lineFixture({ experiments: false });
 const paused = vi.fn();
 const runtime = new VariantsRuntime({ viewer: () => ({ simulationKernel: { desControl: () => runner }, setSimulationPaused: paused }) as unknown as VariantsViewer, documentLoadId: () => 'doc' });
 const seam = runtime as unknown as { _resolveScope(): void; _scopeReady: Promise<void> };
 try { for (const scope of ['variant', 'base', 'variant']) {
  seam._resolveScope(); await seam._scopeReady;
  runner.reset(); manager.duration = 10; expect(await runner.runFastForward(), scope).toBe(true);
 } expect(getProblems().some(p => p.code === 'variant-scope-failed')).toBe(false);
 expect(paused).not.toHaveBeenCalledWith('user', true);
 } finally { runtime.dispose(); runner.dispose(); }
});
