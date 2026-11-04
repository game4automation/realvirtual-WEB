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
/** plan-679 Phase 1: how the scanner reads one file. */
export interface SecretScanOptions {
  /** Test injection: returns the `typescript` module, or `null` when it is not installed. */
  loadTypeScript?: () => unknown;
  /** Throw instead of falling back when the parser is missing (delivery path). */
  requireParser?: boolean;
  /** Called on every fallback read of a JS-family file. */
  onFallback?: (message: string) => void;
}
export interface SecretScanParts {
  literals: string[];
  prose: string[];
  parser: 'typescript' | 'fallback' | 'none';
}
export const PARSED_SOURCE_EXTENSIONS: Set<string>;
export function loadTypeScriptFromGuardModule(): unknown;
export function splitSourceLiteralsAndProse(ts: unknown, text: string, extension: string): { literals: string[]; prose: string[] };
export function secretScanParts(text: string, relativePath: string, extension: string, options?: SecretScanOptions): SecretScanParts;
export function secretScanValues(text: string, relativePath: string, extension: string, options?: SecretScanOptions): string[];
export function containsHighEntropyFragment(value: string): boolean;
export function isHttpUrlLiteral(value: string): boolean;
export function isTestFile(relativePath: string): boolean;
export function secretContentViolation(relLower: string, extension: string, text: string, options?: SecretScanOptions): string | null;
export const CONNECT_LICENSE_KEY_PATTERN: RegExp;
export function looksLikeSecretValue(value: unknown): boolean;
export function assertNoSecrets(
  root: string,
  options?: { skipDirs?: string[]; loadTypeScript?: () => unknown; warn?: (message: string) => void },
): void;

export type ProjectKind = 'customer' | 'demo' | 'internal';
export const PROJECT_KINDS: readonly ProjectKind[];
export function isProjectKind(value: unknown): value is ProjectKind;
export function projectKindOf(projectsDir: string, name: string): ProjectKind | null;
export function knownProjectKeys(privateRoot: string, options?: { kind?: ProjectKind }): string[];

export const MAX_DELIVERY_FILE_BYTES: number;
export function isOversizedDeliveryFile(absolutePath: string): boolean;
export function fileNameOf(path: string): string;

// ─── Secrets as references (plan-718) ───────────────────────────────────

export const CREDENTIAL_PROPERTY_NAMES: readonly string[];
export function isCredentialPropertyName(name: unknown): boolean;
export function isSecretReferenceValue(value: unknown): boolean;
export function collectSecretRefKeys(value: unknown, keys?: string[]): string[];
export function plaintextSecretPaths(value: unknown, path?: Array<string | number>, out?: string[]): string[];

// ─── Hosted deploy deny list (plan-759 F1) ───────────────────────────────

export const HOSTED_DEPLOY_DENIED_DIRS: readonly string[];
export const HOSTED_DEPLOY_DENIED_FILES: readonly RegExp[];
export const HOSTED_DEPLOY_WARN_FILE_BYTES: number;
export interface ProjectIgnoreRule {
  source: string;
  re: RegExp;
  dirOnly: boolean;
  anchored: boolean;
}
/** Parses a `.rvprojectignore` (gitignore-lite); throws on negation. */
export function parseProjectIgnoreRules(text: string | null | undefined): ProjectIgnoreRule[];
/** `<projectDir>/.rvprojectignore` parsed, `[]` when absent. */
export function readProjectIgnoreRules(projectDir: string): ProjectIgnoreRule[];
/** `null` when the path travels, else the short reason it is removed. */
export function hostedDeployDenyReason(
  relPath: string,
  opts?: { isDir?: boolean; ignoreRules?: ProjectIgnoreRule[] },
): string | null;
export function isHostedDeployDenied(
  relPath: string,
  opts?: { isDir?: boolean; ignoreRules?: ProjectIgnoreRule[] },
): boolean;
