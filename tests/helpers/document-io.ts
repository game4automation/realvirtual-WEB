// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * The two call shapes the backend tests used before plan-736 unified the write
 * surface, expressed over `writeDocument`.
 *
 * ## Why these exist rather than 150 rewritten call sites
 *
 * `writeScene(path, { glb, meta, expectedRevision })` and
 * `writeBlob(path, blob, opts?)` are gone from `ProjectBackend`; there is one
 * `writeDocument(ref, bytes, { expectedRevision })`. The adaptation each of the
 * two needs is real but tiny, and — this is the point — it is **the same
 * adaptation production performs**: `rv-scene-glb-io.ts` builds exactly the
 * {@link DocRef} {@link writeSceneDocument} builds, and every migrated asset
 * write does what {@link writeBlobDocument} does.
 *
 * So these are not compatibility shims keeping a retired vocabulary alive in
 * the tests. They are the one place the *scene-shaped* and *blob-shaped* call
 * sites of a test suite say the same thing production says, which is what keeps
 * a characterization test characterising the product rather than a wrapper.
 *
 * A test that is ABOUT the unified contract (`unified-document-write-cas`)
 * deliberately does not use them and calls `writeDocument` directly.
 */

import {
  type DocRef,
  type ProjectBackend,
  type WriteExpectation,
} from '../../src/core/project/backends/project-backend';
import type { SceneRevision, SceneWrite } from '../../src/core/project/rv-scene-record';

/** The plan-709 three-valued precondition, as plan-736 spells it. */
export function expectationOf(
  expected: SceneRevision | null | undefined,
): WriteExpectation {
  if (expected === undefined) return 'any';
  if (expected === null) return 'create';
  return expected;
}

/**
 * The former `backend.writeScene(relPath, write)`.
 *
 * `meta` is what tells a backend that keys scene bodies by id (the browser one)
 * that this is a scene body — caller intent at the call site, exactly as
 * `writeSceneGlbBody()` supplies it in production.
 */
export async function writeSceneDocument(
  backend: ProjectBackend,
  relPath: string,
  write: SceneWrite,
): Promise<SceneRevision> {
  const { revision } = await backend.writeDocument(
    { path: relPath, id: write.meta?.id, meta: write.meta },
    write.glb,
    { expectedRevision: expectationOf(write.expectedRevision) },
  );
  return revision;
}

/** The former `backend.writeBlob(relPath, blob, opts?)`. */
export async function writeBlobDocument(
  backend: ProjectBackend,
  ref: DocRef,
  blob: Blob | Uint8Array,
  opts?: { expectedRevision?: SceneRevision | null },
): Promise<void> {
  const bytes = blob instanceof Uint8Array
    ? blob
    : new Uint8Array(await blob.arrayBuffer());
  await backend.writeDocument(ref, bytes, {
    expectedRevision: expectationOf(opts ? opts.expectedRevision : undefined),
  });
}
