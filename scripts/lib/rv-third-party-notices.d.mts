// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** Type declarations for rv-third-party-notices.mjs (plan-544). */

export type NoticesMode = 'warn' | 'enforce';
export type NoticesTier = 'public' | 'demo' | 'private';

export interface ThirdPartyComponent {
  name: string;
  version: string;
  license: string;
  licenseExpression: string;
  licenseDecision?: string;
  copyright: string[];
  licenseText: string;
  noticeText?: string;
  source: string;
  repository?: string;
  origin: 'npm' | 'nuget' | 'manual';
  linking?: 'dynamic' | 'static';
  vendorTerms?: boolean;
  vendor?: string | null;
  pending?: string;
  notes: string[];
  files?: string[];
  /** Short label of a change we made to the shipped files ("memory limit patch"); details in notes. */
  modified?: string;
  exception?: { reason: string; decidedBy: string; date: string };
}

export interface LicensePolicy {
  path?: string;
  scope: 'public' | 'private' | 'customer';
  allowed: string[];
  dynamicOnly: string[];
  exceptions: Array<{ name: string; version: string; license?: string; reason: string; decidedBy: string; date: string }>;
  vendorTerms: Array<{ name: string; version: string; vendor: string; licenseRef: string; reason: string; decidedBy?: string; date?: string }>;
}

export interface Violation { name: string; version: string; rule: string; message: string }

export const DEFAULT_LICENSE_TEXTS_DIR: string;
export const RELEASE_DEFAULT_MODE: NoticesMode;
export const NOTICES_TXT: string;
export const NOTICES_JSON: string;
export const OCCT_NOTICE: string;

export function normalizeText(text: unknown): string;
export function compareCodePoint(a: string, b: string): number;
export function resolveNoticesMode(options?: { env?: Record<string, string | undefined>; releaseBuild?: boolean; releaseDefault?: NoticesMode }): { mode: NoticesMode; source: string };
export function readNoticesMode(jsonPath: string): NoticesMode | null;
export function noticesWarnBanner(jsonPath: string, options?: { product?: string }): string | null;
export function canonicalSpdxId(id: string): string;
export function normalizeLicenseField(pkg: unknown): { expression: string; licenseFile: string | null; raw: string };
export type SpdxNode = { type: 'id'; id: string; exception?: string } | { type: 'or' | 'and'; items: SpdxNode[] };
export function parseSpdx(expression: string): SpdxNode;
export function stringifySpdx(node: SpdxNode, parent?: string | null): string;
export function spdxIds(node: SpdxNode): string[];
export function evaluateSpdx(expression: string | SpdxNode, policy: { allowed?: string[]; dynamicOnly?: string[] }): { ok: boolean; chosen: string; dynamicOnly: boolean; reason: string | null; rank: number };
export function loadPolicy(path: string, options?: { scope: LicensePolicy['scope']; optional?: boolean }): LicensePolicy | null;
export function mergePolicies(policies: Array<Pick<LicensePolicy, 'allowed' | 'dynamicOnly'>>): { allowed: string[]; dynamicOnly: string[] };
export function applyPolicy(components: ThirdPartyComponent[], policies: LicensePolicy[], options?: { tier?: NoticesTier; declared?: Iterable<string> }): { violations: Violation[]; staleExceptions: Array<Record<string, unknown>> };
export function extractCopyright(text: string, options?: { licenseTextsDir?: string }): string[];
export const IDENTIFIABLE_IDS: string[];
export function identifyLicenseText(text: string, options?: { candidates?: string[]; licenseTextsDir?: string }): string | null;
export function canonicalLicenseText(id: string, options?: { licenseTextsDir?: string }): string | null;
export function canonicalTextForExpression(expression: string, options?: { licenseTextsDir?: string }): string | null;
export function npmSourceUrl(name: string, version: string): string;
export function componentFromPackageDir(dir: string, options?: { licenseTextsDir?: string; linking?: 'static' | 'dynamic' }): ThirdPartyComponent;
export function componentFromManual(entry: Record<string, unknown>, options?: { baseDir?: string; licenseTextsDir?: string; origin?: ThirdPartyComponent['origin'] }): ThirdPartyComponent;
export function loadManualComponents(path: string): Array<Record<string, unknown>>;
export function globToRegExp(glob: string): RegExp;
export function anyGlobMatches(globs: string[] | undefined, candidates: Iterable<string>): boolean;
export function sortAndDedupe(components: ThirdPartyComponent[]): ThirdPartyComponent[];
export function renderNotices(input: { product: string; components: ThirdPartyComponent[]; violations?: Violation[]; mode: NoticesMode; preview?: boolean; incomplete?: string[]; appendix?: string }): string;
export function renderJson(input: { product: string; components: ThirdPartyComponent[]; violations?: Violation[]; mode: NoticesMode; tier?: string | null; incomplete?: string[] }): string;
export function componentsFromNoticesJson(jsonPath: string): ThirdPartyComponent[];
