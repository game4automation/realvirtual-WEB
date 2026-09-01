// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * A document to author against, for tests that do not care where it lives.
 *
 * ## Why this exists instead of `AssetDocument.newUntitled()`
 *
 * That factory was deleted by plan-719 F3. It minted a document over
 * `{ kind: 'empty' }` — an asset with no file, no manifest row and no place —
 * and every consumer downstream then had to carry a branch for the one
 * identity that could not answer "where do my bytes go". Production creates
 * documents through `createDocument()` now, which writes the bytes and the row
 * before the document is opened, so an AssetBase always names somewhere real.
 *
 * The dozens of tests that merely needed *a* document to record ops on should
 * not each grow a project fixture for that, so they get one here — over a
 * `document` base with a plain path. That is a truthful identity (the file
 * simply is not written, which is exactly what these tests are not about) and
 * it keeps the removal of the `empty` special case total: no test can
 * accidentally re-introduce a homeless document, because there is no longer a
 * factory that makes one.
 */

import { AssetDocument } from '../../src/core/editor/rv-asset-document';
import { documentBase } from '../../src/core/editor/active-asset-store';
import { stableDocumentIdOfPath } from '../../src/core/editor/rv-asset-draft-storage';

let seq = 0;

/**
 * A fresh document over `<name>.glb`, ready to record ops on.
 *
 * The path is unique per call so two scratch documents in one test are two
 * documents — `sameDocumentBase` compares ids, and a shared path would make
 * them silently the same one.
 */
export function scratchAssetDocument(viewer: unknown, name = 'Untitled'): AssetDocument {
  seq += 1;
  const path = `scratch/${name}_${seq}.glb`;
  return new AssetDocument(viewer as never, {
    id: `asset_scratch_${seq}`,
    name,
    base: documentBase(stableDocumentIdOfPath(path), name, path),
  });
}
