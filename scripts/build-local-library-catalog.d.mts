/** Repo root (absolute). */
export const ROOT: string;
/** `public/library` (absolute). */
export const LIBRARY_DIR: string;
/** `public/library/catalog.json` (absolute) — the one artefact this script writes. */
export const OUTPUT: string;
/** Insert spaces at camelCase / acronym boundaries and on `-`/`_`, then title-trim. */
export function humanize(s: string): string;
/** Stable, URL-safe id from a path-ish string. */
export function slug(s: string): string;
/** Recursively collect all `.glb` files under `dir`, as paths relative to LIBRARY_DIR (native separators). */
export function collectGlbs(dir: string): Promise<string[]>;
/** Git-ignored entries among `relPaths` (relative to LIBRARY_DIR); empty outside a Git checkout. */
export function gitIgnored(relPaths: string[]): Set<string>;
/**
 * The stable catalog id of one library file (LIBRARY_DIR-relative, native separators).
 *
 * Since plan-737 the demo manifest carries no `library/` document rows — the
 * library is app-level and the demo subscribes to it via `libraries[]` — so
 * `MANIFEST`/`manifestRowFor`/`syncManifestLibraryRows` are gone and this id is
 * the only identity the catalog and a baked `AssetReference` still share.
 */
export function libraryAssetId(rel: string): string;
