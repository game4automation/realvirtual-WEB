// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/** Type declarations for `migrate-delivery-config.mjs` (see `_rv-guards.d.mts`). */

import type { RvCustomer } from './_rv-customers.d.mts';

export interface RvForgejoRemote {
  base: string;
  org: string;
  repo: string;
}

export interface RvMigrateAction {
  file: string;
  status: 'created' | 'updated' | 'unchanged';
  secretFields?: string[];
}

export interface RvMigrateResult {
  configName: string;
  slug: string;
  support: 'managed' | 'basic';
  entry: RvCustomer;
  actions: RvMigrateAction[];
}

export interface RvMigrateOptions {
  apply?: boolean;
  slug?: string;
  support?: 'managed' | 'basic';
  displayName?: string;
  billomatCustomer?: string;
  presetsRoot?: string;
}

export const CUSTOMERS_GITIGNORE: string;
export function parseForgejoRemote(remote: unknown): RvForgejoRemote | null;
export function customerFromDeliveryConfig(
  config: Record<string, any>,
  options: {
    slug: string;
    projects: string[];
    support: 'managed' | 'basic';
    displayName?: string;
    billomatCustomer?: string;
  },
): { entry: RvCustomer; secrets: Record<string, string> };
export function migrateDeliveryConfig(
  privateRoot: string, configName: string, options?: RvMigrateOptions,
): RvMigrateResult;
export function listLegacyConfigNames(privateRoot: string): string[];
