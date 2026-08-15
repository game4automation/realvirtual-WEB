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
    keyRef: string;
    seats?: number;
    activatedFingerprints?: number;
  };
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
  secretsRef?: string;
}

export interface RvCustomerContext {
  fileName?: string;
  privateRoot?: string;
  manifest?: any;
  presetsRoot?: string;
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
/** Org of the one repository every shared standard customer receives (plan-434 §2.7). */
export const SHARED_ORG: string;
/** Repository name inside {@link SHARED_ORG}. */
export const SHARED_REPO: string;

export function isSharedForgejo(customer: Partial<RvCustomer> | null | undefined): boolean;

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
export function customerRemoteUrl(customer: RvCustomer, hubBaseUrl: string): string;
export function resolveCustomerSecrets(
  privateRoot: string,
  customer: RvCustomer,
  options?: {
    env?: Record<string, string | undefined>;
    /** `false` when the run does not ship the key (shared-repo delivery). Default `true`. */
    requireLicenseKey?: boolean;
  },
): RvCustomerSecrets;
