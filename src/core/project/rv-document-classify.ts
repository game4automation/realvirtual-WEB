// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-document-classify — change what a document says it is (plan-413 §2.5,
 * phase 4).
 *
 * One verb, and it writes in one order: **the bytes first, the cache second.**
 * The classification lives in the GLB (phase 1); the manifest entry is a
 * listing cache of it. A torn write must therefore leave a document whose file
 * is right and whose manifest row is stale — which the next scan repairs —
 * never a manifest row describing bytes that were never written. That is the
 * same "sidecar follows the bytes" rule `library-asset-ops` has followed since
 * plan-372, applied to the one field the file is authoritative for.
 *
 * ## Why the patch goes through `bakeIntoGlb`
 *
 * With no edits to fold in, `bakeIntoGlb` takes its fast path: it patches the
 * JSON chunk and hands the BIN tail back byte-identical. So the write costs the
 * size of the file's JSON, not a re-export, and — the reason that matters — it
 * is the *same* writer the save path uses, so a classification written here and
 * one written by a Save cannot drift into two spellings of the same block.
 *
 * ## One surface, one compare-and-swap (plan-736 §2.3 #1)
 *
 * This function used to have two halves. A scene body went in through
 * `writeScene`, which has carried the plan-397 precondition since it existed;
 * everything else went through `writeBlob`, which had none until plan-709 and
 * an optional one after it. Which half ran was decided by
 * `sectionOfDocument(doc)` — the last place in the product where a manifest
 * field chose a storage protocol.
 *
 * Both halves are now `readDocument`/`writeDocument` with a mandatory
 * precondition, so the branch is gone and with it the `surface` field this
 * result used to report. What survives is the property the branch existed to
 * provide: the revision read a moment ago must still be the revision stored,
 * or the write is refused rather than clobbering somebody else's
 * classification.
 */

import { bakeIntoGlb } from '../hmi/scene/rv-scene-glb-bake';
import { materialise } from '../hmi/scene/rv-scene-edits';
import type { ProjectBackend } from './backends/project-backend';
import { isEmptyClassification, type DocumentClassification } from './rv-document-classification';
import type { RvDocumentEntry, RvProjectSceneEntry } from './rv-project-types';
import type { SceneRevision } from './rv-scene-record';

/** A resolver that locates nothing — there are no node edits to place. */
const NO_NODES = { locate: () => null };

export interface ClassifyResult {
  /** What the file now says it is. `null` when the block was removed. */
  classification: DocumentClassification | null;
  /**
   * Revision of the stored body.
   *
   * No longer optional, and `surface` is gone beside it (plan-736): it named
   * WHICH of two write surfaces took the bytes, and there is one. Its last
   * honest use was as a hint about safety — `'blob'` once meant "written
   * without a precondition" — which plan-709 already made false and plan-736
   * made unrepresentable.
   */
  revision: SceneRevision;
}

/**
 * Read a document's bytes, patch its classification, write them back.
 *
 * `classification` follows the three-state convention of the bake path:
 * a value replaces, `null` removes the block. An empty classification (no
 * level, no tags) is treated as `null`, so "classified as nothing" and "never
 * classified" stay one state on disk — phase 1 made that choice for the GLB and
 * this is the caller that would otherwise re-introduce the second one.
 *
 * Throws rather than reporting failure in-band: every caller here runs inside
 * the dashboard's `runVerb`, which exists to surface exactly this.
 */
export async function writeDocumentClassification(
  backend: ProjectBackend,
  doc: RvDocumentEntry,
  classification: DocumentClassification | null,
): Promise<ClassifyResult> {
  if (!backend.writable) throw new Error('This project is read-only.');
  const next = classification !== null && !isEmptyClassification(classification)
    ? classification
    : null;

  // The `section === 'scenes'` branch that used to stand here is gone
  // (plan-736 §2.3 #1). It was the ONE place that chose a storage protocol from
  // a manifest field: a scene went through `readScene`/`writeScene` with a
  // compare-and-swap, everything else through `readBlobUrl`/`writeBlob`
  // without one. There is now a single protocol with the precondition always
  // on, so the branch has nothing left to decide — the two halves it guarded
  // were the same six lines with different method names.
  const record = await backend.readDocument({ path: doc.path, id: doc.id });
  if (!record) throw new Error(`"${doc.name}" could not be read from this project.`);

  const baked = await bakeIntoGlb(record.bytes, materialise([]), NO_NODES, {
    classification: next,
    self: { assetId: doc.id, path: doc.path },
  });
  const { revision } = await backend.writeDocument(
    {
      path: doc.path,
      id: doc.id,
      // The manifest metadata the body write carries with it. The document IS
      // the entry since plan-413 phase 6 — one list, one shape — so the only
      // thing to do here is to state the classification that was just written
      // into the bytes, and let the manifest cache follow them (§2.5).
      meta: {
        ...doc,
        ...(next ? { classification: next } : { classification: undefined }),
      } as RvProjectSceneEntry,
    },
    baked.glb,
    // The revision of what was just read: whoever replaced it in the meantime
    // wrote a classification of their own, and overwriting it silently is the
    // lost update this precondition exists to refuse.
    { expectedRevision: record.revision },
  );
  return { classification: next, revision };
}
