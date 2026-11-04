// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-cad-provider — injection seam for CAD (STEP) geometry in the asset editor.
 *
 * The public core defines only this interface + registry; the actual OCCT WASM
 * tessellation lives in the PRIVATE step-import plugin, which registers its
 * implementation here at plugin init (same injection-not-import pattern as the
 * DES runner factory / `createDesRunner`).
 *
 * The provider deals in GLB BYTES, never in Object3D trees. It converts a CAD
 * file once; from then on the geometry is addressed by the content hash of the
 * ORIGINAL file and re-materialised by parsing the cached GLB
 * (`rv-cad-glb-cache` → `parseGlbSubtree`). That lookup lives in the public core,
 * so a PUBLIC build — which has no provider at all — can still replay an
 * `importCad` op from a draft. The provider is only needed to convert something
 * new, or to re-convert when the GLB cache has been evicted.
 */

import type { CADLinkExtras } from './rv-asset-ops';
import type { Object3D } from 'three';

/** Result of a fresh CAD file import. */
export interface CadImportResult {
  /** Converted GLB bytes — already mm→m scaled and Z-up→Y-up rotated. */
  glb: ArrayBuffer;
  /** The CADLink extras to stamp on the imported root. */
  cadlink: CADLinkExtras;
  /**
   * Visible, non-fatal notes about the import (e.g. "CONNECT conversion failed, converted in
   * the browser — colours may be incomplete"). Absent or empty = nothing to report (plan-561).
   */
  warnings?: string[];
}

/** Options of {@link CadGeometryProvider.importFile}. */
export interface CadImportOptions {
  /**
   * Force a converter (plan-561). A CADLink re-import passes the converter the original was
   * made with so the tree stays identical. Absent = the provider chooses (STEP: CONNECT when a
   * gateway reports the service, else the browser). Providers with a single converter ignore it.
   */
  converter?: 'connect' | 'browser';
}

/**
 * What the replaying document knows when it asks for a rebuild (plan-650): a provider whose
 * geometry derives from the document itself (a parametric family's base parts) needs the tree.
 */
export interface CadRetessellateContext {
  /** Root of the asset being replayed, or null. */
  modelRoot: Object3D | null;
}

export interface CadGeometryProvider {
  /**
   * True for a provider that only REBUILDS geometry derived from the document (plan-650:
   * parametric variants) and imports no files. It never counts as "CAD import available"
   * and is never returned by the format-less lookup.
   */
  derived?: boolean;
  /** Convert a fresh CAD file to GLB (used by import and CADLink re-import). */
  importFile(file: File, quality: string, opts?: CadImportOptions): Promise<CadImportResult>;

  /**
   * Re-convert previously imported geometry from the provider's cached ORIGINAL
   * CAD bytes, for when the converted-GLB cache has been evicted. Returns the
   * GLB bytes (and re-populates the GLB cache), or null when the source bytes
   * are gone too — callers then surface a re-pick prompt.
   *
   * Optional: a provider without a source cache simply omits it. A provider that cannot
   * reach the converter recorded in `cadlink.Converter` THROWS (with a user-facing message)
   * instead of switching converters — the replay records the message as the miss reason.
   */
  retessellate?(cadlink: CADLinkExtras, ctx?: CadRetessellateContext): Promise<ArrayBuffer | null>;
}

// Providers are keyed by CAD format ('step', 'jt', …) — a re-import must re-convert with the
// SAME format the file was imported with (STEP via OCCT, JT via rv_jt.wasm), so a single slot
// no longer suffices once more than one CAD format is importable.
const _providers = new Map<string, CadGeometryProvider>();

/** Register the CAD geometry provider for a format (private plugin, at init). */
export function registerCadProvider(format: string, provider: CadGeometryProvider | null): void {
  const key = format.toLowerCase();
  if (provider) _providers.set(key, provider);
  else _providers.delete(key);
}

/**
 * The registered provider for `format`, or — with no format — any registered provider (used
 * only for the "is CAD import available at all" menu check). null in a public build.
 */
export function getCadProvider(format?: string): CadGeometryProvider | null {
  if (format) return _providers.get(format.toLowerCase()) ?? null;
  for (const p of _providers.values()) if (!p.derived) return p;
  return null;
}

/** Whether any CAD geometry provider is registered (menu-visibility check). */
export function hasCadProvider(): boolean {
  for (const p of _providers.values()) if (!p.derived) return true;
  return false;
}

/** Map a CAD file name to its provider format key ('step' | 'jt' | …). */
export function cadFormatOfName(name: string): string {
  const ext = (name.split('.').pop() ?? '').toLowerCase();
  return ext === 'stp' || ext === 'step' ? 'step' : ext;
}
