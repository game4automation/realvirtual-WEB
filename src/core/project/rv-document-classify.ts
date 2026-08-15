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
 * ## Compare-and-swap on BOTH surfaces (plan-709 §2.3)
 *
 * A scene body goes in through `writeScene`, which has carried the plan-397
 * precondition since it existed: the revision read a moment ago must still be
 * the revision stored, or the write is refused rather than clobbering somebody
 * else's. The asset surface used to have no such precondition, and this
 * function reported the split honestly (`surface: 'blob'` meant "unprotected").
 *
 * plan-709 gave `writeBlob` the same optional precondition, so the split is
 * gone: the asset branch hashes what it read and hands that back as
 * `expectedRevision`. `surface` survives as a description of WHICH store took
 * the bytes — a fact callers and tests still use — but it no longer implies
 * anything about safety, because both are now safe.
 */

import { bakeIntoGlb } from '../hmi/scene/rv-scene-glb-bake';
import { materialise } from '../hmi/scene/rv-scene-edits';
import type { ProjectBackend } from './backends/project-backend';
import { sectionOfDocument } from './rv-project-documents';
import { isEmptyClassification, type DocumentClassification } from './rv-document-classification';
import type { RvDocumentEntry, RvProjectSceneEntry } from './rv-project-types';
import { revisionOfBytes, type SceneRevision } from './rv-scene-record';

/** A resolver that locates nothing — there are no node edits to place. */
const NO_NODES = { locate: () => null };

export interface ClassifyResult {
  /** What the file now says it is. `null` when the block was removed. */
  classification: DocumentClassification | null;
  /** Which write surface carried the bytes — the CAS one, or the plain one. */
  surface: 'scene' | 'blob';
  /** Revision of the stored body, where the surface reports one. */
  revision?: SceneRevision;
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
  const section = sectionOfDocument(doc);

  if (section === 'scenes') {
    const record = await backend.readScene(doc.path);
    if (!record?.glb) {
      throw new Error(`"${doc.name}" could not be read from this project.`);
    }
    const baked = await bakeIntoGlb(record.glb, materialise([]), NO_NODES, {
      classification: next,
      self: { assetId: doc.id, path: doc.path },
    });
    const revision = await backend.writeScene(doc.path, {
      glb: baked.glb,
      // The manifest metadata the body write carries with it. The document IS
      // the entry since phase 6 — one list, one shape — so the only thing to do
      // here is to state the classification that was just written into the
      // bytes, and let the manifest cache follow them (§2.5).
      meta: {
        ...doc,
        ...(next ? { classification: next } : { classification: undefined }),
      } as RvProjectSceneEntry,
      expectedRevision: record.revision,
    });
    return { classification: next, surface: 'scene', revision };
  }

  const resolved = await backend.readBlobUrl(doc.path);
  if (!resolved) throw new Error(`"${doc.name}" could not be read from this project.`);
  let bytes: ArrayBuffer;
  try {
    bytes = await (await fetch(resolved.url)).arrayBuffer();
  } finally {
    // Always: an object URL that outlives its read is a leak whether the read
    // succeeded or threw.
    resolved.release();
  }
  // The revision of what was just read — the same compare-and-swap token the
  // scene branch gets from `readScene`, computed here because `readBlobUrl`
  // hands back bytes rather than a record. Since plan-709 §2.3 `writeBlob`
  // carries the precondition too, so the split this function used to REPORT
  // (`surface: 'blob'` meaning "no precondition") is gone: both branches now
  // refuse a write whose basis somebody else replaced.
  const readRevision = await revisionOfBytes(bytes);
  const baked = await bakeIntoGlb(bytes, materialise([]), NO_NODES, {
    classification: next,
    self: { assetId: doc.id, path: doc.path },
  });
  await backend.writeBlob(
    doc.path,
    new Blob([baked.glb as BlobPart], { type: 'model/gltf-binary' }),
    { expectedRevision: readRevision },
  );
  return { classification: next, surface: 'blob', revision: await revisionOfBytes(baked.glb) };
}
