// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** Type declarations for vite-plugin-third-party-notices.mjs (plan-544). */

import type { Plugin } from 'vite';
import type { NoticesMode, NoticesTier } from './lib/rv-third-party-notices.mjs';

export interface PolicySpec { path: string; scope: 'public' | 'private' | 'customer'; optional?: boolean }

export interface ThirdPartyNoticesOptions {
  rootDir: string;
  policies: PolicySpec[];
  manualComponents?: string;
  licenseTextsDir?: string;
  tier?: NoticesTier;
  mode?: NoticesMode;
  releaseBuild?: boolean;
  env?: Record<string, string | undefined>;
  product?: string;
  firstPartyNames?: string[];
  /** package.json files whose dependencies count as declared for the stale rule (default: root + private). */
  declaredManifests?: string[];
}

export interface ThirdPartyNotices {
  collector: { modules: Set<string>; urlModules: Set<string>; assets: Set<string> };
  /** plan-587 Phase 4: how often the memoised inputs were actually read from disk. */
  reads: { manualComponents: number; policies: number };
  plugin(): Plugin;
  workerPlugin(): Plugin;
  devPreview(): string;
}

export function createThirdPartyNotices(options: ThirdPartyNoticesOptions): ThirdPartyNotices;
export function cleanModuleId(id: string): string | null;
export function isUrlImport(id: string): boolean;
export function createPackageRootResolver(): (modulePath: string) => string | null;
export function noticesTierFromEnv(hasPrivate: boolean, env?: Record<string, string | undefined>): NoticesTier;
export function defaultPolicySpecs(rootDir: string, privateRoot: string | null): PolicySpec[];
