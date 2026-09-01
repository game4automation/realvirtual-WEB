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

export interface MergedSnapshotProject {
  seeded: boolean;
  added: string[];
  updated: string[];
  removed: string[];
  addPending: string[];
  /** Paths the customer kept; carried into the next delivery so it cannot overwrite them. */
  keptByCustomer: string[];
  conflicts: Array<{ path: string; reason: string; sidecar: boolean; sidecarPath: string | null }>;
}

export interface MergedSnapshot {
  version: string;
  generatedAt: string;
  remoteEmpty: boolean;
  baselineTag: string | null;
  projects: Record<string, MergedSnapshotProject>;
  drift: Array<{ status: string; path: string }>;
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
export function stageFilteredSourceTree(options: Record<string, any>): { workspaceRoot: string; coreRoot: string; privateRoot: string | null; project: any; projectKey: string | null; projectKeys: string[]; delivery: any; manifest: TierManifest };
export function assertNoCrossTierLeak(workspaceRoot: string, manifest: TierManifest, profile: DeliveryProfile): void;
export function assertWorkspaceGuards(workspaceRoot: string, options?: Record<string, any>): void;
export function assertLfsPointer(repoRoot: string): void;
export function assertNoSentinelInArtifacts(distRoot: string, sentinels: string[]): void;
export function gitProvenance(repoRoot: string, options?: { requireTag?: boolean }): { commit: string; tags: string[] };
export function hashTree(root: string, excludes?: string[]): string;
export function runBuild(workspaceRoot: string, options?: Record<string, any>): { coreRoot: string; distDir: string; dryRun: boolean };
export function assertBuildProvenance(distDir: string, expected?: Record<string, any>): Record<string, any>;
export function applyMergedSnapshot(
  stagedRoot: string,
  cloneRoot: string,
  options: { projects: Array<{ key: string; vendor?: { managed?: string[]; handover?: string[] } | null }>; version: string; seedMissing?: boolean },
): MergedSnapshot;
export function renderDeliveryReport(snapshot: MergedSnapshot): string;
export function formatMergeSummary(snapshot: MergedSnapshot): string;
export function mergeCommitNote(snapshot: MergedSnapshot): string;
export function summariseMerge(result: { actions: Record<string, string>; conflicts: unknown[] }): Record<string, number>;
export function createDeliveryManifest(options: Record<string, any>): Record<string, any>;
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
