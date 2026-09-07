// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-project-connect-ref-migration — the WEB half of plan-718's stage-1
 * migration (roadmap 1.6b).
 *
 * ## Why this is two halves and not one
 *
 * plan-718 gives every file exactly one author: CONNECT owns `connect/**`,
 * realvirtual WEB owns `project.json`. The migration has to cross that line —
 * the old binding (`ConnectProfile.Model`, a GLB file name) lives in CONNECT's
 * configuration and the new one (`documents[].connectRef`) lives in the
 * manifest — so it is split rather than allowed to break the rule:
 *
 * 1. **CONNECT** turns its inline profiles into `connect/*.connect.json` files
 *    and writes what it knew into a handoff file,
 *    `connect/migration-bindings.json`.
 * 2. **This module** reads that handoff and sets `connectRef` on the matching
 *    document rows, through the manifest's own CAS funnel.
 * 3. **CONNECT** clears the handoff — but only after it has READ the manifest
 *    and found every binding there. Until then the file stays and the whole
 *    thing is repeatable.
 *
 * CONNECT never writes `project.json`, and this module never writes anything
 * under `connect/`.
 *
 * ## Matching
 *
 * The handoff carries the model exactly as CONNECT had it — `models/Cell1.glb`,
 * `Cell1.glb`, `cell1`. That is the fragile form the reference model replaces,
 * so it is compared the way CONNECT compared it (leaf name, `.glb` stripped,
 * case-insensitive) and then never used again: what lands in the manifest is a
 * reference on a row whose id is frozen.
 */

import type { RvDocumentEntry, RvProject } from './rv-project-types';
import { isContainedRef, normalizeRefPath } from './rv-project-refs';
import {
  applyRefMigration, planRefMigration, rollbackRefMigration,
} from './rv-project-ref-migration-core';

/** Project-relative path of the handoff CONNECT writes. */
export const CONNECT_MIGRATION_HANDOFF = 'connect/migration-bindings.json';

/** Manifest key recording that the CONNECT handoff was adopted. */
export const CONNECT_REF_MIGRATION_MARKER = 'rv-project/connect-ref-migration';

/** One model→configuration binding handed over by CONNECT. */
export interface ConnectMigrationBinding {
  /** The legacy `ConnectProfile.Model` value, exactly as CONNECT had it. */
  model: string;
  /** The file the profile was migrated into, project-relative. */
  connectRef: string;
  /** The profile name — for the log, never for matching. */
  profile?: string;
}

export interface ConnectRefMigrationMarker {
  at: string;
  assigned: number;
  assignedIds: string[];
  /** Bindings whose model matched no document row — reported, never guessed at. */
  unmatched: string[];
  [key: string]: unknown;
}

export type ConnectRefMigrationOutcome = 'migrated' | 'already' | 'skipped' | 'failed';

export interface ConnectRefMigrationResult {
  outcome: ConnectRefMigrationOutcome;
  project: RvProject;
  assigned: Array<{ model: string; connectRef: string; documentId: string }>;
  unmatched: string[];
  reason?: string;
}

/**
 * Parses the handoff file's text. Anything it cannot understand yields an empty
 * list — a migration must never be the thing that stops a project from opening.
 */
export function parseConnectMigrationHandoff(
  source: string | object | null | undefined,
): ConnectMigrationBinding[] {
  if (!source) return [];
  let parsed: unknown = source;
  if (typeof source === 'string') {
    try {
      parsed = JSON.parse(source);
    } catch {
      return [];
    }
  }
  const rows = (parsed as { bindings?: unknown })?.bindings;
  if (!Array.isArray(rows)) return [];
  const out: ConnectMigrationBinding[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const rec = row as Record<string, unknown>;
    // CONNECT serialises a C# record, so the keys arrive PascalCase; a hand-written
    // handoff would be camelCase. Both are accepted rather than one being declared correct.
    const model = String(rec.Model ?? rec.model ?? '').trim();
    const connectRef = normalizeRefPath(String(rec.ConnectRef ?? rec.connectRef ?? ''));
    if (!model || !connectRef) continue;
    out.push({ model, connectRef, profile: String(rec.Profile ?? rec.profile ?? '') || undefined });
  }
  return out;
}

/** The recorded marker, or null when this project has never adopted a handoff. */
export function readConnectRefMigrationMarker(
  project: RvProject | null | undefined,
): ConnectRefMigrationMarker | null {
  const raw = project?.[CONNECT_REF_MIGRATION_MARKER];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.at !== 'string') return null;
  return {
    at: rec.at,
    assigned: typeof rec.assigned === 'number' ? rec.assigned : 0,
    assignedIds: Array.isArray(rec.assignedIds) ? (rec.assignedIds as string[]) : [],
    unmatched: Array.isArray(rec.unmatched) ? (rec.unmatched as string[]) : [],
  };
}

/** CONNECT's model comparison, reproduced exactly: leaf name, `.glb` stripped, case-insensitive. */
function modelKey(value: string): string {
  let v = value.trim().replace(/\\/g, '/');
  const query = v.indexOf('?');
  if (query >= 0) v = v.slice(0, query);
  const slash = v.lastIndexOf('/');
  if (slash >= 0) v = v.slice(slash + 1);
  if (v.toLowerCase().endsWith('.glb')) v = v.slice(0, -4);
  return v.toLowerCase();
}

/**
 * Applies the handoff to a manifest. Pure — it returns the new project rather
 * than writing it, so the caller can hand it to `updateManifestCas` unchanged.
 */
export function migrateConnectRefs(
  project: RvProject,
  bindings: ConnectMigrationBinding[],
  opts: { now?: () => string } = {},
): ConnectRefMigrationResult {
  const empty = { assigned: [] as ConnectRefMigrationResult['assigned'], unmatched: [] as string[] };

  if (readConnectRefMigrationMarker(project)) {
    return { outcome: 'already', project, ...empty };
  }
  if (bindings.length === 0) {
    return { outcome: 'skipped', project, ...empty, reason: 'no CONNECT handoff to adopt' };
  }

  const documents = project.documents ?? [];
  if (documents.length === 0) {
    return { outcome: 'skipped', project, ...empty, reason: 'the manifest carries no document rows yet' };
  }

  // `bind`, not `report`: CONNECT's comparison IS case-insensitive, so the
  // lowercase key is the match and there is no near-miss to report. The
  // opposite choice from the scriptRef migration, and deliberately so — each
  // reproduces the runtime whose bindings it is adopting.
  const plan = planRefMigration(
    documents,
    bindings.map(b => ({ key: b.model, ref: b.connectRef, binding: b })),
    {
      field: 'connectRef',
      documentKey: modelKey,
      bindingKey: modelKey,
      caseMismatch: 'bind',
      // A reference that points outside the project cannot be adopted, and
      // saying so is news: this one DOES record its unmatched bindings.
      isBindable: entry => isContainedRef(entry.binding.connectRef),
    });

  const assigned: ConnectRefMigrationResult['assigned'] = plan.assigned.map(a => ({
    model: a.binding.binding.model,
    connectRef: a.binding.binding.connectRef,
    documentId: a.documentId,
  }));
  const unmatched = plan.unmatched.map(b => b.binding.model);

  if (assigned.length === 0 && unmatched.length === 0) {
    return { outcome: 'skipped', project, ...empty, reason: 'every binding was already authored' };
  }

  const marker: ConnectRefMigrationMarker = {
    at: (opts.now ?? (() => new Date().toISOString()))(),
    assigned: assigned.length,
    assignedIds: assigned.map(a => a.documentId),
    unmatched,
  };
  const migrated = applyRefMigration(project, plan, {
    field: 'connectRef',
    markerKey: CONNECT_REF_MIGRATION_MARKER,
    marker: marker as unknown as Record<string, unknown>,
  });
  return { outcome: 'migrated', project: migrated, assigned, unmatched };
}

/**
 * Removes everything this module wrote. Purely additive on the way in, so this
 * is a real undo — the handoff file it read is CONNECT's and stays untouched.
 */
export function rollbackConnectRefMigration(project: RvProject): RvProject {
  const marker = readConnectRefMigrationMarker(project);
  if (!marker) return project;
  return rollbackRefMigration(project, {
    field: 'connectRef',
    markerKey: CONNECT_REF_MIGRATION_MARKER,
    assignedIds: marker.assignedIds,
  });
}
