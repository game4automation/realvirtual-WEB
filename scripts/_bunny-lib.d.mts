// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Type declarations for `_bunny-lib.mjs` so the Node test suite type-checks
 * without enabling `allowJs`. Keep in sync with the runtime exports.
 */

export const ALWAYS_UPLOAD_FILES: Set<string>;

export function normalizePath(path: string): string;
export function buildUploadUrl(region: string, storageZone: string, relativePath: string): string;
export function normalizeRegion(region: string | undefined | null): string;
export function mimeType(filePath: string): string;
export function isAlwaysUploadFile(filePath: string): boolean;

export interface BunnyConfig {
  storageKey: string;
  storageZone: string;
  accountKey: string;
  pullZoneId: string;
  region: string;
  remotePath: string;
  googleAnalyticsId: string;
  newsApiUrl: string;
}
export function loadConfig(env?: Record<string, string | undefined>): BunnyConfig;
export const DEFAULT_NEWS_API_URL: string;
export function injectNewsIntoSettings(
  settingsPath: string,
  newsApiUrl: string,
  dryRun?: boolean,
): boolean;

export type BuildMode = 'public' | 'private';
export function buildEnvForMode(
  mode: BuildMode,
  opts?: { base?: string | null },
): Record<string, string | undefined>;

export function sanitizeDemoName(name: string | null | undefined): string;

export interface LocalFile { abs: string; rel: string; size: number; }
export function collectLocalFiles(rootDir: string): LocalFile[];

export interface DiffFile { rel: string; size: number; }
export function selectFilesToUpload<T extends DiffFile>(
  local: T[],
  remote: Map<string, number> | null,
  opts?: { force?: boolean; alwaysUploadGlbs?: boolean; alwaysUploadRel?: Iterable<string> },
): T[];

export interface RemoteEntry { rel: string; size: number; isDirectory: boolean; }
export function buildRemoteIndex(entries: RemoteEntry[]): Map<string, number>;

export interface BunnyClientOptions {
  region: string;
  zone: string;
  storageKey: string;
  accountKey?: string;
  pullZoneId?: string;
  dryRun?: boolean;
  log?: (msg: string) => void;
}
export class BunnyClient {
  constructor(opts: BunnyClientOptions);
  putFile(bytes: Uint8Array | Buffer, remotePath: string, mimeOverride?: string): Promise<void>;
  listRecursive(remoteRoot: string): Promise<RemoteEntry[]>;
  purge(): Promise<boolean>;
  getFile(remotePath: string): Promise<Buffer | null>;
  getFileIfExists(remotePath: string): Promise<Buffer | null>;
}

export interface PrivateProject {
  name: string;
  code: string;
  created?: string;
  lastPublished?: string;
  settings?: { defaultModel?: string };
  folderName?: string;
  /**
   * The manifest's one document list — the source of the published Examples
   * catalogue. Always present on a value that came out of `loadProject()`,
   * which derives it from the pre-phase-6 arrays when the file on disk still
   * carries those, and drops them (plan-703 phase 9). `scenes`/`models`/
   * `library` are deliberately NOT declared here: nothing downstream of that
   * boundary may read them, and a declaration is an invitation to.
   */
  documents?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

/**
 * What `generatePrivateSettings` and `publishedSceneIndex` actually need: a
 * manifest-shaped object. Looser than {@link PrivateProject} on purpose —
 * neither function reads `code`, and requiring it would only force test
 * fixtures to carry a field the code never looks at.
 */
export type PrivateProjectLike = Partial<PrivateProject> & Record<string, unknown>;
export function loadProject(projectDir: string): PrivateProject;
export function discoverPrivateProjects(
  baseDir: string,
): Array<{ project: PrivateProject; projectDir: string; folderName: string }>;

/**
 * The generated settings.json of a hosted deploy (plan-759): `projectUrl` and
 * `projectAssetsPath` name `p/`, `encryption` carries the key probe, analytics
 * is always off, and there is never a `defaultModel` (D14).
 */
export function generateHostedSettings(
  opts?: { encryption?: { probe: string } | null; projectSettings?: unknown },
): string;

/** Keys of the generated settings.json a project file may never set (B14). */
export const SETTINGS_RESERVED_KEYS: readonly string[];
/** A `settings/project-settings.json` payload with the reserved keys stripped. */
export function projectSettingsBase(raw: unknown): Record<string, unknown>;
/** `<projectDir>/settings/project-settings.json`, or null when absent/broken. */
export function readProjectSettingsFile(projectDir: string): unknown | null;

/** plan-267: optional AES-256-GCM encryption of GLBs at publish time. */
export interface PrivateEncryptionOptions {
  password: string;
  fragmentSecret: Uint8Array;
  iterations?: number;
  chunkSize?: number;
}

export interface PrivateSigningOptions {
  privateKey: import('node:crypto').KeyObject;
  customerCert?: { pub: string; org: string; sig: string } | null;
}

/** The deploy-relative folder the project is published under (`p/`). */
export const HOSTED_PROJECT_PREFIX: string;

/** What `copyProjectVerbatim` / `stageHostedProject` report for the preflight. */
export interface HostedStageReport {
  copied: string[];
  denied: { rel: string; reason: string }[];
  symlinks: string[];
  oversized: string[];
  /** Only set by `stageHostedProject`. */
  encrypted: string[];
}

/** Copies a project folder byte-for-byte minus the hosted deny list; symlinks are skipped. */
export function copyProjectVerbatim(
  projectDir: string,
  destDir: string,
  opts?: { ignoreRules?: unknown[] | null },
): Omit<HostedStageReport, 'encrypted'>;

/** True for a `p/`-relative path a password deploy encrypts: `.glb`, `aasx/*.aasx`, `aasx/index.json` (plan-596). */
export function isEncryptablePath(rel: string): boolean;

/** Every encryptable file below `dir`, `p/`-relative POSIX paths, sorted. */
export function encryptablePathsBelow(dir: string): string[];

/**
 * The rels a hosted publish uploads regardless of size: the catalog diff united
 * with every encrypted file, translated from `p/`-relative to staging-relative.
 */
export function hostedForcedUploadRels(
  encrypted?: Iterable<string> | null,
  catalogDiff?: Iterable<string> | null,
): string[];

/**
 * Stages a hosted project: runtime at the root, the project verbatim under
 * `p/`, generated settings.json; every `.glb` — and the project AASX
 * (`aasx/*.aasx`, `aasx/index.json`) — an RVE1 envelope when `encryption` is
 * given (one salt per publish, the file path as `hkdfInfo`). Signing touches
 * `.glb` only.
 */
export function stageHostedProject(opts: {
  distDir: string;
  projectDir: string;
  encryption?: PrivateEncryptionOptions | null;
  signing?: PrivateSigningOptions | null;
  onReport?: ((report: HostedStageReport) => void) | null;
}): Promise<string>;

export const PUBLIC_MODEL_PREFIX: string;

export interface PublicModelAllowlistResult {
  kept: string[];
  dropped: string[];
  droppedAssets: string[];
}
export function applyPublicModelAllowlist(
  distDir: string,
  /**
   * `keep` is the manifest-derived allowlist (plan-726). When present it
   * REPLACES the prefix rule rather than adding to it — the manifest is what
   * says what the demo contains. `prefix` remains the fallback for a dist/
   * without a manifest and the `RV_PUBLIC_MODEL_PREFIX` override.
   */
  opts?: { prefix?: string; dryRun?: boolean; keep?: string[] | null },
): PublicModelAllowlistResult;

/**
 * The `models/` filenames the deploy manifest at `distDir` declares, or null
 * when that root carries no readable `project.json`.
 *
 * Null and `[]` mean different things: null is "no manifest, use the prefix
 * rule", `[]` is "the manifest declares no models" — a manifest worth failing
 * on rather than silently reinterpreting.
 */
export function publicDemoModelAllowlist(distDir: string): string[] | null;

/**
 * Every `models/` and `scenes/` document the deploy manifest names that is NOT
 * in the build output (plan-726 F5). Empty when the manifest is satisfied, and
 * vacuously empty for a root without one.
 *
 * The comparison is case-SENSITIVE: a `Models/…` typo passes `existsSync` on
 * Windows and 404s on the Linux storage zone.
 */
export function publicDemoManifestMisses(distDir: string): string[];

/**
 * A deploy-root `project.json`, read through the shared document projection —
 * or null when it is absent or unparseable.
 *
 * The third read entry point for a manifest, next to `loadProject()` (which
 * demands a `code` the public demo deliberately does not have) and the private
 * project reader. Never throws.
 */
export function readDeployManifest(rootDir: string): Record<string, unknown> | null;

export const PUBLIC_TEST_SCENE_PREFIX: string;

/** Folder name of the demo project inside a deploy root (plan-737). */
export const PUBLIC_DEMO_FOLDER: string;

/** `<distDir>/demo-realvirtual` — the base every public-demo guard works from. */
export function publicDemoDir(distDir: string): string;

export interface PublicScenePruningResult {
  kept: string[];
  dropped: string[];
}
export function applyPublicScenePruning(
  distDir: string,
  opts?: { prefix?: string; dryRun?: boolean },
): PublicScenePruningResult;

export const PUBLIC_BASE_URL: string;
export const SEO_CANONICAL_PATH: string;

export function injectSeoTags(
  distDir: string,
  opts: { pageUrl: string; dryRun?: boolean },
): boolean;

export function injectNoindex(
  indexPath: string,
  opts?: { dryRun?: boolean },
): boolean;

export interface SeoArtifacts {
  robots: string;
  sitemap: string;
}
export function writeSeoArtifacts(
  distDir: string,
  opts: { pageUrl: string; dryRun?: boolean },
): SeoArtifacts;

// ─── Library catalog integrity (plan-508) ────────────────────────────────

/** The reserved probe path that must never exist in a deploy. */
export const PROBE_MISSING_ASSET: string;
/** `existsSync` that insists on the spelling per segment and on the last segment being a file. */
export function existsOnDiskExactly(rootDir: string, relPath: string): boolean;
/** Every `catalog.json` under `rootDir` (forward-slash rels). */
export function findCatalogFiles(rootDir: string): string[];
/** Deploy-relative path of an entry's `glbUrl` / `splatUrl`, or null for non-relative urls. */
export function catalogEntryBinaryRel(catalogRel: string, entry: { glbUrl?: string; splatUrl?: string }): string | null;
/** Re-stamp `sha256` + `sizeBytes` into every catalog under `rootDir` from the bytes there now. */
export function stampCatalogHashes(rootDir: string, opts?: { dryRun?: boolean }): { catalogs: number; stamped: number };
/** Catalogued binaries whose hash differs from the remote catalog (null = none published: all). */
export function catalogChangedBinaries(localDir: string, catalogRel: string, remoteText: string | Buffer | null): string[];
export interface ProbeResult { ok: boolean; findings: string[]; checks: string[]; }
/** Post-deploy probe: missing asset 404 (any type — Bunny's text/html error page is accepted; a 200 fails), catalog byte-equal, first asset hashes to its sha256. */
export function probePublishedAssets(opts: {
  baseUrl: string;
  distDir: string;
  timeoutMs?: number;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  catalogRel?: string;
  now?: () => number;
}): Promise<ProbeResult>;
