// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-document-variants-write — store a document's variants in its own bytes (plan-2013
 * §2.8). A structural copy of `writeDocumentPlanning`: the bytes first, the cache second,
 * the fast bake path (JSON chunk patched, BIN byte-identical) and the compare-and-swap on
 * the revision just read. Only the `Variants` key changes — base values are never written
 * here, so a value of the variant in the scene can never become a base value.
 */

import { bakeIntoGlb } from '../hmi/scene/rv-scene-glb-bake';
import { materialise } from '../hmi/scene/rv-scene-edits';
import type { ProjectBackend } from './backends/project-backend';
import type { RvDocumentEntry } from './rv-project-types';
import type { SceneRevision } from './rv-scene-record';

const NO_NODES = { locate: () => null };

export interface DocumentVariantsWriteResult {
  /** What the file now carries (`null` = block removed). */
  variants: Record<string, unknown> | null;
  revision: SceneRevision;
}

/**
 * Read a document's bytes, replace its `Variants` block with `payload` (the serialised
 * block; `null` removes it), write them back. Throws on a read-only project, an unreadable
 * body or a revision somebody replaced in the meantime.
 */
export async function writeDocumentVariants(
  backend: ProjectBackend,
  doc: RvDocumentEntry,
  payload: Record<string, unknown> | null,
): Promise<DocumentVariantsWriteResult> {
  if (!backend.writable) throw new Error('This project is read-only.');
  const record = await backend.readDocument({ path: doc.path, id: doc.id });
  if (!record) throw new Error(`"${doc.name}" could not be read from this project.`);
  const baked = await bakeIntoGlb(record.bytes, materialise([]), NO_NODES, {
    variants: payload,
    self: { assetId: doc.id, path: doc.path },
  });
  const meta: RvDocumentEntry = { ...doc, extrasScan: 2 };
  const { revision } = await backend.writeDocument(
    { path: doc.path, id: doc.id, meta },
    baked.glb,
    { expectedRevision: record.revision },
  );
  return { variants: payload, revision };
}
