// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-650 Phase 5b — the child-family bundle wired into the share export and
 * the import into the project library.
 *
 * `rv-parametric-bundle.ts` holds the pure byte functions; this module brings
 * the two things they leave to the caller:
 *
 *  - **Export (share):** the bytes of every declared child family, looked up
 *    through the same resolver the loader uses (library sources, then the
 *    project manifest, then `Path`). A child whose bytes no longer hash to the
 *    declared `DocHash` is NOT bundled - shipping other bytes under that hash
 *    would make the receiver's import refuse the slice anyway - and is
 *    reported as missing, like a child that resolves to nothing.
 *  - **Import:** every bundled child is written VERBATIM into the project
 *    library (so its `DocHash` still matches) and gets a manifest row whose id
 *    is the `Family` - the asset id the child reference resolves by. A family
 *    the project already has is left alone. Declared children that are neither
 *    bundled nor in the project are reported (`parametric-child-missing`).
 *
 * Every lookup and write goes through a small IO seam, so the round trip is
 * testable without a viewer or a project backend.
 */

import type { ParametricUse } from '../engine/rv-parametric-component';
import {
  bundleChildFamilies, bundledChildrenOf, declaredUsesOf, unpackChildFamilies, type UnpackedChildFamily,
} from '../engine/rv-parametric-bundle';
import { readGlbJson } from '../engine/rv-binary-resources';
import { sha256HexBytes } from '../engine/rv-parametric-hash';

/** Resolve a declared child family to its document bytes, or null. */
export type ChildFamilyResolver = (use: ParametricUse) => Promise<Uint8Array | null>;

export interface ShareBundleReport {
  bundled: string[];
  /** Declared families without bytes (unresolvable) - the receiver will see `parametric-child-missing`. */
  missing: string[];
  /** Declared families whose current bytes no longer match the declared `DocHash` (also not bundled). */
  stale: string[];
}

/**
 * Collect the bytes of every child family `glb` declares, transitively, and
 * bundle them flat into `glb`. Only bytes whose SHA-256 equals the declared
 * `DocHash` are taken. A GLB without `Uses` comes back unchanged.
 */
export async function bundleChildFamiliesForShare(
  glb: Uint8Array,
  resolve: ChildFamilyResolver = defaultChildFamilyResolver,
): Promise<{ glb: Uint8Array; report: ShareBundleReport }> {
  const report: ShareBundleReport = { bundled: [], missing: [], stale: [] };
  const first = declaredUsesOf(readGlbJson(glb));
  if (first.length === 0) return { glb, report };

  // Async pre-fetch, then the synchronous pure bundler reads the map.
  const bytesOf = new Map<string, Uint8Array>();
  const seen = new Set<string>();
  const queue = [...first];
  while (queue.length > 0) {
    const use = queue.shift()!;
    if (seen.has(use.Family)) continue;
    seen.add(use.Family);
    let bytes: Uint8Array | null = null;
    try { bytes = await resolve(use); } catch { bytes = null; }
    if (!bytes) continue;
    if ((await sha256HexBytes(bytes)) !== use.DocHash) { report.stale.push(use.Family); continue; }
    bytesOf.set(use.Family, bytes);
    queue.push(...declaredUsesOf(readGlbJson(bytes)));
  }

  const result = bundleChildFamilies(glb, (use) => bytesOf.get(use.Family) ?? null);
  report.bundled = result.bundled;
  report.missing = result.missing.filter((f) => !report.stale.includes(f));
  return { glb: result.glb, report };
}

/** Does `glb` carry a child-family bundle manifest? Cheap - JSON chunk only. */
export function hasChildFamilyBundle(glb: Uint8Array | ArrayBuffer): boolean {
  return bundledChildrenOf(readGlbJson(glb)).length > 0;
}

// ─── Import ──────────────────────────────────────────────────────────────

/** What the import needs from the open project. */
export interface ChildFamilyImportIO {
  /** Is a family with this asset id already resolvable in the project / libraries? */
  hasFamily(family: string): Promise<boolean>;
  /** Is this project-relative path taken? */
  fileExists(relPath: string): Promise<boolean>;
  /** Write new bytes (create-only). */
  writeFile(relPath: string, bytes: Uint8Array): Promise<void>;
  /** Add manifest rows `{ id: Family, path, name }` in ONE manifest write. */
  addRows(rows: Array<{ id: string; path: string; name: string }>): Promise<void>;
}

export interface ChildFamilyImportReport {
  /** Families written into the library (`Family` → project-relative path). */
  written: Array<{ family: string; path: string }>;
  /** Bundled families the project already had - left untouched. */
  kept: string[];
  /** Declared families neither bundled nor in the project. */
  missing: string[];
}

/** Folder that receives bundled child families without a usable `Path`. */
export const PARAMETRIC_LIBRARY_FOLDER = 'library/parametric';

function sanitize(name: string): string {
  return name.replace(/\.glb$/i, '').replace(/[\\/:*?"<>|#%\s]+/g, '_').replace(/^_+|_+$/g, '') || 'family';
}

function leafName(path: string): string {
  return (path.split('/').filter(Boolean).pop() ?? path).replace(/\.glb$/i, '');
}

/** Where a child lands: its own `Path` when that is a library GLB, else `library/parametric/<Family>.glb`. */
export function libraryPathForChild(child: Pick<UnpackedChildFamily, 'Family' | 'Path'>): string {
  const p = (child.Path ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (p.startsWith('library/') && /\.glb$/i.test(p) && !p.includes('..')) return p;
  return `${PARAMETRIC_LIBRARY_FOLDER}/${sanitize(child.Family)}.glb`;
}

/**
 * Unpack the child-family bundle of `glb` into the project library. Bytes are
 * written verbatim (DocHash unchanged), never over an existing file; a taken
 * path gets a `-2`, `-3`, … suffix. Returns what happened, including declared
 * children that are still missing afterwards.
 */
export async function importBundledChildFamilies(
  glb: Uint8Array,
  io: ChildFamilyImportIO,
): Promise<ChildFamilyImportReport> {
  const report: ChildFamilyImportReport = { written: [], kept: [], missing: [] };
  const children = unpackChildFamilies(glb);
  const rows: Array<{ id: string; path: string; name: string }> = [];
  const known = new Set<string>();

  for (const child of children) {
    if (await io.hasFamily(child.Family)) { report.kept.push(child.Family); known.add(child.Family); continue; }
    const wanted = libraryPathForChild(child);
    let path = wanted;
    for (let n = 2; await io.fileExists(path); n++) path = wanted.replace(/\.glb$/i, `-${n}.glb`);
    await io.writeFile(path, child.bytes);
    rows.push({ id: child.Family, path, name: leafName(child.Path ?? child.Family) });
    report.written.push({ family: child.Family, path });
    known.add(child.Family);
  }
  if (rows.length > 0) await io.addRows(rows);

  // Declared by the parent or by any bundled child, and still nowhere.
  const declared = new Set<string>();
  for (const u of declaredUsesOf(readGlbJson(glb))) declared.add(u.Family);
  for (const c of children) for (const u of declaredUsesOf(readGlbJson(c.bytes))) declared.add(u.Family);
  for (const family of declared) {
    if (known.has(family)) continue;
    if (await io.hasFamily(family)) continue;
    report.missing.push(family);
  }
  return report;
}

// ─── Default seams (viewer / project store) ───────────────────────────────

/** The loader's resolver: library sources, project manifest, then `Path`. */
export const defaultChildFamilyResolver: ChildFamilyResolver = async (use) => {
  const { createReferenceResolver } = await import('../engine/rv-glb-reference-resolver');
  const resolved = await createReferenceResolver()(
    { assetId: use.Family },
    { baseUrl: '', occurrence: '', depth: 0, resolvedPath: use.Path ?? '' },
  );
  return resolved ? new Uint8Array(resolved.bytes) : null;
};

/** IO against the open project's backend and manifest; null when nothing is writable. */
export async function projectChildFamilyImportIO(): Promise<ChildFamilyImportIO | null> {
  const { getProjectStore } = await import('../project/project-store');
  const store = getProjectStore();
  const backend = store.getBackend();
  if (!backend?.writable || !store.getProject()) return null;
  return {
    hasFamily: async (family) => (await defaultChildFamilyResolver({ Family: family, FamilyNodeId: '', DocHash: '' })) !== null,
    fileExists: async (relPath) => {
      const r = await backend.readDocumentUrl(relPath);
      if (!r) return false;
      r.release();
      return true;
    },
    writeFile: async (relPath, bytes) => { await backend.writeDocument(relPath, bytes, { expectedRevision: 'create' }); },
    addRows: async (rows) => {
      await store.applyManifestDelta((current) => {
        const docs = Array.isArray(current.documents) ? [...current.documents] : [];
        for (const r of rows) {
          if (docs.some((d) => d && (d as { id?: string }).id === r.id)) continue;
          docs.push({ id: r.id, path: r.path, name: r.name });
        }
        return { ...current, documents: docs };
      });
    },
  };
}
