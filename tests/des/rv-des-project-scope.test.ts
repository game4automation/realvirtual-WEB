// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-260 tests §9.2b — project scope / comparison boundary:
 *  - project CRUD in the public `rv-sim-projects` DB
 *  - ensureActiveScope: default project bootstrap + experiment find-or-create
 *    by glb fingerprint (F5/F6)
 *  - changed model structure (glbHash) → NEW experiment under the SAME project
 *  - listProjectExperiments is limited to the active project (F11)
 *  - deleteProjectCascade removes the project's experiments (F8)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { IndexedDBSnapshotStore } from '@rv-private/plugins/des/rv-des-experiment-store';
import {
  listProjects, createProject, renameProject, closeProjectDb, runScopeStore,
} from '../../src/core/material-flow/rv-run-history-store';
import {
  ensureActiveProject, ensureActiveScope, setActiveProject,
  listProjectExperiments, deleteProjectCascade, nextExperimentName, sha256Hex,
  type ProjectManagerViewerLike,
} from '../../src/core/material-flow/rv-project-manager';
import { __resetDesRunSettingsForTest, getDesRunSettings } from '../../src/core/hmi/des-run-settings-store';
import type { SimDesControl, SimDesComponentState } from '../../src/core/material-flow/simulation-kernel';

/** Fake viewer whose SimDesControl is backed by the REAL experiment store. */
function makeViewer(store: IndexedDBSnapshotStore, components: string[]): ProjectManagerViewerLike {
  const ctl: Partial<SimDesControl> = {
    masterSeed: 42,
    componentStates: (): SimDesComponentState[] => components.map((name) => ({
      name, type: 'Conveyor', kind: 'conveyor', entityId: 0, load: 0, maxCapacity: 1,
      inTransit: 0, blocked: 0, isBlocked: false, next: [], prev: [],
    })),
    listExperiments: async (model?: string) => {
      const all = await store.listIndex();
      return model === undefined ? all : all.filter((e) => e.model === model);
    },
    readManifestJson: async (model: string, exp: string) => {
      const meta = await store.readManifest(model, exp);
      return meta ? JSON.stringify(meta) : null;
    },
    patchExperimentMetaJson: async (model: string, exp: string, patchJson: string) => {
      const raw = JSON.parse(patchJson) as { projectId?: string; glbHash?: string; baseSeed?: number };
      await store.patchManifestMeta(model, exp, raw);
    },
    deleteExperiment: (model: string, exp: string) => store.deleteExperiment(model, exp),
  };
  return {
    currentModelUrl: '/models/TestPlant.glb',
    simulationKernel: { desControl: () => ctl as SimDesControl },
  };
}

let _lastStore: IndexedDBSnapshotStore | null = null;
async function freshDbs(): Promise<IndexedDBSnapshotStore> {
  await _lastStore?.close();
  await closeProjectDb();
  for (const name of ['rv-des-experiments', 'rv-sim-projects']) {
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(name);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });
  }
  _lastStore = new IndexedDBSnapshotStore();
  return _lastStore;
}

describe('project scope (plan-260 §9.2b)', () => {
  beforeEach(async () => {
    __resetDesRunSettingsForTest();
    runScopeStore.set(() => null);
  });

  it('project CRUD: create, list (newest first), rename', async () => {
    await freshDbs();
    const a = await createProject('Halle 3');
    const b = await createProject('Halle 4');
    const projects = await listProjects();
    expect(projects.map((p) => p.name)).toContain('Halle 3');
    expect(projects.map((p) => p.name)).toContain('Halle 4');
    await renameProject(a.projectId, 'Halle 3b');
    expect((await listProjects()).find((p) => p.projectId === a.projectId)?.name).toBe('Halle 3b');
    expect(b.projectId).not.toBe(a.projectId);
  });

  it('bootstraps a default project and stores it as active (F5)', async () => {
    await freshDbs();
    const project = await ensureActiveProject();
    expect(project.name).toBe('Default Project');
    expect(getDesRunSettings().activeProjectId).toBe(project.projectId);
    // Second call returns the SAME project (no duplicate bootstrap).
    expect((await ensureActiveProject()).projectId).toBe(project.projectId);
    expect(await listProjects()).toHaveLength(1);
  });

  it('ensureActiveScope creates an experiment tagged with project + glbHash (F6)', async () => {
    const store = await freshDbs();
    const viewer = makeViewer(store, ['ConveyorA', 'StationB']);
    const scope = await ensureActiveScope(viewer);
    expect(scope).not.toBeNull();
    expect(scope!.model).toBe('TestPlant');
    expect(runScopeStore.getSnapshot()).toEqual(scope);

    const meta = await store.readManifest(scope!.model, scope!.exp);
    expect(meta?.projectId).toBe(scope!.projectId);
    expect(meta?.glbHash).toBeTruthy();

    // Same structure again → SAME experiment (no duplicate).
    const scope2 = await ensureActiveScope(viewer);
    expect(scope2!.exp).toBe(scope!.exp);
  });

  it('changed glbHash creates a NEW experiment under the SAME project (F6)', async () => {
    const store = await freshDbs();
    const v1 = makeViewer(store, ['ConveyorA', 'StationB']);
    const scope1 = await ensureActiveScope(v1);

    // "Station 2 doubled" — different structure, same model/project.
    const v2 = makeViewer(store, ['ConveyorA', 'StationB', 'StationB2']);
    const scope2 = await ensureActiveScope(v2);

    expect(scope2!.projectId).toBe(scope1!.projectId);
    expect(scope2!.exp).not.toBe(scope1!.exp);
    const exps = await listProjectExperiments(v2, scope1!.projectId!);
    expect(exps).toHaveLength(2);
  });

  it('compare candidate list is limited to the active project (F11)', async () => {
    const store = await freshDbs();
    const viewer = makeViewer(store, ['ConveyorA']);
    const scope = await ensureActiveScope(viewer);

    // A second project with its own experiment on the same model.
    const other = await createProject('Other');
    await store.patchManifestMeta('TestPlant', 'Foreign Exp', { projectId: other.projectId, glbHash: 'x' });
    // An untagged legacy experiment.
    await store.patchManifestMeta('TestPlant', 'Legacy', {});

    const mine = await listProjectExperiments(viewer, scope!.projectId!);
    expect(mine.map((e) => e.experiment)).toEqual([scope!.exp]);
    const theirs = await listProjectExperiments(viewer, other.projectId);
    expect(theirs.map((e) => e.experiment)).toEqual(['Foreign Exp']);
  });

  it('deleteProjectCascade removes the project AND its tagged experiments (F8)', async () => {
    const store = await freshDbs();
    const viewer = makeViewer(store, ['ConveyorA']);
    const scope = await ensureActiveScope(viewer);
    const other = await createProject('Other');
    await store.patchManifestMeta('TestPlant', 'Foreign Exp', { projectId: other.projectId });

    await deleteProjectCascade(viewer, scope!.projectId!);

    expect((await listProjects()).map((p) => p.projectId)).toEqual([other.projectId]);
    expect(await store.readManifest(scope!.model, scope!.exp)).toBeNull();
    expect(await store.readManifest('TestPlant', 'Foreign Exp')).not.toBeNull();
    expect(getDesRunSettings().activeProjectId).toBeNull();
    expect(runScopeStore.getSnapshot()).toBeNull();
  });

  it('setActiveProject clears the run scope for re-resolution', async () => {
    await freshDbs();
    runScopeStore.set(() => ({ model: 'M', exp: 'E', projectId: 'p' }));
    setActiveProject('p2');
    expect(runScopeStore.getSnapshot()).toBeNull();
    expect(getDesRunSettings().activeProjectId).toBe('p2');
  });

  it('nextExperimentName picks a free name; sha256Hex is stable', async () => {
    expect(nextExperimentName([])).toBe('Experiment 1');
    expect(nextExperimentName(['Experiment 1', 'Experiment 2'])).toBe('Experiment 3');
    expect(nextExperimentName(['Experiment 3'])).toBe('Experiment 2');
    expect(await sha256Hex('abc')).toBe(await sha256Hex('abc'));
    expect(await sha256Hex('abc')).not.toBe(await sha256Hex('abd'));
  });
});
