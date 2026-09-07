export interface DeliveryProfile {
  /** DISPLAY name ("Mauser 3D HMI") — never a key. */
  project?: string;
  /** Repository-level slug; defaults to the config file name. */
  customer?: string;
  /** Every project folder this customer repository carries (§2.10). Empty for a `standard` customer. */
  projects?: string[];
  /** Relationship kind from the customer register; a `standard` customer is delivered projectless. */
  kind?: 'development' | 'standard';
  /**
   * True when this delivery goes into the ONE repository shared by all standard
   * customers (plan-434 §2.7). Nothing customer-specific may be generated into it —
   * above all no `connectLicensePrefill`.
   */
  sharedRepo?: boolean;
  /** The one project a resolving load was asked for; `null` for a projectless delivery. */
  projectKey?: string | null;
  configName?: string;
  path?: string;
  tier: 'core' | 'commercial';
  restrictedFeatures: string[];
  remote?: string;
  mirror?: string | null;
  connectChannel?: 'stable' | 'beta';
  connectLicenseKey?: string;
}

/** What one delivery wrote into a customer repository (plan-738 §2.4). */
export interface DeliverySnapshot {
  version: string;
  generatedAt: string;
  remoteEmpty: boolean;
  /** The remote was EMPTY, so every project folder was seeded. */
  firstDelivery: boolean;
  /**
   * The remote had content but no `delivery/*` tag. Not a first delivery: only
   * the project folders genuinely missing from the clone are seeded.
   */
  untagged: boolean;
  /** Newest existing delivery tag; the tier gate reads its inventory from it. */
  baselineTag: string | null;
  /** Project folders written because they did not exist in the clone. */
  seeded: string[];
  /** Project folders replaced because `--projects` named them. */
  replaced: string[];
  /** Leftover pre-738 `.vendor-*` conflict sidecars removed from `projects/` (F11). */
  sidecarsRemoved: string[];
}

/** The baseline of a customer clone, decided by a real tag scan (§2.4.5). */
export interface DeliveryBaseline {
  remoteEmpty: boolean;
  tags: string[];
  /** Content, but no `delivery/*` tag — an existing delivery whose tags are gone. */
  untagged: boolean;
  /** The remote is empty. The ONLY case that seeds every project folder. */
  firstDelivery: boolean;
  baselineTag: string | null;
}

/** One project folder's answer to "what would a `--projects` replace destroy?" */
export interface ProjectReplacePreviewEntry {
  name: string;
  diff: { added: string[]; changed: string[]; removed: string[] };
  affected: number;
}

export interface ProjectReplacePreview {
  projects: ProjectReplacePreviewEntry[];
  total: number;
}
export interface TierManifest { defaults: string; rules: Array<Record<string, any>>; registrations: Record<string, any>; path: string }
export function loadTierManifest(path: string): TierManifest;
export function resolveTier(manifest: TierManifest, path: string): { tier: string; feature?: string | null };
export function loadDeliveryConfig(privateRoot: string, projectKey: string, manifest?: TierManifest): DeliveryProfile;
export function loadDeliveryConfigByCustomer(privateRoot: string, customer: string, manifest?: TierManifest): DeliveryProfile;
export function listDeliveryConfigs(privateRoot: string, manifest?: TierManifest): DeliveryProfile[];
export function hasDeliveryConfig(privateRoot: string, projectKey: string): boolean;
export interface SharedDeliveryTarget {
  org: string;
  repo: string;
  remote: string;
  /** Slugs of every customer receiving this one repository, sorted. */
  customers: string[];
}
export function sharedDeliveryTarget(privateRoot: string, manifest?: TierManifest): SharedDeliveryTarget | null;
/** Why this register entry has no git delivery, or `null` when it has one. The ONE rule. */
export function undeliverableReason(customer: { customer: string; delivery: { channel: string } }): string | null;
export function generateCustomerPrivatePlugins(manifest: TierManifest, profile: DeliveryProfile): string;
export function renderFeatureMatrix(
  manifest: TierManifest,
  deliveries: DeliveryProfile[],
  customerProjectKey?: string | null,
  projectPlugins?: Array<{ file: string; name: string }> | null,
  options?: { customerScoped?: boolean },
): string;
/**
 * Stages public/demo-realvirtual/ into <destinationRoot>/projects/demo-realvirtual/,
 * DELETING whatever was there first (plan-737 F4: always overwrite).
 * Returns false when the core tree carries no demo folder.
 */
export function copyDemoRealvirtualFolder(coreRoot: string, destinationRoot: string): boolean;
/**
 * Documents delivered only with a matching tier entitlement. EMPTY since plan-739 — the mechanism
 * is kept, its two former members are unconditional now.
 */
export const CONDITIONAL_DELIVERED_DOCS: Map<string, string>;
/**
 * Rewrites links in the copied core Markdown so a target the delivery does not carry degrades to
 * plain text instead of reaching {@link assertNoBrokenDocLinks} as a hard failure. `workspaceRoot`
 * is the delivery destination root; `coreOutput` the `realvirtual-web/` tree inside it.
 */
export function curateCoreMarkdownLinks(workspaceRoot: string, coreOutput: string): void;
/** Fails when a delivered Markdown file links a relative path that is absent from the tree. */
export function assertNoBrokenDocLinks(stagingRoot: string): void;
export function stageFilteredSourceTree(options: Record<string, any>): { workspaceRoot: string; coreRoot: string; privateRoot: string | null; project: any; projectKey: string | null; projectKeys: string[]; delivery: any; manifest: TierManifest };
export function assertNoCrossTierLeak(workspaceRoot: string, manifest: TierManifest, profile: DeliveryProfile): void;
export function assertWorkspaceGuards(workspaceRoot: string, options?: Record<string, any>): void;
export function assertLfsPointer(repoRoot: string): void;
/** Fails when a tracked file of `projects/<key>` is still an unfetched Git LFS pointer. */
export function assertNoUnfetchedLfsObjects(privateRoot: string, key: string, files: Iterable<string>): void;
/** Fails when `projects/<key>` carries any change or untracked, unignored file. */
export function assertProjectTreeClean(privateRoot: string, key: string): void;
export function assertNoSentinelInArtifacts(distRoot: string, sentinels: string[]): void;
export function gitProvenance(repoRoot: string, options?: { requireTag?: boolean }): { commit: string; tags: string[] };
export function hashTree(root: string, excludes?: string[]): string;
export function runBuild(workspaceRoot: string, options?: Record<string, any>): { coreRoot: string; distDir: string; dryRun: boolean };
export function assertBuildProvenance(distDir: string, expected?: Record<string, any>): Record<string, any>;
export function applySnapshot(
  stagedRoot: string,
  cloneRoot: string,
  options?: {
    version?: string;
    /** Project folders to replace as an exact snapshot; ignored on a first delivery. */
    replaceProjects?: string[];
    log?: (line: string) => void;
  },
): DeliverySnapshot;
export function detectDeliveryBaseline(clone: string): DeliveryBaseline;
/**
 * Resolves `--projects` names against what this delivery carries. `all` means
 * every vendor project plus the demo, never a folder the customer created.
 * Throws on an unknown name, naming the right spelling for a case-only miss.
 */
export function resolveRequestedProjects(requested: string[] | string, available: string[]): string[];
/** Lists what a `--projects` replace would overwrite or delete — call BEFORE applySnapshot. */
export function previewProjectReplace(
  stagedRoot: string,
  cloneRoot: string,
  names: string[],
  options?: { log?: (line: string) => void },
): ProjectReplacePreview;
/** Thrown when a `--projects` replace was neither confirmed nor forced; carries exitCode 1. */
export class ProjectReplaceAbort extends Error {
  exitCode: number;
}
export function confirmProjectReplace(
  preview: ProjectReplacePreview,
  options?: {
    force?: boolean;
    log?: (line: string) => void;
    interactive?: boolean;
    ask?: (question: string) => string;
  },
): { confirmed: boolean; reason: 'no-deviation' | 'force' | 'interactive' };
export function formatSnapshotSummary(snapshot: DeliverySnapshot): string;
/** The paragraph the first delivery under the new model puts in its commit message (F9). */
export function changeoverCommitNote(
  previousManifestVersion: number | null,
  snapshot?: DeliverySnapshot | { sidecarsRemoved?: string[] } | null,
): string;
export function createDeliveryManifest(options: Record<string, any>): Record<string, any>;

// ─── delivery-manifest baseline (plan-738 §2.8) ──────────────────────────
export const DELIVERY_MANIFEST_VERSION: number;
export function baselineTagFor(version: string): string;
export function readDeliveryManifest(raw: unknown): {
  manifestVersion: number;
  baselineTag: string | null;
  projects: Record<string, any>;
  [key: string]: any;
};
export function withDeliveryBaseline(
  base: Record<string, any>,
  // Extra keys on a project entry are accepted and ignored: a caller may still be
  // handing over an old-shaped entry, and v3 simply has nowhere to put the rest.
  options: { version: string; projects?: Record<string, { schemaVersion?: number | null; [key: string]: any }> },
): Record<string, any>;
export function parseLsFiles(output: string): Record<string, string>;
export function parseLsTree(output: string): Record<string, string>;
export interface PrivateSourceInventory { count: number; sha256: string; paths: string[] }
export interface BaselineSourceInventory { paths: string[]; trusted: boolean; reason: string | null }
export interface PrivateSourceDiff {
  gated: boolean;
  trusted: boolean;
  reason: string | null;
  added: string[];
  removed: string[];
}
export function inventoryDigest(paths: readonly string[]): string;
export function collectPrivateSourceInventory(workspaceRoot: string): PrivateSourceInventory;
export function parseBaselineSourceInventory(baseline: string | Record<string, any> | null | undefined): BaselineSourceInventory | null;
export function diffPrivateSourceInventory(baseline: BaselineSourceInventory | null, current: PrivateSourceInventory): PrivateSourceDiff;
export function assertPrivateSourceInventory(
  baseline: BaselineSourceInventory | null,
  current: PrivateSourceInventory,
  options?: { acceptNew?: boolean },
): PrivateSourceDiff;
export function readBaselineSourceInventory(clone: string, baselineTag: string | null): BaselineSourceInventory | null;
export function deliveryChangelog(coreRoot: string, previousCoreCommit: string | null, options?: { limit?: number }): string;

/**
 * Options for {@link generatedSettings} (plan-721 F7).
 *
 * Both are opt-in and both default to "behave exactly as before": a delivery
 * that passes neither produces the file this function has always produced.
 */
export interface GeneratedSettingsOptions {
  /**
   * Leave `defaultModel` OUT of the delivered `settings.json` entirely — not
   * blank, absent. An appliance boots from `project.json`, and a second copy of
   * "which document opens first" baked into the runtime is the LOP-116 class of
   * bug: two answers that drift, with the stale one winning.
   */
  omitDefaultModel?: boolean;
  /**
   * Workspace mode to lock the deployment into (`"hmi"` for a kiosk). Written
   * as `mode: { lock }` and read by `main.ts` BEFORE the boot resolves what to
   * open. A blank value writes nothing.
   */
  modeLock?: string;
}

export function generatedSettings(
  project: Record<string, any> | null | undefined,
  delivery: Record<string, any>,
  connectPin: Record<string, any> | null | undefined,
  options?: GeneratedSettingsOptions,
): Record<string, any>;
