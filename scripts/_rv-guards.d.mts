// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Type declarations for `_rv-guards.mjs`.
 *
 * Required because the Node tests import the module statically from TypeScript;
 * without it `npx tsc --noEmit` fails with TS7016. Keep in step with the .mjs —
 * there is no compiler check tying the two together.
 */

export interface RvVendorBlock {
  managed?: string[];
  handover?: string[];
  [key: string]: unknown;
}

export const SECRET_FILE_PATTERNS: readonly RegExp[];
export function isSecretFileName(name: string): boolean;
export function isSecretPath(relPath: string): boolean;

export const PROJECT_ASSET_SKIP_DIRS: readonly string[];
export const DENIED_PROJECT_ASSET_FILES: readonly string[];
export function isProjectAssetSkipDir(name: string): boolean;
export function isDeniedProjectArtifactPath(relPath: string): boolean;
export function isDeniedProjectArtifact(projectRoot: string, sourcePath: string): boolean;

export const SECRET_SCAN_EXTENSIONS: Set<string>;
export function isAllowedSecretSchemaPath(relativePath: string, propertyPath: Array<string | number>): boolean;
export function collectJsonStringValues(
  value: unknown, relativePath: string, propertyPath?: Array<string | number>, values?: string[],
): string[];
export function secretScanValues(text: string, relativePath: string, extension: string): string[];
export function containsHighEntropyFragment(value: string): boolean;
export function isHttpUrlLiteral(value: string): boolean;
export function isTestFile(relativePath: string): boolean;
export function secretContentViolation(relLower: string, extension: string, text: string): string | null;
export function assertNoSecrets(root: string, options?: { skipDirs?: string[] }): void;

export function knownProjectKeys(privateRoot: string): string[];

export const CUSTOMER_OWNED_FOLDERS: readonly string[];
export const DEFAULT_VENDOR_BLOCK: { readonly managed: readonly string[]; readonly handover: readonly string[] };
export function vendorGlobProblems(vendor: unknown): string[];
export function assertVendorGlobs(vendor: unknown, label?: string): void;

export const MAX_DELIVERY_FILE_BYTES: number;
export function isOversizedDeliveryFile(absolutePath: string): boolean;
export function fileNameOf(path: string): string;
