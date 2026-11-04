// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-document-info-write — change what a document says about itself
 * (plan-506 F2).
 *
 * A structural copy of `writeDocumentClassification` (`rv-document-classify`),
 * and deliberately so: the two blocks sit side by side in the same scene
 * extras, so they must be written by the same machinery or they drift into two
 * spellings of "a file-level fact". Same order — **the bytes first, the cache
 * second** — same fast path through `bakeIntoGlb` (JSON chunk patched, BIN tail
 * byte-identical), same mandatory compare-and-swap on the revision just read.
 *
 * ## What differs from the classification verb
 *
 * The block is STAMPED here: `updatedAt` (ISO-8601) and `updatedBy` (the
 * multiuser display name, when the user set one) are written by this function
 * and by nothing else. A caller's stamps are ignored — a stamp nobody can
 * forge by accident is what makes "updated 2 h ago · Thomas" worth showing.
 *
 * The row this writes into the manifest carries `extrasScan: 2` (plan-506
 * F13): the block in it was just WRITTEN into the bytes, which is at least as
 * good as having read it. It rides along with the first write instead of
 * waiting for an unrelated one.
 */

import { bakeIntoGlb } from '../hmi/scene/rv-scene-glb-bake';
import { materialise } from '../hmi/scene/rv-scene-edits';
import { loadMultiuserSettings } from '../hmi/multiuser-settings-store';
import type { ProjectBackend } from './backends/project-backend';
import { normaliseDocumentInfo, type DocumentInfo } from './rv-document-info';
import type { RvDocumentEntry } from './rv-project-types';
import type { SceneRevision } from './rv-scene-record';

/** A resolver that locates nothing — there are no node edits to place. */
const NO_NODES = { locate: () => null };

/** The multiuser default name says nothing about who wrote a description. */
const ANONYMOUS_DISPLAY_NAME = 'Browser';

export interface DocumentInfoWriteResult {
  /** What the file now says. `null` when the block was removed. */
  documentInfo: DocumentInfo | null;
  /** Revision of the stored body after the write. */
  revision: SceneRevision;
}

export interface DocumentInfoWriteOptions {
  /**
   * Keep a newly imported path-addressed blob in its existing storage. The
   * browser backend interprets ref.meta as intent to create an id-addressed
   * scene. The caller remains responsible for recording the manifest row.
   */
  addressByPath?: boolean;
  /** Clock for the `updatedAt` stamp — injectable for tests. */
  now?: () => Date;
  /**
   * Display name for the `updatedBy` stamp. `undefined` resolves the
   * multiuser display name (omitted while it is still the anonymous default);
   * `null` omits the stamp.
   */
  updatedBy?: string | null;
}

/**
 * The display name the stamp uses when the caller does not name one.
 *
 * The one identity concept the product already has is the multiuser display
 * name; a second one for a text field would be a new concept for a footnote.
 * Its default (`Browser`) names nobody and is left out.
 */
export function defaultDocumentInfoAuthor(): string | undefined {
  try {
    const name = loadMultiuserSettings().displayName?.trim();
    if (!name || name === ANONYMOUS_DISPLAY_NAME) return undefined;
    return name;
  } catch {
    return undefined;
  }
}

/**
 * Read a document's bytes, patch its `DocumentInfo`, write them back.
 *
 * `info === null` — or a block with neither summary nor description — removes
 * the block, so "never described" and "described as nothing" stay one state on
 * disk. Throws rather than reporting failure in-band: a read-only project, an
 * unreadable body, or a revision somebody else replaced in the meantime.
 */
export async function writeDocumentInfo(
  backend: ProjectBackend,
  doc: RvDocumentEntry,
  info: DocumentInfo | null,
  opts: DocumentInfoWriteOptions = {},
): Promise<DocumentInfoWriteResult> {
  if (!backend.writable) throw new Error('This project is read-only.');
  const text = info ? normaliseDocumentInfo({ v: 1, summary: info.summary, description: info.description }) : null;
  let next: DocumentInfo | null = null;
  if (text) {
    next = { ...text, updatedAt: (opts.now?.() ?? new Date()).toISOString() };
    const by = opts.updatedBy === undefined ? defaultDocumentInfoAuthor() : opts.updatedBy?.trim();
    if (by) next.updatedBy = by;
  }

  const record = await backend.readDocument({ path: doc.path, id: doc.id });
  if (!record) throw new Error(`"${doc.name}" could not be read from this project.`);

  const baked = await bakeIntoGlb(record.bytes, materialise([]), NO_NODES, {
    documentInfo: next,
    self: { assetId: doc.id, path: doc.path },
  });
  const meta: RvDocumentEntry = { ...doc, extrasScan: 2 };
  if (next) meta.documentInfo = next;
  else delete meta.documentInfo;
  const { revision } = await backend.writeDocument(
    opts.addressByPath ? doc.path : { path: doc.path, id: doc.id, meta },
    baked.glb,
    // The revision of what was just read: whoever replaced it in the meantime
    // wrote a description of their own, and overwriting it silently is the
    // lost update this precondition exists to refuse.
    { expectedRevision: record.revision },
  );
  return { documentInfo: next, revision };
}
