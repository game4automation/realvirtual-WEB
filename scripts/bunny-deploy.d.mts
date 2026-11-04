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
): Promise<{ uploaded: number; skipped: number; deleted: number }>;
/** plan-759 F9: the remote snapshot of a hosted publish — exactly the staging listing, lower-cased. */
export function expectedHostedSnapshot(stagingDir: string): Set<string>;
/** Is `rel` a catalog or library manifest (`…/catalog.json`, `library/project.json`, `libraries/<id>/project.json`)? */
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
  fast?: boolean;
  /** plan-646 F14: build the public-demo welcome window; honoured only for mode 'demo'. */
  demoWelcome?: boolean;
  /** /dev only: the lighter build profile (RV_DEV_FAST_BUILD=1). */
  devFast?: boolean;
  /** Receives the [timing] marks of staging and build. */
  timings?: DeployTimings | null;
}, deps?: Record<string, any>): { workspaceRoot: string; coreRoot: string; distDir: string; dryRun: boolean; manifest: any };
/** plan-646 F14: the `--demo` staging profile (full commercial tier + `demo-welcome`). */
export const DEMO_PROFILE: Readonly<{ tier: 'commercial'; restrictedFeatures: readonly string[] }>;
/** `demo`, `/demo/`, `demo/`, `\demo` → `demo` (lower-cased, outer slashes stripped). */
export function normalizeRemotePrefix(remotePrefix: string | null | undefined): string;
/** plan-646 F14: true only for `--demo` with the effective target path `demo` (never with `--root`). */
export function demoWelcomeForTarget(options?: {
  demo?: boolean;
  remotePrefix?: string | null;
  root?: boolean;
}): boolean;
/** plan-646: writes generated/features.json before a --demo staging; throws (deploy aborts) on failure. */
export function generateDemoFeatures(options?: {
  generate?: () => { available: false; manifestPath: string } | { available: true; json: string };
  write?: (path: string, data: string) => void;
  out?: string;
}): string;
export function reconcileRemoteSnapshot(
  client: { listRecursive(path: string): Promise<any[]>; deleteFile(path: string): Promise<void> },
  remotePrefix: string,
  expectedPaths: Set<string>,
): Promise<number>;
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

/** `[timing] <step> <seconds>s` lines; `time` measures a sync or async function. */
export interface DeployTimings { mark(step: string, ms: number): void; time<T>(step: string, fn: () => T): T }
export function createTimings(write?: (line: string) => void, now?: () => number): DeployTimings;
/** Throws unless `--dev-fast` targets a public / --demo deploy to the prefix `dev`. */
export function assertDevFastAllowed(options?: { devFast?: boolean; private?: boolean; root?: boolean; path?: string | null }): void;
