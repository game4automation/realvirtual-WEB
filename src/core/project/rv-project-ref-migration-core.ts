// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-project-ref-migration-core — the shared middle of the two ref migrations
 * (plan-462 B8 / V2).
 *
 * `rv-project-refs-migration` (a plugin module's `models[]` becomes
 * `documents[].scriptRef`) and `rv-project-connect-ref-migration` (CONNECT's
 * handoff becomes `documents[].connectRef`) are the same migration twice: index
 * the document rows by a name derived from their path, walk a list of declared
 * bindings, write the reference on the first row that matches and has none, and
 * leave a marker that says precisely which rows were touched so the whole thing
 * can be undone.
 *
 * ## What is shared, and what deliberately is not
 *
 * Shared: the index (first row wins), the "an authored reference is never
 * overwritten" rule, one reference per document per run, the marker-driven
 * rollback.
 *
 * NOT shared, and expressed as options rather than smoothed away — these are
 * real product differences, and unifying them would change what a migration
 * does to a customer's manifest:
 *
 *  - **Case.** The scriptRef matcher is case-SENSITIVE at runtime, so a
 *    declaration that differs only in case binds nothing and is merely
 *    `report`ed. CONNECT's legacy comparison was case-INSENSITIVE, so the
 *    lowercase key IS the match and it `bind`s. Opposite answers to the same
 *    question, both correct for their own runtime.
 *  - **What counts as news.** One records unmatched declarations in its marker,
 *    the other records case mismatches; each treats "nothing but that" as a
 *    reason to write a marker or not.
 *
 * So the core computes a PLAN and never decides an outcome. The two adapters
 * keep their own pre-checks, their own result shapes and their own no-op rule,
 * which is what lets both of their existing test suites stay untouched.
 */

import type { RvDocumentEntry, RvProject } from './rv-project-types';
import { normalizeRefPath } from './rv-project-refs';

/** One declaration: a name to look up, and the reference to write when it hits. */
export interface RefMigrationBinding {
  /** What the source declared — a model name or a path, matched against rows. */
  key: string;
  /** The project-relative reference to write onto the matched row. */
  ref: string;
}

/**
 * What to do when a declaration matches a row only when case is ignored.
 *
 *  - `report` — do not bind; hand it back so the caller can put it in the
 *    marker and warn. The runtime matcher is case-sensitive, so binding would
 *    make the project behave differently after a migration whose whole promise
 *    is that it does not.
 *  - `bind` — the case-insensitive key IS the match. There is no separate
 *    mismatch to report, because nothing was missed.
 */
export type CaseMismatchPolicy = 'report' | 'bind';

export interface RefMigrationPlanOptions<B extends RefMigrationBinding> {
  /** The row field this migration writes (`scriptRef`, `connectRef`). */
  field: string;
  /** The lookup name a DOCUMENT contributes, derived from its path. */
  documentKey: (path: string) => string;
  /** The lookup name a BINDING contributes, derived from {@link RefMigrationBinding.key}. */
  bindingKey: (key: string) => string;
  caseMismatch: CaseMismatchPolicy;
  /**
   * Reject a binding before it is matched — an unusable reference, say.
   * A rejected binding lands in {@link RefMigrationPlan.unmatched} without ever
   * touching the index. Omitted means every binding is bindable.
   */
  isBindable?: (binding: B) => boolean;
}

/** A row this run would bind, and to what. */
export interface RefMigrationAssignment<B> {
  binding: B;
  document: RvDocumentEntry;
  documentId: string;
  documentPath: string;
}

/** A declaration that matched only case-insensitively, under the `report` policy. */
export interface RefMigrationCaseMismatch<B> {
  binding: B;
  document: RvDocumentEntry;
  documentId: string;
  documentPath: string;
}

/**
 * What a run WOULD do — computed, not applied.
 *
 * Splitting plan from apply is what lets the two adapters keep their different
 * no-op rules: each reads the three lists and decides for itself whether this
 * amounts to a migration at all.
 */
export interface RefMigrationPlan<B> {
  assigned: Array<RefMigrationAssignment<B>>;
  caseMismatches: Array<RefMigrationCaseMismatch<B>>;
  /** Bindings that named no row, or that {@link RefMigrationPlanOptions.isBindable} rejected. */
  unmatched: B[];
}

/**
 * Index the rows and walk the bindings — the half both migrations share.
 *
 * Three rules live here and nowhere else:
 *
 *  1. **First row wins.** Two documents whose paths yield the same name are
 *     ambiguous under a name-based comparison, and the name-based comparison is
 *     the only thing that could ever have bound them. Taking the first
 *     reproduces what the legacy runtime did; guessing would not.
 *  2. **An authored reference is never overwritten.** A human has already
 *     answered that question, and the manifest is the authority a declaration
 *     was replaced BY.
 *  3. **One reference per document per run.** Two declarations naming the same
 *     row would otherwise fight, and the second would silently win.
 */
export function planRefMigration<B extends RefMigrationBinding>(
  documents: readonly RvDocumentEntry[],
  bindings: readonly B[],
  opts: RefMigrationPlanOptions<B>,
): RefMigrationPlan<B> {
  const exact = new Map<string, RvDocumentEntry>();
  const loose = new Map<string, RvDocumentEntry>();
  for (const doc of documents) {
    const path = typeof doc.path === 'string' ? doc.path : '';
    if (path === '') continue;
    const key = opts.documentKey(path);
    if (key === '') continue;
    if (!exact.has(key)) exact.set(key, doc);
    const lower = key.toLowerCase();
    if (!loose.has(lower)) loose.set(lower, doc);
  }

  const assigned: Array<RefMigrationAssignment<B>> = [];
  const caseMismatches: Array<RefMigrationCaseMismatch<B>> = [];
  const unmatched: B[] = [];
  const taken = new Set<RvDocumentEntry>();

  for (const binding of bindings) {
    if (opts.isBindable && !opts.isBindable(binding)) {
      unmatched.push(binding);
      continue;
    }
    const key = opts.bindingKey(binding.key);
    const hit = exact.get(key);
    if (!hit) {
      // Only the `report` policy has a second chance to miss: under `bind` the
      // lookup above already WAS the case-insensitive one.
      if (opts.caseMismatch === 'report') {
        const near = loose.get(key.toLowerCase());
        if (near) {
          caseMismatches.push({
            binding,
            document: near,
            documentId: String(near.id ?? ''),
            documentPath: String(near.path ?? ''),
          });
          continue;
        }
      }
      unmatched.push(binding);
      continue;
    }
    const current = (hit as Record<string, unknown>)[opts.field];
    if (typeof current === 'string' && normalizeRefPath(current) !== '') continue;
    if (taken.has(hit)) continue;
    taken.add(hit);
    assigned.push({
      binding,
      document: hit,
      documentId: String(hit.id ?? ''),
      documentPath: String(hit.path ?? ''),
    });
  }

  return { assigned, caseMismatches, unmatched };
}

/**
 * Write a plan's assignments and its marker into a NEW manifest.
 *
 * Pure, like both migrations already were: the caller hands the result to
 * `updateManifestCas` unchanged.
 */
export function applyRefMigration<B>(
  project: RvProject,
  plan: RefMigrationPlan<B>,
  opts: { field: string; markerKey: string; marker: Record<string, unknown> },
): RvProject {
  const refByDocument = new Map<RvDocumentEntry, string>();
  for (const entry of plan.assigned) {
    refByDocument.set(entry.document, (entry.binding as RefMigrationBinding).ref);
  }
  return {
    ...project,
    documents: (project.documents ?? []).map((doc) => {
      const ref = refByDocument.get(doc);
      return ref ? { ...doc, [opts.field]: ref } : doc;
    }),
    [opts.markerKey]: opts.marker,
  } as RvProject;
}

/**
 * Remove everything a run wrote — the marker, and the refs on the rows it names.
 *
 * A real undo for both callers, because both are purely additive on the way in:
 * they write a field on rows that had none and leave what they read untouched.
 * Only the rows the marker NAMES are cleared — a reference a human authored
 * afterwards is not this module's to remove.
 */
export function rollbackRefMigration(
  project: RvProject,
  opts: { field: string; markerKey: string; assignedIds: readonly string[] },
): RvProject {
  const assigned = new Set(opts.assignedIds);
  const out: Record<string, unknown> = { ...(project as Record<string, unknown>) };
  delete out[opts.markerKey];
  out.documents = (project.documents ?? []).map((doc) => {
    if (!assigned.has(String(doc.id ?? ''))) return doc;
    const { [opts.field]: _dropped, ...rest } = doc as Record<string, unknown>;
    return rest as RvDocumentEntry;
  });
  return out as RvProject;
}
