// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-third-party-notices.mjs — the shared core of the third-party licence notices (plan-544).
 *
 * Used by the WEB Vite plugin (`scripts/vite-plugin-third-party-notices.mjs`) and by the CONNECT
 * generator (`realvirtual-Connect~/tools/gen-third-party-notices.mjs`, relative import). Pure
 * functions plus a few small file readers; no dependency outside Node's standard library.
 *
 * What it does, in order:
 *   1. normalise licence fields (`normalizeLicenseField`) and SPDX expressions (`parseSpdx`,
 *      `evaluateSpdx`) — legacy npm forms included;
 *   2. build component records from an npm package folder (`componentFromPackageDir`) or a
 *      hand-maintained manual entry (`componentFromManual`);
 *   3. apply the licence policies (`applyPolicy`) — allowlist, dynamic-only LGPL, exceptions,
 *      vendor terms, stale-exception check per policy file and tier;
 *   4. render the deterministic `THIRD-PARTY-NOTICES.txt` and `third-party-notices.json`
 *      (`renderNotices`, `renderJson`).
 *
 * Determinism (F10): inputs are normalised (BOM stripped, CRLF -> LF, trailing whitespace trimmed),
 * output is LF / UTF-8 without BOM, components are sorted by name then version with a code-point
 * comparison, and nothing time-dependent is written.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Default licence texts shipped next to this module (`<core>/third-party/license-texts`). */
export const DEFAULT_LICENSE_TEXTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../third-party/license-texts');

/**
 * The mode our OWN release builds (staged `runBuild`, the embed build, CONNECT Release) use when
 * `RV_NOTICES_MODE` is not set. `enforce` since plan-544 Phase 6 (2026-10-21, every tier ran green);
 * `RV_NOTICES_MODE=warn` is the emergency switch.
 */
export const RELEASE_DEFAULT_MODE = 'enforce';

/** Output file names — the same in every product. */
export const NOTICES_TXT = 'THIRD-PARTY-NOTICES.txt';
export const NOTICES_JSON = 'third-party-notices.json';

const MODES = new Set(['warn', 'enforce']);

// ── Text normalisation ────────────────────────────────────────────────────────────────────

/** BOM stripped, CRLF/CR -> LF, trailing whitespace per line trimmed, leading/trailing blank lines removed. */
export function normalizeText(text) {
  if (text === undefined || text === null) return '';
  return String(text)
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v]+$/, ''))
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
}

/** Code-point comparison (never `localeCompare`: output must not depend on the machine's locale). */
export function compareCodePoint(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function readTextIfExists(path) {
  try {
    return existsSync(path) ? normalizeText(readFileSync(path, 'utf8')) : null;
  } catch {
    return null;
  }
}

// ── Mode resolution (F11) ─────────────────────────────────────────────────────────────────

/**
 * `RV_NOTICES_MODE` wins when set; otherwise our own release builds use RELEASE_DEFAULT_MODE and
 * every other build (local `npm run build`, a customer workspace) `warn`. An unknown value is
 * reported and treated as `warn` — the emergency switch must never be able to break a build.
 */
export function resolveNoticesMode({ env = process.env, releaseBuild = false, releaseDefault = RELEASE_DEFAULT_MODE } = {}) {
  const raw = String(env.RV_NOTICES_MODE ?? '').trim().toLowerCase();
  if (raw) {
    if (MODES.has(raw)) return { mode: raw, source: 'RV_NOTICES_MODE' };
    return { mode: 'warn', source: `RV_NOTICES_MODE (unknown value "${env.RV_NOTICES_MODE}" — treated as warn)` };
  }
  if (releaseBuild) return { mode: releaseDefault, source: 'release-build default' };
  return { mode: 'warn', source: 'local-build default' };
}

/** Reads the `mode` field of a written `third-party-notices.json`; null when absent/unreadable. */
export function readNoticesMode(jsonPath) {
  try {
    const data = JSON.parse(readFileSync(jsonPath, 'utf8'));
    return MODES.has(data?.mode) ? data.mode : null;
  } catch {
    return null;
  }
}

/**
 * The loud multi-line banner deploy/release scripts print when the notices were generated in
 * `warn` mode (or are missing). Returns null when the mode is `enforce`.
 */
export function noticesWarnBanner(jsonPath, { product = 'build' } = {}) {
  let data = null;
  try { data = JSON.parse(readFileSync(jsonPath, 'utf8')); } catch { data = null; }
  if (data?.mode === 'enforce') return null;
  const bar = '!'.repeat(72);
  const lines = [bar];
  if (!data) {
    lines.push(`!! THIRD-PARTY NOTICES MISSING for this ${product}: ${jsonPath}`);
    lines.push('!! The delivery carries no licence notices — rebuild before shipping.');
  } else {
    const violations = Array.isArray(data.violations) ? data.violations.length : 0;
    lines.push(`!! THIRD-PARTY NOTICES generated in WARN mode for this ${product}.`);
    lines.push(`!! Licence-policy violations: ${violations}${data.incomplete ? ' (notices INCOMPLETE — internal error)' : ''}.`);
    lines.push('!! The licence gate did not block this build. Fix the policy or the dependency;');
    lines.push('!! RV_NOTICES_MODE=warn / -p:ThirdPartyNoticesMode=warn is an emergency switch only.');
  }
  lines.push(bar);
  return lines.join('\n');
}

// ── SPDX ──────────────────────────────────────────────────────────────────────────────────

/** Known SPDX ids (canonical spelling) plus deprecated ids mapped to their successor. */
const KNOWN_IDS = [
  'MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD', 'Zlib', 'CC0-1.0', 'Unlicense',
  'BlueOak-1.0.0', 'MPL-2.0', 'OFL-1.1', 'CC-BY-4.0', 'CC-BY-3.0', 'Python-2.0', 'BSL-1.0', 'WTFPL',
  'LGPL-2.1-only', 'LGPL-2.1-or-later', 'LGPL-3.0-only', 'LGPL-3.0-or-later',
  'GPL-2.0-only', 'GPL-2.0-or-later', 'GPL-3.0-only', 'GPL-3.0-or-later',
  'AGPL-3.0-only', 'AGPL-3.0-or-later', 'EPL-2.0', 'MS-PL', 'FTL', 'FreeImage', 'X11', 'Artistic-2.0',
  'OCCT-exception-1.0', 'Classpath-exception-2.0', 'LLVM-exception',
];
const CANONICAL_ID = new Map(KNOWN_IDS.map((id) => [id.toLowerCase(), id]));
const DEPRECATED_IDS = new Map([
  ['lgpl-2.1', 'LGPL-2.1-only'], ['lgpl-2.1+', 'LGPL-2.1-or-later'],
  ['lgpl-3.0', 'LGPL-3.0-only'], ['lgpl-3.0+', 'LGPL-3.0-or-later'],
  ['gpl-2.0', 'GPL-2.0-only'], ['gpl-2.0+', 'GPL-2.0-or-later'],
  ['gpl-3.0', 'GPL-3.0-only'], ['gpl-3.0+', 'GPL-3.0-or-later'],
  ['agpl-3.0', 'AGPL-3.0-only'], ['agpl-3.0+', 'AGPL-3.0-or-later'],
]);
/** Free-text licence fields seen in the wild, mapped to SPDX. Anything else stays unknown. */
const LICENSE_ALIASES = new Map([
  ['apache 2.0', 'Apache-2.0'], ['apache-2', 'Apache-2.0'], ['apache 2', 'Apache-2.0'],
  ['apache license 2.0', 'Apache-2.0'], ['apache license, version 2.0', 'Apache-2.0'], ['apache2', 'Apache-2.0'],
  ['mit/x11', 'MIT'], ['mit license', 'MIT'], ['the mit license', 'MIT'], ['expat', 'MIT'],
  ['bsd-3', 'BSD-3-Clause'], ['bsd 3-clause', 'BSD-3-Clause'], ['new bsd', 'BSD-3-Clause'],
  ['bsd-2', 'BSD-2-Clause'], ['bsd 2-clause', 'BSD-2-Clause'], ['simplified bsd', 'BSD-2-Clause'],
  ['isc license', 'ISC'], ['mpl 2.0', 'MPL-2.0'], ['mpl-2', 'MPL-2.0'],
  ['cc0', 'CC0-1.0'], ['public domain (cc0)', 'CC0-1.0'],
  ['sil open font license 1.1', 'OFL-1.1'], ['ofl', 'OFL-1.1'],
]);

/** Canonical spelling of one SPDX id; ids we do not know keep their spelling (and stay unknown). */
export function canonicalSpdxId(id) {
  const raw = String(id).trim();
  const lower = raw.toLowerCase();
  if (DEPRECATED_IDS.has(lower)) return DEPRECATED_IDS.get(lower);
  if (CANONICAL_ID.has(lower)) return CANONICAL_ID.get(lower);
  if (lower.endsWith('+') && CANONICAL_ID.has(lower.slice(0, -1))) {
    const base = CANONICAL_ID.get(lower.slice(0, -1));
    return base.endsWith('-only') ? base.replace(/-only$/, '-or-later') : `${base}+`;
  }
  return raw;
}

/**
 * Normalises the `license` / `licenses` fields of a package.json.
 * @returns {{ expression: string, licenseFile: string | null, raw: string }}
 *   `expression` is an SPDX expression ('' when the package declares nothing).
 */
export function normalizeLicenseField(pkg) {
  let raw = '';
  let value = pkg?.license;
  if (value && typeof value === 'object' && !Array.isArray(value)) value = value.type ?? '';
  if (Array.isArray(value)) value = value.map((entry) => (typeof entry === 'string' ? entry : entry?.type)).filter(Boolean).join(' OR ');
  if ((!value || typeof value !== 'string') && Array.isArray(pkg?.licenses)) {
    const ids = pkg.licenses.map((entry) => (typeof entry === 'string' ? entry : entry?.type)).filter(Boolean);
    value = ids.length > 1 ? `(${ids.join(' OR ')})` : (ids[0] ?? '');
  }
  if (typeof value !== 'string') value = '';
  raw = value.trim();
  if (!raw) return { expression: '', licenseFile: null, raw };
  const seeFile = raw.match(/^SEE LICEN[CS]E IN\s+(.+)$/i);
  if (seeFile) return { expression: 'LicenseRef-file', licenseFile: seeFile[1].trim(), raw };
  if (/^UNLICENSED$/i.test(raw)) return { expression: 'LicenseRef-UNLICENSED', licenseFile: null, raw };
  const alias = LICENSE_ALIASES.get(raw.toLowerCase());
  if (alias) return { expression: alias, licenseFile: null, raw };
  try {
    return { expression: stringifySpdx(parseSpdx(raw)), licenseFile: null, raw };
  } catch {
    // Free text that is neither SPDX nor a known alias ("Custom", "Public Domain", …).
    return { expression: 'LicenseRef-unknown', licenseFile: null, raw };
  }
}

/**
 * Parses an SPDX expression into `{ type: 'id', id, exception? } | { type: 'or'|'and', items }`.
 * Throws on malformed input.
 */
export function parseSpdx(expression) {
  const tokens = String(expression).replace(/[()]/g, ' $& ').trim().split(/\s+/).filter(Boolean);
  let index = 0;
  const peek = () => tokens[index];
  const next = () => tokens[index++];
  const isOp = (token, op) => typeof token === 'string' && token.toUpperCase() === op;
  function atom() {
    const token = next();
    if (token === undefined) throw new Error(`Unexpected end of SPDX expression "${expression}"`);
    if (token === '(') {
      const inner = orExpr();
      if (next() !== ')') throw new Error(`Missing ")" in SPDX expression "${expression}"`);
      return inner;
    }
    if (token === ')' || isOp(token, 'AND') || isOp(token, 'OR') || isOp(token, 'WITH')) {
      throw new Error(`Unexpected "${token}" in SPDX expression "${expression}"`);
    }
    if (!/^[A-Za-z0-9.+\-:]+$/.test(token)) throw new Error(`Invalid SPDX id "${token}"`);
    return { type: 'id', id: canonicalSpdxId(token) };
  }
  function withExpr() {
    const node = atom();
    if (isOp(peek(), 'WITH')) {
      next();
      const exception = next();
      if (!exception || exception === '(' || exception === ')') throw new Error(`Missing exception after WITH in "${expression}"`);
      if (node.type !== 'id') throw new Error(`WITH needs a licence id in "${expression}"`);
      return { ...node, exception: canonicalSpdxId(exception) };
    }
    return node;
  }
  function andExpr() {
    const items = [withExpr()];
    while (isOp(peek(), 'AND')) { next(); items.push(withExpr()); }
    return items.length === 1 ? items[0] : { type: 'and', items };
  }
  function orExpr() {
    const items = [andExpr()];
    while (isOp(peek(), 'OR')) { next(); items.push(andExpr()); }
    return items.length === 1 ? items[0] : { type: 'or', items };
  }
  const tree = orExpr();
  if (index !== tokens.length) throw new Error(`Trailing tokens in SPDX expression "${expression}"`);
  return tree;
}

/** Renders a parsed SPDX tree back to text (canonical ids, minimal parentheses). */
export function stringifySpdx(node, parent = null) {
  if (node.type === 'id') return node.exception ? `${node.id} WITH ${node.exception}` : node.id;
  const op = node.type === 'and' ? ' AND ' : ' OR ';
  const text = node.items.map((item) => stringifySpdx(item, node.type)).join(op);
  return parent && parent !== node.type ? `(${text})` : text;
}

/** All licence ids (not exceptions) that occur in an expression. */
export function spdxIds(node) {
  if (node.type === 'id') return [node.id];
  return node.items.flatMap(spdxIds);
}

/**
 * Evaluates an SPDX expression against a (merged) policy.
 *
 * OR  → the alternative that ranks first in `allowed` order (dynamic-only ids rank after every
 *       allowed id) is chosen and recorded;
 * AND → every part must be allowed;
 * WITH → the base licence must be allowed (or dynamic-only) AND the exception id must be in `allowed`.
 *
 * @returns {{ ok: boolean, chosen: string, dynamicOnly: boolean, reason: string | null, rank: number }}
 */
export function evaluateSpdx(expression, policy) {
  let tree;
  try {
    tree = typeof expression === 'string' ? parseSpdx(expression) : expression;
  } catch (error) {
    return { ok: false, chosen: String(expression), dynamicOnly: false, reason: `unparseable licence expression: ${error.message}`, rank: Infinity };
  }
  const allowed = policy.allowed ?? [];
  const dynamicOnly = policy.dynamicOnly ?? [];
  function rankOf(id) {
    const a = allowed.indexOf(id);
    if (a >= 0) return a;
    const d = dynamicOnly.indexOf(id);
    if (d >= 0) return allowed.length + d;
    return Infinity;
  }
  function evalNode(node) {
    if (node.type === 'id') {
      const text = stringifySpdx(node);
      const rank = rankOf(node.id);
      if (rank === Infinity) return { ok: false, chosen: text, dynamicOnly: false, reason: `licence ${node.id} is not allowed`, rank };
      if (node.exception && !allowed.includes(node.exception)) {
        return { ok: false, chosen: text, dynamicOnly: false, reason: `licence exception ${node.exception} is not allowed`, rank: Infinity };
      }
      return { ok: true, chosen: text, dynamicOnly: dynamicOnly.includes(node.id), reason: null, rank };
    }
    const results = node.items.map(evalNode);
    if (node.type === 'and') {
      const failed = results.find((r) => !r.ok);
      if (failed) return { ...failed, chosen: stringifySpdx(node) };
      return {
        ok: true,
        chosen: results.map((r, i) => (node.items[i].type === 'or' ? `(${r.chosen})` : r.chosen)).join(' AND '),
        dynamicOnly: results.some((r) => r.dynamicOnly),
        reason: null,
        rank: Math.max(...results.map((r) => r.rank)),
      };
    }
    const okResults = results.filter((r) => r.ok).sort((x, y) => x.rank - y.rank);
    if (okResults.length) return okResults[0];
    return { ok: false, chosen: stringifySpdx(node), dynamicOnly: false, reason: `no alternative of ${stringifySpdx(node)} is allowed`, rank: Infinity };
  }
  return evalNode(tree);
}

// ── Policies ──────────────────────────────────────────────────────────────────────────────

/**
 * Loads one policy file. `scope` is 'public' | 'private' | 'customer'. A missing optional file
 * yields null. Malformed JSON throws (the caller decides warn vs enforce).
 */
export function loadPolicy(path, { scope, optional = false } = {}) {
  if (!existsSync(path)) {
    if (optional) return null;
    throw new Error(`Licence policy not found: ${path}`);
  }
  const data = JSON.parse(normalizeText(readFileSync(path, 'utf8')) || '{}');
  const policy = {
    path,
    scope,
    allowed: Array.isArray(data.allowed) ? data.allowed.map(String) : [],
    dynamicOnly: Array.isArray(data.dynamicOnly) ? data.dynamicOnly.map(String) : [],
    exceptions: Array.isArray(data.exceptions) ? data.exceptions : [],
    vendorTerms: Array.isArray(data.vendorTerms) ? data.vendorTerms : [],
  };
  for (const kind of ['exceptions', 'vendorTerms']) {
    for (const entry of policy[kind]) assertPolicyEntryTiers(entry, `${path} ${kind} ${entry?.name ?? '?'}`);
  }
  return policy;
}

// ── Tiers (plan-679 Phase 3) ──────────────────────────────────────────────────────────────

/**
 * The delivery tiers of a customer workspace — the same list as `DELIVERY_TIERS` in
 * `_workspace-lib.mjs` (a drift test holds the two together; this module must not import the
 * workspace library, which imports the world).
 */
export const NOTICE_DELIVERY_TIERS = Object.freeze(['core', 'commercial', 'restricted', 'internal']);

/**
 * What a policy entry's optional `tiers` field may name: a delivery tier, or `private` = the
 * FULL build (unpruned private manifest: dev and Bunny private builds). Omniverse, for example,
 * reaches no delivery tier at all — the staging prunes every `@nvidia/` dependency — only the full
 * build, so its entry says `["private"]`.
 */
export const NOTICE_POLICY_TIERS = Object.freeze([...NOTICE_DELIVERY_TIERS, 'private']);

function assertPolicyEntryTiers(entry, label) {
  if (entry?.tiers === undefined) return;
  const tiers = entry.tiers;
  if (!Array.isArray(tiers) || tiers.length === 0
      || tiers.some((tier) => !NOTICE_POLICY_TIERS.includes(tier))
      || new Set(tiers).size !== tiers.length) {
    throw new Error(`${label}: "tiers" must be a non-empty list of distinct values from `
      + `${NOTICE_POLICY_TIERS.join(', ')} (got ${JSON.stringify(tiers)}).`);
  }
}

/**
 * True when a policy entry is expected to match something in a build of `tier`.
 *
 * - no `tiers` field: every tier (the behaviour before plan-679);
 * - the full build (`private`): every entry — the full build carries everything, so an unused
 *   entry there is stale exactly as before;
 * - a delivery tier: only entries whose `tiers` names it;
 * - `public` / `demo`: only entries without `tiers` (the vocabulary names no such tier).
 */
export function policyEntryAppliesToTier(entry, tier) {
  if (!Array.isArray(entry?.tiers)) return true;
  if (tier === 'private') return true;
  return entry.tiers.includes(tier);
}

/** Merges policies: allowed/dynamicOnly in first-seen order (the public policy defines the rank). */
export function mergePolicies(policies) {
  const allowed = [];
  const dynamicOnly = [];
  for (const policy of policies) {
    for (const id of policy.allowed ?? []) if (!allowed.includes(id)) allowed.push(id);
    for (const id of policy.dynamicOnly ?? []) if (!dynamicOnly.includes(id)) dynamicOnly.push(id);
  }
  return { allowed, dynamicOnly };
}

function versionMatches(pattern, version) {
  if (pattern === undefined || pattern === null || pattern === '*' || pattern === '') return true;
  return String(pattern) === String(version);
}

function isProposed(entry) {
  return String(entry?.decidedBy ?? '').trim().toLowerCase() === 'proposed';
}

/**
 * Applies the policies to a component list (mutates `licenseDecision`, `vendorTerms`, `exception`
 * on the components) and reports violations.
 *
 * Stale exceptions are violations per policy file and tier (F3): the public policy is checked in
 * every tier, a private policy in the full `private` build and in a delivery-tier build (plan-679:
 * only its entries whose `tiers` name that delivery tier; the others are reported in
 * `notInTier`, never as a violation), a customer policy never. An entry with
 * `decidedBy: "proposed"` is a proposal for a human decision — it never silences a violation and
 * is never reported as stale.
 *
 * `declared` (plan-544 Nachkorrektur 2026-10-03): names of components the PRODUCT declares but this
 * particular build does not ship — every manual-list entry, every dependency of a package.json the
 * build reads. Many approvals are legitimately conditional (CONNECT's Windows-only vendor DLLs in a
 * linux build, the public demo's AASX files in a customer workspace, an internal-tier-only npm
 * package in a customer build); an entry for such a component is not stale, only one that covers
 * nothing the product can ship at all. Nothing is silenced by this: a component that IS shipped is
 * still matched by name AND version.
 *
 * @returns {{ violations: Array<{ name: string, version: string, rule: string, message: string }>, staleExceptions: Array<object> }}
 */
export function applyPolicy(components, policies, { tier = 'public', declared = [] } = {}) {
  const declaredNames = new Set(declared);
  const merged = mergePolicies(policies);
  const violations = [];
  const used = new Set();
  const usedKey = (policy, kind, index) => `${policy.path ?? policy.scope}#${kind}#${index}`;
  const findEntry = (kind, component, extra = () => true) => {
    let proposed = null;
    for (const policy of policies) {
      const list = policy[kind] ?? [];
      for (let index = 0; index < list.length; index++) {
        const entry = list[index];
        if (entry?.name !== component.name || !versionMatches(entry.version, component.version) || !extra(entry)) continue;
        if (isProposed(entry)) { proposed ??= { policy, entry }; continue; }
        used.add(usedKey(policy, kind, index));
        return { policy, entry, proposed: null };
      }
    }
    return { policy: null, entry: null, proposed };
  };
  const violate = (component, rule, message) => violations.push({ name: component.name, version: component.version, rule, message });

  for (const component of components) {
    component.notes ??= [];
    // A manual entry whose inventory is not finished yet (e.g. the Rust crates statically linked
    // into one of our own binaries). Listed, but never green until the audit is done.
    if (component.pending) {
      violate(component, 'pending-audit', `${component.name} ${component.version}: ${component.pending}`);
      continue;
    }
    // Vendor terms: proprietary libraries, models and documents redistributed under their
    // vendor's terms — declared by a manual entry (`vendorTerms: true`) or by a policy entry that
    // names an npm package.
    const vendor = findEntry('vendorTerms', component);
    if (vendor.entry) {
      component.vendorTerms = true;
      component.vendor = vendor.entry.vendor ?? component.vendor ?? null;
      component.licenseDecision = vendor.entry.licenseRef ?? component.licenseExpression;
      component.vendorReason = vendor.entry.reason ?? '';
      continue;
    }
    if (component.vendorTerms || vendor.proposed) {
      violate(component, 'vendor-terms', vendor.proposed
        ? `${component.name} ${component.version} is shipped under vendor terms (${vendor.proposed.entry.vendor ?? 'vendor'}) that are proposed and await a decision`
        : `${component.name} ${component.version} is shipped under vendor terms that no policy vendorTerms entry covers`);
      continue;
    }
    const exception = findEntry('exceptions', component, (entry) => !entry.license || entry.license === component.licenseExpression);
    if (exception.entry) {
      component.exception = { reason: exception.entry.reason ?? '', decidedBy: exception.entry.decidedBy ?? '', date: exception.entry.date ?? '' };
      component.licenseDecision = component.licenseExpression;
      if (!component.licenseText) violate(component, 'missing-license-text', `no licence text found for ${component.name} ${component.version}`);
      continue;
    }
    const pending = exception.proposed ? ' (a proposed exception awaits a decision)' : '';
    if (!component.licenseExpression) {
      violate(component, 'unknown-license', `${component.name} ${component.version} declares no licence${pending}`);
      continue;
    }
    const decision = evaluateSpdx(component.licenseExpression, merged);
    if (!decision.ok) {
      const copyleft = /(^|[^L])GPL|AGPL/.test(component.licenseExpression) ? ' (strong copyleft)' : '';
      violate(component, 'license-not-allowed', `${component.name} ${component.version}: ${decision.reason}${copyleft}${pending}`);
      continue;
    }
    component.licenseDecision = decision.chosen;
    if (decision.dynamicOnly) {
      if (component.linking !== 'dynamic') {
        violate(component, 'lgpl-not-dynamic', `${component.name} ${component.version} is ${decision.chosen} and must be linked dynamically as a separate, replaceable library, `
          + `but it is ${component.linking === 'static' ? 'bundled into a JS chunk / linked statically' : 'not declared linking: "dynamic"'}${pending}`);
        continue;
      }
    }
    if (!component.licenseText) violate(component, 'missing-license-text', `no licence text found for ${component.name} ${component.version}`);
  }

  const staleExceptions = [];
  const notInTier = [];
  // plan-679 Phase 3: a delivery-tier build (customer workspace, RV_NOTICES_TIER) checks the
  // private policy too, but only the entries marked for its tier. Before, it was checked as
  // "private" by a side effect of VITE_PRIVATE_BUILD=1 — against a PRUNED manifest — and an
  // entry for a package only the full build carries read as stale and aborted the delivery.
  const deliveryTier = NOTICE_DELIVERY_TIERS.includes(tier);
  for (const policy of policies) {
    const checkStale = policy.scope === 'public'
      || (policy.scope === 'private' && (tier === 'private' || deliveryTier));
    if (!checkStale) continue;
    for (const kind of ['exceptions', 'vendorTerms']) {
      const list = policy[kind] ?? [];
      for (let index = 0; index < list.length; index++) {
        const entry = list[index];
        if (isProposed(entry) || used.has(usedKey(policy, kind, index))) continue;
        if (!policyEntryAppliesToTier(entry, tier)) {
          notInTier.push({ name: entry.name, version: String(entry.version ?? '*'), kind, policy: policy.path ?? policy.scope, tiers: entry.tiers });
          continue;
        }
        if (declaredNames.has(entry.name)) continue;
        staleExceptions.push({ ...entry, kind, policy: policy.path ?? policy.scope });
        violations.push({
          name: entry.name, version: String(entry.version ?? '*'), rule: 'stale-exception',
          message: `${kind === 'exceptions' ? 'exception' : 'vendorTerms entry'} for ${entry.name} ${entry.version ?? '*'} in ${policy.scope} policy matches no shipped component — remove it`,
        });
      }
    }
  }
  violations.sort((a, b) => compareCodePoint(a.name, b.name) || compareCodePoint(a.version, b.version) || compareCodePoint(a.rule, b.rule));
  return { violations, staleExceptions, notInTier };
}

// ── Component records ─────────────────────────────────────────────────────────────────────

const LICENSE_FILE_RE = /^(licen[cs]e|copying|unlicense)([.\-_].*)?$/i;
const NOTICE_FILE_RE = /^(notice|third[-_]?party[-_]?notices?)([.\-_].*)?$/i;

let canonicalLineCache = null;
/** Lines of the canonical licence texts — excluded from copyright extraction (FSF header etc.). */
function canonicalLines(textsDir) {
  if (canonicalLineCache && canonicalLineCache.dir === textsDir) return canonicalLineCache.lines;
  const lines = new Set();
  try {
    for (const name of readdirSync(textsDir)) {
      for (const line of normalizeText(readFileSync(join(textsDir, name), 'utf8')).split('\n')) {
        if (line.trim()) lines.add(line.trim());
      }
    }
  } catch { /* no texts dir — nothing to exclude */ }
  canonicalLineCache = { dir: textsDir, lines };
  return lines;
}

/** Copyright lines of a licence text, minus lines that belong to canonical licence texts. */
export function extractCopyright(text, { licenseTextsDir = DEFAULT_LICENSE_TEXTS_DIR } = {}) {
  const exclude = canonicalLines(licenseTextsDir);
  const out = [];
  for (const raw of normalizeText(text).split('\n')) {
    const line = raw.trim().replace(/^[#*>\-\s]+/, '');
    if (!/^(copyright\b|\(c\)\s|©)/i.test(line)) continue;
    if (exclude.has(raw.trim()) || exclude.has(line)) continue;
    if (/\[(yyyy|year)\]|<year>|\{\{\s*year/i.test(line)) continue;
    if (!out.includes(line)) out.push(line);
  }
  return out;
}

function collapse(text) {
  return normalizeText(text).toLowerCase()
    .replace(/[“”‘’`']/g, '"')
    .replace(/""/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Canonical body of a licence text for matching: the title line (if any) is not part of it. */
function canonicalBody(text) {
  const lines = normalizeText(text).split('\n');
  if (lines.length > 3 && lines[0].length < 60 && !/[.:;]$/.test(lines[0].trim())) lines.shift();
  return collapse(lines.join('\n'));
}

/** SPDX ids a licence file may be identified as (permissive texts with a canonical copy here). */
export const IDENTIFIABLE_IDS = ['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD', 'Zlib', 'Unlicense', 'BlueOak-1.0.0', 'MPL-2.0'];

/**
 * Identifies a licence FILE whose package declares no SPDX id (`SEE LICENSE IN`, nuspec
 * `<license type="file">`, a bare licence URL): the file must contain the complete canonical text
 * of one of `candidates` (whitespace, case and quote style ignored). The longest canonical text
 * that is contained wins; no partial or fuzzy match. Returns the SPDX id or null.
 */
export function identifyLicenseText(text, { candidates = IDENTIFIABLE_IDS, licenseTextsDir = DEFAULT_LICENSE_TEXTS_DIR } = {}) {
  const haystack = collapse(text ?? '');
  if (!haystack) return null;
  let best = null;
  for (const id of candidates) {
    const canonical = canonicalLicenseText(id, { licenseTextsDir });
    if (!canonical) continue;
    const body = canonicalBody(canonical);
    if (body.length < 200) continue;
    if (haystack.includes(body) && (!best || body.length > best.length)) best = { id, length: body.length };
  }
  return best?.id ?? null;
}

/** Canonical licence text for an allowlisted SPDX id, or null. */
export function canonicalLicenseText(id, { licenseTextsDir = DEFAULT_LICENSE_TEXTS_DIR } = {}) {
  if (!/^[A-Za-z0-9.+\-]+$/.test(id)) return null;
  return readTextIfExists(join(licenseTextsDir, `${id}.txt`));
}

/** Canonical text for every id of an evaluated (chosen) expression; null when any id has none. */
export function canonicalTextForExpression(expression, options = {}) {
  let tree;
  try { tree = parseSpdx(expression); } catch { return null; }
  const parts = [];
  const visit = (node) => {
    if (node.type === 'id') {
      parts.push(canonicalLicenseText(node.id, options));
      if (node.exception) parts.push(canonicalLicenseText(node.exception, options));
      return;
    }
    node.items.forEach(visit);
  };
  visit(tree);
  if (parts.some((p) => !p)) return null;
  return parts.join('\n\n');
}

function authorString(author) {
  if (!author) return null;
  if (typeof author === 'string') return author.replace(/\s*<[^>]*>\s*/g, ' ').replace(/\s*\([^)]*\)\s*/g, ' ').trim() || null;
  if (typeof author === 'object' && author.name) return String(author.name).trim();
  return null;
}

function repositoryUrl(repository) {
  const raw = typeof repository === 'string' ? repository : repository?.url;
  if (!raw) return null;
  let url = String(raw).replace(/^git\+/, '').replace(/\.git$/, '');
  if (/^github:/.test(url)) url = `https://github.com/${url.slice(7)}`;
  else if (/^[\w.-]+\/[\w.-]+$/.test(url)) url = `https://github.com/${url}`;
  url = url.replace(/^git:\/\//, 'https://').replace(/^ssh:\/\/git@/, 'https://').replace(/^git@github\.com:/, 'https://github.com/');
  return url;
}

/** Exact-version source link of an npm package. */
export function npmSourceUrl(name, version) {
  return `https://www.npmjs.com/package/${name}/v/${version}`;
}

/** Plain files directly in `dir`, sorted (one readdir — packages like @mui/icons-material hold 10k+ files). */
function listFiles(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() || (entry.isSymbolicLink() && isFile(join(dir, entry.name))))
      .map((entry) => entry.name)
      .sort(compareCodePoint);
  } catch {
    return [];
  }
}

function isFile(path) {
  try { return statSync(path).isFile(); } catch { return false; }
}

/**
 * Builds a component record from an npm package folder (F2).
 * @param {string} dir package root (contains package.json with a name)
 * @param {{ licenseTextsDir?: string, linking?: 'static'|'dynamic' }} options
 */
export function componentFromPackageDir(dir, { licenseTextsDir = DEFAULT_LICENSE_TEXTS_DIR, linking = 'static' } = {}) {
  const pkg = JSON.parse(normalizeText(readFileSync(join(dir, 'package.json'), 'utf8')));
  const name = String(pkg.name);
  const version = String(pkg.version ?? '0.0.0');
  const field = normalizeLicenseField(pkg);
  const notes = [];
  const files = listFiles(dir);
  let licenseText = '';
  if (field.licenseFile) {
    licenseText = readTextIfExists(join(dir, field.licenseFile)) ?? '';
  }
  if (!licenseText) {
    const texts = files.filter((file) => LICENSE_FILE_RE.test(file)).map((file) => readTextIfExists(join(dir, file))).filter(Boolean);
    licenseText = texts.join('\n\n');
  }
  const noticeText = files.filter((file) => NOTICE_FILE_RE.test(file)).map((file) => readTextIfExists(join(dir, file))).filter(Boolean).join('\n\n');
  let copyright = licenseText ? extractCopyright(licenseText, { licenseTextsDir }) : [];
  let expression = field.expression;
  if (expression === 'LicenseRef-file' && licenseText) {
    const identified = identifyLicenseText(licenseText, { licenseTextsDir });
    if (identified) {
      expression = identified;
      notes.push(`Licence identified from ${field.licenseFile}: the file contains the complete ${identified} text.`);
    }
  }
  let canonical = false;
  if (!licenseText && expression && !expression.startsWith('LicenseRef-')) {
    const text = canonicalTextForExpression(expression, { licenseTextsDir });
    if (text) { licenseText = text; canonical = true; }
  }
  if (!copyright.length) {
    const author = authorString(pkg.author);
    if (author) copyright = [`Copyright (c) ${author}`];
    else {
      const readme = files.find((file) => /^readme(\..*)?$/i.test(file));
      const head = readme ? (readTextIfExists(join(dir, readme)) ?? '').split('\n').slice(0, 40).join('\n') : '';
      copyright = extractCopyright(head, { licenseTextsDir });
    }
  }
  if (!copyright.length) notes.push('Copyright: see source.');
  if (canonical) notes.push('The package ships no licence file; the canonical licence text is reproduced below.');
  return {
    name,
    version,
    license: field.raw || expression,
    licenseExpression: expression,
    copyright,
    licenseText,
    noticeText: noticeText || undefined,
    source: npmSourceUrl(name, version),
    repository: repositoryUrl(pkg.repository) ?? undefined,
    origin: 'npm',
    linking,
    notes,
  };
}

/**
 * Builds a component record from a manual entry. `licenseFile` is resolved against `baseDir`
 * (the folder of the manual list); without a file the canonical text of the expression is used.
 */
export function componentFromManual(entry, { baseDir, licenseTextsDir = DEFAULT_LICENSE_TEXTS_DIR, origin = 'manual' } = {}) {
  const expression = (() => {
    const value = String(entry.license ?? '').trim();
    if (!value) return '';
    if (value.startsWith('LicenseRef-')) return value;
    try { return stringifySpdx(parseSpdx(value)); } catch { return 'LicenseRef-unknown'; }
  })();
  const notes = Array.isArray(entry.notes) ? [...entry.notes] : [];
  let licenseText = '';
  if (entry.licenseFile) {
    const file = resolve(baseDir ?? '.', entry.licenseFile);
    const text = readTextIfExists(file);
    if (text && entry.licenseSection) {
      licenseText = extractSection(text, entry.licenseSection) ?? '';
    } else {
      licenseText = text ?? '';
    }
  }
  if (!licenseText && entry.licenseText) licenseText = normalizeText(entry.licenseText);
  if (!licenseText && expression && !expression.startsWith('LicenseRef-')) {
    licenseText = canonicalTextForExpression(expression, { licenseTextsDir }) ?? '';
  }
  const copyright = Array.isArray(entry.copyright) ? entry.copyright.map(String) : [];
  if (!copyright.length && !entry.vendorTerms) notes.push('Copyright: see source.');
  return {
    name: String(entry.name),
    version: String(entry.version ?? ''),
    license: String(entry.license ?? ''),
    licenseExpression: expression,
    copyright,
    licenseText,
    noticeText: entry.noticeText ? normalizeText(entry.noticeText) : undefined,
    source: String(entry.source ?? ''),
    origin,
    linking: entry.linking ?? undefined,
    vendorTerms: entry.vendorTerms === true ? true : undefined,
    // A component we ship CHANGED (e.g. occt-import-js' memory limit patch): the short label is
    // shown next to the name in the component list and the section header (LGPL §2a: modified files
    // must carry a prominent notice); the details belong in `notes`.
    modified: entry.modified ? String(entry.modified) : undefined,
    vendor: entry.vendor ?? undefined,
    pending: entry.pending ? String(entry.pending) : undefined,
    files: Array.isArray(entry.files) ? [...entry.files].map(String).sort(compareCodePoint) : undefined,
    notes,
  };
}

/** Lines between a marker line that contains `start` and the next line that contains `end` (exclusive). */
function extractSection(text, { start, end }) {
  const lines = text.split('\n');
  const from = lines.findIndex((line) => line.includes(start));
  if (from < 0) return null;
  let to = end ? lines.findIndex((line, i) => i > from && line.includes(end)) : -1;
  if (to < 0) to = lines.length;
  const section = lines.slice(from, to);
  // Drop the separator rule of the NEXT section's header that precedes its title line.
  while (section.length && /^\s*([=\-])\1{3,}\s*$|^\s*$/.test(section[section.length - 1])) section.pop();
  return normalizeText(section.join('\n'));
}

/** Loads a manual list (`{ components: [...] }` or a bare array). */
export function loadManualComponents(path) {
  if (!existsSync(path)) return [];
  const data = JSON.parse(normalizeText(readFileSync(path, 'utf8')) || '[]');
  return Array.isArray(data) ? data : (Array.isArray(data.components) ? data.components : []);
}

// ── POSIX glob (manual `match` / `present`) ───────────────────────────────────────────────

/** Minimal POSIX glob → RegExp: `**` any depth, `*` within a segment, `?` one char, `{a,b}`. */
export function globToRegExp(glob) {
  let out = '';
  const g = String(glob).replace(/\\/g, '/');
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        const slash = g[i + 2] === '/';
        out += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else if (c === '{') {
      const close = g.indexOf('}', i);
      if (close > i) {
        out += `(?:${g.slice(i + 1, close).split(',').map((part) => part.replace(/[.+^$()|[\]\\]/g, '\\$&')).join('|')})`;
        i = close;
      } else out += '\\{';
    } else out += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`, 'i');
}

/** True when any glob matches any of the candidate POSIX paths. */
export function anyGlobMatches(globs, candidates) {
  const patterns = (globs ?? []).map(globToRegExp);
  for (const candidate of candidates) {
    const path = String(candidate).replace(/\\/g, '/');
    if (patterns.some((re) => re.test(path))) return true;
  }
  return false;
}

// ── Rendering ─────────────────────────────────────────────────────────────────────────────

/** Dedup + sort: one record per name+version, sorted by name then version (code point). */
export function sortAndDedupe(components) {
  const byKey = new Map();
  for (const component of components) {
    const key = `${component.name}\u0000${component.version}`;
    const existing = byKey.get(key);
    if (!existing) { byKey.set(key, component); continue; }
    // Two sightings of the same package (main + worker pass): a static sighting wins, files merge.
    if (component.linking === 'static') existing.linking = 'static';
    if (component.files?.length) existing.files = [...new Set([...(existing.files ?? []), ...component.files])].sort(compareCodePoint);
  }
  return [...byKey.values()].sort((a, b) => compareCodePoint(a.name, b.name) || compareCodePoint(a.version, b.version));
}

function licenseNotes(component) {
  const notes = [];
  const expr = component.licenseDecision ?? component.licenseExpression ?? '';
  if (/\bMPL-2\.0\b/.test(expr)) {
    notes.push(`Source code of this component: ${component.source}; used unmodified.`);
  }
  if (/\bLGPL-/.test(expr)) {
    notes.push(`Source code of this component: ${component.source}.`);
    // The replaceability statement is only true for a separately shipped library; a bundled one
    // is a policy violation and must not be described as replaceable.
    if (component.linking === 'dynamic') {
      notes.push('This library is shipped as a separate, replaceable library; you may replace it with a modified, interface-compatible version.');
    }
    notes.push('On written request, realvirtual GmbH (https://realvirtual.io) provides the complete corresponding source code of this library, for at least three years after the distribution.');
  }
  return notes;
}

/** ` — modified (<label>)` for a component we ship changed; empty otherwise. */
function modifiedLabel(component) {
  return component.modified ? ` — modified (${component.modified})` : '';
}

function usesOcct(components) {
  return components.some((c) => /OCCT-exception-1\.0/.test(`${c.licenseExpression ?? ''} ${c.licenseDecision ?? ''}`) || c.occtNotice === true);
}

export const OCCT_NOTICE = 'This product uses Open CASCADE Technology (https://dev.opencascade.org).';

/**
 * Renders THIRD-PARTY-NOTICES.txt.
 * @param {{ product: string, components: object[], violations?: object[], mode: string, preview?: boolean, incomplete?: string[] }} input
 */
export function renderNotices({ product, components, violations = [], mode, preview = false, incomplete = [], appendix = '' }) {
  const sorted = sortAndDedupe(components);
  const regular = sorted.filter((c) => !c.vendorTerms);
  const vendor = sorted.filter((c) => c.vendorTerms);
  const out = [];
  const rule = '='.repeat(80);
  const thin = '-'.repeat(80);
  if (preview) {
    out.push(`DEVELOPMENT PREVIEW — approximated from package-lock.json and node_modules; the notices of a production build list exactly what is shipped.`, '');
  }
  if (usesOcct(sorted)) out.push(OCCT_NOTICE, '');
  out.push(rule, `${product} — Third-party software notices`, rule, '');
  out.push(`${product} includes the third-party components listed below. Each component is`);
  out.push('licensed by its authors under the licence named for it; the licence texts follow.');
  out.push('');
  if (incomplete.length) {
    out.push(thin, 'NOTICE: these notices are INCOMPLETE (generated in warn mode after an internal error):', thin);
    for (const line of incomplete) out.push(`- ${line}`);
    out.push('');
  }
  if (violations.length) {
    out.push(thin, `Policy violations (${mode} mode)`, thin);
    for (const v of violations) out.push(`- [${v.rule}] ${v.message}`);
    out.push('');
  }
  out.push(thin, `Components (${regular.length})`, thin);
  for (const c of regular) out.push(`- ${c.name} ${c.version}${modifiedLabel(c)} — ${c.licenseDecision ?? c.licenseExpression ?? c.license ?? 'unknown'}`);
  out.push('');

  // Licence texts deduplicated by hash of the normalised text.
  const textIndex = new Map();
  const textOrder = [];
  for (const c of regular) {
    const text = normalizeText(c.licenseText ?? '');
    if (!text) continue;
    const hash = sha256(text);
    if (!textIndex.has(hash)) {
      textIndex.set(hash, { id: `L${textOrder.length + 1}`, text, licenses: new Set(), appliesTo: [] });
      textOrder.push(hash);
    }
    const entry = textIndex.get(hash);
    entry.licenses.add(c.licenseDecision ?? c.licenseExpression ?? c.license ?? '');
    entry.appliesTo.push(`${c.name} ${c.version}`);
    c._textRef = entry.id;
  }

  for (const c of regular) {
    out.push(rule, `${c.name} ${c.version}${modifiedLabel(c)}`, rule);
    out.push(`License: ${c.licenseDecision ?? c.licenseExpression ?? c.license ?? 'unknown'}`);
    if (c.licenseDecision && c.licenseExpression && c.licenseDecision !== c.licenseExpression) out.push(`Declared: ${c.licenseExpression} (chosen: ${c.licenseDecision})`);
    if (c.source) out.push(`Source: ${c.source}`);
    if (c.repository) out.push(`Repository: ${c.repository}`);
    for (const line of c.copyright ?? []) out.push(line);
    if (c.files?.length) out.push(`Files: ${c.files.join(', ')}`);
    for (const note of [...licenseNotes(c), ...(c.notes ?? [])]) out.push(note);
    if (c.exception) out.push(`Policy exception: ${c.exception.reason}${c.exception.decidedBy ? ` (decided by ${c.exception.decidedBy}${c.exception.date ? `, ${c.exception.date}` : ''})` : ''}`);
    if (c.noticeText) out.push('', 'NOTICE:', normalizeText(c.noticeText));
    out.push(c._textRef ? `License text: see [${c._textRef}] below.` : 'License text: not available.');
    out.push('');
  }

  if (textOrder.length) {
    out.push(rule, 'License texts', rule, '');
    for (const hash of textOrder) {
      const entry = textIndex.get(hash);
      out.push(thin, `[${entry.id}] ${[...entry.licenses].sort(compareCodePoint).join(', ')}`, `Applies to: ${entry.appliesTo.join(', ')}`, thin, '', entry.text, '');
    }
  }

  if (vendor.length) {
    out.push(rule, 'Third-party components under vendor terms', rule, '');
    for (const c of vendor) {
      out.push(`${c.name} ${c.version}`);
      if (c.vendor) out.push(`Vendor: ${c.vendor}`);
      out.push(`Terms: ${c.licenseDecision ?? c.licenseExpression ?? c.license ?? 'vendor terms'}`);
      if (c.source) out.push(`Source: ${c.source}`);
      for (const line of c.copyright ?? []) out.push(line);
      if (c.files?.length) out.push(`Files: ${c.files.join(', ')}`);
      if (c.vendorReason) out.push(`Redistribution: ${c.vendorReason}`);
      for (const note of c.notes ?? []) out.push(note);
      if (c.licenseText) out.push('', normalizeText(c.licenseText));
      out.push('');
    }
  }
  // Another product's complete notices (CONNECT embeds the WEB HMI's file verbatim).
  if (appendix) out.push(normalizeText(appendix), '');
  for (const c of regular) delete c._textRef;
  return `${normalizeText(out.join('\n'))}\n`;
}

/** Renders third-party-notices.json — fixed key order, no timestamps. */
export function renderJson({ product, components, violations = [], mode, tier = null, incomplete = [] }) {
  const sorted = sortAndDedupe(components);
  const data = {
    schema: 1,
    product,
    mode,
    tier,
    incomplete: incomplete.length ? incomplete : undefined,
    violations: violations.map((v) => ({ name: v.name, version: v.version, rule: v.rule, message: v.message })),
    components: sorted.map((c) => ({
      name: c.name,
      version: c.version,
      license: c.licenseDecision ?? c.licenseExpression ?? c.license ?? '',
      licenseExpression: c.licenseExpression ?? '',
      origin: c.origin,
      linking: c.linking,
      vendorTerms: c.vendorTerms ? true : undefined,
      vendor: c.vendor,
      source: c.source || undefined,
      copyright: c.copyright?.length ? c.copyright : undefined,
      files: c.files?.length ? c.files : undefined,
      modified: c.modified,
      exception: c.exception,
    })),
  };
  return `${JSON.stringify(data, null, 2)}\n`;
}

/**
 * Reads a `third-party-notices.json` written by another product (CONNECT merges the WEB set).
 * Returns component records carrying their licence text from the matching TXT when present.
 */
export function componentsFromNoticesJson(jsonPath) {
  const data = JSON.parse(normalizeText(readFileSync(jsonPath, 'utf8')));
  return (data.components ?? []).map((c) => ({
    name: c.name,
    version: c.version,
    license: c.license,
    licenseExpression: c.licenseExpression ?? c.license,
    copyright: c.copyright ?? [],
    licenseText: '',
    source: c.source ?? '',
    origin: c.origin ?? 'npm',
    linking: c.linking,
    vendorTerms: c.vendorTerms,
    vendor: c.vendor,
    files: c.files,
    modified: c.modified,
    notes: [],
    fromWeb: true,
  }));
}
