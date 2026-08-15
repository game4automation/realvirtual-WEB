// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-project-knowledge — what `documents[].knowledgeRef` points at (plan-718
 * §2.3, stage 3.1).
 *
 * The manifest row names ONE file and nothing else. That file — a small JSON
 * with `$schema: "rv-knowledge/1.0"` — is what names the PDFs and, optionally,
 * the RAG bundle:
 *
 * ```jsonc
 * { "$schema": "rv-knowledge/1.0",
 *   "documents": [ { "title": "Betriebsanleitung", "ref": "docs/linie1/manual.pdf" } ],
 *   "ragRef": "rag/linie1.zip" }
 * ```
 *
 * ## Why a file and not three more manifest fields
 *
 * A machine's documentation is a list that grows, gets reordered and is often
 * generated. Putting it on the document row would make every added PDF a
 * manifest write under compare-and-swap, and would put a build's output into
 * the file the app treats as its own. The row therefore carries a reference,
 * the knowledge file carries the list, and the two have different authors.
 *
 * The consequence worth stating: **there is no `docs/` and no `rag/`
 * convention here.** Every path inside the knowledge file is a project-relative
 * reference resolved exactly like a manifest reference, so a project may keep
 * its manuals wherever it likes. Nothing in this module scans a folder.
 *
 * ## Tolerance, following `_applySettings`
 *
 * The loader is the same shape as `ProjectStore._applySettings`
 * (`project-store.ts`): try/catch around the read, a `$schema` discriminator
 * before anything is believed, and "absent" as the answer to every failure.
 * Concretely:
 *
 *  - **No `knowledgeRef`** → `null`. The feature is not there; not an error.
 *  - **Reference leaves the project** → `null` (containment is strict, §2.3).
 *  - **Target missing or unreadable** → `null` plus a warning, because the
 *    manifest promised something the project does not have — that is worth
 *    saying out loud once, and `validate-project.mjs` says it again on the way
 *    out.
 *  - **Wrong or missing `$schema`** → `null` plus a warning. The browser
 *    backend answers `readSettings()` with the settings blob no matter which
 *    path it is asked for; the discriminator is what keeps that from being
 *    mistaken for a knowledge file.
 *  - **A single unusable row** costs that row, never the file.
 *
 * ## One known limitation of the read path
 *
 * The folder backend resolves a settings path through `readSettingsFile`, whose
 * `splitRelPath` handles exactly ONE folder level (`getDirectoryHandle` cannot
 * take `a/b`). So `knowledge/linie-1.json` reads and `docs/linie1/knowledge.json`
 * reads as *absent* — which is the honest outcome, and reported as a dead
 * reference rather than swallowed. Deepening that resolver is a change to the
 * storage layer every backend shares, and belongs to whoever needs it first.
 *
 * ## Consumer
 *
 * OPEN. The viewer's existing documentation surfaces are configured elsewhere
 * (the `aas-link` plugin's `pdfLinks`, the build-generated `docs-index.json`),
 * and neither is per-document. This module therefore ships as the resolution
 * API — {@link knowledgeForDocument} — and the first consumer wires itself to
 * it rather than to a second way of finding a PDF.
 */

import { findDocumentById } from './rv-asset-identity';
import { isContainedRef, normalizeRefPath, readDocumentRef } from './rv-project-refs';
import type { RvProject } from './rv-project-types';

/** Discriminator every knowledge file must carry. */
export const KNOWLEDGE_SCHEMA = 'rv-knowledge/1.0';

/** One referenced document — a PDF in practice, but nothing here says so. */
export interface RvKnowledgeDocument {
  /** Human-readable label. Falls back to the file name when the file omits it. */
  title: string;
  /** Project-relative path of the referenced file. */
  ref: string;
  /** Optional free-form kind (`pdf`, `image`, …) as written by the author. */
  kind?: string;
  [key: string]: unknown;
}

/** A parsed knowledge file. */
export interface RvKnowledge {
  /** The referenced documents, in file order, containment already enforced. */
  documents: RvKnowledgeDocument[];
  /** The RAG bundle this knowledge set was built from, when it names one. */
  ragRef: string | null;
  /**
   * What was dropped and why — rows whose reference is missing or leaves the
   * project. Kept rather than thrown so a caller can surface a partial file
   * without having to re-read it.
   */
  rejected: Array<{ ref: string; reason: 'not-a-reference' | 'escapes' }>;
}

function titleOf(value: unknown, ref: string): string {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  const leaf = ref.split('/').pop() ?? ref;
  return leaf;
}

/**
 * Parse a knowledge payload. Returns null when it is not one.
 *
 * Null covers both "not an object" and "wrong `$schema`" on purpose: the caller
 * has one absent case to handle, and the reason is a warning, not a variant.
 */
export function parseKnowledge(raw: unknown): RvKnowledge | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const root = raw as { $schema?: unknown; documents?: unknown; ragRef?: unknown };
  if (root.$schema !== KNOWLEDGE_SCHEMA) return null;

  const documents: RvKnowledgeDocument[] = [];
  const rejected: RvKnowledge['rejected'] = [];
  if (Array.isArray(root.documents)) {
    for (const row of root.documents) {
      if (typeof row !== 'object' || row === null || Array.isArray(row)) continue;
      const entry = row as { ref?: unknown; path?: unknown; title?: unknown; kind?: unknown };
      // `path` is accepted beside `ref` because docs-index.json spells it that
      // way and hand-written files copy from whatever they saw last.
      const rawRef = typeof entry.ref === 'string' ? entry.ref
        : typeof entry.path === 'string' ? entry.path
        : null;
      if (rawRef === null || rawRef.trim() === '') {
        rejected.push({ ref: String(entry.ref ?? entry.path ?? ''), reason: 'not-a-reference' });
        continue;
      }
      if (!isContainedRef(rawRef)) {
        rejected.push({ ref: rawRef, reason: 'escapes' });
        continue;
      }
      const ref = normalizeRefPath(rawRef);
      documents.push({
        ...(row as Record<string, unknown>),
        title: titleOf(entry.title, ref),
        ref,
        ...(typeof entry.kind === 'string' ? { kind: entry.kind } : {}),
      });
    }
  }

  let ragRef: string | null = null;
  if (typeof root.ragRef === 'string' && root.ragRef.trim() !== '') {
    if (isContainedRef(root.ragRef)) ragRef = normalizeRefPath(root.ragRef);
    else rejected.push({ ref: root.ragRef, reason: 'escapes' });
  }

  return { documents, ragRef, rejected };
}

/** The knowledge reference of one document row, or null. Pure, no I/O. */
export function knowledgeRefForDocument(
  project: RvProject | null | undefined,
  documentId: string,
): string | null {
  return readDocumentRef(findDocumentById(project, documentId), 'knowledgeRef');
}

/**
 * The subset of a project backend this module needs — the same
 * `readSettings(relPath)` the settings bundle is read through, and nothing else.
 *
 * Narrow on purpose: a knowledge file is JSON at a project-relative path, which
 * is exactly what that method already answers on all three backends.
 */
export interface KnowledgeSource {
  readSettings(relPath?: string): Promise<unknown | null>;
}

/**
 * Resolve and read the knowledge file bound to `documentId`.
 *
 * Returns null whenever the feature is absent for any reason; `onWarning` — when
 * given — receives the one-line explanation for the cases where the manifest
 * promised something that is not there.
 */
export async function knowledgeForDocument(
  project: RvProject | null | undefined,
  documentId: string,
  source: KnowledgeSource | null | undefined,
  onWarning?: (message: string) => void,
): Promise<RvKnowledge | null> {
  const ref = knowledgeRefForDocument(project, documentId);
  if (!ref || !source) return null;

  let raw: unknown;
  try {
    raw = await source.readSettings(ref);
  } catch (e) {
    onWarning?.(`Knowledge file "${ref}" could not be read: ${String(e)}`);
    return null;
  }
  if (raw === null || raw === undefined) {
    onWarning?.(`Knowledge file "${ref}" is referenced but missing.`);
    return null;
  }
  const parsed = parseKnowledge(raw);
  if (!parsed) {
    onWarning?.(`"${ref}" is not a knowledge file (expected $schema "${KNOWLEDGE_SCHEMA}").`);
    return null;
  }
  return parsed;
}
