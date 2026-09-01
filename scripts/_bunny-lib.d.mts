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
  opts?: { force?: boolean; alwaysUploadGlbs?: boolean },
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

export function generatePrivateSettings(
  project: PrivateProjectLike,
  projectFolderName?: string,
  opts?: { encryption?: boolean; projectSettings?: unknown },
): string;

/** Keys of the generated settings.json a project file may never set (B14). */
export const SETTINGS_RESERVED_KEYS: readonly string[];
/** A `settings/project-settings.json` payload with the reserved keys stripped. */
export function projectSettingsBase(raw: unknown): Record<string, unknown>;
/** `<projectDir>/settings/project-settings.json`, or null when absent/broken. */
export function readProjectSettingsFile(projectDir: string): unknown | null;

/** One entry of the curated `scenes/index.json` Examples catalogue. */
export interface PublishedSceneIndexEntry {
  file: string;
  name?: string;
  mode?: string;
  /** Classification level cache, so a bundled deploy needs no scan (plan-413). */
  level?: string;
}
/** The Examples catalogue derived from `documents[]`, or null when none apply. */
export function publishedSceneIndex(project: PrivateProjectLike | null): PublishedSceneIndexEntry[] | null;

/**
 * The GLBs a project publishes: the union of `models/*.glb` on disk (P0-3 — the
 * folder can never be shortened by the manifest) and the `documents[]` entries
 * that name an existing root-level GLB (plan-720).
 */
export function projectModelNames(projectDir: string): string[];

/** A manifest/folder disagreement `projectModelNamesWithReport()` reports instead of swallowing. */
export interface ProjectModelDiscrepancy {
  /** `missing-file` = declared but absent (not published); `unregistered` = on disk but undeclared (published). */
  kind: 'missing-file' | 'unregistered';
  path: string;
  reason: string;
}

/** `projectModelNames()` plus the source paths staging needs and the discrepancy report. */
export function projectModelNamesWithReport(projectDir: string): {
  list: string[];
  sources: Map<string, string>;
  discrepancies: ProjectModelDiscrepancy[];
};

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

export function stagePrivateProject(opts: {
  distDir: string;
  projectDir: string;
  encryption?: PrivateEncryptionOptions | null;
  signing?: PrivateSigningOptions | null;
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
