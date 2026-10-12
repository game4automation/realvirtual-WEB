export function uploadDirectory(
  client: { listRecursive(path: string): Promise<any[]>; putFile(bytes: Buffer, path: string): Promise<void>; deleteFile(path: string): Promise<void> },
  localDir: string,
  remotePrefix: string,
  options: {
    force: boolean;
    dryRun: boolean;
    alwaysUploadGlbs: boolean;
    preserveRemotePrefixes?: string[];
    /** plan-508 F2b: rels uploaded regardless of size (catalogued binaries whose hash changed). */
    alwaysUploadRel?: Iterable<string> | null;
    /** plan-508 F2b: uploaded only after every other asset settled — default: each `catalog.json`. */
    deferUntilLast?: ((rel: string) => boolean) | Iterable<string> | null;
    /** plan-759 F9: assets entering the pool first (a hosted deploy's `p/**`). Start order only. */
    uploadFirst?: ((rel: string) => boolean) | null;
  },
): Promise<{
  uploaded: number; skipped: number; deleted: number; deleteFailures: number;
  /** plan-598: deploy-relative paths that were uploaded / deleted (for the URL purge). */
  uploadedRels: string[]; deletedRels: string[];
}>;
/** plan-759 F9: the remote snapshot of a hosted publish — exactly the staging listing, lower-cased. */
export function expectedHostedSnapshot(stagingDir: string): Set<string>;
/** Is `rel` a library catalog (`…/catalog.json`)? */
export function isCatalogFile(rel: string): boolean;
/** Catalogued binaries whose sha256 changed against the published catalogs under `remotePrefix`. */
export function catalogHashDiff(
  client: { getFileIfExists(path: string): Promise<Buffer | null> },
  localDir: string,
  remotePrefix: string,
): Promise<Set<string>>;
/** The public base URL a remote prefix is served under. */
export function publicBaseUrlFor(remotePrefix: string | null | undefined): string;
export function stageAndBuild(options: {
  mode: 'public' | 'demo' | 'private';
  projectDir?: string | null;
  base?: string | null;
  dryRun?: boolean;
}): { workspaceRoot: string; coreRoot: string; distDir: string; dryRun: boolean; manifest: any };
export function reconcileRemoteSnapshot(
  client: { listRecursive(path: string): Promise<any[]>; deleteFile(path: string): Promise<void> },
  remotePrefix: string,
  expectedPaths: Set<string>,
  /** plan-598: collects the deleted prefix-relative paths. */
  deletedOut?: string[] | null,
): Promise<number>;
/** plan-598 Phase 2: URL purge of what changed (zone purge fallback); without `changes` the zone purge. */
export function maybePurge(
  client: unknown,
  uploadedCount: number,
  opts: { noPurge?: boolean },
  changes?: { baseUrl: string; uploaded?: string[]; deleted?: string[]; extraUrls?: string[]; partial?: boolean } | null,
): Promise<void>;
/**
 * plan-587 F4 — the phase the deploy reports for the /dev watcher's deadline.
 * `build` is the only phase in which an expired deadline may kill this process
 * (see `KILLABLE_PHASES` in `lib/rv-proc.mjs`).
 */
export type DeployPhase = 'build' | 'upload' | 'published' | 'smoke';
/** The phases in the order they happen. */
export const DEPLOY_PHASES: readonly DeployPhase[];
/** File name of the phase record. */
export const DEPLOY_PHASE_FILENAME: string;
/** `RV_DEPLOY_PHASE_FILE`, else `<RV_DELIVER_TMP>/deploy-phase.json`, else null. */
export function deployPhaseFilePath(env?: Record<string, string | undefined>): string | null;
/** Reports one phase change atomically (tmp + rename). Returns the path written, or null. Never throws. */
export function reportDeployPhase(phase: DeployPhase, options?: {
  path?: string | null;
  now?: () => number;
  fs?: {
    mkdirSync: (path: string, options: { recursive: true }) => unknown;
    writeFileSync: (path: string, data: string) => void;
    renameSync: (from: string, to: string) => void;
  };
}): string | null;
