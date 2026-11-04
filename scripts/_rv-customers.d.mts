// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/** Type declarations for `_rv-customers.mjs` (see `_rv-guards.d.mts`). */

export interface RvCustomerForgejo {
  org: string;
  repo: string;
  team: string;
  permission: 'read' | 'write';
}

export interface RvCustomerContact {
  login: string;
  email?: string;
  fullName?: string;
  role?: string;
  status: 'active' | 'inactive';
}

export interface RvCustomerLicensing {
  connect?: {
    issuer: string;
    /**
     * The licence key as a VALUE (2026-09-13). It used to be a `keyRef` naming
     * a field in a gitignored sidecar; optional because a customer sits between
     * onboarding and the portal without one. See `validateCustomer` in
     * `_rv-customers.mjs`, which is the authority on this shape.
     */
    key?: string;
    seats?: number;
    activatedFingerprints?: number;
  };
}

/** The Requesty pair, carried in the register entry itself. */
export interface RvCustomerInference {
  requestyApiKey?: string;
  requestyBaseUrl?: string;
}

export interface RvCustomerDelivery {
  channel: 'git-workspace' | 'hosted-link' | 'connect-exe';
  tier: 'core' | 'commercial';
  restrictedFeatures: string[];
  projects: string[];
  connectChannel: 'stable' | 'beta';
  mirror: string | null;
}

export interface RvCustomer {
  schemaVersion: number;
  customer: string;
  displayName: string;
  kind: 'development' | 'standard';
  support: 'managed' | 'basic';
  status: 'active' | 'suspended';
  forgejo?: RvCustomerForgejo;
  contacts: RvCustomerContact[];
  licensing?: RvCustomerLicensing;
  delivery: RvCustomerDelivery;
  billing?: { billomatCustomer?: string };
  inference?: RvCustomerInference;
  /** plan-759: the hosted-link key halves, in the entry like the licence. */
  hosted?: RvCustomerHosted;
  /** plan-603: the partner's own Bunny zone, from which he publishes his own projects. */
  publishing?: RvCustomerPublishing;
  secretsRef?: string;
}

/** A partner's publishing target — his own storage zone in our Bunny account (plan-603 D1). */
export interface RvCustomerPublishing {
  target: 'partner-zone';
  /** Storage-zone name, e.g. `rv-partner-customer`. */
  storageZone: string;
  storageZoneId?: number;
  pullZoneId?: number;
  /** Public hostname of the pull zone, e.g. `customer.web.realvirtual.io`. */
  hostname: string;
  region?: 'DE' | 'NY' | 'LA' | 'SG';
  /** Monthly bandwidth cap in GB; 0 means uncapped and is reported by the doctor. */
  monthlyBandwidthGb?: number;
  /** The zone password we issue to the partner (write + delete inside HIS zone only). */
  storageKey?: string;
}

export interface RvPartnerPublishing {
  target: 'partner-zone';
  storageZone: string;
  storageZoneId: number | null;
  pullZoneId: number | null;
  hostname: string;
  region: 'DE' | 'NY' | 'LA' | 'SG';
  monthlyBandwidthGb: number | null;
  storageKey: string | null;
}

export const PUBLISHING_TARGETS: readonly ['partner-zone'];
export const BUNNY_REGIONS: readonly ['DE', 'NY', 'LA', 'SG'];

/** The partner's publishing target, or null when the entry has none. */
export function resolvePartnerPublishing(customer: RvCustomer | null | undefined): RvPartnerPublishing | null;
/** The `.env` lines the partner pastes into his clone (`BUNNY_STORAGE_KEY` only once known). */
export function partnerDeployEnv(publishing: RvPartnerPublishing | null): Array<[string, string]>;
/** Merges a provisioning result into `customers/<slug>.json`; refuses a silent zone swap. */
export function recordPartnerPublishing(
  privateRoot: string,
  slug: string,
  publishing: Partial<RvCustomerPublishing>,
): RvCustomer;
/** The entry with both register credentials masked for display. */
export function redactRegisterSecrets<T extends RvCustomer>(customer: T): T;

/** The two halves of a hosted deploy's key (plan-759 D6b). */
export interface RvCustomerHosted {
  /** base64url of 32 bytes — the `#k=` link factor; stable across re-publishes. */
  fragment?: string;
  /** The password the customer types (≥ 8 characters). */
  password?: string;
}

export interface RvHostedSecrets {
  password: string | null;
  fragment: string | null;
  source: 'env' | 'register' | null;
}

/** True for the base64url form of exactly 32 bytes. */
export function isHostedFragment(value: unknown): boolean;
/** Password + fragment, environment over register; `customer` may be null. */
export function resolveHostedSecrets(
  customer: RvCustomer | null | undefined,
  env?: Record<string, string | undefined>,
): RvHostedSecrets;
/** Writes a minted fragment into `customers/<slug>.json`; refuses to overwrite one. */
export function recordHostedFragment(privateRoot: string, slug: string, fragment: string): RvCustomer;
/** The entry with `hosted.password` masked for display. */
export function redactHostedSecrets<T extends RvCustomer>(customer: T): T;

export interface RvCustomerContext {
  fileName?: string;
  privateRoot?: string;
  manifest?: any;
  presetsRoot?: string;
  /** Doctor only: deep library resolution (default off - shape checks only). */
  deepLibraries?: boolean;
  librarySources?: { projectsDir?: string | null; libraries?: Record<string, string> };
}

export interface RvCustomerFindings {
  errors: string[];
  warnings: string[];
}

export interface RvCustomerLoadOptions {
  manifest?: any;
  presetsRoot?: string;
  onWarning?: (warning: string) => void;
}

export interface RvCustomerSecrets {
  connectLicenseKey?: string;
  requestyApiKey?: string;
  requestyBaseUrl?: string;
  path: string;
}

export const CUSTOMER_SCHEMA_VERSION: number;
export const CUSTOMER_KINDS: readonly string[];
export const CUSTOMER_SUPPORT_LEVELS: readonly string[];
export const CUSTOMER_STATUSES: readonly string[];
export const DELIVERY_CHANNELS: readonly string[];
export const CONTACT_STATUSES: readonly string[];
export const FORGEJO_PERMISSIONS: readonly string[];
export const CUSTOMER_SECRET_KEYS: readonly string[];
/**
 * The hub, named once (plan-739 F6). Both `_workspace-lib.mjs` `hubBaseUrl()` and
 * the private `scripts/deliver-release.mjs` read THIS constant; there is no second.
 */
export const DEFAULT_HUB_URL: string;
/** Org of the one repository every shared standard customer receives (plan-434 §2.7). */
export const SHARED_ORG: string;
/** Repository name inside {@link SHARED_ORG}. */
export const SHARED_REPO: string;

export function isSharedForgejo(customer: Partial<RvCustomer> | null | undefined): boolean;
/** plan-679 Phase 2: true when a delivery of this customer carries the diagnosis package (`support: "managed"`). */
export function deliversDiagnosis(customer: unknown): boolean;

export function customerRegistryPath(privateRoot: string, slug: string): string;
export function customerSecretsPath(privateRoot: string, customer: Partial<RvCustomer>): string;
export function diagnosisPresetPath(privateRoot: string, projectKey: string, presetsRoot?: string | null): string;
export function listCustomerSlugs(privateRoot: string): string[];
export function assertCustomerInvariants(customer: unknown, context?: RvCustomerContext): RvCustomerFindings;
export function loadCustomer(privateRoot: string, slug: string, options?: RvCustomerLoadOptions): RvCustomer;
export function listCustomers(privateRoot: string, options?: RvCustomerLoadOptions): RvCustomer[];
export function resolveCustomerForProject(
  privateRoot: string, projectKey: string, options?: RvCustomerLoadOptions,
): RvCustomer | null;
export function customerRemoteUrl(customer: RvCustomer, hubBaseUrl?: string): string;
export function resolveCustomerSecrets(
  privateRoot: string,
  customer: RvCustomer,
  options?: {
    env?: Record<string, string | undefined>;
    /** `false` when the run does not ship the key (shared-repo delivery). Default `true`. */
    requireLicenseKey?: boolean;
  },
): RvCustomerSecrets;

/** plan-778: library findings of projects/<key> (libraries[] shape, then resolution by id in projects/). */
export function projectLibraryProblems(
  privateRoot: string,
  key: string,
  opts?: { deep?: boolean; sources?: { projectsDir?: string | null; libraries?: Record<string, string> } },
): string[];
