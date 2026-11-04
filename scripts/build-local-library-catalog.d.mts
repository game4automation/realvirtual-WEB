/** Repo root (absolute). */
export const ROOT: string;
/** `public/library` (absolute). */
export const LIBRARY_DIR: string;
/** Insert spaces at camelCase / acronym boundaries and on `-`/`_`, then title-trim. */
export function humanize(s: string): string;
/** Stable, URL-safe id from a path-ish string. */
export function slug(s: string): string;
/** Recursively collect all `.glb` files under `dir`, as paths relative to `root` (default LIBRARY_DIR, native separators). */
export function collectGlbs(dir: string, root?: string): Promise<string[]>;
/** One catalog entry as the builder writes it (plan-508: `sha256` + `sizeBytes` of the bytes behind `glbUrl`). */
export interface LocalCatalogEntry {
  id: string;
  name: string;
  category: string;
  glbUrl: string;
  sha256: string;
  sizeBytes: number;
  /** The saved preview, library-relative (plan-776): `<category>/.thumbnails/<id>.<hash8>.<webp|png>`. Absent = placeholder. */
  thumbnail?: string;
}
/** A document id as a file name — the twin of `encodeThumbnailId` in `src/core/library/library-types.ts`. */
export function encodeThumbnailId(documentId: string): string;
/** The newest hashed sidecar of catalog entry `id` in `folder` (library-relative, POSIX; '' = root), or null. */
export function findCatalogThumbnail(libraryDir: string, folder: string, id: string): string | null;
/** Build the catalog object for `libraryDir` (default LIBRARY_DIR); `filterIgnored` defaults to true only for LIBRARY_DIR. */
export function buildLocalCatalog(
  libraryDir?: string,
  options?: { filterIgnored?: boolean; log?: (message: string) => void },
): Promise<{ version: '1.0'; name: string; entries: LocalCatalogEntry[] }>;
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

// ─── plan-778 Phase 3: the realvirtual library as a project ───────────────

/** `public/library/project.json` (absolute) — the one artefact this script writes (plan-778 Phase 4). */
export const PROJECT_OUTPUT: string;
/** `prj_realvirtual_library` — identity of the library project in every location. */
export const LIBRARY_PROJECT_ID: string;
/** `realvirtual-Library` — GitHub repo name the scan ids are minted from. */
export const GITHUB_REPO_NAME: string;
/** The id the GitHub repo scan mints for `rel` (a path inside the repo) — the alias of that document. */
export function githubScanId(rel: string, repoName?: string): string;
/** One document row of the library project manifest. */
export interface LibraryProjectDocument {
  id: string;
  name: string;
  path: string;
  sha256: string;
  sizeBytes: number;
  thumbnail?: string;
  collections: string[];
  footprintMm?: number[];
  pivotToFloor?: boolean;
  tags?: string[];
  aliases: string[];
}
/** The catalog as a project manifest; throws when an alias is not unique or shadows a document id. */
export function buildLibraryProject(
  catalog: { name?: string; entries: Array<LocalCatalogEntry & { footprintMm?: number[]; pivotToFloor?: boolean; tags?: string[] }> },
  options?: { repoName?: string },
): { schemaVersion: 2; id: string; name: string; kind: 'demo'; documents: LibraryProjectDocument[] };
