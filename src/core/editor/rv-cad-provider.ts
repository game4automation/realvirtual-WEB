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

/** Result of a fresh CAD file import. */
export interface CadImportResult {
  /** Converted GLB bytes — already mm→m scaled and Z-up→Y-up rotated. */
  glb: ArrayBuffer;
  /** The CADLink extras to stamp on the imported root. */
  cadlink: CADLinkExtras;
}

export interface CadGeometryProvider {
  /** Convert a fresh CAD file to GLB (used by import and CADLink re-import). */
  importFile(file: File, quality: string): Promise<CadImportResult>;

  /**
   * Re-convert previously imported geometry from the provider's cached ORIGINAL
   * CAD bytes, for when the converted-GLB cache has been evicted. Returns the
   * GLB bytes (and re-populates the GLB cache), or null when the source bytes
   * are gone too — callers then surface a re-pick prompt.
   *
   * Optional: a provider without a source cache simply omits it.
   */
  retessellate?(cadlink: CADLinkExtras): Promise<ArrayBuffer | null>;
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
  return _providers.values().next().value ?? null;
}

/** Whether any CAD geometry provider is registered (menu-visibility check). */
export function hasCadProvider(): boolean {
  return _providers.size > 0;
}

/** Map a CAD file name to its provider format key ('step' | 'jt' | …). */
export function cadFormatOfName(name: string): string {
  const ext = (name.split('.').pop() ?? '').toLowerCase();
  return ext === 'stp' || ext === 'step' ? 'step' : ext;
}
