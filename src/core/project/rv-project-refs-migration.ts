// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-project-refs-migration — the module's self-declaration becomes the
 * manifest's reference (plan-718 §2.7, F5/F9).
 *
 * Until now a plugin module said which models it served:
 *
 * ```ts
 * export const models = ['Linie1', 'Linie2'];   // the FILE NAMES of two GLBs
 * ```
 *
 * which binds code to a file name and therefore breaks the moment anyone renames
 * the GLB — the failure the whole reference model exists to remove. This
 * migration moves that statement to where it survives: `scriptRef` on the
 * document row, whose id is frozen at birth (plan-717).
 *
 * ## What it deliberately does NOT repair
 *
 * A declared name that matches a document only when case is ignored is
 * **reported and not assigned** (K3). The runtime matcher is and stays
 * case-sensitive, so such a declaration binds nothing today; assigning it would
 * make a project behave differently after a migration whose whole promise is
 * that it does not. It goes into the marker, where a human can find it.
 *
 * ## The marker travels with the project
 *
 * Same reasoning as `rv-project-documents-migration.ts`: this migrates a FILE
 * that moves between machines, git and customer deliveries, so a localStorage
 * marker would let machine B redo what machine A already did. And read-only
 * backends never migrate at all (plan-717 §9.0) — a deployed project reads its
 * bindings through the `models[]` compatibility path for one more release
 * generation instead.
 */

import type { RvDocumentEntry, RvProject } from './rv-project-types';
import { assertContainedRef, isContainedRef, normalizeRefPath } from './rv-project-refs';

// ─── Marker ─────────────────────────────────────────────────────────────

/** Manifest key recording that this project's plugin declarations became references. */
export const SCRIPT_REF_MIGRATION_MARKER = 'rv-project/script-ref-migration';

export interface ScriptRefMigrationMarker {
  /** ISO timestamp of the run. */
  at: string;
  /** How many rows were bound. */
  assigned: number;
  /** WHICH rows were bound — what makes the rollback precise rather than sweeping. */
  assignedIds: string[];
  /** Declarations that matched a document only case-insensitively (K3). */
  caseMismatches: ScriptRefCaseMismatch[];
  [key: string]: unknown;
}

export interface ScriptRefCaseMismatch {
  /** The name the module declared. */
  declared: string;
  /** The script that declared it. */
  scriptRef: string;
  documentId: string;
  documentPath: string;
}

/** The recorded marker, or null when this project has never been migrated. */
export function readScriptRefMigrationMarker(
  project: RvProject | null | undefined,
): ScriptRefMigrationMarker | null {
  const raw = project?.[SCRIPT_REF_MIGRATION_MARKER];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.at !== 'string') return null;
  return {
    at: rec.at,
    assigned: typeof rec.assigned === 'number' ? rec.assigned : 0,
    assignedIds: Array.isArray(rec.assignedIds) ? (rec.assignedIds as string[]) : [],
    caseMismatches: Array.isArray(rec.caseMismatches)
      ? (rec.caseMismatches as ScriptRefCaseMismatch[])
      : [],
    ...rec,
  } as ScriptRefMigrationMarker;
}

// ─── Input and outcome ──────────────────────────────────────────────────

/** One plugin module: where it lives inside the project, and what it declared. */
export interface PluginModuleDeclaration {
  /** Project-relative path of the module — what becomes the `scriptRef`. */
  scriptRef: string;
  /** The module's legacy `models: string[]`. */
  models: string[];
}

/**
 *  - `migrated` — at least one row was bound, or a case mismatch was recorded.
 *  - `already`  — the marker is there; nothing done.
 *  - `skipped`  — read-only backend, no declarations, or nothing matched.
 *  - `failed`   — the input was not a manifest at all.
 */
export type ScriptRefMigrationOutcome = 'migrated' | 'already' | 'skipped' | 'failed';

export interface ScriptRefMigrationResult {
  outcome: ScriptRefMigrationOutcome;
  /** The manifest after the run. Identical to the input for every non-`migrated` outcome. */
  project: RvProject;
  /** The bindings this run created. */
  assigned: Array<{ declared: string; scriptRef: string; documentId: string }>;
  /** Declarations that differ from a document only in case — reported, not bound. */
  caseMismatches: ScriptRefCaseMismatch[];
  /** Why, for `skipped`/`failed`. Diagnostics. */
  reason?: string;
}

export interface ScriptRefMigrateOptions {
  /** The project's plugin modules and their declarations. */
  modules: PluginModuleDeclaration[];
  /**
   * Whether the manifest can be written back.
   *
   * Defaults to true. A read-only or bundled backend passes `false` and gets
   * `skipped` — migrating a manifest that cannot be saved would run again on
   * every open and mint a different answer each time (plan-717 §9.0).
   */
  writable?: boolean;
  /** Re-run even when the marker says it already ran. */
  force?: boolean;
  /** Clock seam. */
  now?: () => string;
}

// ─── The migration ──────────────────────────────────────────────────────

/** The model name a document path carries: the file stem without `.glb`. */
export function modelNameOfDocumentPath(path: string): string {
  const file = String(path ?? '').split('?')[0].split('/').filter(Boolean).pop() ?? '';
  return file.replace(/\.glb$/i, '');
}

/**
 * Bind every row a module declared to that module, once.
 *
 * A row that already carries a `scriptRef` is left alone: the manifest is the
 * authority and a declaration is what the manifest replaced.
 */
export function migrateProjectScriptRefs(
  project: RvProject,
  opts: ScriptRefMigrateOptions,
): ScriptRefMigrationResult {
  const empty = (): Pick<ScriptRefMigrationResult, 'assigned' | 'caseMismatches'> =>
    ({ assigned: [], caseMismatches: [] });
  if (!project || typeof project !== 'object' || Array.isArray(project)) {
    return { outcome: 'failed', project, ...empty(), reason: 'not a manifest object' };
  }
  if (opts.writable === false) {
    return { outcome: 'skipped', project, ...empty(), reason: 'read-only backend' };
  }
  if (readScriptRefMigrationMarker(project) && !opts.force) {
    return { outcome: 'already', project, ...empty() };
  }
  const documents = project.documents ?? [];
  const modules = (opts.modules ?? []).filter(m => isContainedRef(m?.scriptRef));
  if (documents.length === 0 || modules.length === 0) {
    return { outcome: 'skipped', project, ...empty(), reason: 'nothing to migrate' };
  }

  // First row wins for a name two documents share — the same rule the runtime's
  // first-match-wins loop already applies, so the migration cannot change which
  // of the two a module bound to.
  const byName = new Map<string, RvDocumentEntry>();
  const byLowerName = new Map<string, RvDocumentEntry>();
  for (const doc of documents) {
    const name = modelNameOfDocumentPath(String(doc.path ?? ''));
    if (name === '') continue;
    if (!byName.has(name)) byName.set(name, doc);
    if (!byLowerName.has(name.toLowerCase())) byLowerName.set(name.toLowerCase(), doc);
  }

  const assigned: ScriptRefMigrationResult['assigned'] = [];
  const caseMismatches: ScriptRefCaseMismatch[] = [];
  const refByDocument = new Map<RvDocumentEntry, string>();

  for (const mod of modules) {
    const scriptRef = assertContainedRef(mod.scriptRef, 'scriptRef');
    for (const declared of mod.models ?? []) {
      if (typeof declared !== 'string' || declared.trim() === '') continue;
      const exact = byName.get(declared);
      if (!exact) {
        const loose = byLowerName.get(declared.toLowerCase());
        if (loose) {
          caseMismatches.push({
            declared,
            scriptRef,
            documentId: String(loose.id ?? ''),
            documentPath: String(loose.path ?? ''),
          });
        }
        continue;
      }
      const current = exact.scriptRef;
      if (typeof current === 'string' && normalizeRefPath(current) !== '') continue;
      if (refByDocument.has(exact)) continue;
      refByDocument.set(exact, scriptRef);
      assigned.push({ declared, scriptRef, documentId: String(exact.id ?? '') });
    }
  }

  if (assigned.length === 0 && caseMismatches.length === 0) {
    return { outcome: 'skipped', project, ...empty(), reason: 'no declaration matched a document' };
  }

  const marker: ScriptRefMigrationMarker = {
    at: (opts.now ?? (() => new Date().toISOString()))(),
    assigned: assigned.length,
    assignedIds: assigned.map(a => a.documentId),
    caseMismatches,
  };
  const migrated: RvProject = {
    ...project,
    documents: documents.map(doc => {
      const ref = refByDocument.get(doc);
      return ref ? { ...doc, scriptRef: ref } : doc;
    }),
    [SCRIPT_REF_MIGRATION_MARKER]: marker,
  };
  return { outcome: 'migrated', project: migrated, assigned, caseMismatches };
}

/**
 * Remove everything this module wrote.
 *
 * A real undo, unlike the documents migration's: this one is purely additive —
 * it writes `scriptRef` on rows that had none and a marker, and it removes
 * nothing on the way in. The `models[]` declarations it read are still in the
 * modules, untouched, which is what makes the rollback complete.
 */
export function rollbackScriptRefMigration(project: RvProject): RvProject {
  const marker = readScriptRefMigrationMarker(project);
  if (!marker) return project;
  // Only the rows THIS migration bound. A `scriptRef` a human authored
  // afterwards is not ours to remove.
  const assignedRefs = new Set(marker.assignedIds);
  const out: Record<string, unknown> = { ...(project as Record<string, unknown>) };
  delete out[SCRIPT_REF_MIGRATION_MARKER];
  out.documents = (project.documents ?? []).map(doc => {
    if (!assignedRefs.has(String(doc.id ?? ''))) return doc;
    const { scriptRef: _dropped, ...rest } = doc;
    return rest as RvDocumentEntry;
  });
  return out as RvProject;
}
