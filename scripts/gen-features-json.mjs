// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * gen-features-json.mjs — the public editions data of realvirtual WEB (plan-646).
 *
 * Two inputs, one output family:
 *   - `features.catalog.json` (this repository, public): label, group, summary, docs and demo
 *     links of every row, and which manifest registrations a commercial row stands for;
 *   - `../realvirtual-WebViewer-Private~/tier-manifest.json` (the ORIGINAL manifest, where
 *     `defaults: commercial` holds — never a staged copy): tier and status of every id.
 *
 * Outputs:
 *   - `generated/features.json` (gitignored) — the `FeaturesJson` of plan-646 §2.3, read by the
 *     demo build, the documentation and the website;
 *   - the README block between `<!-- editions:begin -->` and `<!-- editions:end -->`.
 *
 * Validation (plan-646 F3, exit 1 with every problem listed): every commercial registration
 * belongs to exactly one row (visible or `public: false`); a restricted or internal id in the
 * catalog is always an error, also with `public: false`; an unknown id is an error; a
 * `demo.doc` must be a document of `public/demo-realvirtual/project.json`. Restricted and
 * internal ids are additionally searched for in everything written, as a last leak guard.
 *
 * Without the private sibling (a Community clone of the public mirror) the script says
 * "manifest not available", writes nothing and exits 0.
 *
 * Usage:
 *   node scripts/gen-features-json.mjs                 # validate + write generated/features.json
 *   node scripts/gen-features-json.mjs --write-readme  # ... and rewrite the README block
 *   node scripts/gen-features-json.mjs --check         # validate + README block up to date? (no writes)
 *   Options: --private <dir>  --out <file>  --readme <file>
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FEATURE_CATALOG_FILE, featureTier, loadFeatureCatalog, loadTierManifest, resolveTier,
} from './_workspace-lib.mjs';

const CORE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_PRIVATE_ROOT = resolve(CORE_ROOT, '../realvirtual-WebViewer-Private~');

export const EDITIONS_BEGIN = '<!-- editions:begin -->';
export const EDITIONS_END = '<!-- editions:end -->';
export const DEFAULT_OUTPUT = join(CORE_ROOT, 'generated', 'features.json');
const DEMO_PROJECT = join('public', 'demo-realvirtual', 'project.json');
const DEMO_BASE_URL = 'https://web.realvirtual.io/demo/';
const DOCS_BASE_URL = 'https://realvirtual.io/doc/web/';
const HIDDEN_TIERS = new Set(['restricted', 'internal']);

//! Thrown when catalog and manifest disagree; `problems` lists every finding.
export class FeatureCatalogError extends Error {
  constructor(problems) {
    super(`${FEATURE_CATALOG_FILE} does not match tier-manifest.json:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'FeatureCatalogError';
    this.problems = problems;
  }
}

//! Every name that must never appear in public output: registrations whose tier is restricted
//! or internal, the feature of every restricted/internal rule, and the `<name>` of every
//! restricted/internal `src/features/<name>.register.ts` rule (an internal provider such as
//! `aml-import` has a register file but no registration).
export function hiddenFeatureIds(manifest) {
  const hidden = new Set();
  for (const feature of Object.keys(manifest.registrations)) {
    if (HIDDEN_TIERS.has(featureTier(manifest, feature))) hidden.add(feature);
  }
  for (const rule of manifest.rules) {
    if (!HIDDEN_TIERS.has(rule.tier)) continue;
    if (rule.feature) hidden.add(rule.feature);
    const register = /^src\/features\/([a-z0-9][a-z0-9-]*)\.register\.ts$/.exec(rule.path);
    if (register) hidden.add(register[1]);
  }
  return hidden;
}

function tierOfId(manifest, id) {
  if (manifest.registrations[id]) return featureTier(manifest, id);
  // Not a registration: an unregistered register file can still carry a tier (internal).
  const rule = resolveTier(manifest, `src/features/${id}.register.ts`);
  return rule.path ? rule.tier : null;
}

function idPattern(id) {
  return new RegExp(`(?<![A-Za-z0-9-])${id.replace(/[-]/g, '\\-')}(?![A-Za-z0-9-])`);
}

//! Throws when `text` names a restricted or internal id (whole-token match).
export function assertNoHiddenIds(text, hidden, where) {
  const leaked = [...hidden].filter((id) => idPattern(id).test(text)).sort();
  if (leaked.length) throw new FeatureCatalogError(leaked.map((id) => `${where} names the hidden id "${id}"`));
}

//! Builds the public `FeaturesJson` (plan-646 §2.3) from catalog + manifest. Deterministic:
//! groups and rows in catalog order, fixed key order, no timestamps.
export function buildFeaturesJson({ catalog, manifest, demoDocIds }) {
  const problems = [];
  const hidden = hiddenFeatureIds(manifest);
  const assigned = new Map();
  for (const row of catalog.rows) {
    if (hidden.has(row.id)) problems.push(`row "${row.id}" uses the id of a restricted/internal feature`);
    for (const id of row.ids ?? []) {
      const tier = tierOfId(manifest, id);
      if (hidden.has(id) || HIDDEN_TIERS.has(tier)) {
        problems.push(`row "${row.id}": "${id}" is ${tier ?? 'restricted/internal'} and must never be in the public catalog (not even with public:false)`);
      } else if (!manifest.registrations[id]) {
        problems.push(`row "${row.id}": unknown manifest id "${id}"`);
      } else if (tier !== 'commercial') {
        problems.push(`row "${row.id}": "${id}" has tier "${tier}", only commercial ids belong in a commercial row`);
      }
      assigned.set(id, row.id);
    }
    if (row.demo && !demoDocIds.has(row.demo.doc)) {
      problems.push(`row "${row.id}": demo.doc "${row.demo.doc}" is not a document of ${DEMO_PROJECT.replace(/\\/g, '/')}`);
    }
  }
  for (const feature of Object.keys(manifest.registrations).sort()) {
    if (featureTier(manifest, feature) === 'commercial' && !assigned.has(feature)) {
      problems.push(`commercial registration "${feature}" is not assigned to any row (add it to a row, or to a public:false row)`);
    }
  }
  if (problems.length) throw new FeatureCatalogError(problems);

  const groups = catalog.groups.map((group) => ({
    id: group.id,
    label: group.label,
    ...(group.note ? { note: group.note } : {}),
    rows: catalog.rows
      .filter((row) => row.group === group.id && row.public !== false)
      .map((row) => {
        if (row.cells) {
          // A cells row (the CONNECT interfaces): its column texts are its statement. It has
          // no `edition`, so nothing reads it as a Community or Commercial claim of WEB.
          const out = { id: row.id, label: row.label, summary: row.summary, status: 'stable', inDemo: true };
          if (row.docs) out.docs = row.docs;
          out.cells = { community: row.cells.community, commercial: row.cells.commercial, demo: row.cells.demo };
          return out;
        }
        const commercial = row.edition !== 'community';
        const beta = commercial
          ? row.ids.some((id) => manifest.registrations[id].status === 'beta')
          : row.status === 'beta';
        const out = {
          id: row.id,
          label: row.label,
          summary: row.summary,
          edition: commercial ? 'commercial' : 'community',
          status: beta ? 'beta' : 'stable',
          inDemo: true,
        };
        if (row.docs) out.docs = row.docs;
        if (row.demo) {
          out.demoUrl = `${DEMO_BASE_URL}?doc=${encodeURIComponent(row.demo.doc)}`
            + (row.demo.mode ? `&mode=${encodeURIComponent(row.demo.mode)}` : '');
        }
        return out;
      }),
  })).filter((group) => group.rows.length);

  const features = {
    version: 1,
    editions: { community: catalog.editions.community, commercial: catalog.editions.commercial, demo: catalog.editions.demo },
    groups,
  };
  assertNoHiddenIds(JSON.stringify(features), hidden, 'features.json');
  return features;
}

//! Serialises `FeaturesJson` byte-stable (two-space indent, trailing newline).
export function serializeFeaturesJson(features) {
  return `${JSON.stringify(features, null, 2)}\n`;
}

//! Renders the README editions block (markers included, `\n` line endings).
export function renderEditionsBlock(features) {
  const { community, commercial, demo } = features.editions;
  const lines = [
    EDITIONS_BEGIN,
    '<!-- Generated from features.catalog.json and the tier manifest by `npm run features:generate -- --write-readme`. Do not edit by hand. -->',
    '',
    `| Feature | ${community} | ${commercial} | ${demo} |`,
    '| --- | --- | --- | --- |',
  ];
  for (const group of features.groups) {
    lines.push(`| **${group.label}** | | | |`);
    for (const row of group.rows) {
      const label = row.docs ? `[${row.label}](${DOCS_BASE_URL}${row.docs})` : row.label;
      if (row.cells) {
        lines.push(`| ${label} | ${markdownCell(row.cells.community)} | ${markdownCell(row.cells.commercial)} | ${markdownCell(row.cells.demo)} |`);
        continue;
      }
      const beta = row.status === 'beta' ? ' *(Beta)*' : '';
      const inCommunity = row.edition === 'community' ? 'Included' : '—';
      const inDemo = row.demoUrl ? `Included · [Try it](${row.demoUrl})` : 'Included';
      lines.push(`| ${label}${beta} | ${inCommunity} | Included | ${inDemo} |`);
    }
  }
  for (const group of features.groups) {
    if (group.note) lines.push('', `**${group.label}:** ${markdownCell(group.note)}`);
  }
  lines.push(
    '',
    `**${community}** is this repository. **${commercial}** adds the modules marked "—" in the ${community} column; they are not part of this repository, and a public build resolves them to no-op stubs. The DES experiment manager is a commercial module. *(Beta)* marks features that are usable but still changing.`,
    '',
    `**${demo}:** [web.realvirtual.io/demo](https://web.realvirtual.io/demo) runs every ${community} and ${commercial} feature and is free to use for evaluation and non-commercial purposes. Compared with ${commercial}, it runs on the free tier of realvirtual CONNECT (20 signals, STEP files up to 25 MB, JT files up to 12 MB), comes without source code, cannot be extended with your own plugins, and is provided as is, without support or warranty. A local ${community} build does not gain the ${commercial} modules by opening the same model.`,
    EDITIONS_END,
  );
  return lines.join('\n');
}

// Escapes the Markdown characters a cell or note text may carry ("Unlimited*", "* with ...").
function markdownCell(text) {
  return text.replace(/([\\*_|`])/g, '\\$1');
}

//! Replaces the editions block of `readme` (keeps the file's line endings). Throws when the
//! markers are missing or out of order.
export function replaceEditionsBlock(readme, block) {
  const begin = readme.indexOf(EDITIONS_BEGIN);
  const end = readme.indexOf(EDITIONS_END);
  if (begin < 0 || end < begin) throw new Error(`README has no ${EDITIONS_BEGIN} … ${EDITIONS_END} block.`);
  const eol = readme.includes('\r\n') ? '\r\n' : '\n';
  return readme.slice(0, begin) + block.replace(/\n/g, eol) + readme.slice(end + EDITIONS_END.length);
}

//! Extracts the current editions block of `readme` with `\n` line endings, or null.
export function extractEditionsBlock(readme) {
  const begin = readme.indexOf(EDITIONS_BEGIN);
  const end = readme.indexOf(EDITIONS_END);
  if (begin < 0 || end < begin) return null;
  return readme.slice(begin, end + EDITIONS_END.length).replace(/\r\n/g, '\n');
}

//! Reads the document ids of the demo project.
export function demoDocumentIds(coreRoot = CORE_ROOT) {
  const project = JSON.parse(readFileSync(join(coreRoot, DEMO_PROJECT), 'utf8'));
  return new Set((project.documents ?? []).map((document) => document.id));
}

//! Loads all inputs and generates. Returns `{ available: false, manifestPath }` when the
//! private manifest is missing (Community clone), otherwise `{ available: true, features,
//! json, block }`. Throws FeatureCatalogError on a catalog/manifest mismatch.
export function generateFeatures(options = {}) {
  const coreRoot = resolve(options.coreRoot ?? CORE_ROOT);
  const privateRoot = resolve(options.privateRoot ?? DEFAULT_PRIVATE_ROOT);
  const manifestPath = join(privateRoot, 'tier-manifest.json');
  if (!existsSync(manifestPath)) return { available: false, manifestPath };
  const catalog = loadFeatureCatalog(options.catalogPath ?? join(coreRoot, FEATURE_CATALOG_FILE));
  const manifest = loadTierManifest(manifestPath);
  const hidden = hiddenFeatureIds(manifest);
  // The public catalog itself is published; it must not even mention a hidden id.
  assertNoHiddenIds(readFileSync(options.catalogPath ?? join(coreRoot, FEATURE_CATALOG_FILE), 'utf8'), hidden, FEATURE_CATALOG_FILE);
  const features = buildFeaturesJson({ catalog, manifest, demoDocIds: options.demoDocIds ?? demoDocumentIds(coreRoot) });
  const block = renderEditionsBlock(features);
  assertNoHiddenIds(block, hidden, 'README editions block');
  return { available: true, features, json: serializeFeaturesJson(features), block };
}

function argValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export function main(args = process.argv.slice(2)) {
  const check = args.includes('--check');
  const writeReadme = args.includes('--write-readme');
  const privateRoot = argValue(args, '--private');
  const output = resolve(argValue(args, '--out') ?? DEFAULT_OUTPUT);
  const readmePath = resolve(argValue(args, '--readme') ?? join(CORE_ROOT, 'README.md'));
  let result;
  try {
    result = generateFeatures({ privateRoot });
  } catch (error) {
    console.error(`[features] ${error.message}`);
    return 1;
  }
  if (!result.available) {
    console.log(`[features] manifest not available (${result.manifestPath}) - nothing generated. `
      + 'This is expected in a Community clone without the private sibling.');
    return 0;
  }
  const readme = readFileSync(readmePath, 'utf8');
  if (check) {
    if (extractEditionsBlock(readme) !== result.block) {
      console.error('[features] README editions block is out of date - run `npm run features:generate -- --write-readme`.');
      return 1;
    }
    console.log('[features] catalog, manifest and README editions block agree.');
    return 0;
  }
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, result.json);
  console.log(`[features] wrote ${output}`);
  if (writeReadme) {
    const next = replaceEditionsBlock(readme, result.block);
    if (next !== readme) writeFileSync(readmePath, next);
    console.log(`[features] README editions block ${next === readme ? 'already up to date' : 'updated'}.`);
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
