// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-project-manager.ts — active project / experiment resolution (plan-260).
 *
 * A PROJECT is the comparison boundary (F5/F11): every experiment/run inside
 * shares the same KPI structure and may be compared; cross-project comparison
 * does not exist. An EXPERIMENT is one concrete model state (identified by
 * `glbHash`, F6) inside a project — a changed layout creates a NEW experiment
 * under the SAME project.
 *
 * All experiment data lives behind the `SimDesControl` facade (JSON string
 * transport, plan-261 B3); this module only orchestrates: default project
 * bootstrap, glb fingerprinting, experiment find-or-create, active-scope
 * publication (`runScopeStore`, read by the private run-lifecycle controller)
 * and cascading project deletion.
 *
 * glbHash deviation from the plan wording (documented in plan-260's
 * Implementation-Complete section): instead of hashing the raw GLB bytes
 * (which are not retained after parsing), the fingerprint is a SHA-256 over
 * the STRUCTURE the statistics are keyed by — the sorted material-flow
 * component names/types/kinds plus the model key. That is exactly the
 * comparability criterion a project protects (same stations/KPIs) and it is
 * available at runtime without re-downloading the model.
 */

import type { SimDesControl, SimulationKernel } from './simulation-kernel';
import {
  listProjects, createProject, deleteProjectRecord, parseExperimentInfo,
  runScopeStore,
  type Project, type ExperimentInfo, type RunScope,
} from './rv-run-history-store';
import { getDesRunSettings, updateDesRunSettings } from '../hmi/des-run-settings-store';

/** Minimal viewer surface (structural — no RVViewer import). */
export interface ProjectManagerViewerLike {
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

/** Structure fingerprint of the loaded model — the experiment identity (F6). */
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
  updateDesRunSettings({ activeProjectId: projectId });
  runScopeStore.set(() => null);
}

/** All experiment manifests of `projectId` for the CURRENT model (the compare
 *  candidate list is strictly project-internal — F11). Untagged legacy
 *  experiments (no projectId) are NOT offered. */
export async function listProjectExperiments(
  viewer: ProjectManagerViewerLike,
  projectId: string,
): Promise<ExperimentInfo[]> {
  const ctl = viewer.simulationKernel?.desControl() ?? null;
  if (!ctl?.listExperiments || !ctl.readManifestJson) return [];
  const model = modelKeyOf(viewer);
  const index = await ctl.listExperiments(model);
  const out: ExperimentInfo[] = [];
  for (const e of index) {
    const json = await ctl.readManifestJson(e.model, e.experiment);
    const info = json ? parseExperimentInfo(json) : null;
    if (info && info.projectId === projectId) out.push(info);
  }
  out.sort((a, b) => a.createdAt - b.createdAt);
  return out;
}

/**
 * Resolve (or create) the experiment for the current model state under the
 * active project and publish it as the ACTIVE RUN SCOPE (F6). A changed model
 * structure (different `glbHash`) creates a new experiment in the SAME
 * project. Returns null without a DES control surface.
 */
export async function ensureActiveScope(viewer: ProjectManagerViewerLike): Promise<RunScope | null> {
  const ctl = viewer.simulationKernel?.desControl() ?? null;
  if (!ctl?.patchExperimentMetaJson) return null;

  const project = await ensureActiveProject();
  const model = modelKeyOf(viewer);
  const glbHash = await computeGlbFingerprint(viewer);

  const experiments = await listProjectExperiments(viewer, project.projectId);
  let expName = experiments.find((e) => e.glbHash === glbHash)?.experiment;
  if (!expName) {
    expName = nextExperimentName(experiments.map((e) => e.experiment));
    await ctl.patchExperimentMetaJson(model, expName, JSON.stringify({
      projectId: project.projectId,
      glbHash,
      baseSeed: ctl.masterSeed ?? 42,
    }));
  }
  const scope: RunScope = { model, exp: expName, projectId: project.projectId };
  runScopeStore.set(() => scope);
  return scope;
}

/** Explicitly select an experiment of the active project as the run scope. */
export function setActiveExperiment(model: string, exp: string, projectId: string | null): void {
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
