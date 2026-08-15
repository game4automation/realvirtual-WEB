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

  const byKey = new Map<string, RvDocumentEntry>();
  for (const doc of documents) {
    const path = typeof doc.path === 'string' ? doc.path : '';
    if (!path) continue;
    const key = modelKey(path);
    // First row wins: two GLBs with the same leaf name in different folders are ambiguous under
    // the LEGACY comparison, and the legacy comparison is the only thing that could ever have
    // bound them. Picking the first reproduces what CONNECT did; guessing would not.
    if (!byKey.has(key)) byKey.set(key, doc);
  }

  const refByDocument = new Map<RvDocumentEntry, string>();
  const assigned: ConnectRefMigrationResult['assigned'] = [];
  const unmatched: string[] = [];

  for (const binding of bindings) {
    if (!isContainedRef(binding.connectRef)) {
      unmatched.push(binding.model);
      continue;
    }
    const doc = byKey.get(modelKey(binding.model));
    if (!doc) {
      unmatched.push(binding.model);
      continue;
    }
    // An authored connectRef is never overwritten — a human already answered this question.
    const current = doc.connectRef;
    if (typeof current === 'string' && normalizeRefPath(current) !== '') continue;
    if (refByDocument.has(doc)) continue;
    refByDocument.set(doc, binding.connectRef);
    assigned.push({ model: binding.model, connectRef: binding.connectRef, documentId: String(doc.id ?? '') });
  }

  if (assigned.length === 0 && unmatched.length === 0) {
    return { outcome: 'skipped', project, ...empty, reason: 'every binding was already authored' };
  }

  const marker: ConnectRefMigrationMarker = {
    at: (opts.now ?? (() => new Date().toISOString()))(),
    assigned: assigned.length,
    assignedIds: assigned.map(a => a.documentId),
    unmatched,
  };
  const migrated: RvProject = {
    ...project,
    documents: documents.map(doc => {
      const ref = refByDocument.get(doc);
      return ref ? { ...doc, connectRef: ref } : doc;
    }),
    [CONNECT_REF_MIGRATION_MARKER]: marker,
  };
  return { outcome: 'migrated', project: migrated, assigned, unmatched };
}

/**
 * Removes everything this module wrote. Purely additive on the way in, so this
 * is a real undo — the handoff file it read is CONNECT's and stays untouched.
 */
export function rollbackConnectRefMigration(project: RvProject): RvProject {
  const marker = readConnectRefMigrationMarker(project);
  if (!marker) return project;
  const assignedIds = new Set(marker.assignedIds);
  const out: Record<string, unknown> = { ...(project as Record<string, unknown>) };
  delete out[CONNECT_REF_MIGRATION_MARKER];
  out.documents = (project.documents ?? []).map(doc => {
    if (!assignedIds.has(String(doc.id ?? ''))) return doc;
    const { connectRef: _dropped, ...rest } = doc;
    return rest as RvDocumentEntry;
  });
  return out as RvProject;
}
