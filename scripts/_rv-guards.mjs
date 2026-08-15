// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * _rv-guards — the single source of truth for "this must never leave the
 * building" (plan-700 §2.9, B10/B11).
 *
 * ## The problem this replaces
 *
 * Four independent lists said what a secret is and what must not be published:
 * `_workspace-lib.mjs` (delivery), `validate-project.mjs` (CI gate),
 * `bunny-deploy.mjs` (CDN publish) and the CONNECT repo's `stage-project.mjs`
 * (embedded build). They had already drifted — `connect/secrets.local.json`,
 * declared binding by plan-370 §3.8, appeared in none of them.
 *
 * A drifting denylist is worse than no denylist: it creates the belief that a
 * path is covered. So there is now exactly one list per concern, here, and a
 * drift test (`tests/rv-guards.node.test.ts`) fails the build if a caller grows
 * its own array again.
 *
 * ## What lives here and what does not
 *
 * Here: what is forbidden, and how to recognise it. Not here: how to walk a
 * tree or match a glob — that is `_rv-fs-utils.mjs`, which this module imports
 * and `_workspace-lib.mjs` imports too. Neither of those two imports the other,
 * which is the whole reason the split exists.
 *
 * ## Name-based, not content-sniffing
 *
 * Secret *files* are matched on their name. Content sniffing for keys produces
 * false positives on legitimate data — a GLB full of compressed bytes matches
 * any entropy heuristic — and a name rule is one a human can verify by reading
 * it. Content scanning exists too ({@link secretContentViolation}) but is
 * confined to text extensions and carries explicit schema exemptions.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

import { globRegex, walk } from './_rv-fs-utils.mjs';

// ─── Secret files (matched on the file NAME) ─────────────────────────────

/**
 * Files that must never be committed into a project, delivered to a customer,
 * or uploaded to a CDN. Matched against the bare filename.
 *
 * `secrets.local.json` and `*.secrets.json` are the entries plan-370 §3.8
 * declared binding and that no list actually carried (B11): CONNECT reads
 * `connect/secrets.local.json` for gateway credentials, so it is precisely the
 * file a project is most likely to acquire and least likely to notice.
 */
export const SECRET_FILE_PATTERNS = Object.freeze([
  // Prefix, not exact: the delivery guard has always rejected any segment
  // starting with `.env`, and narrowing that here would silently weaken a
  // guard while appearing to consolidate it.
  /^\.env/i,
  /^\.npmrc$/i,
  /(^|\.)mcp_auth_token$/i,
  /^secrets\.local\.json$/i,
  /^.*\.secrets\.json$/i,
  /^.*\.pem$/i,
  /^.*\.p12$/i,
  /^.*\.pfx$/i,
  /^.*\.snk$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)$/i,
  /^.*\.keystore$/i,
  /^credentials(\.json)?$/i,
  /^service-account.*\.json$/i,
]);

//! True when a bare filename is a secret-bearing file.
export function isSecretFileName(name) {
  return SECRET_FILE_PATTERNS.some((pattern) => pattern.test(name));
}

/**
 * True when any segment of a relative path is a secret-bearing file or a
 * directory named like one (`.env.d/`, `secrets.local.json/`).
 *
 * Segment-wise rather than filename-only, because the delivery guard has
 * always rejected a *directory* called `.env…` too, and dropping that would be
 * a silent weakening of an existing guard.
 */
export function isSecretPath(relPath) {
  return relPath.split(/[\\/]/).some((segment) => isSecretFileName(segment));
}

// ─── Denied project artefacts (publish / embed) ──────────────────────────

/**
 * TOP-LEVEL project folders that are code or machinery, not publishable assets.
 * Skipped at depth 1 only — a `docs/scripts/` folder is documentation content
 * and must still travel, which is why this is a separate, shallower rule than
 * {@link isDeniedProjectArtifactPath} rather than one merged predicate.
 */
export const PROJECT_ASSET_SKIP_DIRS = Object.freeze([
  'models', 'plugins', 'scripts', 'node_modules', '.git',
]);

/**
 * Path segments that are derived RAG/vector working data at any depth —
 * hundreds of megabytes whose only effect on a recipient is a slower download.
 */
const DENIED_ARTIFACT_SEGMENTS = Object.freeze(['index', 'runtime']);

/**
 * JSON files that are configuration or derived data, not assets.
 * `project-config.json` is CONNECT's gateway config and can carry API keys.
 */
export const DENIED_PROJECT_ASSET_FILES = Object.freeze([
  'project.json', 'project-config.json', 'llm.json', 'comments.json',
]);

//! True when a top-level project folder is code/machinery rather than an asset.
export function isProjectAssetSkipDir(name) {
  return PROJECT_ASSET_SKIP_DIRS.includes(name.toLowerCase());
}

/**
 * True when a project-relative path must never be published or embedded,
 * at any depth.
 *
 * Takes a project-relative POSIX path so it is testable without a filesystem;
 * callers holding absolute paths use {@link isDeniedProjectArtifact}.
 */
export function isDeniedProjectArtifactPath(relPath) {
  const segments = relPath.replace(/\\/g, '/').split('/').filter(Boolean).map((s) => s.toLowerCase());
  if (segments.length === 0) return false;
  const name = segments.at(-1);
  return segments.some((segment) => DENIED_ARTIFACT_SEGMENTS.includes(segment))
    || DENIED_PROJECT_ASSET_FILES.includes(name)
    || name.startsWith('vector-index')
    || name.endsWith('.summary.json')
    || name.endsWith('.key')
    || isSecretFileName(name);
}

//! Absolute-path form of {@link isDeniedProjectArtifactPath}. Paths outside the project are allowed.
export function isDeniedProjectArtifact(projectRoot, sourcePath) {
  const root = projectRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  const candidate = sourcePath.replace(/\\/g, '/');
  if (!candidate.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return false;
  return isDeniedProjectArtifactPath(candidate.slice(root.length + 1));
}

// ─── Secret content scanning ─────────────────────────────────────────────

/** Extensions worth reading as text. Anything else is data, not source. */
export const SECRET_SCAN_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.jsx', '.json', '.md', '.txt',
  '.ps1', '.sh', '.html', '.xml', '.yml', '.yaml', '.pem', '.key',
]);

const PLAIN_TEXT_SECRET_EXTENSIONS = new Set(['.txt', '.pem', '.key']);
const KNOWN_SECRET_FORMAT = /\b(?:rqsty-sk-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b/;
const COMPACT_JWS_FORMAT = /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/;
const HIGH_ENTROPY_FRAGMENT = /[A-Za-z0-9+/=_-]{32,}/g;
const HEX_DIGEST_LITERAL = /^[0-9a-fA-F]{32,}$/;
const SUBRESOURCE_INTEGRITY_LITERAL = /^(sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/;

function extractStringLiterals(text) {
  const values = [];
  for (let index = 0; index < text.length; index++) {
    const quote = text[index];
    if (quote !== '"' && quote !== "'" && quote !== '`') continue;
    let value = '';
    for (index += 1; index < text.length; index++) {
      const char = text[index];
      if (char === '\\') {
        if (index + 1 < text.length) value += text[++index];
      } else if (char === quote) {
        values.push(value);
        break;
      } else {
        value += char;
      }
    }
  }
  return values;
}

/**
 * The four places a credential-shaped string is legitimately part of a
 * delivered schema. Anywhere else it is a leak.
 *
 * The fourth is plan-718's: a `rv-connect-config/1.0` file may carry a secret
 * REFERENCE — `{"$secretRef": "linie1.plc"}` — and a reference is a name, not a
 * credential. The allowance is deliberately for the `$secretRef` LEAF only: the
 * sibling value it replaces (`"Password": "hunter2"`) stays scanned, which is
 * what makes "a committed connect file may not contain a plaintext secret" a
 * mechanical rule rather than a review habit.
 *
 * The connect file's own path is not fixed — it is whatever a `connectRef`
 * names — so the match is on the `$secretRef` property name, not on a file name.
 */
export function isAllowedSecretSchemaPath(relativePath, propertyPath) {
  if (propertyPath[propertyPath.length - 1] === '$secretRef'
    && /(^|\/)connect\/[^/]+\.json$/i.test(String(relativePath).replace(/\\/g, '/'))) {
    return true;
  }
  return relativePath === 'connect/project-config.json'
    && propertyPath.length === 2
    && propertyPath[0] === 'Diagnosis'
    && propertyPath[1] === 'RequestyApiKey'
    || relativePath === 'connect/project-config.json'
    && propertyPath.length === 3
    && propertyPath[0] === 'Agents'
    && propertyPath[1] === 'DeliveredApiKeys'
    && typeof propertyPath[2] === 'string'
    && propertyPath[2].length > 0
    || relativePath === 'realvirtual-web/public/settings.json'
    && propertyPath.length === 1
    && propertyPath[0] === 'connectLicensePrefill';
}

//! Flattens a parsed JSON value to its string leaves, skipping allowed schema paths.
export function collectJsonStringValues(value, relativePath, propertyPath = [], values = []) {
  if (typeof value === 'string') {
    if (!isAllowedSecretSchemaPath(relativePath, propertyPath)) values.push(value);
    return values;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectJsonStringValues(item, relativePath, [...propertyPath, index], values));
    return values;
  }
  if (value && typeof value === 'object') {
    Object.entries(value).forEach(([key, item]) => collectJsonStringValues(item, relativePath, [...propertyPath, key], values));
  }
  return values;
}

//! The strings worth scanning in one file: JSON leaves, or source-code literals.
export function secretScanValues(text, relativePath, extension) {
  if (extension === '.json') {
    try {
      return collectJsonStringValues(JSON.parse(text), relativePath);
    } catch { /* malformed JSON is scanned as ordinary text */ }
  }
  const values = extractStringLiterals(text);
  if (PLAIN_TEXT_SECRET_EXTENSIONS.has(extension)) values.push(text);
  return values;
}

function shannonEntropy(value) {
  const counts = new Map();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function isSubresourceIntegrityLiteral(value) {
  const match = SUBRESOURCE_INTEGRITY_LITERAL.exec(value);
  if (!match) return false;
  const expectedBytes = { sha256: 32, sha384: 48, sha512: 64 }[match[1]];
  const decoded = Buffer.from(match[2], 'base64');
  return decoded.length === expectedBytes && decoded.toString('base64') === match[2];
}

//! Longest unbroken run inside a separator-delimited fragment still read as a word, not a token.
//! Calibrated against real customer deliveries: engineering identifiers peak near 17 characters
//! per segment, while every token format keeps a random run of 33+ even behind a prefix.
//!
//! Raised 24 -> 30 after the contract-test identifiers of the share backend
//! (`myShares_DeleteRemovesAndReturns410`, `upload_CrossOwnerConfirmOrDelete_403`) aborted every
//! customer delivery: their CamelCase middle runs 25-26 characters. The value stays below the 33
//! this comment already calibrates for real tokens, so the band that only ever held false
//! positives is what got given up — nothing a token format reaches.
//!
//! Treating a CamelCase boundary as a separator was considered and rejected: a random mixed-case
//! token is *made* of case changes and would have been excused by it.
const MAX_IDENTIFIER_SEGMENT = 30;

//! True for `_`/`-` separated compound identifiers — machine designations, drawing numbers, signal
//! and file names — which only reach the 32-character fragment length by joining short words.
//! A fragment with no separator, or with one long dense run, is never excused: that is what a real
//! secret looks like even when it carries an `sk_live_`-style prefix.
function isSeparatedIdentifier(fragment) {
  const segments = fragment.split(/[_-]+/).filter(Boolean);
  if (segments.length < 2) return false;
  return segments.every((segment) => segment.length < MAX_IDENTIFIER_SEGMENT);
}

//! True when a string carries a fragment that looks generated rather than written.
export function containsHighEntropyFragment(value) {
  if (HEX_DIGEST_LITERAL.test(value) || isSubresourceIntegrityLiteral(value)) return false;
  HIGH_ENTROPY_FRAGMENT.lastIndex = 0;
  for (const match of value.matchAll(HIGH_ENTROPY_FRAGMENT)) {
    const fragment = match[0];
    if (fragment.includes('/')) continue;
    if (isSeparatedIdentifier(fragment)) continue;
    const characterClasses = [/[a-z]/, /[A-Z]/, /[0-9]/]
      .filter((pattern) => pattern.test(fragment)).length;
    if (characterClasses >= 3 && shannonEntropy(fragment) >= 3.5) return true;
  }
  return false;
}

//! True for an http(s) URL literal — long, dense, and never a credential by itself.
export function isHttpUrlLiteral(value) {
  return /^https?:\/\//i.test(value);
}

//! True for a test file, where fixture tokens are expected and not a leak.
export function isTestFile(relativePath) {
  const segments = relativePath.split('/');
  return segments.some((segment) => segment === 'test' || segment === 'tests' || segment === '__tests__')
    || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(relativePath);
}

/**
 * Scans one already-read text file. Returns a human-readable violation message,
 * or `null` when the file is clean.
 *
 * Returning a message instead of throwing lets the delivery guard fold this
 * into its own single tree walk (links, sizes, foreign names) rather than
 * walking the workspace twice.
 */
export function secretContentViolation(relLower, extension, text) {
  if (/-----BEGIN/.test(text)) return `PEM block found in ${relLower}.`;
  if (COMPACT_JWS_FORMAT.test(text)) return `Compact JWS found in ${relLower}.`;
  for (const value of secretScanValues(text, relLower, extension)) {
    if (KNOWN_SECRET_FORMAT.test(value)) {
      return `Token-like secret found outside an allowed schema path: ${relLower}.`;
    }
    if (/RVC1-[A-Za-z0-9_-]+/.test(value)) {
      return `CONNECT licence key found outside settings schema path: ${relLower}.`;
    }
    if (!isTestFile(relLower) && !isHttpUrlLiteral(value) && containsHighEntropyFragment(value)) {
      return `High-entropy string literal found in ${relLower}.`;
    }
  }
  return null;
}

// ─── Secrets as references (plan-718 §2.3 / F3) ─────────────────────────

/**
 * Property names whose VALUE is a credential.
 *
 * The one home for this list, for the reason the whole module exists: a second
 * copy in `validate-project.mjs` would drift, and the copies would each look
 * reasonable. Matched case-insensitively on the leaf property name only —
 * `Interfaces[0].Settings.Password`, not a path.
 *
 * Deliberately short and about VALUES, not about names in general:
 * `KeyFile`/`Keyword`/`Monkey` must not trip it, so the match is on the whole
 * name or on a `…Password`/`…Token`/`…Secret`/`…ApiKey` suffix.
 */
export const CREDENTIAL_PROPERTY_NAMES = Object.freeze([
  'password', 'passwd', 'pwd', 'passphrase', 'token', 'secret', 'apikey', 'api_key',
  'accesskey', 'privatekey', 'clientsecret', 'credential',
]);

//! True when a property NAME says its value is a credential.
export function isCredentialPropertyName(name) {
  const lower = String(name ?? '').toLowerCase().replace(/[^a-z_]/g, '');
  return CREDENTIAL_PROPERTY_NAMES.some(n => lower === n || lower.endsWith(n));
}

/**
 * True when a value is a REFERENCE to a secret rather than the secret itself.
 *
 * The two accepted forms of plan-718 §2.3 — `{"$secretRef": "linie1.plc"}` and
 * `"${env:RV_LINIE1_PLC}"` — plus the empty string, which configures nothing and
 * therefore leaks nothing.
 */
export function isSecretReferenceValue(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') {
    return value.trim() === '' || /^\$\{env:[^}]+\}$/.test(value.trim());
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    return typeof value.$secretRef === 'string' && value.$secretRef.trim() !== '';
  }
  return false;
}

/**
 * Every `$secretRef` key a parsed connect config names, in document order.
 *
 * Feeds the collision warning: secret keys are one flat namespace, so two
 * different connect files reaching for `plc.password` are either sharing on
 * purpose or colliding by accident, and only the author can tell which.
 */
export function collectSecretRefKeys(value, keys = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectSecretRefKeys(item, keys);
    return keys;
  }
  if (value && typeof value === 'object') {
    if (typeof value.$secretRef === 'string' && value.$secretRef.trim() !== '') {
      keys.push(value.$secretRef.trim());
    }
    for (const item of Object.values(value)) collectSecretRefKeys(item, keys);
  }
  return keys;
}

/**
 * Credential-named properties carrying a plaintext value, as `path` strings.
 *
 * A hard failure for a committed connect file (F3): the file travels — git, a
 * zip, a customer delivery — and a password in it is an incident, not a lint
 * warning. Entropy heuristics do not help here; `"Password": "hunter2"` is low
 * entropy and every bit as leaked, which is why the rule is about the property
 * NAME and the SHAPE of its value.
 */
export function plaintextSecretPaths(value, path = [], out = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => plaintextSecretPaths(item, [...path, index], out));
    return out;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (isCredentialPropertyName(key) && !isSecretReferenceValue(item)) {
        out.push([...path, key].join('.'));
        continue;
      }
      plaintextSecretPaths(item, [...path, key], out);
    }
  }
  return out;
}

// ─── Secret VALUES in operator-owned registers (plan-434 §2.3) ───────────

/**
 * A CONNECT licence key as the gateway actually issues them.
 *
 * The pattern lived as a literal inside `_workspace-lib.mjs`'s
 * `assertDeliveryFields`. The customer register (`_rv-customers.mjs`) has to
 * recognise the very same shape to refuse a key that was typed into the
 * register instead of the secrets file — and two independently maintained
 * copies of a secret pattern is exactly the drift this module exists to
 * prevent, so the definition moved here and both callers import it.
 */
export const CONNECT_LICENSE_KEY_PATTERN = /^LIC(-[A-Z0-9]{4}){3}$/i;

/**
 * A bare UUID. Not a secret by itself — but it *is* the shape the Requesty /
 * Scaleway inference keys carry, and `containsHighEntropyFragment` deliberately
 * excuses it (five short `-`-separated segments read as a compound identifier).
 * So a register value has to be judged by this rule too, or the one API key
 * format actually in use here would sail straight through.
 */
const UUID_SHAPED_SECRET = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * True when a *value* looks like a credential rather than a description.
 *
 * Used on operator-owned metadata (the customer register), never on delivered
 * content — {@link secretContentViolation} is the rule for that, and it stays
 * unchanged. The question here is narrower and stricter: "did somebody paste a
 * key where only a reference belongs?".
 */
export function looksLikeSecretValue(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (CONNECT_LICENSE_KEY_PATTERN.test(trimmed)) return true;
  if (KNOWN_SECRET_FORMAT.test(trimmed)) return true;
  if (COMPACT_JWS_FORMAT.test(trimmed)) return true;
  if (UUID_SHAPED_SECRET.test(trimmed)) return true;
  if (/^RVC1-[A-Za-z0-9_-]+$/.test(trimmed)) return true;
  return !isHttpUrlLiteral(trimmed) && containsHighEntropyFragment(trimmed);
}

/**
 * Walks a tree and throws on the first secret found, by name or by content.
 *
 * Used where there is no other guard walk to fold into (the incoming tree of a
 * customer pull, an ad-hoc check). The delivery guard uses the two primitives
 * directly.
 */
export function assertNoSecrets(root, { skipDirs = ['.git', 'node_modules', 'dist'] } = {}) {
  const skip = new Set(skipDirs.map((name) => name.toLowerCase()));
  walk(root, (absolute, rel, entry) => {
    if (entry.isDirectory()) return !skip.has(entry.name.toLowerCase());
    if (!entry.isFile()) return;
    if (isSecretPath(rel)) throw new Error(`Secret-bearing file is forbidden: ${rel}`);
    const lower = rel.toLowerCase();
    const ext = lower.slice(lower.lastIndexOf('.'));
    if (!SECRET_SCAN_EXTENSIONS.has(ext)) return;
    const violation = secretContentViolation(lower, ext, readFileSync(absolute, 'utf8'));
    if (violation) throw new Error(violation);
  });
}

// ─── Project discovery ───────────────────────────────────────────────────

/**
 * Every project key present under `<privateRoot>/projects/`, read from disk.
 *
 * This used to be a hardcoded four-element array in
 * `generate-customer-workspace.mjs` (B4). It fed the foreign-customer-name
 * guard, so the two projects missing from it (`festo`, `demo-realvirtual`)
 * were names the guard could not recognise — the one guard whose failure mode
 * is leaking one customer's material to another.
 *
 * A key is a directory carrying a `project.json`; anything else under
 * `projects/` is scratch and is ignored rather than reported, because the
 * guard's question is "which names are customer names", not "is this folder
 * well-formed".
 *
 * `{ kind: 'customer' }` narrows the answer to the folders that actually
 * declare themselves customer material (plan-434 §2.6). That is the form the
 * foreign-name guard wants: with every folder in the list, an internal
 * playground called `festo` or `new-project` reads as a foreign customer's name
 * and aborts a delivery over a fixture. Without the option the result is
 * unchanged, so existing callers keep their behaviour.
 */
export function knownProjectKeys(privateRoot, options = {}) {
  const projectsDir = join(privateRoot, 'projects');
  if (!existsSync(projectsDir)) return [];
  const keys = readdirSync(projectsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(projectsDir, name, 'project.json')))
    .sort();
  const wanted = options.kind;
  if (wanted === undefined) return keys;
  return keys.filter((name) => projectKindOf(projectsDir, name) === wanted);
}

/**
 * How a project folder declares itself (plan-434 §2.6).
 *
 * The register answers "which customers exist"; this answers the other half,
 * "what is this folder", and the two are not the same question — a folder can be
 * a customer project long before anybody wrote its register entry, and most
 * folders under `projects/` are neither.
 *
 *  - `customer` — real customer material. Travels under an NDA, is delivered,
 *    and is the only kind the foreign-name guard has to defend.
 *  - `demo` — something we show publicly.
 *  - `internal` — everything else: test fixtures, scratch, spikes.
 */
export const PROJECT_KINDS = Object.freeze(['customer', 'demo', 'internal']);

//! True when a value is one of {@link PROJECT_KINDS}.
export function isProjectKind(value) {
  return typeof value === 'string' && PROJECT_KINDS.includes(value);
}

/**
 * The declared `kind` of one project folder, or `null` when it declares none.
 *
 * Unreadable and unmigrated manifests both yield `null` rather than a guess: the
 * one consumer that filters on this is the foreign-customer-name guard, and
 * "I could not tell" must never silently become "customer".
 */
export function projectKindOf(projectsDir, name) {
  const manifest = join(projectsDir, name, 'project.json');
  if (!existsSync(manifest)) return null;
  try {
    const kind = JSON.parse(readFileSync(manifest, 'utf8'))?.kind;
    return isProjectKind(kind) ? kind : null;
  } catch {
    return null;
  }
}

// ─── Vendor globs (plan-700 §2.3) ────────────────────────────────────────

/**
 * Folders inside a project that are the customer's working data and can never
 * be vendor-managed. A glob that reaches into one of these is refused.
 *
 * These three are where a customer's actual work lives: the scenes they built,
 * the settings they tuned, the layouts they placed. Overwriting any of them is
 * the failure mode this whole plan exists to prevent.
 */
export const CUSTOMER_OWNED_FOLDERS = Object.freeze(['scenes', 'settings', 'layouts']);

/**
 * The conservative `vendor` block a migrated project starts with.
 *
 * Deliberately narrow. A human sharpens it per project afterwards; the cost of
 * a missing entry is one update that did not arrive, and the cost of a
 * superfluous one is customer data. Only the first is repairable.
 */
export const DEFAULT_VENDOR_BLOCK = Object.freeze({
  managed: Object.freeze(['models/**', 'library/**', 'docs/**', 'connect/**', 'plugins/**', 'rag/**']),
  handover: Object.freeze(['connect/secrets.local.json', 'models/custom/**']),
});

//! Probe paths used to prove a glob cannot reach customer-owned territory.
const CUSTOMER_PROBE_PATHS = CUSTOMER_OWNED_FOLDERS.flatMap((folder) => [
  `${folder}/a.json`,
  `${folder}/nested/a.json`,
  `${folder}`,
]);

/**
 * Reports every problem with a project's vendor globs. Empty array = usable.
 *
 * Checked mechanically rather than by review, because the review that matters
 * happens once and the glob is then read at every delivery. Three refusals:
 *
 *  - a bare `*` / `**` / `**\/*`: it claims the whole project, including the
 *    customer's scenes,
 *  - any glob that matches one of {@link CUSTOMER_PROBE_PATHS}: same effect,
 *    reached less obviously (`*\/*.json` does it),
 *  - a `handover` entry that no `managed` entry covers: harmless, but always a
 *    typo — `handover` only has meaning as an exception inside `managed`.
 */
export function vendorGlobProblems(vendor) {
  const problems = [];
  if (vendor === undefined || vendor === null) return problems;
  if (typeof vendor !== 'object' || Array.isArray(vendor)) {
    return ['"vendor" must be a JSON object.'];
  }
  for (const key of ['managed', 'handover']) {
    if (vendor[key] === undefined) continue;
    if (!Array.isArray(vendor[key])) problems.push(`"vendor.${key}" must be an array when present.`);
  }
  if (problems.length) return problems;

  const managed = Array.isArray(vendor.managed) ? vendor.managed : [];
  const handover = Array.isArray(vendor.handover) ? vendor.handover : [];
  for (const [key, globs] of [['managed', managed], ['handover', handover]]) {
    for (const glob of globs) {
      if (typeof glob !== 'string' || !glob.trim()) {
        problems.push(`"vendor.${key}" contains an empty entry.`);
        continue;
      }
      if (glob.startsWith('/') || glob.includes('..') || glob.includes('\\')) {
        problems.push(`"vendor.${key}": "${glob}" must be a relative POSIX glob inside the project.`);
      }
    }
  }
  for (const glob of managed) {
    if (typeof glob !== 'string') continue;
    if (['*', '**', '**/*', '*/**'].includes(glob.trim())) {
      problems.push(`"vendor.managed": "${glob}" claims the whole project, including customer data.`);
      continue;
    }
    const regex = globRegex(glob);
    const hit = CUSTOMER_PROBE_PATHS.find((probe) => regex.test(probe));
    if (hit) {
      problems.push(`"vendor.managed": "${glob}" can match customer-owned "${hit}" — `
        + `${CUSTOMER_OWNED_FOLDERS.map((f) => `${f}/`).join(', ')} are never vendor-managed.`);
    }
  }
  for (const glob of handover) {
    if (typeof glob !== 'string' || !glob.trim()) continue;
    const probe = concreteProbeFor(glob);
    if (!managed.some((m) => typeof m === 'string' && globRegex(m).test(probe))) {
      problems.push(`"vendor.handover": "${glob}" is outside every "managed" glob and has no effect.`);
    }
  }
  return problems;
}

/**
 * One concrete path a glob would match, used to ask "does any managed glob
 * cover this handover glob?" without implementing glob-vs-glob containment,
 * which is a harder problem than the question deserves.
 */
function concreteProbeFor(glob) {
  const DOUBLE = ' ';
  return glob
    .replace(/\*\*/g, DOUBLE)
    .replace(/\*/g, 'probe')
    .split(DOUBLE).join('probe/probe')
    .replace(/\/+$/, '');
}

//! Convenience for callers that want a hard failure rather than a list.
export function assertVendorGlobs(vendor, label = 'project.json') {
  const problems = vendorGlobProblems(vendor);
  if (problems.length) throw new Error(`${label}: ${problems.join(' ')}`);
}

//! Size ceiling for a single delivered file that is not routed through Git LFS.
export const MAX_DELIVERY_FILE_BYTES = 90 * 1024 * 1024;

//! True when a path on disk exceeds the delivery size ceiling.
export function isOversizedDeliveryFile(absolutePath) {
  return statSync(absolutePath).size > MAX_DELIVERY_FILE_BYTES;
}

//! Bare filename of a path, normalised across separators. Convenience re-export shape.
export function fileNameOf(path) {
  return basename(path.replace(/\\/g, '/'));
}
