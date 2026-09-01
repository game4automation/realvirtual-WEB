// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-project-refs — the reference model of plan-718 §2.1, in one module.
 *
 * A project is a directory that must survive being copied. Everything a
 * document needs beyond its own bytes — the CONNECT configuration it talks to,
 * the project's own code, its knowledge file — is therefore named **on the
 * document row** as a project-relative path, and nowhere else:
 *
 * > Nothing is found by a fixed path, a folder scan or a name comparison. All
 * > bindings are references in the manifest.
 *
 * Three properties fall out of that, and this module is where each of them is
 * actually enforced:
 *
 *  - **N:1 needs no modelling.** Two rows carrying the same value share the
 *    file. There is no registry and no reverse list to keep in sync — the
 *    reverse direction is a scan of `documents[]` ({@link documentsWithRef}),
 *    which cannot go stale because there is nothing to update.
 *  - **A rename cannot break a binding.** The reference hangs on the row, whose
 *    id is frozen at birth (plan-717); renaming the GLB rewrites `path` and
 *    leaves everything else alone.
 *  - **A reference cannot leave the project.** Containment is strict (user
 *    decision 2026-08-14): a project that points outside itself is a project
 *    that does not survive being copied, which is the one thing the whole model
 *    exists to guarantee. {@link assertContainedRef} refuses on the way in, and
 *    `scripts/validate-project.mjs` refuses again on the way out.
 *
 * ## Writing goes through the CAS funnel, always
 *
 * {@link setDocumentRef} is a thin delta on top of `updateManifestCas` — read,
 * change one field, write under a compare-and-swap precondition, retry against
 * the fresh state on conflict. It never calls `commitDocuments()` or
 * `replaceManifest()`: those write a manifest built from an earlier read, which
 * is how a concurrent writer's row disappears (plan-717 R2-F1). The `apply`
 * callback here is a pure function of the manifest it is handed, which is what
 * makes retrying it safe.
 */

import type { RvDocumentEntry, RvProject } from './rv-project-types';
import { updateManifestCas } from './rv-project-storage';

// ─── The fields ─────────────────────────────────────────────────────────

/** The three per-document reference fields, in schema order. */
export const DOCUMENT_REF_FIELDS = ['connectRef', 'scriptRef', 'knowledgeRef'] as const;

/** One of the three per-document reference fields. */
export type DocumentRefField = (typeof DOCUMENT_REF_FIELDS)[number];

/**
 * Where a project's secrets sidecar lives when `connect.secretsRef` says nothing.
 *
 * A default, not a convention: a project may point the field anywhere inside
 * itself, and nothing scans for this name.
 */
export const DEFAULT_SECRETS_REF = 'connect/secrets.local.json';

/**
 * The file ending that makes a file a CONNECT configuration.
 *
 * The ENDING is the classification, never the folder: `connect/` is merely the
 * conventional place CONNECT writes its profiles to, and a config that a user
 * keeps next to its model is exactly as much a config. Anything that wants to
 * treat CONNECT configs specially (cards, badges, ref pickers) must ask
 * {@link isConnectConfigPath} instead of looking at the directory.
 */
export const CONNECT_CONFIG_SUFFIX = '.connect.json';

/** Is this path a CONNECT configuration file — by ending, wherever it sits? */
export function isConnectConfigPath(path: string | null | undefined): boolean {
  return typeof path === 'string'
    && path.trim().toLowerCase().endsWith(CONNECT_CONFIG_SUFFIX);
}

/**
 * The file ending that makes a file a knowledge document (plan-718
 * `knowledgeRef`). Same rule as {@link CONNECT_CONFIG_SUFFIX}: the ENDING is
 * the classification, never the folder — a machine's knowledge file may sit
 * right next to its model.
 */
export const KNOWLEDGE_FILE_SUFFIX = '.knowledge.md';

/** Is this path a knowledge file — by ending, wherever it sits? */
export function isKnowledgeFilePath(path: string | null | undefined): boolean {
  return typeof path === 'string'
    && path.trim().toLowerCase().endsWith(KNOWLEDGE_FILE_SUFFIX);
}

/**
 * The DISPLAY form of a config path: the `.connect.json` ending removed.
 *
 * The ending is machinery — it is how a config is recognised, not part of its
 * name — so no user-visible string ever shows it (user decision 2026-08-19).
 * The full path stays the identity everywhere else; this is presentation only.
 * A non-config path passes through unchanged, so callers may apply it blindly.
 */
export function stripConnectConfigSuffix(path: string): string {
  const trimmed = String(path ?? '').trim();
  return isConnectConfigPath(trimmed)
    ? trimmed.slice(0, -CONNECT_CONFIG_SUFFIX.length)
    : trimmed;
}

/** {@link stripConnectConfigSuffix}'s knowledge twin — presentation only. */
export function stripKnowledgeFileSuffix(path: string): string {
  const trimmed = String(path ?? '').trim();
  return isKnowledgeFilePath(trimmed)
    ? trimmed.slice(0, -KNOWLEDGE_FILE_SUFFIX.length)
    : trimmed;
}

// ─── Paths ──────────────────────────────────────────────────────────────

/**
 * The one spelling of a reference: `/`-separated, no leading `./` or `/`.
 *
 * Windows hands out backslashes, a file picker hands out a leading slash, and a
 * hand-edited manifest hands out both. Normalising once here is what lets N:1 be
 * a string comparison — two rows that mean the same file must not miss each
 * other over a separator.
 */
export function normalizeRefPath(ref: string): string {
  return String(ref ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.?\//, '')
    .replace(/\/+$/, '');
}

/** Thrown when a reference would leave the project directory. */
export class RefContainmentError extends Error {
  constructor(readonly ref: string, readonly field?: string) {
    super(
      `"${ref}" is not a valid ${field ?? 'project'} reference — `
      + 'references must be relative paths inside the project.',
    );
    this.name = 'RefContainmentError';
  }
}

/**
 * Whether `ref` stays inside the project.
 *
 * Rejected: the empty string, an absolute POSIX path, a Windows drive letter, a
 * URL, and any `..` segment. The check is on SEGMENTS, not on the substring
 * `..`, so a perfectly ordinary `models/v..2/a.glb` passes while `../out.json`
 * and `a/../../out.json` do not.
 *
 * There is no symlink half here on purpose: a browser has no way to resolve one
 * and no way to be exposed to one either — this is a string in a JSON file, and
 * the file system that could hold a link is CONNECT's side of the contract
 * (plan-718 §2.3, stage 1).
 */
export function isContainedRef(ref: unknown): ref is string {
  if (typeof ref !== 'string') return false;
  const raw = ref.trim();
  if (raw === '') return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) return false; // scheme, and `C:` with it
  if (raw.startsWith('/') || raw.startsWith('\\')) return false;
  return !normalizeRefPath(raw).split('/').includes('..');
}

/** {@link isContainedRef}, as a refusal. */
export function assertContainedRef(ref: unknown, field?: string): string {
  if (!isContainedRef(ref)) throw new RefContainmentError(String(ref), field);
  return normalizeRefPath(ref);
}

// ─── Reading ────────────────────────────────────────────────────────────

/**
 * The normalised value of one reference field, or null.
 *
 * A reference that is not contained reads as **null rather than throwing**: a
 * broken manifest must not make a project unopenable, and "the feature is not
 * there" is the same answer a missing field gives. The loud version of the same
 * finding is the validator's job.
 */
export function readDocumentRef(
  entry: RvDocumentEntry | null | undefined,
  field: DocumentRefField,
): string | null {
  const raw = entry?.[field];
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  return isContainedRef(raw) ? normalizeRefPath(raw) : null;
}

/** Every document bound to `ref` through `field` — the N:1 set, in manifest order. */
export function documentsWithRef(
  project: RvProject | null | undefined,
  field: DocumentRefField,
  ref: string,
): RvDocumentEntry[] {
  const wanted = normalizeRefPath(ref);
  if (wanted === '') return [];
  return (project?.documents ?? []).filter(d => readDocumentRef(d, field) === wanted);
}

/** One entry per reference actually set in the manifest. Diagnostics and validation. */
export function documentRefsOf(
  project: RvProject | null | undefined,
): Array<{ documentId: string; field: DocumentRefField; ref: string }> {
  const out: Array<{ documentId: string; field: DocumentRefField; ref: string }> = [];
  for (const doc of project?.documents ?? []) {
    for (const field of DOCUMENT_REF_FIELDS) {
      const ref = readDocumentRef(doc, field);
      if (ref) out.push({ documentId: String(doc.id ?? ''), field, ref });
    }
  }
  return out;
}

/** The project-wide CONNECT references, with the sidecar default filled in. */
export function projectConnectRefs(
  project: RvProject | null | undefined,
): { agentsRef: string | null; secretsRef: string; ragRef: string | null } {
  const connect = project?.connect;
  const agents = typeof connect?.agentsRef === 'string' ? connect.agentsRef : null;
  const secrets = typeof connect?.secretsRef === 'string' ? connect.secretsRef : null;
  // `ragRef` has no default twin: a project either ships a RAG bundle or it does
  // not, and inventing a path for one that does not exist would turn "no
  // knowledge base" into a dead reference (plan-718 stage 3.3).
  const rag = typeof connect?.ragRef === 'string' ? connect.ragRef : null;
  return {
    agentsRef: agents && isContainedRef(agents) ? normalizeRefPath(agents) : null,
    secretsRef: secrets && isContainedRef(secrets) ? normalizeRefPath(secrets) : DEFAULT_SECRETS_REF,
    ragRef: rag && isContainedRef(rag) ? normalizeRefPath(rag) : null,
  };
}

// ─── Resolving a loading model back to its row ──────────────────────────

/**
 * The `scriptRef` bound to the document whose bytes are at `modelUrl`, or null.
 *
 * The manager that calls this knows a URL and nothing else — it is handed one by
 * `loadModel()`, sometimes a `blob:` one. So the match is on the tail of the
 * path: a row's `path` matches when the URL ends with it on a segment boundary,
 * longest row first, so `models/a/linie1.glb` wins over `linie1.glb` when both
 * exist. Query strings are ignored; the extension is not, because two documents
 * may differ only in it.
 *
 * A URL that matches no row yields null, which is simply "this model is not a
 * document of the open project" — a bundled demo, a dropped file, a library part
 * opened directly.
 */
export function scriptRefForModelUrl(
  project: RvProject | null | undefined,
  modelUrl: string,
): string | null {
  const doc = documentForModelUrl(project, modelUrl);
  return doc ? readDocumentRef(doc, 'scriptRef') : null;
}

/** The document row whose `path` the given model URL ends with. See {@link scriptRefForModelUrl}. */
export function documentForModelUrl(
  project: RvProject | null | undefined,
  modelUrl: string,
): RvDocumentEntry | null {
  const url = normalizeRefPath(String(modelUrl ?? '').split('?')[0].split('#')[0]);
  if (url === '') return null;
  const candidates = (project?.documents ?? [])
    .filter(d => typeof d.path === 'string' && d.path.trim() !== '')
    .sort((a, b) => String(b.path).length - String(a.path).length);
  for (const doc of candidates) {
    const path = normalizeRefPath(String(doc.path));
    if (path === '') continue;
    if (url === path || url.endsWith(`/${path}`)) return doc;
  }
  return null;
}

// ─── Writing: pure ──────────────────────────────────────────────────────

/**
 * Set (or, with `null`, clear) one reference on one row. Pure.
 *
 * Returns the SAME object when nothing changes, so a caller can use identity to
 * decide whether a write is needed at all — the convention `moveDocumentPath`
 * and `rewriteDocsIndexPaths` already follow.
 */
export function setDocumentRefOn(
  project: RvProject,
  documentId: string,
  field: DocumentRefField,
  ref: string | null,
): RvProject {
  const documents = project.documents ?? [];
  const row = documents.find(d => d.id === documentId);
  if (!row) {
    throw new Error(
      `Cannot set ${field} — this project has no document with id "${documentId}".`,
    );
  }
  const next = ref === null ? null : assertContainedRef(ref, field);
  const current = typeof row[field] === 'string' ? normalizeRefPath(row[field] as string) : null;
  if (current === next) return project;

  return {
    ...project,
    documents: documents.map(d => {
      if (d !== row) return d;
      if (next === null) {
        const { [field]: _dropped, ...rest } = d;
        return rest as RvDocumentEntry;
      }
      return { ...d, [field]: next };
    }),
  };
}

/**
 * Repoint every reference that points at a moved file — the BACKWARD direction
 * (plan-718 §2.4, R3).
 *
 * `moveDocumentPath` repoints a row at its own bytes. This repoints OTHER rows
 * at a file that is not theirs, which is the structurally new part: a connect
 * config or a script has no document row of its own, so nothing else in the
 * system would ever notice it moved. Forgetting this direction is how a move
 * leaves dead references behind.
 *
 * A move whose `from` is a FOLDER repoints everything beneath it, matched on a
 * `/` boundary so `scripts/line1` never captures `scripts/line10`. Tree-move
 * flattens folder moves into their descendants before it gets here, so that
 * branch is belt-and-braces for callers that do not.
 *
 * Returns the same project object when nothing pointed at anything moved.
 */
export function repointDocumentRefs(
  project: RvProject,
  moves: ReadonlyArray<{ from: string; to: string }>,
): { project: RvProject; rewritten: number } {
  const pairs = moves
    .map(m => ({ from: normalizeRefPath(m.from), to: normalizeRefPath(m.to) }))
    .filter(m => m.from !== '' && m.to !== '' && m.from !== m.to);
  if (pairs.length === 0) return { project, rewritten: 0 };

  const repoint = (ref: string): string | null => {
    for (const { from, to } of pairs) {
      if (ref === from) return to;
      if (ref.startsWith(`${from}/`)) return `${to}${ref.slice(from.length)}`;
    }
    return null;
  };

  let rewritten = 0;
  const documents = (project.documents ?? []).map(doc => {
    let next = doc;
    for (const field of DOCUMENT_REF_FIELDS) {
      const ref = readDocumentRef(next, field);
      if (!ref) continue;
      const moved = repoint(ref);
      if (moved === null || moved === ref) continue;
      next = { ...next, [field]: moved };
      rewritten++;
    }
    return next;
  });
  if (rewritten === 0) return { project, rewritten: 0 };
  return { project: { ...project, documents }, rewritten };
}

// ─── Writing: persistent ────────────────────────────────────────────────

/**
 * Persist one reference change through the manifest's compare-and-swap funnel.
 *
 * Durable first, then in-memory: the caller re-reads the returned project rather
 * than patching its own copy, so a conflict retry cannot leave the two
 * disagreeing (plan-717 R2-F3).
 *
 * @deprecated **Dead as of plan-725 §2.7 — verified, not assumed.**
 * `grep -rn "setDocumentRef\b" src tests` finds only this definition and the
 * doc reference at the top of this file: nothing calls it. Every live write of
 * a document reference goes through `ProjectStore._setDocumentRefField`, which
 * also updates the in-memory rows and — since plan-725 — tells a running
 * CONNECT gateway. This second door does neither, so a caller that found it
 * would get a manifest the app does not know it wrote. Delete it or route it
 * through the store; do not build on it.
 */
export async function setDocumentRef(
  dir: FileSystemDirectoryHandle,
  documentId: string,
  field: DocumentRefField,
  ref: string | null,
): Promise<{ project: RvProject; revision: string }> {
  // Refuse before the first read: a containment error is a caller bug, and
  // discovering it inside a retry loop would report it three times.
  if (ref !== null) assertContainedRef(ref, field);
  return updateManifestCas(dir, current => {
    if (!current) {
      throw new Error(`Cannot set ${field} — this project has no manifest.`);
    }
    return setDocumentRefOn(current, documentId, field, ref);
  });
}
