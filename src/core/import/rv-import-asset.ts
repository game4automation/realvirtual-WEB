// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-import-asset — the EDITOR import sink.
 *
 * Editor mode always edits ONE library object (untitled until saved). It has no
 * scene, so "Open as new scene" is meaningless there and an import is always an
 * ADDITION to the current asset document: an undoable `importCad` op.
 *
 * Every provider already resolved to GLB bytes, so this sink only has to make
 * sure each item carries a `CADLinkExtras` — the provenance record that keys the
 * content-addressed GLB cache and powers "Re-import…". Providers that convert a
 * source (STEP, USD) supply it; a plain `.glb` file or a catalog entry does not,
 * so one is synthesized from the bytes themselves. `Quality: 'glb'` marks the
 * "conversion" as the identity.
 */

import type { AssetDocument } from '../editor/rv-asset-document';
import type { CADLinkExtras } from '../editor/rv-asset-ops';
import type { ImportResultItem } from './rv-import-provider';
import { sha256Hex } from './rv-cad-glb-cache';

/** One resolved item, flattened to the bytes + provenance the document needs. */
export interface AssetImportUnit {
  glb: ArrayBuffer;
  cadlink: CADLinkExtras;
  suggestedName: string;
}

/** Provenance for a source that needed no conversion (a GLB already). */
async function glbPassthroughCadlink(name: string, bytes: ArrayBuffer): Promise<CADLinkExtras> {
  return {
    File: name.toLowerCase().endsWith('.glb') ? name : `${name}.glb`,
    Sha256: await sha256Hex(bytes),
    Quality: 'glb', // identity conversion — nothing to re-tessellate
    ImportScaleFactor: 1,
    ZIsUpVector: false,
  };
}

/**
 * Flatten resolved import items into `{glb, cadlink, suggestedName}` units.
 *
 * Catalog entries (Asset Manager, Onshape) are downloaded here: in editor mode a
 * stable URL is not enough, because the asset must stay openable offline and the
 * op log addresses geometry by content hash, not by URL.
 */
export async function itemsToAssetImports(items: ImportResultItem[]): Promise<AssetImportUnit[]> {
  const units: AssetImportUnit[] = [];
  for (const item of items) {
    if (item.kind === 'glb') {
      units.push({
        glb: item.bytes,
        cadlink: item.cadlink ?? (await glbPassthroughCadlink(item.suggestedName, item.bytes)),
        suggestedName: item.suggestedName,
      });
      continue;
    }
    for (const entry of item.entries) {
      if (!entry.glbUrl) continue;
      const resp = await fetch(entry.glbUrl);
      if (!resp.ok) throw new Error(`[import] Could not download "${entry.name}" (HTTP ${resp.status})`);
      const bytes = await resp.arrayBuffer();
      units.push({
        glb: bytes,
        cadlink: await glbPassthroughCadlink(entry.name, bytes),
        suggestedName: entry.name,
      });
    }
  }
  return units;
}

/**
 * EDITOR import sink. Attaches every resolved item under the current asset root
 * as an undoable `importCad` op. Returns the created root paths.
 *
 * NEVER calls `loadModel`/`clearModel` — the asset base stays what it was.
 */
export async function importIntoAsset(
  doc: AssetDocument,
  items: ImportResultItem[],
): Promise<string[]> {
  const units = await itemsToAssetImports(items);
  const paths: string[] = [];
  for (const unit of units) {
    paths.push(await doc.importCad({ glb: unit.glb, cadlink: unit.cadlink }, { name: unit.suggestedName }));
  }
  return paths;
}
