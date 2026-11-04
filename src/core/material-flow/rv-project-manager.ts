// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>


/**
 * Active project and scene-column resolution. Projects bound comparisons; columns
 * bind to Base or a variant ID. Effective Base changes invalidate results without changing the column.
 */

import type { SimDesControl, SimulationKernel } from './simulation-kernel';
import type { ModelInputHost } from '../../plugins/des/rv-des-model-input';
import {
  listProjects, createProject, deleteProjectRecord, parseExperimentInfo,
  runScopeStore,
  type Project, type ExperimentInfo, type RunScope,
} from './rv-run-history-store';
import { currentRunLease, getSceneVariantProvenance, subscribeRunLease, getColumnMigrationContext } from '../hmi/rv-run-lease';
import { reportProblem } from '../hmi/problems-store';
import { getDesRunSettings, updateDesRunSettings } from '../hmi/des-run-settings-store';

/** Minimal viewer surface (structural — no RVViewer import). */
export interface ProjectManagerViewerLike extends Partial<ModelInputHost> {
  readonly currentModelUrl?: string | null;
  readonly simulationKernel: Pick<SimulationKernel, 'desControl'> | null;
}

/** Model key of the loaded GLB: file basename without extension (matches the
 *  private experiment browser convention so both address the same manifests). */
export function modelKeyOf(viewer: ProjectManagerViewerLike): string {
  const url = viewer.currentModelUrl;
  if (!url) return 'default';
  const base = url.split(/[/\\]/).pop() ?? url;
  const dot = base.lastIndexOf('.');
  try {
    return decodeURIComponent(dot > 0 ? base.slice(0, dot) : base) || 'default';
  } catch {
    return (dot > 0 ? base.slice(0, dot) : base) || 'default';
  }
}

/** SHA-256 hex of a string (crypto.subtle), FNV-1a fallback for insecure
 *  contexts (S4 — a stable hash, collisions merely merge experiments). */
export async function sha256Hex(text: string): Promise<string> {
  try {
    if (typeof crypto !== 'undefined' && crypto.subtle) {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
    }
  } catch { /* fall through to FNV */ }
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `fnv1a-${(h >>> 0).toString(16)}`;
}

/** Legacy structure fingerprint retained for the old matrix metadata. */
export async function computeGlbFingerprint(viewer: ProjectManagerViewerLike): Promise<string> {
  const ctl = viewer.simulationKernel?.desControl() ?? null;
  const states = ctl?.componentStates?.() ?? [];
  const rows = states
    .map((s) => `${s.name}|${s.type}|${s.kind}`)
    .sort();
  return sha256Hex(`${modelKeyOf(viewer)}::${rows.join(';')}`);
}

/** The active project, creating a default one on first use (F5). */
export async function ensureActiveProject(): Promise<Project> {
  const projects = await listProjects();
  const activeId = getDesRunSettings().activeProjectId;
  const active = projects.find((p) => p.projectId === activeId);
  if (active) return active;
  if (projects.length > 0) {
    updateDesRunSettings({ activeProjectId: projects[0].projectId });
    return projects[0];
  }
  const created = await createProject('Default Project');
  updateDesRunSettings({ activeProjectId: created.projectId });
  return created;
}

/** Switch the active project (comparison context). Clears the run scope so it
 *  re-resolves against the new project on the next `ensureActiveScope`. */
export function setActiveProject(projectId: string): void {
  scopeGeneration++;
  updateDesRunSettings({ activeProjectId: projectId });
  runScopeStore.set(() => null);
}

export type ExperimentScopeHook = (viewer: ProjectManagerViewerLike) => Promise<RunScope | null>;
export type VariantSetChangedHook = (viewer: ProjectManagerViewerLike, restore?: boolean,
  knownVariants?: readonly import('../variants/rv-variant-model').Variant[]) => Promise<void>;
export let experimentScopeHook: ExperimentScopeHook | null = null;
let variantSetChangedHook: VariantSetChangedHook | null = null;
export function setExperimentScopeHook(hook: ExperimentScopeHook | null): void { experimentScopeHook = hook; }
export function setOnVariantSetChanged(hook: VariantSetChangedHook | null): void { variantSetChangedHook = hook; }
export function ensureActiveScope(viewer: ProjectManagerViewerLike): Promise<RunScope | null> {
  return experimentScopeHook?.(viewer) ?? Promise.resolve(null);
}
export function reconcileExperimentVariants(viewer: ProjectManagerViewerLike, restore = true,
  knownVariants: readonly import('../variants/rv-variant-model').Variant[] = []): Promise<void> {
  return variantSetChangedHook?.(viewer, restore, knownVariants) ?? Promise.resolve();
}
let scopeGeneration = 0;
export function experimentScopeGeneration(): number { return scopeGeneration; }

/** Explicitly select an experiment of the active project as the run scope. */
export function setActiveExperiment(model: string, exp: string, projectId: string | null): void {
  if (projectId !== null && projectId !== getDesRunSettings().activeProjectId) {
    throw new Error('Cannot select an experiment belonging to another project');
  }
  scopeGeneration++;
  runScopeStore.set(() => ({ model, exp, projectId }));
}

/** Pick the next free `Experiment N` name. */
export function nextExperimentName(existing: readonly string[]): string {
  let n = existing.length + 1;
  let name = `Experiment ${n}`;
  const taken = new Set(existing);
  while (taken.has(name)) name = `Experiment ${++n}`;
  return name;
}

/**
 * Delete a project INCLUDING all its experiments/runs/checkpoints (cascade,
 * F5/F8) — experiments across ALL models tagged with this projectId.
 */
export async function deleteProjectCascade(
  viewer: ProjectManagerViewerLike,
  projectId: string,
): Promise<void> {
  const ctl = viewer.simulationKernel?.desControl() ?? null;
  if (ctl?.listExperiments && ctl.readManifestJson && ctl.deleteExperiment) {
    const index = await ctl.listExperiments();
    for (const e of index) {
      const json = await ctl.readManifestJson(e.model, e.experiment);
      const info = json ? parseExperimentInfo(json) : null;
      if (info?.projectId === projectId) {
        await ctl.deleteExperiment(e.model, e.experiment);
      }
    }
  }
  await deleteProjectRecord(projectId);
  if (getDesRunSettings().activeProjectId === projectId) {
    updateDesRunSettings({ activeProjectId: null });
    runScopeStore.set(() => null);
  }
}

export const onVariantSetChanged = reconcileExperimentVariants;
