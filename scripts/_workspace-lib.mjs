// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Customer source-delivery primitives. All generated workspaces are assembled
 * from allowlisted inputs before a build is allowed to run.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';

// Neutral FS/glob helpers. They live in their own module so `_rv-guards.mjs`
// can use them without importing this file back (plan-700 §2.9); there is
// exactly one definition of each, here or there, never both.
import { fixedPrefix, globRegex, patternsOverlap, readJson, toPosix, walk } from './_rv-fs-utils.mjs';
// Secret patterns, denylists and size limits have exactly one definition, in
// _rv-guards.mjs (plan-700 §2.9 / B10). Do not reintroduce a local array here —
// tests/rv-guards.node.test.ts fails the build if one appears.
import {
  MAX_DELIVERY_FILE_BYTES,
  SECRET_SCAN_EXTENSIONS,
  isSecretPath,
  secretContentViolation,
} from './_rv-guards.mjs';
// The three-way decision layer (plan-700 §2.5). It is pure — maps in, actions out —
// and this file supplies the I/O around it: the Git blob maps, the copying, the
// sidecars and the report. _vendor-merge.mjs imports nothing from here.
import {
  CONFLICT_REASON,
  MERGE_ACTION,
  mergeProjectManifest,
  mergeVendorTree,
  nextCustomerOwned,
  parseCheckAttr,
  parseLsFiles,
  parseLsTree,
  projectSubtree,
  readDeliveryManifest,
  sidecarIsSafe,
  sidecarPathFor,
  summariseMerge,
  withDeliveryBaseline,
} from './_vendor-merge.mjs';

export const DELIVERY_TIERS = Object.freeze(['core', 'commercial', 'restricted', 'internal']);
// A STRICT allowlist: assertKnownKeys throws on anything not named here, so the
// two multi-project fields had to be added in the same change that introduced
// them — otherwise the very first converted config fails to load (§2.10 / I1).
//
// `project` stays the DISPLAY name ("Mauser 3D HMI") and is deliberately not
// re-interpreted as a key; `customer` is the new repository-level identity and
// `projects[]` the list of project folders that repository carries.
const DELIVERY_CONFIG_KEYS = new Set([
  'project', 'customer', 'projects',
  'tier', 'restrictedFeatures', 'remote', 'mirror', 'connectChannel', 'connectLicenseKey',
  // The diagnosis credentials, alongside connectLicenseKey and for the same reason: a delivery must
  // be reproducible from the config alone. They used to live only in the operator's environment, so
  // a delivery from a machine that had never run one failed at the RAG step with nothing on disk
  // saying where to get them — and the values were recoverable only by cloning the customer's own
  // repository back, since bundle-rag embeds them into the delivered project-config.json anyway.
  'requestyApiKey', 'requestyBaseUrl',
]);
const REGISTRATION_KEYS = new Set(['adapter', 'requires']);
const GENERATED_GIT_ATTRIBUTES = [
  'connect/rag.zip filter=lfs diff=lfs merge=lfs -text',
  'projects/*/models/*.glb filter=lfs diff=lfs merge=lfs -text',
  'realvirtual-web/public/models/*.glb filter=lfs diff=lfs merge=lfs -text',
  'realvirtual-web/public/models/library/**/*.glb filter=lfs diff=lfs merge=lfs -text',
];
//! Node.js major version the workspace is delivered for. Single source for `.nvmrc`,
//! the start-script preflight, and the README prerequisites.
const REQUIRED_NODE_MAJOR = 22;
const CORE_FILES = [
  'index.html', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts',
  'vitest.config.ts', 'vitest.node.config.ts', 'LICENSE', 'README.md', 'webviewer.mcp.md',
];
const ALWAYS_DELIVERED_DOCS = [
  'doc-webviewer.md', 'doc-extending-webviewer.md', 'doc-scripting.md', 'doc-behaviors.md',
  'doc-behavior-modelling.md', 'doc-events-and-hooks.md', 'doc-signal-architecture.md',
  'doc-webviewer-interface.md', 'doc-document-linking.md', 'doc-web-debugging.md',
  'doc-ai-integration.md', 'doc-unity-to-web.md', 'doc-lifecycle.md', 'doc-persistence.md',
  // Referenced from doc-signal-architecture.md and doc-unity-to-web.md, both of which ship:
  // leaving it out turns those into broken links and strands the customer exactly when a
  // reference resolves to nothing (plan-381).
  'doc-node-paths.md',
  // Same case: doc-extending-webviewer.md tells the reader to consult it BEFORE gating a slot by
  // mode, so omitting it strands them at exactly the moment they were sent looking.
  'doc-ui-visibility.md',
  // Same case again: README.md is a CORE_FILE and therefore always delivered, and it links here
  // from the documentation index.
  'doc-signal-connection-logic.md',
];
// DESIGN.md and PRODUCT.md used to be delivered from here. They now live in the private sibling
// (brand and strategy are not published on the public mirror), so this tree cannot deliver them;
// the code itself — src/core/hmi/theme.ts and signal-colors.ts — is the authority a customer has.
const CONDITIONAL_DELIVERED_DOCS = new Map([
  ['doc-layout-planner.md', 'layout-planner'],
  ['doc-multiuser-system.md', 'multiuser'],
]);
const NEVER_DELIVERED_DOCS = new Set([
  'doc-deploy.md', 'doc-plc-programming.md', 'doc-render-picking.md', 'PRODUCT.md',
]);
const DELIVERY_DOC_LINK_REDIRECTS = new Map([
  ['src/plugins/sim-controller/DESExperimentsPanel.tsx', 'src/plugins/sim-controller/DESExperimentMatrixPanel.tsx'],
]);
const NON_DELIVERED_DOC_LINK_PREFIXES = [
  'tests/', 'e2e/', 'scripts/', 'mcp-bridge/', '.claude/', '.github/', 'public/models/', 'public/scenes/',
];
// Delivered content from the core `public/models/` tree, relative to `public/`. The rest of
// that tree stays internal: test GLBs, CAD import scratch files and work-in-progress library
// assets are only partially tracked by Git and can hold other customers' geometry, so the
// allowlists below are intersected with the Git index (see deliveredPublicModels) instead of
// being copied from disk.
// The DemoRealvirtual content is BUNDLED: it sits in the core tree's own `public/models/` and
// `public/library/`. Named explicitly rather than globbed, because the rest of `public/models/`
// is scratch. Delivered into the workspace's `public/models/`, which is where the runtime
// resolves models from — a customer needs a reference model next to their own machine.
const DELIVERED_DEMO_MODEL_FILES = [
  'DemoRealvirtualWeb.glb',
  'DemoRealvirtualWeb.settings.json',
];
// Curated bundled-library categories under `public/library/`. Anything else there is scratch
// or CAD-import material. Set this to [] to deliver a workspace without the bundled library.
const DELIVERED_LIBRARY_CATEGORIES = ['PalletHandling'];
const LIBRARY_ROOT = 'library';
const LIBRARY_CATALOG = `${LIBRARY_ROOT}/catalog.json`;
// The bundled library is only useful together with the layout planner. The planner lives in
// the AGPL core and is statically imported by src/main.ts, so it is part of every delivery
// today; keying off its presence keeps the coupling honest if that ever changes.
const LIBRARY_CONSUMER_DIR = 'src/plugins/layout-planner';
const CORE_SCRIPT_FILES = [
  'install-private-dependencies.mjs', 'patch-occt-memory.mjs',
  'build-local-library-catalog.mjs', 'inject-ga-settings.mjs',
];
// Directories outside src/ and public/ that staged source imports (schema/v1/rv-odt.json
// via src/core/engine/rv-component-registry.ts) — the build fails without them.
// The MCP help guides used to be listed here too; they now live under
// src/plugins/mcp-bridge/help/ and travel with src/ like any other source file.
const CORE_DIRS = ['schema'];
// Recipes authored as real Markdown in the core repo's `recipes/` and copied verbatim into the
// workspace, rather than generated as template literals below. Used for runbooks that are long,
// code-block-heavy and identical for every customer, and that double as the canonical source for
// the internal agent definitions — one text, no drift, no backtick escaping.
const STATIC_CORE_RECIPES = ['kinematize-cad-import.md'];
// Public no-op stubs for `@rv-private/*` modules; used as per-file fallback when a
// delivery tier excludes the real private module (see stagePrivateStubFallbacks).
const PRIVATE_STUB_ROOT = 'src/private-stubs';
// Curated AGPL-core capabilities included in every delivery, independent of tier or
// project. Kept honest and stable; it is the SSOT for the "Core (AGPL)" block in the
// generated FEATURES.md and README. Layout planner is a restricted feature, so it is
// intentionally excluded here.
const CORE_FEATURES = Object.freeze([
  'Drives (linear and rotational motion)',
  'Sensors',
  'Transport surfaces (conveyors)',
  'Sources and sinks (MU spawning and consumption)',
  'Grippers and pick-and-place',
  'Signals and PLC connectivity (rv WebSocket Realtime v2)',
  'HMI panels and overlays',
  'Camera presets and views',
  'PDF document linking',
]);

function isWithin(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function normalizeMarkdownTarget(rawTarget) {
  let target = rawTarget.trim();
  if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1).trim();
  else target = target.match(/^(\S+?)(?:\s+["'(].*)?$/)?.[1] ?? target;
  if (!target || target.startsWith('#') || target.startsWith('/') || target.startsWith('//')
      || /^[a-z][a-z0-9+.-]*:/i.test(target)) return null;
  target = target.split('#', 1)[0].split('?', 1)[0];
  try { target = decodeURIComponent(target); } catch { /* Guard the literal path below. */ }
  return target || null;
}

function mapMarkdownFencedProse(text, transform) {
  return text.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g).map((block, blockIndex) => {
    return blockIndex % 2 === 1 ? block : transform(block);
  }).join('');
}

function mapMarkdownProse(text, transform) {
  return mapMarkdownFencedProse(text, block => block.split(/(`+[^`\n]*`+)/g)
      .map((part, inlineIndex) => inlineIndex % 2 === 1 ? part : transform(part))
      .join(''));
}

function markdownLinks(text) {
  const links = [];
  const prose = mapMarkdownProse(text, value => value)
    .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, '')
    .replace(/`+[^`\n]*`+/g, '');
  const inline = /(!?)\[([^\]]*)\]\((<[^>\n]+>|[^)\n]+)\)/g;
  for (const match of prose.matchAll(inline)) {
    const target = normalizeMarkdownTarget(match[3]);
    if (target) links.push({ full: match[0], image: match[1] === '!', label: match[2], target });
  }
  const definitions = /^\s*\[[^\]]+\]:\s*(<[^>\n]+>|\S+)/gm;
  for (const match of prose.matchAll(definitions)) {
    const target = normalizeMarkdownTarget(match[1]);
    if (target) links.push({ full: match[0], image: false, label: '', target });
  }
  const html = /<(?:img|a)\b[^>]*(?:src|href)=["']([^"']+)["'][^>]*>/gi;
  for (const match of prose.matchAll(html)) {
    const target = normalizeMarkdownTarget(match[1]);
    if (target) links.push({ full: match[0], image: /^<img\b/i.test(match[0]), label: '', target });
  }
  return links;
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
}

function assertKnownKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unknown field "${key}".`);
  }
}

function assertSafeRelativePath(path, label) {
  if (typeof path !== 'string' || !path || isAbsolute(path) || path.includes('\\')) {
    throw new Error(`${label} must be a non-empty POSIX relative path.`);
  }
  const segments = path.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`${label} contains an unsafe path segment: ${path}`);
  }
}

//! Loads and validates the private source tier manifest.
export function loadTierManifest(manifestPathOrPrivateRoot) {
  const manifestPath = manifestPathOrPrivateRoot.endsWith('.json')
    ? manifestPathOrPrivateRoot
    : join(manifestPathOrPrivateRoot, 'tier-manifest.json');
  const manifest = readJson(manifestPath, 'tier-manifest.json');
  assertObject(manifest, 'tier-manifest.json');
  assertKnownKeys(manifest, new Set(['defaults', 'rules', 'registrations']), 'tier-manifest.json');
  if (!DELIVERY_TIERS.includes(manifest.defaults)) {
    throw new Error(`tier-manifest defaults must be one of ${DELIVERY_TIERS.join(', ')}.`);
  }
  if (!Array.isArray(manifest.rules)) throw new Error('tier-manifest rules must be an array.');
  assertObject(manifest.registrations, 'tier-manifest registrations');

  const registrations = {};
  for (const [feature, registration] of Object.entries(manifest.registrations)) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(feature)) throw new Error(`Invalid feature key "${feature}".`);
    assertObject(registration, `registration ${feature}`);
    assertKnownKeys(registration, REGISTRATION_KEYS, `registration ${feature}`);
    assertSafeRelativePath(String(registration.adapter ?? '').replace(/^\.\//, ''), `${feature}.adapter`);
    const requires = registration.requires ?? [];
    if (!Array.isArray(requires) || requires.some((item) => typeof item !== 'string')) {
      throw new Error(`${feature}.requires must be an array of feature keys.`);
    }
    registrations[feature] = { adapter: registration.adapter, requires: [...requires] };
  }

  const rules = manifest.rules.map((rule, index) => {
    assertObject(rule, `tier rule ${index}`);
    assertKnownKeys(rule, new Set(['path', 'tier', 'feature']), `tier rule ${index}`);
    assertSafeRelativePath(rule.path, `tier rule ${index}.path`);
    if (!DELIVERY_TIERS.includes(rule.tier)) throw new Error(`Unknown tier "${rule.tier}".`);
    if (rule.feature && !registrations[rule.feature]) {
      throw new Error(`Tier rule references unknown feature "${rule.feature}".`);
    }
    return { ...rule, matcher: globRegex(rule.path) };
  });
  for (let i = 0; i < rules.length; i++) {
    for (let j = i + 1; j < rules.length; j++) {
      if (patternsOverlap(rules[i].path, rules[j].path)) {
        throw new Error(`Overlapping tier rules are ambiguous: ${rules[i].path} and ${rules[j].path}.`);
      }
    }
  }
  for (const [feature, registration] of Object.entries(registrations)) {
    for (const dependency of registration.requires) {
      if (!registrations[dependency]) throw new Error(`${feature} requires unknown feature ${dependency}.`);
    }
  }
  const visiting = new Set();
  const visited = new Set();
  function visit(feature) {
    if (visiting.has(feature)) throw new Error(`Feature dependency cycle at ${feature}.`);
    if (visited.has(feature)) return;
    visiting.add(feature);
    for (const dependency of registrations[feature].requires) visit(dependency);
    visiting.delete(feature);
    visited.add(feature);
  }
  for (const feature of Object.keys(registrations)) visit(feature);
  return { defaults: manifest.defaults, rules, registrations, path: manifestPath };
}

//! Resolves one private source path to its tier and optional feature key.
export function resolveTier(manifest, relativePath) {
  const normalized = toPosix(relativePath).replace(/^\.\//, '');
  const matches = manifest.rules.filter((rule) => rule.matcher.test(normalized));
  if (matches.length > 1) throw new Error(`Multiple tier rules match ${normalized}.`);
  return matches[0] ?? { tier: manifest.defaults, feature: null, path: null };
}

const DELIVERY_KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

//! Normalises the project list of one delivery config. A config without `projects[]`
//! carries exactly one project named after its own file — the pre-plan-700 shape,
//! which must keep loading unchanged.
function deliveryConfigProjects(config, configName) {
  if (config.projects === undefined) return [configName];
  if (!Array.isArray(config.projects) || config.projects.length === 0) {
    throw new Error(`delivery/${configName}.json: "projects" must be a non-empty array of project keys.`);
  }
  for (const key of config.projects) {
    if (typeof key !== 'string' || !DELIVERY_KEY_PATTERN.test(key)) {
      throw new Error(`delivery/${configName}.json: "projects" contains an invalid project key: ${JSON.stringify(key)}`);
    }
  }
  if (new Set(config.projects).size !== config.projects.length) {
    throw new Error(`delivery/${configName}.json: "projects" contains duplicates.`);
  }
  return [...config.projects];
}

//! Reads and validates one delivery/<name>.json. The result carries the normalised
//! `customer` and `projects[]`; `projectKey` is added by the resolving callers below.
function readDeliveryConfigFile(privateRoot, configName, manifest) {
  if (!DELIVERY_KEY_PATTERN.test(configName)) throw new Error(`Invalid delivery config name ${configName}.`);
  const path = join(privateRoot, 'delivery', `${configName}.json`);
  if (!existsSync(path)) throw new Error(`Delivery config not found: ${path}`);
  const config = readJson(path, `delivery/${configName}.json`);
  assertObject(config, `delivery/${configName}.json`);
  assertKnownKeys(config, DELIVERY_CONFIG_KEYS, `delivery/${configName}.json`);
  if (typeof config.project !== 'string' || !config.project.trim()) throw new Error('delivery.project is required.');
  if (config.customer !== undefined && (typeof config.customer !== 'string' || !DELIVERY_KEY_PATTERN.test(config.customer))) {
    throw new Error(`delivery/${configName}.json: "customer" must be a slug like the file name.`);
  }
  const projects = deliveryConfigProjects(config, configName);
  return assertDeliveryFields(config, manifest, { customer: config.customer ?? configName, projects, configName, path });
}

//! Lists every delivery config in the private repository, sorted by file name.
export function listDeliveryConfigs(privateRoot, manifest = loadTierManifest(privateRoot)) {
  const deliveryRoot = join(privateRoot, 'delivery');
  if (!existsSync(deliveryRoot)) return [];
  return readdirSync(deliveryRoot).filter((name) => name.endsWith('.json')).sort()
    .map((name) => readDeliveryConfigFile(privateRoot, name.slice(0, -5), manifest));
}

/**
 * True when some delivery config claims this project key.
 *
 * A pure existence probe: it neither validates the config nor needs the tier
 * manifest, because it replaces an `existsSync` at call sites where "no config"
 * is a perfectly normal state (an internal-only project being deployed to Bunny).
 * Validation is `loadDeliveryConfig`'s job and happens when the config is used.
 */
export function hasDeliveryConfig(privateRoot, projectKey) {
  if (!DELIVERY_KEY_PATTERN.test(projectKey)) return false;
  const deliveryRoot = join(privateRoot, 'delivery');
  if (existsSync(join(deliveryRoot, `${projectKey}.json`))) return true;
  if (!existsSync(deliveryRoot)) return false;
  return readdirSync(deliveryRoot).filter((name) => name.endsWith('.json')).some((name) => {
    try {
      const config = readJson(join(deliveryRoot, name), `delivery/${name}`);
      return Array.isArray(config?.projects) && config.projects.includes(projectKey);
    } catch {
      return false;
    }
  });
}

/**
 * Loads the internal, generator-owned delivery configuration for one project.
 *
 * The file name is no longer the project key. A repository may carry several
 * projects (§2.10), so the key is resolved: the same-named file first — which
 * keeps every existing single-project config working with no change at all —
 * then the `projects[]` list of every config. An ambiguous key is an error
 * rather than a first-match, because guessing here means delivering one
 * customer's project into another customer's repository.
 */
export function loadDeliveryConfig(privateRoot, projectKey, manifest = loadTierManifest(privateRoot)) {
  if (!DELIVERY_KEY_PATTERN.test(projectKey)) throw new Error(`Invalid project key ${projectKey}.`);
  const direct = join(privateRoot, 'delivery', `${projectKey}.json`);
  if (existsSync(direct)) {
    const config = readDeliveryConfigFile(privateRoot, projectKey, manifest);
    if (config.projects.includes(projectKey)) return { ...config, projectKey };
    throw new Error(`delivery/${projectKey}.json does not list "${projectKey}" in its projects [${config.projects.join(', ')}]. `
      + `Deliver one of those keys, or the whole customer with --customer ${config.customer}.`);
  }
  const matches = listDeliveryConfigs(privateRoot, manifest).filter((config) => config.projects.includes(projectKey));
  if (matches.length === 0) throw new Error(`Delivery config not found: ${direct}`);
  if (matches.length > 1) {
    throw new Error(`Project "${projectKey}" is claimed by more than one delivery config: `
      + `${matches.map((config) => `delivery/${config.configName}.json`).join(', ')}.`);
  }
  return { ...matches[0], projectKey };
}

//! Loads the delivery configuration of one customer, i.e. of one customer repository.
//! `projectKey` is set to the first project so single-project call sites keep working.
export function loadDeliveryConfigByCustomer(privateRoot, customer, manifest = loadTierManifest(privateRoot)) {
  if (!DELIVERY_KEY_PATTERN.test(customer)) throw new Error(`Invalid customer ${customer}.`);
  const matches = listDeliveryConfigs(privateRoot, manifest)
    .filter((config) => config.customer === customer || config.configName === customer);
  if (matches.length === 0) throw new Error(`No delivery config for customer "${customer}" in ${join(privateRoot, 'delivery')}.`);
  if (matches.length > 1) {
    throw new Error(`Customer "${customer}" is claimed by more than one delivery config: `
      + `${matches.map((config) => `delivery/${config.configName}.json`).join(', ')}.`);
  }
  return { ...matches[0], projectKey: matches[0].projects[0] };
}

function assertDeliveryFields(config, manifest, extra) {
  if (!['core', 'commercial'].includes(config.tier)) throw new Error('delivery.tier must be core or commercial.');
  if (!Array.isArray(config.restrictedFeatures)
      || config.restrictedFeatures.some((feature) => typeof feature !== 'string' || !manifest.registrations[feature])) {
    throw new Error('delivery.restrictedFeatures contains an unknown feature.');
  }
  if (new Set(config.restrictedFeatures).size !== config.restrictedFeatures.length) {
    throw new Error('delivery.restrictedFeatures contains duplicates.');
  }
  if (typeof config.remote !== 'string' || !config.remote.trim()) throw new Error('delivery.remote is required.');
  if (config.mirror !== null && typeof config.mirror !== 'string') throw new Error('delivery.mirror must be a string or null.');
  if (!['stable', 'beta'].includes(config.connectChannel)) throw new Error('delivery.connectChannel must be stable or beta.');
  // CONNECT issues keys as LIC-XXXX-XXXX-XXXX (see LicenseStore's masked form). The previous
  // check demanded an "RVC1-" prefix that no real key carries, so a delivery could only pass it
  // with a made-up value — which is how RVC1-PLACEHOLDER reached a customer and left their
  // gateway unlicensed until someone typed a key by hand.
  if (typeof config.connectLicenseKey !== 'string'
      || !/^LIC(-[A-Z0-9]{4}){3}$/i.test(config.connectLicenseKey.trim())) {
    throw new Error('delivery.connectLicenseKey must be a CONNECT key in the form LIC-XXXX-XXXX-XXXX.');
  }
  if (/placeholder|example|dummy|xxxx/i.test(config.connectLicenseKey)) {
    throw new Error('delivery.connectLicenseKey looks like a placeholder; deliver the customer\'s real key.');
  }
  // Both optional: a --no-rag delivery needs neither, and REQUESTY_API_KEY in the environment still
  // wins over the config for a one-off run against another gateway.
  if (config.requestyApiKey !== undefined
      && (typeof config.requestyApiKey !== 'string' || !config.requestyApiKey.trim())) {
    throw new Error('delivery.requestyApiKey must be a non-empty string when present.');
  }
  if (config.requestyBaseUrl !== undefined
      && (typeof config.requestyBaseUrl !== 'string' || !/^https:\/\//i.test(config.requestyBaseUrl))) {
    throw new Error('delivery.requestyBaseUrl must be an https:// URL when present.');
  }
  return { ...config, ...extra };
}

function featureTier(manifest, feature) {
  const adapter = manifest.registrations[feature].adapter.replace(/^\.\//, '') + '.ts';
  return resolveTier(manifest, `src/${adapter}`).tier;
}

function selectedFeatures(manifest, profile) {
  const entitled = new Set(profile.restrictedFeatures ?? []);
  const selected = [];
  for (const feature of Object.keys(manifest.registrations)) {
    const tier = featureTier(manifest, feature);
    if (tier === 'commercial' && profile.tier === 'commercial') selected.push(feature);
    if (tier === 'restricted' && entitled.has(feature)) selected.push(feature);
  }
  const ordered = [];
  const seen = new Set();
  function add(feature) {
    if (seen.has(feature)) return;
    for (const dependency of manifest.registrations[feature].requires) {
      if (!selected.includes(dependency)) throw new Error(`${feature} requires non-entitled feature ${dependency}.`);
      add(dependency);
    }
    seen.add(feature);
    ordered.push(feature);
  }
  for (const feature of selected) add(feature);
  return ordered;
}

function selectedDocumentation(manifest, profile) {
  const docs = [...ALWAYS_DELIVERED_DOCS];
  const features = new Set(selectedFeatures(manifest, profile));
  for (const [doc, feature] of CONDITIONAL_DELIVERED_DOCS) {
    if (!manifest.registrations[feature]) {
      console.warn(`[customer-workspace] Skipping ${doc}: entitlement "${feature}" is not declared in tier-manifest.json.`);
      continue;
    }
    if (features.has(feature)) docs.push(doc);
  }
  return docs;
}

//! Generates the customer-specific private plugin entry point without any internal import.
export function generateCustomerPrivatePlugins(manifest, profile) {
  const features = selectedFeatures(manifest, profile);
  const imports = features.map((feature, index) =>
    `import { register as registerFeature${index} } from '${manifest.registrations[feature].adapter}';`);
  const calls = features.map((_feature, index) => `  await registerFeature${index}(viewer);`);
  return [
    `import type { RVViewer } from '../../realvirtual-web/src/core/rv-viewer';`,
    ...imports,
    '',
    'export async function registerPrivatePlugins(viewer: RVViewer): Promise<void> {',
    ...(calls.length ? calls : ['  void viewer;']),
    '}',
    '',
  ].join('\n');
}

//! Lists the customer's own project plugins under `projects/<key>/plugins/`.
//! Returns `{ file, name }` for every `*.ts`/`*.tsx` except the `index.ts` entry point,
//! where `name` is the file name without its extension (a readable label).
function listProjectPluginNames(workspaceRoot, projectKey) {
  const pluginsDir = join(workspaceRoot, 'projects', projectKey, 'plugins');
  if (!existsSync(pluginsDir)) return [];
  return readdirSync(pluginsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => /\.tsx?$/.test(name) && name !== 'index.ts')
    .sort()
    .map((name) => ({ file: name, name: name.replace(/\.[^.]+$/, '') }));
}

//! Renders the feature matrix used internally and in customer workspaces.
//! For a single customer (customerProjectKey set) it produces three clearly separated
//! categories: the always-included AGPL core, the tier-gated licensed features, and the
//! customer's own project plugins. `projectPlugins` is the list from listProjectPluginNames.
export function renderFeatureMatrix(manifest, deliveries, customerProjectKey = null, projectPlugins = null) {
  // A config may now carry several projects, so membership decides — not the
  // single `projectKey` a resolving load happened to attach.
  const configs = customerProjectKey
    ? deliveries.filter((delivery) => (delivery.projects ?? [delivery.projectKey]).includes(customerProjectKey))
    : deliveries;
  const lines = ['# Delivered features', ''];

  lines.push('## Core (AGPL) - always included', '');
  lines.push('Included in every delivery (AGPL core).', '');
  for (const capability of CORE_FEATURES) lines.push(`- ${capability}`);
  lines.push('');

  lines.push('## Licensed features', '');
  lines.push('Tier-gated commercial and restricted features; enabled per your licence.', '');
  const headers = ['Feature', 'Tier', ...configs.map((delivery) => delivery.project)];
  lines.push(`| ${headers.join(' | ')} |`);
  lines.push(`| ${headers.map(() => '---').join(' | ')} |`);
  for (const feature of Object.keys(manifest.registrations).sort()) {
    const tier = featureTier(manifest, feature);
    const cells = configs.map((delivery) => {
      const enabled = tier === 'commercial'
        ? delivery.tier === 'commercial'
        : tier === 'restricted' && delivery.restrictedFeatures.includes(feature);
      return enabled ? 'yes' : 'no';
    });
    lines.push(`| ${feature} | ${tier} | ${cells.join(' | ')} |`);
  }
  lines.push('');

  if (customerProjectKey) {
    lines.push('## Your project', '');
    const plugins = projectPlugins ?? [];
    if (plugins.length) {
      lines.push(`Your own project-specific code under \`projects/${customerProjectKey}/plugins/\` - developed together with realvirtual.`, '');
      for (const plugin of plugins) lines.push(`- \`${plugin.name}\` (${plugin.file})`);
    } else {
      lines.push(`No project plugins yet - add your first one under \`projects/${customerProjectKey}/plugins/\` (see [create-custom-plugin.md](recipes/create-custom-plugin.md)).`);
    }
    lines.push('');
  }

  lines.push('_Generated from tier-manifest.json and internal delivery profiles._', '');
  return lines.join('\n');
}

// Build-output directories that are never delivered: the generated workspace
// .gitignore excludes `**/node_modules/` and `**/dist/`. Link scans and the
// snapshot copy skip them at every level so a --fast build-cache junction in
// node_modules cannot trip the link-reject guard; the guard stays fully active
// for all delivered content (e.g. a link inside projects/<key>/ still aborts).
const NON_DELIVERED_BUILD_DIRS = new Set(['node_modules', 'dist']);

function isNonDeliveredBuildDir(entry) {
  return NON_DELIVERED_BUILD_DIRS.has(entry.name.toLowerCase())
    && (entry.isDirectory() || entry.isSymbolicLink());
}

function assertNotLink(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`Links are not allowed in delivery input: ${path}`);
  if (process.platform === 'win32' && stat.isDirectory()) {
    const resolved = realpathSync.native(path);
    const expected = join(realpathSync.native(dirname(path)), basename(path));
    if (resolve(resolved).toLowerCase() !== resolve(expected).toLowerCase()) {
      throw new Error(`Junctions are not allowed in delivery input: ${path}`);
    }
  }
}

function copyTree(source, destination, filter = () => true, sourceRoot = source) {
  assertNotLink(source);
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const rel = toPosix(relative(sourceRoot, from));
    if (!filter(rel, entry)) continue;
    assertNotLink(from);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) copyTree(from, to, filter, sourceRoot);
    else if (entry.isFile()) copyFileSync(from, to);
  }
}

function copyReferencedDocImages(coreRoot, outputRoot, markdownFiles) {
  const imageRoot = join(coreRoot, 'docs', 'images');
  for (const markdownFile of markdownFiles) {
    const sourceMarkdown = join(coreRoot, markdownFile);
    if (!existsSync(sourceMarkdown)) continue;
    for (const { target } of markdownLinks(readFileSync(sourceMarkdown, 'utf8'))) {
      const source = resolve(dirname(sourceMarkdown), target);
      if (!isWithin(imageRoot, source) || !existsSync(source) || !statSync(source).isFile()) continue;
      const destination = join(outputRoot, relative(coreRoot, source));
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(source, destination);
    }
  }
}

//! Git-tracked paths under `public/models/`, relative to `public/`. Returns null when the core
//! tree carries no usable Git index (test fixtures) so the caller then delivers no models at
//! all instead of copying whatever happens to sit on disk.
function trackedPublicModels(coreRoot) {
  if (!existsSync(join(coreRoot, '.git'))) return null;
  try {
    return new Set(execFileSync('git', ['ls-files', '-z', '--', 'public/models'], { cwd: coreRoot })
      .toString('utf8').split('\0').filter(Boolean)
      .map((path) => toPosix(path).slice('public/'.length)));
  } catch {
    return null;
  }
}

//! Resolves the `public/models/` files a delivery ships FROM THE CORE TREE, relative to
//! `public/`.
//!
//! That is nothing at all: {@link copyDemoAssetsIntoCore} names the demo files it delivers and
//! copies them explicitly. What is left under `public/models/` is local scratch — CAD import
//! leftovers, other customers' geometry — which must never reach a customer workspace. The
//! Git-index intersection is kept as the guard it always was, so widening the (now empty)
//! allowlist still cannot ship untracked material.
function deliveredPublicModels(coreRoot) {
  const tracked = trackedPublicModels(coreRoot);
  if (!tracked) return new Set();
  return new Set();
}

//! Copies the DemoRealvirtual reference model AND the curated component library out of the
//! core tree into the delivered `realvirtual-web/public/`.
//!
//! The demo content is bundled: it lives in the core tree's own `public/models/` and
//! `public/library/`, which is also where the workspace expects it, because that is where
//! the runtime resolves models and the library catalog from.
//!
//! The library follows the layout planner: without the planner in the core there is nothing to
//! browse it with, so it is omitted (and its categories are still filtered to
//! {@link DELIVERED_LIBRARY_CATEGORIES} — `Custom/` and `imports/` are scratch).
//!
//! A silently model-less delivery is exactly the failure this step exists to prevent, so a
//! missing file throws rather than shipping an empty workspace.
function copyDemoAssetsIntoCore(coreRoot, coreOutput) {
  const projectDir = join(coreRoot, 'public');
  const sourceDir = join(projectDir, 'models');
  const targetDir = join(coreOutput, 'public', 'models');
  mkdirSync(targetDir, { recursive: true });
  for (const name of DELIVERED_DEMO_MODEL_FILES) {
    const source = join(sourceDir, name);
    if (!existsSync(source)) {
      throw new Error(`Demo model is missing from the core public/ tree: ${source}`);
    }
    copyFileSync(source, join(targetDir, name));
  }

  if (!existsSync(join(coreRoot, LIBRARY_CONSUMER_DIR))) return;
  const delivered = new Set();
  for (const category of DELIVERED_LIBRARY_CATEGORIES) {
    const source = join(projectDir, 'library', category);
    if (!existsSync(source)) continue;
    copyTree(source, join(coreOutput, 'public', 'library', category));
    for (const file of readdirSync(source, { withFileTypes: true })) {
      if (file.isFile()) delivered.add(`${LIBRARY_ROOT}/${category}/${file.name}`);
    }
  }
  writeDeliveredLibraryCatalog(projectDir, join(coreOutput, 'public'), delivered);
}

//! Writes a bundled-library catalog reduced to the delivered GLBs. The project catalog also
//! lists internal and customer-specific assets; delivering it verbatim would 404 in the
//! workspace and expose those asset names in the planner library UI.
function writeDeliveredLibraryCatalog(projectDir, publicOutput, delivered) {
  const source = join(projectDir, 'library', 'catalog.json');
  if (!existsSync(source)) return;
  const catalog = readJson(source);
  const entries = (catalog.entries ?? [])
    .filter((entry) => delivered.has(`${LIBRARY_ROOT}/${toPosix(String(entry?.glbUrl ?? ''))}`));
  if (entries.length === 0) return;
  const destination = join(publicOutput, LIBRARY_CATALOG);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, JSON.stringify({ ...catalog, entries }, null, 2) + '\n');
}

function copyCore(coreRoot, outputRoot, deliveredDocs, publicModels = new Set(), opts = {}) {
  // includePublicDemoContent: the PUBLIC demo deploy ships realvirtual's own curated
  // scenes/ (Examples incl. DemoPlanner) and aasx/ (AAS supplier demos: Festo, SEW,
  // Bosch). Customer deliveries never get them — they are demo content, not product.
  const { includePublicDemoContent = false } = opts;
  for (const name of CORE_FILES) {
    const source = join(coreRoot, name);
    if (existsSync(source)) copyFileSync(source, join(outputRoot, name));
  }
  for (const name of deliveredDocs) {
    const source = join(coreRoot, name);
    if (existsSync(source)) copyFileSync(source, join(outputRoot, name));
  }
  copyReferencedDocImages(coreRoot, outputRoot, ['README.md', ...deliveredDocs]);
  copyTree(join(coreRoot, 'src'), join(outputRoot, 'src'));
  // Directories on the path to a delivered model; a models/ directory outside this set is never
  // entered, so no empty placeholder folders reach the workspace.
  const modelDirectories = new Set();
  for (const rel of publicModels) {
    const segments = rel.split('/');
    for (let index = 1; index < segments.length; index++) modelDirectories.add(segments.slice(0, index).join('/'));
  }
  copyTree(join(coreRoot, 'public'), join(outputRoot, 'public'), (path, entry) => {
    const rel = toPosix(path);
    const normalized = rel.toLowerCase();
    if (!includePublicDemoContent) {
      if (normalized === 'scenes' || normalized.startsWith('scenes/')) return false;
      if (normalized === 'aasx' || normalized.startsWith('aasx/')) return false;
    }
    // The bundled component library is delivered by copyDemoAssetsIntoCore, which filters it
    // to DELIVERED_LIBRARY_CATEGORIES and writes a matching reduced catalog. Copying the tree
    // wholesale here would ship every category plus the full catalog.json and silently defeat
    // that curation.
    if (normalized === 'library' || normalized.startsWith('library/')) return false;
    if (normalized !== 'models' && !normalized.startsWith('models/')) return true;
    return entry.isDirectory() ? modelDirectories.has(rel) : publicModels.has(rel);
  });
  for (const name of CORE_DIRS) {
    const source = join(coreRoot, name);
    if (existsSync(source)) copyTree(source, join(outputRoot, name));
  }
  mkdirSync(join(outputRoot, 'scripts'), { recursive: true });
  for (const name of CORE_SCRIPT_FILES) {
    const source = join(coreRoot, 'scripts', name);
    if (existsSync(source)) copyFileSync(source, join(outputRoot, 'scripts', name));
  }
}

function sourceAllowed(resolved, profile) {
  if (resolved.tier === 'commercial') return profile.tier === 'commercial';
  if (resolved.tier === 'restricted') return (profile.restrictedFeatures ?? []).includes(resolved.feature);
  return false;
}

function writePrunedPrivatePackage(privateRoot, destination) {
  const manifest = readJson(join(privateRoot, 'package.json'));
  manifest.dependencies = Object.fromEntries(Object.entries(manifest.dependencies ?? {})
    .filter(([name]) => !name.toLowerCase().startsWith('@nvidia/')));
  writeFileSync(join(destination, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(join(destination, 'package-lock.json'), JSON.stringify({
    name: manifest.name,
    version: manifest.version,
    lockfileVersion: 3,
    requires: true,
    packages: { '': { name: manifest.name, version: manifest.version, dependencies: manifest.dependencies } },
  }, null, 2) + '\n');
}

function writeWorkspaceTsconfig(coreOutput) {
  const config = readJson(join(coreOutput, 'tsconfig.json'));
  config.compilerOptions.paths['@rv-private/*'] = ['../realvirtual-web-pro/src/*', 'src/private-stubs/*'];
  config.compilerOptions.paths['@rv-projects/*'] = ['../projects/*', '../realvirtual-web-pro/projects/*', 'src/private-stubs/projects/*'];
  config.include = ['src', 'tests', '../realvirtual-web-pro/src', '../projects'];
  writeFileSync(join(coreOutput, 'tsconfig.json'), JSON.stringify(config, null, 2) + '\n');
}

function bareDefaultModel(project) {
  const configured = project?.settings?.defaultModel ?? project?.defaultModel ?? '';
  return configured ? basename(String(configured).replace(/\\/g, '/')) : '';
}

function generatedSettings(project, delivery, connectPin) {
  const settings = {
    defaultModel: bareDefaultModel(project),
    connectChannel: delivery.connectChannel,
    connectLicensePrefill: delivery.connectLicenseKey,
    analytics: { googleAnalyticsId: '' },
  };
  if (connectPin) settings.connectDownload = { channel: delivery.connectChannel, ...connectPin };
  return settings;
}

function generateReadme(delivery, projectKey, model, features, projectPlugins = null, hasDiagnosis = true) {
  const plugins = projectPlugins ?? [];
  const licensedBlock = features.length
    ? features.map((feature) => `- \`${feature}\``).join('\n')
    : '- None enabled for this profile.';
  const projectBlock = plugins.length
    ? plugins.map((plugin) => `- \`${plugin.name}\` (${plugin.file})`).join('\n')
    : `- No project plugins yet - add your first one under \`projects/${projectKey}/plugins/\` (see [create-custom-plugin.md](recipes/create-custom-plugin.md)).`;
  const remote = typeof delivery.remote === 'string' && delivery.remote.trim()
    ? delivery.remote.trim()
    : '<REMOTE-URL>';
  const customerModel = model || 'the configured customer model';
  return `# ${delivery.project}\n\n` +
    `This repository is your ready-to-run realvirtual WEB workspace for \`${customerModel}\`.\n\n` +
    `Data protection, hosting, and access control are described under [Your private workspace](#your-private-workspace) in the reference section below.\n\n` +
    `## Quick start (Windows)\n\n` +
    `1. Download **realvirtual WEB dev** from [web.realvirtual.io/download/dev/realvirtual-WEB-dev-setup.exe](https://web.realvirtual.io/download/dev/realvirtual-WEB-dev-setup.exe) and run it. It installs into your user profile, so no administrator rights are needed, and it brings its own Node.js and Git along with the dependency archive. Nothing is installed system-wide and nothing else has to be prepared.\n` +
    `2. Give the installer the repository address \`${remote}\` and a folder. Choose a short local folder such as \`D:\\git\\${projectKey}\`, not one inside OneDrive: the sync client would try to upload every one of the tens of thousands of files in the workspace. If the folder you pick still holds files from an earlier attempt, the setup offers to empty it before cloning, because deleting such a folder in Explorer usually stops halfway through \`node_modules\`. The installer then clones this workspace, restores the dependencies from the bundled archive and downloads realvirtual CONNECT.\n` +
    `3. Start **realvirtual WEB dev** from the Start menu. It starts CONNECT and the viewer and opens your browser.\n\n` +
    `## Quick start (manual, Linux, macOS)\n\n` +
    `The installer above is the short way on Windows 10/11, the recommended operating system. Linux and macOS are supported through the manual route described here, which also works on Windows if you prefer to install the parts yourself. This route needs the following prepared by hand; with the installer, the first two come along with it:\n\n` +
    `- **Node.js ${REQUIRED_NODE_MAJOR} LTS (required for this route):** The workspace does not run without it. Download the Windows Installer (.msi, LTS ${REQUIRED_NODE_MAJOR}) from [nodejs.org](https://nodejs.org/) and keep the "Add to PATH" option enabled, or run \`winget install OpenJS.NodeJS.LTS\`. On Linux and macOS, use your package manager or [nvm](https://github.com/nvm-sh/nvm). **After installing, close the terminal and open a new one** - in an IDE such as VS Code, close the IDE itself - because a running terminal keeps the old PATH. Then verify with \`node --version\` and \`npm --version\`; \`node --version\` must report v${REQUIRED_NODE_MAJOR} or newer (the delivered version is pinned in \`.nvmrc\`).\n` +
    (hasDiagnosis
      ? `- **Git and Git LFS:** Install both, then check them with \`git --version\` and \`git lfs version\`. Run \`git lfs install\` once on your computer. Git LFS is critical because \`connect/rag.zip\` is an LFS object; without Git LFS, Git downloads only a small pointer file and the diagnosis function cannot start.\n`
      : `- **Git and Git LFS:** Install both, then check them with \`git --version\` and \`git lfs version\`. Run \`git lfs install\` once on your computer. Git LFS is critical because the delivered models are LFS objects; without Git LFS, Git downloads only small pointer files and the models cannot load.\n`) +
    `- **Disk and network:** Keep about 2 GB of free disk space and allow network access to \`git.realvirtual.io\` and \`web.realvirtual.io\` for the CONNECT download.\n\n` +
    `Then set the workspace up:\n\n` +
    `1. Open PowerShell on Windows, or a terminal on Linux/macOS.\n` +
    `2. Clone this repository and open the cloned folder:\n\n` +
    `   \`git clone ${remote}\`\n\n` +
    `3. Start the workspace **from the repository root**, the folder that contains \`start.ps1\` next to \`realvirtual-web/\`. Do not run the start script from inside \`realvirtual-web/\`:\n\n` +
    `   - **Windows:** Run \`powershell -NoProfile -ExecutionPolicy Bypass -File .\\start.ps1\`. The \`-ExecutionPolicy Bypass\` option avoids the common local-script policy error. Alternatively, right-click \`start.ps1\` and select **Run with PowerShell**.\n` +
    `   - **Linux:** Run \`./start.sh\`.\n\n` +
    `   \`start.ps1\` prepares the workspace by calling \`setup.ps1\` and then starts realvirtual CONNECT, which serves the viewer itself. \`setup.ps1\` can also be run on its own after a \`git pull\`; it starts nothing.\n\n` +
    `## The first start\n\n` +
    `Wait for the first start to finish. It installs the npm dependencies, downloads realvirtual CONNECT (about 225 MB) from \`web.realvirtual.io\`, verifies its SHA-256 checksum, and opens your browser with \`${customerModel}\`.\n\n` +
    `The preparation reports its stages, shows the CONNECT download progress in MB, and the browser only opens once the viewer actually answers. On a first start, the dependency installation and the download each take several minutes; as long as steps or progress keep appearing, it is working. If progress stops entirely, read [If the start hangs while installing the dependencies](#if-the-start-hangs-while-installing-the-dependencies) in the reference section.\n\n` +
    `### Licence activation\n\n` +
    `On the first start, the activation dialog appears with your licence key already filled in. Click **Activate** and accept the Terms once. Activation needs Internet access to the realvirtual portal. Without activation, the viewer still runs, but CONNECT functions are limited.\n\n` +
    `## Daily operation\n\n` +
    `### One address, whichever way the workspace runs\n\n` +
    `realvirtual CONNECT is the only thing you start. It works out how this workspace is set up, starts the development server for you when the sources are present, and serves the Viewer at **http://localhost:5100** either way. Hot reload works there as usual: save a file and the browser updates.\n\n` +
    `To use other ports, pass them to the start script: \`powershell -NoProfile -ExecutionPolicy Bypass -File .\\start.ps1 -ConnectPort 5101 -WebPort 5174\`.\n\n` +
    `The realvirtual CONNECT tray icon shows which mode this instance runs in and which folders it uses, and lets you stop, start or restart the development server from **realvirtual WEB**.\n\n` +
    `### Updates\n\n` +
    `Updates stay in Git: run \`git pull\` in the workspace folder, then start again the way you started before - from the Start-menu entry **realvirtual WEB dev** after an installer setup, or with the same start script otherwise. Nothing else is required. Your own changes under \`projects/${projectKey}/\` remain untouched.\n\n` +
    `### After a \`git pull\` that changes the dependencies\n\n` +
    `Run \`setup.ps1\` (Linux: \`setup.sh\`) once. It reinstalls only what changed and records the new state. If you start without doing so, CONNECT reports that the dependencies have moved on and lets you either update or keep working with what you have.\n\n` +
    `## Working with the workspace\n\n` +
    `Your editable files are under \`projects/${projectKey}/\`: \`models/\` contains the machine models, \`plugins/\` contains project-specific viewer code, and \`docs/\` contains project documentation. Edit only this project directory; everything outside it - \`realvirtual-web/\`, \`realvirtual-web-pro/\`, \`connect/\` - is replaced by every delivery update. See \`CONTRIBUTING.md\` before making changes, and "Receiving an update" below for what an update does inside your project directory.\n\n` +
    `The [workspace recipes](recipes/README.md) are the canonical, vendor-neutral runbooks for common model, CONNECT, historian, plugin, troubleshooting, and deployment tasks. They can be followed by a person or any AI assistant.\n\n` +
    `### Use your own machine model\n\n` +
    `Export the machine as a GLB file from Unity with the GLB export in realvirtual Professional, then place it in \`projects/${projectKey}/models/\`. If the new file has the same name as the existing model, no configuration change is required. If it has a different name, update \`defaultModel\` in \`realvirtual-web/public/settings.json\`. GLB models are tracked with Git LFS.\n\n` +
    `### Custom development\n\n` +
    `Create project-specific Viewer code only in \`projects/${projectKey}/plugins/\`. Add a plugin file there, export and register it from \`projects/${projectKey}/plugins/index.ts\`, then restart the development server so Vite discovers the changed project entry point. See [Extending realvirtual WEB](realvirtual-web/doc-extending-webviewer.md) and [Scripting](realvirtual-web/doc-scripting.md). Before opening a pull request, run \`npx tsc --noEmit\` and \`npm run build\` from \`realvirtual-web/\`.\n\n` +
    `### AI-assisted development (optional)\n\n` +
    `The workspace includes \`CLAUDE.md\` and an MCP bridge. If you start Claude Code, or another MCP-capable assistant, in the workspace folder, it can inspect and modify the running scene through the \`web_*\` MCP tools. This requires your own subscription with the respective provider; realvirtual supplies the integration, not an assistant licence.\n\n` +
    `### Submit changes\n\n` +
    `Create a branch, commit your changes, and open a pull request in this repository. realvirtual reviews the pull request. See \`CONTRIBUTING.md\` for details.\n\n` +
    `### Receiving an update\n\n` +
    `An update arrives as a commit pushed to this repository by realvirtual. It touches three kinds of file, and the rule differs for each:\n\n` +
    `| What | What an update does |\n` +
    `| --- | --- |\n` +
    `| \`realvirtual-web/\`, \`realvirtual-web-pro/\`, \`connect/\` and everything else outside \`projects/\` | **Replaced.** Do not edit these; changes here are overwritten. If you did change something, the update lists it in the report so you can see what was lost. |\n` +
    `| Parts of \`projects/${projectKey}/\` that realvirtual maintains - typically \`models/\`, \`docs/\`, \`connect/\`, \`plugins/\`, \`rag/\` | **Merged.** If you did not change a file, it is updated. If you did, **your version stays** and ours is put beside it (see below). |\n` +
    `| Everything else in \`projects/${projectKey}/\` - \`scenes/\`, \`settings/\`, \`layouts/\`, and anything not listed above | **Never touched.** This is yours. |\n\n` +
    `After every update, read \`DELIVERY-REPORT.md\` in the repository root. It is regenerated each time and lists, in German, what was updated, added and removed, which of your files were kept, and any changes of yours outside \`projects/\` that the update overwrote.\n\n` +
    `**When your version was kept.** The report names a file such as \`projects/${projectKey}/connect/project-config.json\` and, next to it, a second file with \`.vendor-<version>\` in its name - for example \`project-config.vendor-6.3.0.json\`. That is our new version, parked there unopened. Nothing about your file changed. To resolve it:\n\n` +
    `1. Compare the two files (\`git diff --no-index <yours> <the .vendor- one>\`).\n` +
    `2. Decide what to keep. Usually you want your change plus whatever we changed - merge by hand.\n` +
    `3. Delete the \`.vendor-<version>\` file and commit.\n\n` +
    `Leaving it in place is safe: later updates never overwrite or remove a \`.vendor-\` file, so nothing is lost if you get to it next week. But each conflicting update adds another one, so they accumulate until you clear them.\n\n` +
    `**A file you deleted on purpose is not restored.** If you removed one of our files, the update reports it and leaves it removed. Ask us if you want it back.\n\n` +
    `**The first update after August 2026 is a special case.** It establishes the baseline that all later updates compare against, so it deliberately changes nothing inside \`projects/${projectKey}/\` and instead reports which of our files are missing on your side. The update after it carries the actual changes. If you would rather not wait, tell us after reading that report and we will send the missing files immediately.\n\n` +
    `## Reference\n\n` +
    `### Features\n\n` +
    `Every delivery includes the AGPL core (${CORE_FEATURES.length} capabilities: drives, sensors, transport surfaces, sources and sinks, grippers, signals and PLC connectivity, HMI panels, camera presets, and PDF document linking). The categories below add to that core; they do not replace it.\n\n` +
    `**Licensed features** - tier-gated commercial and restricted features, enabled per your licence:\n\n` +
    `${licensedBlock}\n\n` +
    `**Your project** - your own code under \`projects/${projectKey}/plugins/\`, developed together with realvirtual:\n\n` +
    `${projectBlock}\n\n` +
    `See [FEATURES.md](FEATURES.md) for the detailed feature matrix and tier assignment.\n\n` +
    `### Editions\n\n` +
    `- **Community:** \`realvirtual-web/\` is the AGPL-licensed core, using the same licence and codebase as the public Community version. Release schedules are independent, so the public Community version can be newer or older than this delivered snapshot. For this delivery, \`delivery-manifest.json\` is authoritative for the version, commit, and changeset.\n` +
    `- **Professional/Commercial:** Additional commercial extensions in \`realvirtual-web-pro/\`. Their use requires a commercial licence.\n` +
    `- **Customer-specific development:** All code below \`projects/${projectKey}/\`. It is developed together with realvirtual; ownership and usage rights are governed by the customer contract.\n\n` +
    `### Your private workspace\n\n` +
    `This repository is a private repository in your organisation on \`git.realvirtual.io\`. Access is limited to invited accounts in your organisation, sign-in is required, and there is no anonymous read access. Other customers use separate organisations and cannot access this repository.\n\n` +
    `realvirtual operates the server on its own infrastructure in the EU, in a Hetzner data centre in Helsinki, rather than on US cloud services. Machine geometry, documentation, and project-specific code are stored in this private repository.\n\n` +
    `Each user receives an individual account. Two-factor authentication (2FA) is recommended. Access is assigned per person and can be revoked individually.\n\n` +
    (hasDiagnosis
      ? `The optional AI diagnosis in realvirtual CONNECT sends the current question and relevant excerpts from the documentation to an EU-hosted AI endpoint for processing. To avoid this processing, disable the diagnosis function by setting \`Diagnosis.Enabled=false\` in \`connect/project-config.json\`. All other workspace functions - the viewer, simulation, and models - run locally.\n\n`
      : `This delivery contains no AI diagnosis package, so nothing in this workspace sends questions or documentation to an AI endpoint. The viewer, simulation, and models run locally.\n\n`) +
    `### Appliance (optional)\n\n` +
    `For a machine that has to carry its own HMI at the plant, realvirtual can deliver an **appliance**: one dedicated box in the plant network that serves the HMI, the project Git repository, the recorded signal history and the realvirtual CONNECT gateway from a single secured address, without Internet access. It is optional, it is separate from this workspace, and this workspace stays where the project is developed. The appliance is still in development and is not released for production use. If it is part of your delivery, the \`appliance/\` folder ships with the workspace and [Set up the appliance](recipes/setup-appliance.md) is the runbook; if the folder is not there and you need it, ask [professional@realvirtual.io](mailto:professional@realvirtual.io).\n\n` +
    `### Updating realvirtual CONNECT\n\n` +
    `The newest stable release is always at the same two addresses. They are overwritten by every release, so they never need to be looked up again:\n\n` +
    `| What | Address |\n` +
    `| --- | --- |\n` +
    `| The program itself | \`https://web.realvirtual.io/download/realvirtual-Connect.exe\` |\n` +
    `| Its version and checksum | \`https://web.realvirtual.io/download/connect-latest.json\` |\n\n` +
    `There are three ways to take it, and none of them needs the Viewer or the development server to be running:\n\n` +
    `1. **From the workspace, no browser needed.** Run \`powershell -NoProfile -ExecutionPolicy Bypass -File .\\setup.ps1\` (Linux: \`./setup.sh\`) after a \`git pull\`, or fetch CONNECT alone with \`node tools/get-connect.mjs --latest\`. This reads the published version, downloads it, verifies its SHA-256 checksum, replaces \`tools/connect/realvirtual-Connect.exe\` atomically and records the new version in \`connect.lock.json\`. Nothing is replaced unless the checksum matches, so an interrupted download cannot leave a broken binary behind.\n` +
    `2. **From inside CONNECT.** Open the CONNECT options window in the Viewer. If a newer build is published it is offered by name, and confirming it replaces the program file and restarts. This is the same operation as above and also carries \`connect.lock.json\` along, but it needs the Viewer open, which is why it is the second option here.\n` +
    `3. **By hand.** Download the address in the table above and replace \`tools/connect/realvirtual-Connect.exe\` with it while CONNECT is not running. Use this if the machine has no route for the automated download.\n\n` +
    `CONNECT never updates itself unattended: it downloads nothing before a confirmation naming a specific build, and it does not check on startup whether a newer version exists. An update is always something you asked for, so a workspace keeps behaving exactly as it did yesterday until you decide otherwise.\n\n` +
    `Your project files are untouched by all three routes. Only the program file under \`tools/connect/\` changes.\n\n` +
    `### Going back to an earlier realvirtual CONNECT\n\n` +
    `If a new CONNECT version misbehaves, pin an earlier one instead of waiting for a fix:\n\n` +
    `1. Open \`connect.lock.json\` in the workspace root and set \`version\`, \`url\` and \`sha256\` to the earlier release. Ask [professional@realvirtual.io](mailto:professional@realvirtual.io) for the values if you do not have them.\n` +
    `2. Delete \`tools/connect/\` so the old binary is fetched again.\n` +
    `3. Run the preparation once: \`powershell -NoProfile -ExecutionPolicy Bypass -File .\\setup.ps1\` (Linux: \`./setup.sh\`).\n\n` +
    `Start the workspace as usual afterwards. A CONNECT that predates the built-in launcher cannot start the development server itself; the start script notices that and starts it separately, so the Viewer works either way.\n\n` +
    `### If the start hangs while installing the dependencies\n\n` +
    `The dependency installation writes about 73000 files and normally fetches around 700 packages from the public npm registry. Behind a company proxy, a TLS-inspecting gateway, or an on-access virus scanner this is the step that can stall for a very long time without any error message.\n\n` +
    `This workspace therefore ships a **dependency archive**: one file, verified by SHA-256, that replaces the whole registry download. The start script uses it automatically when \`dependencies.lock.json\` is present, and only falls back to \`npm ci\` if the archive is unavailable.\n\n` +
    `For a fully offline installation, or when the download itself is blocked, do it by hand:\n\n` +
    `1. Open \`dependencies.lock.json\` in the workspace root and copy the \`url\`.\n` +
    `2. Download that file on any machine with internet access, for example in a browser.\n` +
    `3. Put it, unrenamed, next to \`start.ps1\` in the workspace root.\n` +
    `4. Start the workspace again. The archive is verified against the \`sha256\` from \`dependencies.lock.json\` and unpacked into \`realvirtual-web/node_modules\`; nothing is fetched from the network.\n\n` +
    `The archive belongs to exactly one \`package-lock.json\` and one operating system, both recorded in \`dependencies.lock.json\`. After an update that changes the dependencies, the file name changes with it, so download the new one named in the updated \`dependencies.lock.json\`.\n\n` +
    `If your virus scanner is the bottleneck rather than the network, ask your IT department for a scan exclusion for the workspace folder. That single change usually turns a start of many minutes into one of a few.\n\n` +
    `## Troubleshooting\n\n` +
    `| Problem | Solution |\n` +
    `| --- | --- |\n` +
    `| \`npm\` or \`node\` is not recognized as a command | Node.js ${REQUIRED_NODE_MAJOR} LTS is not installed, or the terminal still uses the old PATH. Install it from [nodejs.org](https://nodejs.org/), then open a new terminal - in an IDE, restart the IDE - and check \`node --version\`. |\n` +
    `| \`start.ps1\` is not found | You are inside a subfolder. The start script is in the repository root, next to \`realvirtual-web/\`. Run \`cd ..\` until \`dir\` (Windows) or \`ls\` (Linux/macOS) shows \`start.ps1\`. |\n` +
    `| Company proxy or custom certificate authority | Set \`NODE_EXTRA_CA_CERTS\` to your corporate CA bundle before running npm. Do not disable TLS verification. |\n` +
    (hasDiagnosis
      ? `| \`connect/rag.zip\` is only a few KB | Git LFS was missing during the clone. Run \`git lfs install && git lfs pull\`. |\n`
      : `| A model file is only a few KB | Git LFS was missing during the clone. Run \`git lfs install && git lfs pull\`. |\n`) +
    `| Web or CONNECT port is already in use | On Windows, choose other ports with \`powershell -NoProfile -ExecutionPolicy Bypass -File .\\start.ps1 -WebPort 5174 -ConnectPort 5101\`. |\n` +
    `| "realvirtual CONNECT is already running for a different workspace" | Another workspace holds the CONNECT port. End it from its tray icon, or start this one on other ports as in the previous row. Starting a second instance on the same port would not work: the first one owns it. |\n` +
    `| The Viewer is empty and the tray says the development server failed | Open the tray icon, **realvirtual WEB > Show dev server log**. If it reports changed dependencies, run \`setup.ps1\` once. |\n` +
    `| CONNECT download fails | Ask your IT team to allow the firewall/proxy connection to \`web.realvirtual.io\`. |\n` +
    `| You still need help | Contact [professional@realvirtual.io](mailto:professional@realvirtual.io). |\n`;
}

//! Writes vendor-neutral workspace runbooks for people and AI assistants.
function writeWorkspaceRecipes(root, projectKey, model, coreRoot) {
  const recipesRoot = join(root, 'recipes');
  const customerModel = model || '<your-model>.glb';
  const modelStem = customerModel.replace(/\.glb$/i, '');
  mkdirSync(recipesRoot, { recursive: true });

  for (const name of STATIC_CORE_RECIPES) {
    const source = join(coreRoot, 'recipes', name);
    if (!existsSync(source)) throw new Error(`Static recipe missing from the core repo: ${source}`);
    copyFileSync(source, join(recipesRoot, name));
  }

  const recipes = {
    'README.md': `# Workspace recipes\n\n` +
      `These runbooks are the canonical instructions for recurring workspace tasks. Follow them directly with a person or any AI assistant; tool-specific slash commands are only short adapters.\n\n` +
      `## Recommended order\n\n` +
      `1. [Replace the machine model](replace-machine-model.md) - put the exported GLB for ${deliveryName(projectKey)} in the correct location and verify its scale, axes, and startup view.\n` +
      `2. [Kinematize and materialize a CAD import](kinematize-cad-import.md) - turn a raw STEP, JT, or GLB assembly into a named, grouped, materialized asset whose axes are proven to move.\n` +
      `3. [Connect live signals](connect-live-signals.md) - bind the GLB's \`rv_extras\` signals to realvirtual CONNECT with the correct PLC direction.\n` +
      `4. [Set up the InfluxDB historian](setup-influxdb-historian.md) - install customer-owned InfluxDB OSS v2, provision project buckets and a scoped token, configure CONNECT, and verify recorded data.\n` +
      `5. [Create a custom plugin](create-custom-plugin.md) - add customer-owned behavior with a minimal, disposable plugin lifecycle.\n` +
      `6. [Troubleshoot the runtime](troubleshoot-runtime.md) - isolate failures from asset path through browser, WebSocket, CONNECT, and proxy.\n` +
      `7. [Deploy the production web app](deploy-production-web.md) - publish the static build with correct routing, WebSocket, security, and cache controls.\n` +
      `8. [Set up the appliance](setup-appliance.md) - install the optional on-premise box that serves the HMI, the project Git repository, the signal history, and the gateway from one secured address in the plant network.\n`,

    'replace-machine-model.md': `# Replace the machine model\n\n` +
      `## Goal and outcome\n\nReplace the current \`${customerModel}\` model for project \`${projectKey}\` with a GLB exported from Unity. The result loads in the development server with the intended axes, units, and startup camera and without browser console errors.\n\n` +
      `## When to use\n\nUse this recipe after changing the machine in Unity or when introducing a different customer model.\n\n` +
      `## Prerequisites\n\n- realvirtual Professional in Unity with GLB export available.\n- Git and Git LFS installed; run \`git lfs install\` once per computer.\n- A clean export that includes the required realvirtual metadata.\n\n` +
      `## Steps\n\n1. In Unity, export the machine with the realvirtual Professional GLB export.\n2. Copy the GLB into the [project model directory](../projects/${projectKey}/models/). The generated \`.gitattributes\` tracks \`projects/*/models/*.glb\` with Git LFS.\n3. To replace \`${customerModel}\` without a configuration change, keep exactly the same filename.\n4. If the filename changes, set \`defaultModel\` to the new bare filename in [settings.json](../realvirtual-web/public/settings.json); do not add a directory prefix.\n5. Start the workspace with \`start.ps1\` (Linux: \`./start.sh\`) or the **realvirtual WEB dev** Start-menu entry, and open http://localhost:5100. Hard-reload the browser and confirm that the requested GLB, rather than a cached previous file, loads.\n6. Check the machine's X/Y/Z orientation, physical scale and units, and the initial camera framing. Correct the Unity export or startup-camera data if any of them are wrong.\n7. Review \`git status\` and confirm that the GLB is handled by Git LFS before committing it.\n\n` +
      `## Acceptance criteria\n\n- The model loads in the development server without browser console errors.\n- Axes, units, scale, and the startup camera are correct.\n- Git LFS tracks the GLB, and \`defaultModel\` is the bare filename of the delivered model.\n\n` +
      `## Rollback\n\nRestore the previous tracked file with \`git checkout -- projects/${projectKey}/models/${customerModel}\`. If you changed \`defaultModel\`, also restore \`realvirtual-web/public/settings.json\`, then restart the development server.\n\n` +
      `## Common problems\n\n- **404 for the GLB:** the filename or \`defaultModel\` does not match, including letter case.\n- **Only a small text pointer is present:** run \`git lfs pull\`.\n- **Wrong size or orientation:** fix the Unity unit/axis export settings and export again.\n- **Old geometry remains:** hard-reload and verify the requested model URL in the browser Network panel.\n\n` +
      `## Security and version notes\n\nA GLB shipped to an authorized browser user can be downloaded by that user. Do not include geometry or metadata that the recipient is not permitted to receive. Version meaningful model changes in Git; for deployments that cache models, prefer a new filename when cache invalidation must be explicit.\n\n` +
      `## Further reading\n\n- [Unity-to-WEB workflow](../realvirtual-web/doc-unity-to-web.md)\n- [realvirtual WEB overview](../realvirtual-web/doc-webviewer.md)\n`,

    'connect-live-signals.md': `# Connect live signals\n\n` +
      `## Goal and outcome\n\nConnect the signals embedded in \`${customerModel}\` to realvirtual CONNECT so live PLC values flow in the intended direction.\n\n` +
      `## When to use\n\nUse this recipe when commissioning a model against CONNECT, a PLC, or another configured realtime source.\n\n` +
      `## Prerequisites\n\n- The model loads locally and contains exported signal names in \`rv_extras\`.\n- The workspace's pinned CONNECT binary is installed by the start script.\n- Network and PLC access have been approved by the customer's IT/OT owners.\n\n` +
      `## Steps\n\n1. Start the workspace with [start.ps1](../start.ps1) on Windows. For a manual CONNECT start, run the workspace-local CONNECT binary with \`--project-root <workspace-root>\`; do not rely on a globally installed CLI.\n2. Open the model and inspect its exported \`rv_extras\` signal names. Use those exact names, including case, in CONNECT and PLC mappings.\n3. Apply the PLC direction convention: **PLC Outputs -> the Viewer reads**; **PLC Inputs -> the Viewer writes**.\n4. Open the Viewer ConnectPanel and verify that the gateway is reachable and the expected connection is selected.\n5. Set safe test values from the owning side of each signal. Confirm the value and type in the ConnectPanel or debug signal view, then confirm the visible machine response.\n6. Test at least one signal in each direction when the project supports both. Return all test values to a safe state.\n\n` +
      `## Acceptance criteria\n\n- The ConnectPanel reports a healthy connection.\n- Signal names, data types, and directions match \`rv_extras\`.\n- Safe test values reach the intended endpoint and produce the expected Viewer response.\n\n` +
      `## Rollback\n\nStop CONNECT or disconnect in the ConnectPanel, restore the previous CONNECT/PLC mapping, and return test signals to their documented safe values.\n\n` +
      `## Common problems\n\n- **Name mismatch:** compare exact GLB \`rv_extras\` names, including case and hierarchy.\n- **Type mismatch:** align Boolean, numeric, and string types on both sides.\n- **Wrong direction:** re-check PLC Output/Viewer-read and PLC Input/Viewer-write ownership.\n- **Gateway unreachable:** verify CONNECT is running, the configured URL/port is correct, and firewall or proxy rules allow the route.\n\n` +
      `## Security and version notes\n\nUse only approved test values and change-control procedures on live equipment. Do not expose CONNECT or PLC ports directly to the public Internet; use the customer-approved reverse proxy, VPN, or DMZ design. Keep the workspace's pinned CONNECT version unless an update is explicitly tested.\n\n` +
      `## Further reading\n\n- [Industrial interfaces and signal flow](../realvirtual-web/doc-webviewer-interface.md)\n- [Signal architecture](../realvirtual-web/doc-signal-architecture.md)\n`,

    'setup-influxdb-historian.md': `# Set up the InfluxDB historian\n\n` +
      `## Goal and outcome\n\nInstall a customer-owned InfluxDB OSS v2 instance, create isolated resources for project \`${projectKey}\`, connect realvirtual CONNECT with a least-privilege token, and prove that selected signal history appears in the Viewer.\n\n` +
      `CONNECT derives the bucket names from the project. There is no free-form Bucket field: project \`${projectKey}\` uses \`${projectKey}_raw\`, \`${projectKey}_1m\`, and \`${projectKey}_1h\`.\n\n` +
      `## When to use\n\nUse this recipe when a customer wants persistent signal trends on infrastructure they operate. It applies to local machines, an OT server, a customer VM, or a customer-approved private cloud. It does not depend on realvirtual infrastructure.\n\n` +
      `## Prerequisites\n\n- An x64 Windows or Linux host with persistent storage and an approved backup location.\n- Network approval between CONNECT and TCP port 8086 on the InfluxDB host. Do not expose port 8086 to the public Internet.\n- An InfluxDB OSS v2 operator token for one-time provisioning. Store it outside this Git workspace.\n- Node.js 18 or newer for the supplied provisioning helper.\n- A running workspace and at least one CONNECT signal that can be safely marked for recording.\n\n` +
      `## 1. Install InfluxDB OSS v2\n\n` +
      `Choose one customer-approved installation method. Record the exact InfluxDB v2 version in the deployment record and test upgrades before applying them.\n\n` +
      `### Docker or Docker Compose (recommended)\n\n` +
      `Use the official \`influxdb:2\` image or an explicitly approved v2 patch tag. Do not use \`latest\`, because it is not a stable promise of the v2 product line. Persist both \`/var/lib/influxdb2\` and \`/etc/influxdb2\`. Use Docker secrets for the initial username, password, and operator token; do not commit them to this repository.\n\n` +
      `In an IT-managed deployment folder outside this Git workspace, create three one-line secret files and the following \`compose.yaml\`. Replace \`<customer-org>\` and \`<secure-directory>\`; the secure directory must not be inside a Git checkout:\n\n` +
      `\`\`\`yaml\nservices:\n  influxdb:\n    image: influxdb:2\n    restart: unless-stopped\n    ports:\n      - "127.0.0.1:8086:8086"\n    volumes:\n      - influxdb-data:/var/lib/influxdb2\n      - influxdb-config:/etc/influxdb2\n    environment:\n      DOCKER_INFLUXDB_INIT_MODE: setup\n      DOCKER_INFLUXDB_INIT_USERNAME_FILE: /run/secrets/admin-user\n      DOCKER_INFLUXDB_INIT_PASSWORD_FILE: /run/secrets/admin-password\n      DOCKER_INFLUXDB_INIT_ADMIN_TOKEN_FILE: /run/secrets/operator-token\n      DOCKER_INFLUXDB_INIT_ORG: <customer-org>\n      DOCKER_INFLUXDB_INIT_BUCKET: bootstrap\n    secrets:\n      - admin-user\n      - admin-password\n      - operator-token\n    healthcheck:\n      test: ["CMD", "influx", "ping", "--host", "http://localhost:8086"]\n      interval: 10s\n      timeout: 5s\n      retries: 10\nsecrets:\n  admin-user:\n    file: <secure-directory>/influx-admin-user.txt\n  admin-password:\n    file: <secure-directory>/influx-admin-password.txt\n  operator-token:\n    file: <secure-directory>/influx-operator-token.txt\nvolumes:\n  influxdb-data:\n  influxdb-config:\n\`\`\`\n\n` +
      `Start and inspect it with \`docker compose up -d\` and \`docker compose ps\`. The \`bootstrap\` bucket only completes first-time setup; the helper below creates the historian buckets.\n\n` +
      `Bind \`127.0.0.1:8086:8086\` when CONNECT runs on the same host. If CONNECT runs on another host, bind only an approved LAN/VLAN address and restrict TCP 8086 at the firewall to the CONNECT host. Start the service, then verify \`http://<influx-host>:8086/health\` from the CONNECT network.\n\n` +
      `Official setup reference: [Install InfluxDB v2 with Docker Compose](https://docs.influxdata.com/influxdb/v2/install/use-docker-compose/).\n\n` +
      `### Windows binary\n\n` +
      `Download the current approved InfluxDB OSS v2 Windows AMD64 archive and its signature from InfluxData, verify the signature, extract it under \`C:\\Program Files\\InfluxData\\\`, and start \`influxd\` from that folder. Complete the initial setup at \`http://localhost:8086\`. For unattended production, register it with the customer-approved Windows service manager and run it under a dedicated low-privilege service account. Allow only the required private-network firewall scope.\n\n` +
      `\`\`\`powershell\nExpand-Archive .\\influxdb2-<version>-windows_amd64.zip -DestinationPath 'C:\\Program Files\\InfluxData\\'\nSet-Location 'C:\\Program Files\\InfluxData\\influxdb2-<version>-windows_amd64'\n.\\influxd.exe\n\`\`\`\n\n` +
      `Official setup reference: [Install InfluxDB OSS v2](https://docs.influxdata.com/influxdb/v2/install/).\n\n` +
      `## 2. Provision project buckets, tasks, and token\n\n` +
      `The supplied [provisioning helper](../tools/provision-influx.mjs) has no customer, organization, project, URL, or credential defaults. It creates the organization when absent, these fixed-retention buckets, a CONNECT token scoped to write raw data and read all three buckets, and dedicated downsampling tasks:\n\n` +
      `| Bucket | Retention | Purpose |\n| --- | ---: | --- |\n| \`${projectKey}_raw\` | 7 days | Deadband- and interval-filtered CONNECT samples |\n| \`${projectKey}_1m\` | 365 days | One-minute means |\n| \`${projectKey}_1h\` | 3650 days | One-hour means |\n\n` +
      `Run from the workspace root. The operator token is read only from the process environment so it does not appear in the command line:\n\n` +
      `\`\`\`powershell\n$env:RV_INFLUX_ADMIN_TOKEN = '<operator-token-from-secret-vault>'\nnode tools/provision-influx.mjs --url 'http://<influx-host>:8086' --org '<customer-org>' --project '${projectKey}'\nRemove-Item Env:RV_INFLUX_ADMIN_TOKEN\n\`\`\`\n\n` +
      `On Linux or macOS, set the same environment variable only for the command process:\n\n` +
      `\`\`\`bash\nRV_INFLUX_ADMIN_TOKEN='<operator-token-from-secret-vault>' node tools/provision-influx.mjs \\\n  --url 'http://<influx-host>:8086' --org '<customer-org>' --project '${projectKey}'\n\`\`\`\n\n` +
      `Copy the returned \`connectToken\` directly into the CONNECT settings, store it in the customer secret vault, and clear the terminal when required by local policy. Never use the operator token in CONNECT. InfluxDB returns a token value only when it is created. A repeat run keeps existing resources and cannot recover their token. Use \`--rotate-token\` only for an intentional revocation and replacement; update CONNECT immediately afterward.\n\n` +
      `## 3. Configure CONNECT\n\n` +
      `1. Start the workspace and connect the Viewer to its workspace-owned CONNECT gateway.\n2. Open **CONNECT Settings -> Historian (InfluxDB)** in the Viewer.\n3. Enter the exact \`URL\`, \`Org\`, and lowercase \`Project\` used above, paste the returned project-scoped token, enable **Record flagged signals to InfluxDB**, and select **Save**.\n4. Confirm the status changes to **Recording to ${projectKey}_raw**. The token is write-only: CONNECT stores it server-side and never returns it through \`GET /config\`. Leaving the token field empty on a later save keeps the stored token.\n\n` +
      `For unattended configuration, the equivalent CONNECT block is shown below. It belongs to CONNECT's persisted \`connect-config.json\`, not to the browser's \`settings.json\` and not to \`connect/project-config.json\`:\n\n` +
      `\`\`\`json\n{\n  "InfluxDb": {\n    "Enabled": true,\n    "Url": "http://<influx-host>:8086",\n    "Org": "<customer-org>",\n    "Project": "${projectKey}",\n    "Token": "<project-scoped-connect-token>"\n  }\n}\n\`\`\`\n\n` +
      `On Windows the default file is \`C:\\ProgramData\\realvirtual\\CONNECT\\connect-config.json\`; on Linux it is \`$XDG_CONFIG_HOME/realvirtual/CONNECT/connect-config.json\` or \`~/.config/realvirtual/CONNECT/connect-config.json\`. Stop CONNECT before hand-editing the file, preserve all existing top-level fields, make a backup, and restart CONNECT afterward. Prefer the Viewer settings UI for a running gateway.\n\n` +
      `## 4. Select signals and verify data\n\n` +
      `1. In the CONNECT signal list, use the record action on one safe numeric or Boolean signal. Only signals with persisted \`Record: true\` are written. Non-numeric/string signals are skipped.\n2. Change the signal safely or wait for the default unchanged-value heartbeat.\n3. Open \`http://127.0.0.1:5100/history/status\` (adjust the CONNECT host/port) and verify \`enabled: true\`, \`connected: true\`, bucket \`${projectKey}_raw\`, a non-null \`lastWriteUtc\`, and \`authError: false\`. If CONNECT uses an API key, send the same \`X-API-Key\` header rather than placing the key in a URL.\n4. Open the Viewer **Historian** panel, select the recorded signal, choose **1h**, and confirm that samples appear.\n5. Optionally verify in the InfluxDB Data Explorer: measurement \`plc_signals\`, field \`value\`, project tag \`${projectKey}\`, and the exact signal-name tag. Use CONNECT for normal Viewer queries; never put an InfluxDB token in browser code or \`settings.json\`.\n\n` +
      `## Acceptance criteria\n\n- The three project buckets have exactly 7-day, 365-day, and 3650-day retention.\n- CONNECT uses the project-scoped token, reports connected status, and writes only signals with \`Record: true\`.\n- \`lastWriteUtc\` advances and \`droppedPoints\` does not grow during normal operation.\n- The Viewer Historian panel displays the selected signal without a token in browser storage or requests.\n- Firewall, backup, retention, monitoring, and token custody are recorded in the customer deployment documentation.\n\n` +
      `## Retention, disk, and backup\n\n` +
      `Retention limits data lifetime but does not replace capacity planning or backup. Actual disk usage depends on the number of recorded signals, change rate, deadband, compression, and tag values. Measure the volume after a representative production week, project peak growth, keep customer-defined reserve space, and alert before the volume is close to full. Review CONNECT's \`MinIntervalMs\`, \`MaxIntervalMs\`, and \`FloatDeadbandPercent\` only from measured requirements; reducing intervals can multiply write volume.\n\n` +
      `Back up both InfluxDB data and metadata with a customer-approved InfluxDB v2 backup/restore procedure, store backups outside the live volume, encrypt them according to policy, and perform a restore test. Retention deletion in InfluxDB does not delete independent backups; apply the agreed backup-retention and deletion policy separately.\n\n` +
      `## Rollback\n\nDisable **Record flagged signals to InfluxDB** in CONNECT Settings first. Keep the database and scoped token until the rollback decision is confirmed. To revert only CONNECT, restore the previous \`InfluxDb\` block or set \`Enabled\` to \`false\`. Token rotation is not reversible: create a new token and update CONNECT if the old one was revoked. Delete buckets only under an approved data-deletion procedure with backup impact understood.\n\n` +
      `## Common problems\n\n- **Status says auth error:** the token is wrong, revoked, or lacks raw-write/all-bucket-read permission. Run the helper with \`--rotate-token\` only if deliberate rotation is acceptable.\n- **Connected but \`lastWriteUtc\` is null:** no configured signal has \`Record: true\`, the signal has no current numeric/Boolean value, or no initial snapshot reached the writer yet.\n- **Raw data exists but long ranges are empty:** check the two tasks and their last-run error, plus read/write permission on \`_raw\`, \`_1m\`, and \`_1h\`.\n- **Bucket mismatch:** CONNECT lowercases and validates Project, then derives bucket names; there is no separate Bucket setting. Use the exact project returned by the helper.\n- **InfluxDB is reachable locally only:** check the bind address, firewall, routing, TLS certificate, and proxy policy from the CONNECT host.\n- **Disk grows faster than expected:** review the recorded-signal count, change rate, heartbeat, deadband, task health, and retention values before adding capacity.\n\n` +
      `## Security and version notes\n\nKeep the operator token out of CONNECT, Git, shell history, screenshots, support bundles, and browser-visible files. Give CONNECT only the helper-created project token. Prefer TLS when traffic leaves one trusted host; terminate TLS according to customer IT policy. Pin or approve a v2 image/binary version and test backup restore, token provisioning, task execution, CONNECT writes, and Viewer queries before every upgrade.\n\n` +
      `## Further reading\n\n- [InfluxDB OSS v2 installation](https://docs.influxdata.com/influxdb/v2/install/)\n- [InfluxDB v2 HTTP API](https://docs.influxdata.com/influxdb/v2/api/)\n- [Troubleshoot the runtime](troubleshoot-runtime.md)\n`,

    'deploy-production-web.md': `# Deploy the production web app\n\n` +
      `## Goal and outcome\n\nBuild and host the customer-managed static realvirtual WEB application at its real production URL with secure CONNECT communication and predictable caching.\n\n` +
      `## When to use\n\nUse this recipe when customer IT deploys the Viewer to an intranet, DMZ, private cloud, or approved public web host.\n\n` +
      `## Prerequisites\n\n- A tested model and workspace.\n- A customer-owned HTTPS host or reverse proxy configuration.\n- An approved network path from each user's browser to CONNECT.\n- Customer IT/OT approval for authentication, firewall, VPN/DMZ, retention, and monitoring.\n\n` +
      `## Steps\n\n1. From \`realvirtual-web/\`, run \`npm run build\`. Deploy the generated \`dist/\` directory as static content.\n2. If the app is hosted below a URL subpath, set Vite's \`base\` in [vite.config.ts](../realvirtual-web/vite.config.ts) to that public subpath before building. Configure the web server's SPA fallback so unknown application routes return \`index.html\`.\n3. Serve production over HTTPS. An HTTPS page must connect to CONNECT with \`wss://\`, not insecure \`ws://\`. Configure WebSocket Upgrade headers and proxy read/idle timeouts long enough for persistent sessions and reconnects.\n4. Prefer same-origin routing for the static app, REST endpoints, and WebSocket endpoint. If cross-origin routing is required, configure an explicit CORS allowlist and a CSP whose \`connect-src\` permits only the required HTTPS/WSS endpoints.\n5. Protect the REST and WebSocket endpoints with the same authorization boundary as the application. Authentication on only the HTML page is insufficient.\n6. Set short or revalidation-based caching for \`index.html\` and \`settings.json\`. Cache content-hashed assets for a long time with immutable caching. Version GLB filenames when model cache invalidation must be reliable.\n7. Configure correct MIME types for JavaScript, WebAssembly, and GLB files (for example \`text/javascript\`, \`application/wasm\`, and \`model/gltf-binary\`) and enable Brotli or gzip compression where supported. Avoid recompressing already compressed content when it provides no benefit.\n8. Test the real production URL from the same network and browser profile used by operators. Perform a hard reload, open a nested/subpath URL, verify WebSocket reconnect, and verify the user-visible behavior while CONNECT is unavailable and after it returns.\n\n` +
      `## Acceptance criteria\n\n- \`npm run build\` succeeds and the deployed \`dist/\` loads at the real URL.\n- Hard reload and SPA routing work under the configured base/subpath.\n- HTTPS/WSS, authentication, CSP/CORS, and reverse-proxy Upgrade/timeouts behave as intended.\n- The Viewer reconnects after a WebSocket interruption and handles a CONNECT outage without exposing unsafe controls.\n\n` +
      `## Rollback\n\nKeep the previous immutable \`dist/\` release. Switch the web-server release pointer back, restore the previous proxy/configuration revision, purge only the affected entry-point cache, and repeat the production smoke test.\n\n` +
      `## Common problems\n\n- **Blank page under a subpath:** the Vite \`base\` or asset URLs do not match the deployed path.\n- **404 after a hard reload:** the SPA fallback to \`index.html\` is missing.\n- **WebSocket fails behind the proxy:** Upgrade headers, \`wss://\`, authentication forwarding, or timeouts are wrong.\n- **Stale model/settings:** cache rules are too long for mutable files or the GLB filename was reused behind an immutable cache.\n- **Browser reaches the site but not CONNECT:** a public CDN cannot automatically reach an OT network; the user's browser must have a permitted route to CONNECT.\n\n` +
      `## Security and version notes\n\n- **Never put secrets in \`VITE_*\` variables or \`settings.json\`.** Vite values and settings are delivered to the browser and can be read from the bundle or network responses. Keep secrets in a protected server-side component.\n- Do not expose CONNECT or PLC ports directly to the public Internet. Use a customer-approved reverse proxy, VPN, or DMZ and obtain customer IT/OT approval.\n- Authentication must protect REST and WebSocket traffic, not only the HTML page.\n- A public CDN cannot automatically reach an OT network. The user's browser must be able to reach CONNECT through the approved route.\n- A GLB delivered to an authorized user is downloadable by that user; hosting authorization controls access but cannot make delivered geometry non-extractable.\n- Record the delivered workspace/version and the proxy/static-host configuration with each release.\n\n` +
      `## Further reading\n\n- [Workspace settings](../realvirtual-web/public/settings.json)\n- [Runtime debugging](troubleshoot-runtime.md)\n`,

    'create-custom-plugin.md': `# Create a custom plugin\n\n` +
      `## Goal and outcome\n\nAdd customer-owned behavior for \`${modelStem}\` under \`projects/${projectKey}/plugins/\`, with a minimal \`init\`/\`dispose\` lifecycle and a visible result in the Viewer.\n\n` +
      `## When to use\n\nUse this recipe for project-specific UI, behavior, event handling, or visualization that should travel with the customer project.\n\n` +
      `## Prerequisites\n\n- The model loads in the running workspace at http://localhost:5100.\n- Read the plugin lifecycle and model-specific registration sections linked below.\n- Decide what visible, reversible behavior proves that the plugin is active.\n\n` +
      `## Steps\n\n1. Create a TypeScript or TSX plugin file in the [project plugin directory](../projects/${projectKey}/plugins/). Keep the plugin small and give it a unique \`id\`.\n2. Implement the minimum lifecycle: use \`init(viewer, context)\` to register visible UI/behavior or subscriptions, and \`dispose()\` to unregister listeners and release every resource created by the plugin.\n3. Add or update \`projects/${projectKey}/plugins/index.ts\`: list the matching model name \`${modelStem}\`, create the plugin in \`registerModelPlugins\`, and remove it by ID in \`unregisterModelPlugins\`.\n4. Restart the development server. Project plugin entry points are discovered through a Vite auto-discovery glob, so adding or renaming an entry file is not reliably picked up without a restart.\n5. Confirm the plugin's visible UI, marker, or behavior appears only for the intended model and disappears cleanly after model switch/unload.\n6. From \`realvirtual-web/\`, run \`npx tsc --noEmit\`, then \`npm run build\`.\n\n` +
      `## Acceptance criteria\n\n- \`npx tsc --noEmit\` and \`npm run build\` both succeed.\n- The plugin has a visible intended effect for \`${modelStem}\`.\n- Repeated model load/unload does not duplicate UI, listeners, or scene objects.\n\n` +
      `## Rollback\n\nRemove the plugin registration first, restart the development server, then delete the plugin file. Use Git to restore the previous \`projects/${projectKey}/plugins/\` state if necessary.\n\n` +
      `## Common problems\n\n- **Plugin never appears:** restart the dev server and verify the model name exported by \`models\` matches the GLB filename without \`.glb\`.\n- **TypeScript import errors:** use paths relative to the customer workspace layout and follow existing project plugins.\n- **Duplicate behavior after reload:** ensure \`unregisterModelPlugins\` removes the plugin and \`dispose()\` releases subscriptions/resources.\n- **Build passes but nothing is visible:** add a bounded visible acceptance signal such as a UI slot, then verify it in the intended model.\n\n` +
      `## Security and version notes\n\nDo not add AGPL headers to code under \`projects/${projectKey}/\`; customer code is governed by the customer contract. Do not put credentials, tokens, or private endpoints in browser plugin source. Treat plugin API changes as versioned workspace changes and re-run both checks after delivery updates.\n\n` +
      `## Further reading\n\n- [Extending realvirtual WEB](../realvirtual-web/doc-extending-webviewer.md)\n- [Scripting](../realvirtual-web/doc-scripting.md)\n`,

    'troubleshoot-runtime.md': `# Troubleshoot the runtime\n\n` +
      `## Goal and outcome\n\nLocate a runtime failure at the first broken boundary: asset path -> GLB -> browser console -> WebSocket -> CONNECT -> reverse proxy.\n\n` +
      `## When to use\n\nUse this recipe when the model, live data, controls, or production connection does not behave as expected.\n\n` +
      `## Prerequisites\n\n- Reproduce the issue with a timestamp and expected result.\n- Keep browser DevTools available.\n- Know whether the test is local, same-origin production, or cross-origin production.\n\n` +
      `## Steps\n\n1. **Asset path:** check \`defaultModel\` in [settings.json](../realvirtual-web/public/settings.json), then verify the model request URL/status in the browser Network panel.\n2. **GLB:** confirm the response is a real GLB rather than an LFS pointer, login page, or proxy error. Verify that the GLB contains expected \`rv_extras\` names and loads without parser errors.\n3. **Browser console:** reload with DevTools open. Resolve the first relevant error before secondary failures; use \`http://localhost:5100/__api/debug\` for a read-only runtime snapshot (reachable from this machine only).\n4. **WebSocket:** inspect the connection URL, \`ws://\` versus \`wss://\`, handshake status, close code, reconnect behavior, and frames.\n5. **CONNECT:** verify the workspace-owned CONNECT process is healthy, started with \`--project-root <workspace-root>\`, and exposes the expected signals/types/directions.\n6. **Reverse proxy:** if local operation works, inspect DNS/TLS, base/subpath routing, WebSocket Upgrade headers, authorization forwarding, CORS/CSP, and idle/read timeouts.\n7. Re-test one boundary at a time and record the first failing request, error, or status with secrets removed.\n\n` +
      `## Acceptance criteria\n\n- The first failing boundary is identified with reproducible evidence.\n- The fix is verified at that boundary and through the full user flow.\n- Browser console and debug state contain no new relevant errors.\n\n` +
      `## Rollback\n\nRestore the last known-good model, settings, workspace revision, or proxy configuration for the identified boundary. Restart only the workspace-owned processes and repeat the same reproduction.\n\n` +
      `## Common problems\n\n- **Model request returns HTML:** authentication or SPA fallback intercepted the GLB URL.\n- **GLB is only a small text file:** Git LFS content was not pulled.\n- **Mixed-content error:** an HTTPS page attempted \`ws://\`; use \`wss://\`.\n- **Handshake succeeds locally only:** proxy Upgrade/auth/CSP/CORS or the browser-to-OT route is missing.\n- **Signals connect but do not move the model:** check exact name, type, and PLC direction against \`rv_extras\`.\n\n` +
      `## Security and version notes\n\nRemove tokens, customer data, and machine geometry from shared logs or screenshots. Prefer read-only inspection before changing signal values or processes. Record browser, workspace, CONNECT, and proxy versions because behavior can differ between delivered snapshots.\n\n` +
      `## Further reading\n\n- [WEB debugging guide](../realvirtual-web/doc-web-debugging.md)\n- [Industrial interfaces](../realvirtual-web/doc-webviewer-interface.md)\n`,

    // The appliance ships from the commercial tier only, and the recipe generator has no tier
    // input (writeWorkspaceRecipes takes none, and adding one is plan-372 P5, not this change).
    // The recipe therefore states its own precondition in its first sentence instead of being
    // filtered out: a core-tier reader learns in one line that the folder is not part of their
    // delivery, which is more useful than a silently missing runbook.
    'setup-appliance.md': `# Set up the appliance\n\n` +
      `## Goal and outcome\n\nThis recipe requires the \`appliance/\` folder, which ships from the commercial tier. If it is not in your workspace, this recipe does not apply to your delivery; ask realvirtual whether the appliance is part of your contract.\n\n` +
      `Install the appliance on one dedicated box in the plant network so that project \`${projectKey}\` is served from a single secured HTTPS address: the HMI with \`${customerModel}\`, the project Git repository, the recorded signal history, and the realvirtual CONNECT gateway. Any panel PC or tablet on the same network reaches all of it through that one address, without Internet access.\n\n` +
      `**The appliance is still in development and is not released for production use.** Backup and restore do not exist yet, and the complete Windows installation run has not been performed on a fresh machine. Treat an installation as a pilot on hardware you are able to rebuild.\n\n` +
      `## When to use\n\nUse this recipe when the machine has to carry its own HMI at the plant: no Internet, no engineering workstation in the loop, and the project repository plus the signal history stay on customer premises for the life of the machine. Do not use it for a developer workstation; there the normal workspace start scripts are the right tool.\n\n` +
      `## Prerequisites\n\n` +
      `- **A dedicated box** in one of two topologies. **Windows:** Windows 11 22H2 or newer (build 22621 or higher) with hardware virtualization enabled; CONNECT runs natively on Windows and the remaining services run in Docker inside WSL2. Older Windows releases are ruled out, because without WSL2 mirrored networking there is no route at all from a container to the gateway on the host. **Linux:** x64 with root access, systemd, Docker Engine 24 or newer, and Compose v2; everything runs on the same host.\n` +
      `- **A completely clean system.** The installer refuses to continue when it finds an existing WSL distribution, an existing \`.wslconfig\`, or any Docker installation - including an installed but stopped one, and in particular Docker Desktop, which brings its own WSL distributions and its own network configuration. This is deliberate and there is no switch that skips it. Use a dedicated machine, or remove those installations by hand first.\n` +
      `- **A static host address**, or a DHCP reservation you can name on the command line. The address is written into two independent places, so a silent change disables the appliance; the installer stops rather than accept an unreserved lease.\n` +
      `- **Free TCP ports 80, 443, and 5100**, at least 20 GB of free disk, and a correct system clock.\n` +
      `- **Two names that resolve on the operator devices:** the appliance host name, and \`influx.<host>\` as a second name in DNS or in the local hosts file.\n` +
      `- The built HMI as a \`dist.zip\` archive, and the \`appliance/\` folder from this workspace, copied to the box.\n` +
      `- Customer IT/OT approval for the network paths, for the certificate route, and for who is given the sign-in.\n\n` +
      `## Steps\n\n` +
      `1. Copy the \`appliance/\` folder and \`dist.zip\` to the box, for example to \`C:\\rv-appliance\` on Windows or \`/opt/rv-appliance\` on Linux. Keep the folder together; the scripts expect their neighbours.\n` +
      `2. Run the preflight first. It changes nothing and reports every blocker at once. On Windows: \`powershell -NoProfile -ExecutionPolicy Bypass -File .\\setup-appliance.ps1 -ApplianceHost <host> -Project ${projectKey} -PreflightOnly\`. On Linux: \`sudo ./install.sh --host <host> --project ${projectKey} --preflight-only\`. Clear every finding before continuing.\n` +
      `3. Install. On Windows, from an administrator PowerShell: \`powershell -NoProfile -ExecutionPolicy Bypass -File .\\setup-appliance.ps1 -ApplianceHost <host> -Project ${projectKey} -SeedRelease <path-to-dist.zip>\`. If it ends with exit code 3010, restart the machine and repeat the same call with \`-Resume\` added. On Linux: \`sudo ./install.sh --host <host> --project ${projectKey} --seed-release <path-to-dist.zip>\`. Both routes are repeatable: a second run changes nothing that is already correct, and an existing configuration file with the generated secrets is never overwritten.\n` +
      `4. **Write down the operator password.** The installer prints it once, at the end, and stores it nowhere. There is a second, non-interactive account for the health checks; you do not need it for daily use.\n` +
      `5. Make the operator devices trust the certificate. If the customer has its own certificate authority, install a certificate from that authority instead and skip the rest of this step - then no device needs any change at all. Otherwise take the root certificate from the installer output, a USB stick, or a group policy, compare the fingerprint printed by the installer, and install it per device. The download link in the appliance dashboard is a convenience for a device that already trusts the appliance, not the way to establish that trust. Firefox keeps its own certificate store, and iPadOS additionally requires **Settings > General > About > Certificate Trust Settings**.\n` +
      `6. Publish both names, the appliance host name and \`influx.<host>\`, in the customer DNS or in the hosts files of the operator devices.\n` +
      `7. Verify from a **different** device on the same network: the appliance address must ask for sign-in and then show the HMI; \`/appliance/\` must show the service dashboard with the HMI, Git, history, and gateway tiles; \`/git/\` must show the Git sign-in; \`/connect/health\` must report an ok status; and \`https://influx.<host>/\` must show the InfluxDB user interface.\n` +
      `8. Record in the handover document that the address must stay static, who holds the operator password, which data volumes carry the project repository and the history, and that no backup procedure exists yet.\n\n` +
      `## Acceptance criteria\n\n` +
      `- Every route answers 401 without credentials, measured from another device, including \`/appliance/\`. Anything else means the access protection is not working.\n` +
      `- After a restart of the box, and without anyone signing in to it, the address answers again.\n` +
      `- The dashboard under \`/appliance/\` reports the HMI, Git, history, and gateway as reachable.\n` +
      `- The InfluxDB user interface answers at \`https://influx.<host>/\`.\n` +
      `- Operator devices open the appliance without a certificate warning.\n\n` +
      `## Rollback\n\nRun the uninstaller in the appliance folder. By default it removes the services and containers and **keeps the data volumes**, so a later installation finds the project repository, the history, and the certificate authority unchanged. Removing the volumes is a separate, explicit option that requires a typed confirmation. On Windows, the Windows-side parts - the two autostart tasks, the firewall rule, the WSL distribution, and \`.wslconfig\` - are removed in the order given by the runbook inside the appliance folder. Going back to the workstation route needs nothing from the appliance: start the workspace as usual.\n\n` +
      `## Common problems\n\n` +
      `- **The HMI shows 404 while every other route works:** no release was imported. Import the \`dist.zip\` and switch the current release.\n` +
      `- **The InfluxDB user interface is blank or 404 below the appliance address:** that user interface does not work below a subpath, which is why it has its own name. Open \`https://influx.<host>/\` and make sure the name resolves. The health and API routes of InfluxDB remain on the main address.\n` +
      `- **The browser warns about the certificate:** the root certificate is not installed on that device, or on iPadOS it is installed but not yet trusted in Certificate Trust Settings.\n` +
      `- **The installer stops in the preflight:** the system is not clean, the address is not static, or a port is taken. Fix the reported cause; the check cannot be skipped.\n` +
      `- **The appliance was reachable and then stopped being reachable:** check whether the host address changed. Nothing reconciles it, and the failure looks unrelated.\n` +
      `- **Sign-in fails although the password is correct:** credentials were edited by hand. Use the rotation script in the appliance folder, which also recreates the proxy container - a running proxy keeps the values it started with.\n\n` +
      `## Security and version notes\n\n` +
      `- **One authenticated origin, without role separation.** Whoever signs in can do everything the gateway can do, including writing signals. There is no operator role that only reads, and none may be promised to the customer.\n` +
      `- **There is no rate limit on sign-in attempts.** The appliance relies on being inside the plant network behind its firewall rule.\n` +
      `- The gateway port is opened only for the box itself and the container network. Never widen that rule to the local subnet or to any address.\n` +
      `- The operator password exists only on paper after the installation. The machine account and the generated secrets live in a file readable by the administrator only; never copy it into Git, a support bundle, or a screenshot.\n` +
      `- **There is no backup and no restore yet.** If the data volumes are lost, the project repository, the recorded history, and the certificate authority are lost with them - and losing the certificate authority means every operator device has to trust a new one. Until the procedure exists, protect the box at the virtual-machine or disk level.\n` +
      `- Record the appliance version, the container image versions, and the imported release with each installation, and test an update on a rebuildable machine before applying it at a customer site.\n\n` +
      `## Further reading\n\n- [Set up the InfluxDB historian](setup-influxdb-historian.md)\n- [Deploy the production web app](deploy-production-web.md)\n- [Troubleshoot the runtime](troubleshoot-runtime.md)\n`,
  };

  for (const [name, content] of Object.entries(recipes)) {
    writeFileSync(join(recipesRoot, name), content);
  }
}

function deliveryName(projectKey) {
  return `project \`${projectKey}\``;
}

function generateContributing(projectKey) {
  return `# Contributing\n\nCustomer changes belong only in \`projects/${projectKey}/\` and are submitted through a reviewed pull request.\n\n` +
    `By submitting a contribution, you confirm that you may provide it and grant realvirtual GmbH the rights required to maintain, merge, license, and redistribute it as part of the delivered product. This clause is a placeholder pending legal review and must be replaced before the first customer contribution.\n`;
}

// plan-363 Phase 6 — setup.ps1/setup.sh prepare, start.ps1/start.sh only start.
//
// The split is the point of the phase. Preparation (Node check, dependency restore, CONNECT
// download) is what a workspace needs after a clone or a `git pull`; starting is what it needs
// every day, and that moved into CONNECT itself. Keeping the preparation in a script named
// `start` would have left a script one no longer needs in order to start - a built-in confusion.
//
// SETUP MUST NEVER START CONNECT. CONNECT points the operator at setup when the dependencies moved
// on, so a setup that started CONNECT would be a loop with a 225 MB download in it.

function generateSetupPowerShell(hasDiagnosis = true) {
  return `# Prepares this workspace: Node check, dependencies, realvirtual CONNECT.\n` +
    `#\n` +
    `# It deliberately starts NOTHING. Use start.ps1, or the "realvirtual WEB dev" entry in the Start\n` +
    `# menu, to run the workspace. realvirtual CONNECT points here when the dependencies have moved on,\n` +
    `# so a preparation that also started CONNECT would call itself.\n` +
    `$ErrorActionPreference = 'Stop'\n$workspace = Split-Path -Parent $MyInvocation.MyCommand.Path\n` +
    // Preflight: without Node.js the script would fail deep inside `npm ci` with a bare
    // "npm is not recognized" from PowerShell, which tells a first-time user nothing.
    `if (-not (Get-Command node -ErrorAction SilentlyContinue) -or -not (Get-Command npm -ErrorAction SilentlyContinue)) {\n` +
    `  Write-Host 'Node.js ${REQUIRED_NODE_MAJOR} LTS is required to prepare this workspace, but node/npm were not found.'\n` +
    `  Write-Host 'Install it from https://nodejs.org (LTS ${REQUIRED_NODE_MAJOR}, Windows Installer, keep the PATH option enabled),'\n` +
    `  Write-Host 'or run: winget install OpenJS.NodeJS.LTS'\n` +
    `  Write-Host 'Then close this terminal - in an IDE, close the IDE itself - open a new one so PATH is refreshed, and run setup.ps1 again.'\n` +
    `  exit 1\n}\n` +
    `$nodeMajor = [int](((& node --version).Trim()).TrimStart('v').Split('.')[0])\n` +
    `if ($nodeMajor -lt ${REQUIRED_NODE_MAJOR}) {\n` +
    `  Write-Host "Node.js $nodeMajor was found, but this workspace requires version ${REQUIRED_NODE_MAJOR} or newer (see .nvmrc)."\n` +
    `  Write-Host 'Install the current LTS from https://nodejs.org, then open a new terminal and run setup.ps1 again.'\n` +
    `  exit 1\n}\n` +
    `if ($nodeMajor -gt ${REQUIRED_NODE_MAJOR}) { Write-Host "Note: Node.js $nodeMajor is newer than the delivered version ${REQUIRED_NODE_MAJOR}. If the start fails, install Node.js ${REQUIRED_NODE_MAJOR} LTS." }\n` +
    `Write-Host ''\nWrite-Host 'realvirtual WEB workspace - preparation' -ForegroundColor Cyan\n` +
    `Write-Host "[1/3] Node.js $nodeMajor detected."\n` +
    `$core = Join-Path $workspace 'realvirtual-web'\n` +
    // The shared identity and fingerprint rules. Without them the preparation could still install,
    // but it could not record a fingerprint CONNECT recognises - so it says so instead of writing
    // something the other side will read as "changed" on every start.
    `$launcher = Join-Path $workspace 'tools/rv-launcher.ps1'\n` +
    `if (Test-Path $launcher) { . $launcher } else { Write-Host '      Note: tools/rv-launcher.ps1 is missing, so the dependency state cannot be recorded.' }\n` +
    `$fingerprint = if (Get-Command Get-RvDependencyFingerprint -ErrorAction SilentlyContinue) { Get-RvDependencyFingerprint -WebRoot $core } else { $null }\n` +
    `$recorded = if (Get-Command Get-RvRecordedDependencyFingerprint -ErrorAction SilentlyContinue) { Get-RvRecordedDependencyFingerprint -Workspace $workspace } else { $null }\n` +
    `$modules = Join-Path $core 'node_modules'\n` +
    // "Does node_modules exist?" was the old question and it was the wrong one: it says nothing
    // about whether the tree matches the package-lock that arrived with the last `git pull`. The
    // fingerprint is what makes an update actually repairable here.
    `$stale = (Test-Path $modules) -and $fingerprint -and $recorded -and ($recorded -ne $fingerprint)\n` +
    `if ((Test-Path $modules) -and -not $stale) {\n` +
    `  Write-Host '[2/3] Dependencies are up to date.'\n` +
    // A workspace prepared by an older script has no record. Reinstalling ~73000 files on a hunch
    // would be a punishing default; adopting the current state makes the NEXT pull detectable,
    // which is the point of the record.
    `  if ($fingerprint -and -not $recorded -and (Get-Command Set-RvRecordedDependencyFingerprint -ErrorAction SilentlyContinue)) { Set-RvRecordedDependencyFingerprint -Workspace $workspace -Fingerprint $fingerprint }\n` +
    `} else {\n` +
    `  if ($stale) { Write-Host '[2/3] The dependencies changed with the last update - bringing them up to date.' }\n` +
    `  else { Write-Host '[2/3] Installing dependencies. The first run takes several minutes.' }\n` +
    // One verified archive beats ~717 registry requests behind a corporate proxy; npm ci
    // stays the fallback whenever no archive is pinned, reachable, or current.
    `  $restored = $false\n` +
    `  if (Test-Path (Join-Path $workspace 'dependencies.lock.json')) {\n` +
    `    Write-Host '      Restoring the delivered dependency archive instead of downloading from the npm registry.'\n` +
    `    node (Join-Path $workspace 'tools/get-dependencies.mjs') $workspace\n` +
    `    if ($LASTEXITCODE -eq 0) { $restored = $true } else { Write-Host '      Archive not usable, falling back to npm ci.' }\n` +
    `  }\n` +
    `  if (-not $restored) {\n` +
    `    Push-Location $core\n` +
    `    try { npm ci } finally { Pop-Location }\n` +
    `    if ($LASTEXITCODE -ne 0) {\n` +
    `      Write-Host ''\n` +
    `      Write-Host 'The dependencies could not be installed. The messages above say why.' -ForegroundColor Red\n` +
    `      exit 1\n` +
    `    }\n` +
    `  }\n` +
    // ONLY after a restore that worked. Recording it any earlier stamps the old tree as current:
    // the notice disappears, the problem stays, and the next "dev server failed" loses its cause.
    `  if ($fingerprint -and (Get-Command Set-RvRecordedDependencyFingerprint -ErrorAction SilentlyContinue)) { Set-RvRecordedDependencyFingerprint -Workspace $workspace -Fingerprint $fingerprint }\n` +
    `}\n` +
    (hasDiagnosis
      // Git LFS missing during the clone leaves a few-KB pointer file in place of the bundle, and
      // the symptom appears much later as a diagnosis that will not start. Cheap to catch here.
      ? `$rag = Join-Path $workspace 'connect/rag.zip'\n` +
        `if ((Test-Path $rag) -and ((Get-Item $rag).Length -lt 1MB)) {\n` +
        `  Write-Host '      Warning: connect/rag.zip is only a few KB, so Git LFS was missing during the clone.' -ForegroundColor Yellow\n` +
        `  Write-Host '      Run: git lfs install; git lfs pull'\n` +
        `}\n`
      : '') +
    `Write-Host '[3/3] Checking realvirtual CONNECT. The first run downloads about 225 MB.'\n` +
    // --latest resolves the channel manifest instead of trusting the version this repository was
    // pinned to when it was cloned. Without it a clone that is half a year old starts on a
    // half-year-old CONNECT. The cache still short-circuits the download, and connect.lock.json is
    // only rewritten once the bytes verify - see tools/get-connect.mjs.
    `node (Join-Path $workspace 'tools/get-connect.mjs') $workspace --latest\n` +
    `if ($LASTEXITCODE -ne 0) {\n` +
    `  Write-Host ''\n` +
    `  Write-Host 'realvirtual CONNECT could not be provided. The workspace itself is ready.' -ForegroundColor Yellow\n` +
    // The reason is printed by get-connect one line above, and it is not always the network. Naming
    // only the network sent a customer hunting a firewall for a rejected pin URL, which no amount of
    // network access would have fixed. Point at the reason first, then at the two causes it can have.
    `  Write-Host 'The line above says why. A download that never starts is usually the network blocking'\n` +
    `  Write-Host 'web.realvirtual.io; a rejected pin is connect.lock.json in this folder - ask realvirtual'\n` +
    `  Write-Host 'for the current values, or run: node tools/get-connect.mjs . --latest'\n` +
    `  exit 1\n}\n` +
    `Write-Host ''\nWrite-Host 'The workspace is prepared.' -ForegroundColor Green\n` +
    `Write-Host 'Start it from the Start menu ("realvirtual WEB dev"), or with: powershell -NoProfile -ExecutionPolicy Bypass -File .\\start.ps1'\n`;
}

// The shim. It exists for the installed base: existing shortcuts, older documentation, and the
// muscle memory of every customer who has typed `.\start.ps1` for a year. New documentation names
// the Start-menu entry only.
function generateStartPowerShell() {
  return `# Starts this workspace. A thin shim over two steps that are documented separately:\n` +
    `#   setup.ps1  prepares the workspace (Node, dependencies, realvirtual CONNECT)\n` +
    `#   CONNECT    starts the viewer itself and serves it on the CONNECT port\n` +
    `#\n` +
    `# Kept because shortcuts, older documentation and habit all point at this file. It no longer\n` +
    `# starts a development server of its own: realvirtual CONNECT does that and proxies it, so the\n` +
    `# viewer answers on ONE address whichever way the workspace runs.\n` +
    `param([int]$WebPort = 5173, [int]$ConnectPort = 5100)\n` +
    `$ErrorActionPreference = 'Stop'\n$workspace = Split-Path -Parent $MyInvocation.MyCommand.Path\n` +
    // A separate process with an explicit policy: this file is regularly started by right-clicking
    // "Run with PowerShell", where the machine policy - not ours - decides whether a child script
    // may run at all.
    `& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $workspace 'setup.ps1')\n` +
    `if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }\n` +
    `$launcher = Join-Path $workspace 'tools/rv-launcher.ps1'\n` +
    `if (-not (Test-Path $launcher)) {\n` +
    `  Write-Host 'tools/rv-launcher.ps1 is missing from this workspace, so it cannot be started.' -ForegroundColor Red\n` +
    `  Write-Host 'Run git pull to complete the workspace, then try again.'\n` +
    `  exit 1\n}\n` +
    `. $launcher\n` +
    // Asked before anything is started: a second CONNECT on the same port is ended by the mutex
    // anyway, so the honest outcomes are "bring the running one forward" or "say which other
    // workspace holds the port".
    `$activated = Invoke-RvActivateIfRunning -Workspace $workspace -ConnectPort $ConnectPort\n` +
    `if ($null -ne $activated) { exit $activated }\n` +
    `exit (Start-RvConnectAndOpen -Workspace $workspace -ConnectPort $ConnectPort -WebPort $WebPort)\n`;
}

function generateSetupShell() {
  return `#!/usr/bin/env sh\n` +
    `# Prepares this workspace: Node check, dependencies, realvirtual CONNECT.\n` +
    `# It starts NOTHING - use ./start.sh to run the workspace. realvirtual CONNECT points here when\n` +
    `# the dependencies have moved on, so a preparation that also started CONNECT would call itself.\n` +
    `set -eu\nROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nCORE="$ROOT/realvirtual-web"\n` +
    `if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then\n` +
    `  echo "Node.js ${REQUIRED_NODE_MAJOR} LTS is required to prepare this workspace, but node/npm were not found." >&2\n` +
    `  echo "Install it from https://nodejs.org, or use your package manager or nvm, then open a new terminal and run ./setup.sh again." >&2\n` +
    `  exit 1\nfi\n` +
    `NODE_MAJOR=$(node --version | sed 's/^v//' | cut -d. -f1)\n` +
    `if [ "$NODE_MAJOR" -lt ${REQUIRED_NODE_MAJOR} ]; then\n` +
    `  echo "Node.js $NODE_MAJOR was found, but this workspace requires version ${REQUIRED_NODE_MAJOR} or newer (see .nvmrc)." >&2\n` +
    `  exit 1\nfi\n` +
    `echo "[1/3] Node.js $NODE_MAJOR detected."\n` +
    // The same two file digests the PowerShell library and CONNECT compute. A plain file digest is
    // the one primitive all three languages produce identically, with no encoding or line-ending
    // question in the middle.
    `rv_sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }\n` +
    `rv_fingerprint() {\n` +
    `  [ -f "$CORE/package-lock.json" ] || return 1\n` +
    `  LOCK_PART=$(rv_sha256 "$CORE/package-lock.json" | cut -c1-16)\n` +
    `  NODE_PART=none\n` +
    `  if [ -f "$CORE/.nvmrc" ]; then NODE_PART=$(rv_sha256 "$CORE/.nvmrc" | cut -c1-8)\n` +
    `  elif [ -f "$ROOT/.nvmrc" ]; then NODE_PART=$(rv_sha256 "$ROOT/.nvmrc" | cut -c1-8); fi\n` +
    `  printf '%s:%s' "$LOCK_PART" "$NODE_PART"\n` +
    `}\n` +
    `FINGERPRINT=$(rv_fingerprint || true)\n` +
    `RECORD="$ROOT/.runtime/dependencies.json"\n` +
    `RECORDED=""\n` +
    `[ -f "$RECORD" ] && RECORDED=$(sed -n 's/.*"fingerprint"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "$RECORD")\n` +
    `rv_record() {\n` +
    `  [ -n "$FINGERPRINT" ] || return 0\n` +
    `  mkdir -p "$ROOT/.runtime"\n` +
    // Written next to it and renamed over it, so an interrupted run cannot leave a half-written
    // record that parses as a fingerprint nobody produced.
    `  printf '{\\n  "fingerprint": "%s",\\n  "updatedUtc": "%s"\\n}\\n' "$FINGERPRINT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$RECORD.tmp"\n` +
    `  mv -f "$RECORD.tmp" "$RECORD"\n` +
    `}\n` +
    `STALE=0\n` +
    `if [ -d "$CORE/node_modules" ] && [ -n "$FINGERPRINT" ] && [ -n "$RECORDED" ] && [ "$RECORDED" != "$FINGERPRINT" ]; then STALE=1; fi\n` +
    `if [ -d "$CORE/node_modules" ] && [ "$STALE" = "0" ]; then\n` +
    `  echo "[2/3] Dependencies are up to date."\n` +
    `  [ -n "$RECORDED" ] || rv_record\n` +
    `else\n` +
    `  if [ "$STALE" = "1" ]; then echo "[2/3] The dependencies changed with the last update - bringing them up to date."\n` +
    `  else echo "[2/3] Installing dependencies. The first run takes several minutes."; fi\n` +
    `  RESTORED=0\n` +
    `  if [ -f "$ROOT/dependencies.lock.json" ] && node "$ROOT/tools/get-dependencies.mjs" "$ROOT"; then RESTORED=1; fi\n` +
    `  [ "$RESTORED" = "1" ] || (cd "$CORE" && npm ci)\n` +
    `  rv_record\n` +
    `fi\n` +
    `echo "[3/3] Checking realvirtual CONNECT. The first run downloads about 225 MB."\n` +
    `node "$ROOT/tools/get-connect.mjs" "$ROOT" --latest\n` +
    `echo\necho "The workspace is prepared. Start it with ./start.sh"\n`;
}

// The Linux shim, matching start.ps1: prepare, then hand the day-to-day start to CONNECT.
function generateStartShell() {
  return `#!/usr/bin/env sh\n` +
    `# Starts this workspace. Preparation lives in setup.sh; realvirtual CONNECT serves the viewer\n` +
    `# itself and starts the development server when the workspace is a source checkout, so there is\n` +
    `# ONE address whichever way it runs.\n` +
    `set -eu\nROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\n` +
    `CONNECT_PORT=\${REALVIRTUAL_CONNECT_PORT:-5100}\nWEB_PORT=\${RV_WEB_DEV_PORT:-5173}\n` +
    `"$ROOT/setup.sh"\n` +
    `CONNECT="$ROOT/tools/connect/realvirtual-Connect"\n` +
    `if [ ! -x "$CONNECT" ]; then\n` +
    `  echo "realvirtual CONNECT is not in the workspace yet - run ./setup.sh" >&2\n` +
    `  exit 1\nfi\n` +
    `export REALVIRTUAL_CONNECT_PORT="$CONNECT_PORT"\nexport RV_WEB_DEV_PORT="$WEB_PORT"\n` +
    // The rollback route (plan-363 Phase 6): a CONNECT older than the launcher has no `web` block
    // in /health and never starts a development server, so the viewer would stay blank. Detected by
    // capability rather than by a version string, which beta and custom builds make unreliable.
    `"$CONNECT" --project-root "$ROOT" &\nCONNECT_PID=$!\n` +
    `HEALTH=""\n` +
    `if command -v curl >/dev/null 2>&1; then\n` +
    `  i=0\n` +
    `  while [ $i -lt 600 ]; do\n` +
    `    if ! kill -0 "$CONNECT_PID" 2>/dev/null; then echo "realvirtual CONNECT stopped on its own." >&2; exit 1; fi\n` +
    `    HEALTH=$(curl -fsS "http://127.0.0.1:$CONNECT_PORT/health" 2>/dev/null || true)\n` +
    `    [ -n "$HEALTH" ] && break\n` +
    `    i=$((i + 1)); sleep 1\n` +
    `  done\n` +
    `fi\n` +
    `case "$HEALTH" in\n` +
    `  *'"web"'*)\n` +
    `    echo "realvirtual WEB is running on http://localhost:$CONNECT_PORT" ;;\n` +
    `  '')\n` +
    `    echo "realvirtual CONNECT is starting on http://localhost:$CONNECT_PORT" ;;\n` +
    `  *)\n` +
    `    echo "This realvirtual CONNECT predates the built-in launcher - starting the development server separately."\n` +
    `    (cd "$ROOT/realvirtual-web" && npm run dev -- --port "$WEB_PORT" --strictPort) ;;\n` +
    `esac\n` +
    `wait "$CONNECT_PID"\n`;
}

function generateWorkspaceGuide(projectKey, deliveredDocs) {
  const docIndex = deliveredDocs
    .filter((name) => name.startsWith('doc-'))
    .map((name) => `- [${name}](realvirtual-web/${name})`)
    .join('\n');
  return `# Customer workspace development guide\n\n` +
    `## Structure and ownership\n\n` +
    `- \`projects/${projectKey}/\` is the customer-owned development area. Edit project models, documentation, and plugins only there.\n` +
    `- \`realvirtual-web/\`, \`realvirtual-web-pro/\`, \`connect/\`, and delivery manifests are delivery-managed and are replaced by the next delivery.\n\n` +
    `The project plugin entry point is \`projects/${projectKey}/plugins/index.ts\`. Put new plugin files in the same directory and register them from that entry point. Restart the development server after changing registration.\n\n` +
    `## Commands\n\n` +
    `Start the workspace from its root. realvirtual CONNECT serves the Viewer at http://localhost:5100 and starts the development server itself, so there is one address in every setup:\n\n` +
    `\`\`\`bash\npowershell -NoProfile -ExecutionPolicy Bypass -File .\\start.ps1\n\`\`\`\n\n` +
    `Run these checks from the workspace root:\n\n` +
    `\`\`\`bash\ncd realvirtual-web\nnpx tsc --noEmit\n\`\`\`\n\n` +
    `\`\`\`bash\ncd realvirtual-web\nnpm run build\n\`\`\`\n\n` +
    `## Recipes and documentation\n\n` +
    `The [workspace recipes](recipes/README.md) are the canonical, vendor-neutral instructions for recurring tasks. Follow them directly; assistant-specific commands are only adapters.\n\n` +
    `To turn a CAD assembly that is already open in the asset editor into a usable model - kinematic axes with drives that are proven to move, plus industrial materials - follow [Kinematize and materialize a CAD import](recipes/kinematize-cad-import.md). With Claude Code, run \`/kinematize\` or ask for the \`kinematize\` subagent, which follows that same recipe in its own context window. It never renames CAD nodes and never saves the asset; it also keeps a knowledge folder per asset in the work folder, so drop datasheets or notes there and they are read on the next run.\n\n` +
    `${docIndex || '- No feature documents were delivered.'}\n\n` +
    `The MCP tool reference is [webviewer.mcp.md](realvirtual-web/webviewer.mcp.md). Use the documented \`web_*\` tools to inspect the running Viewer and prefer read-only diagnosis until a requested change is understood.\n\n` +
    `## Verification\n\nBefore submitting a change, run both \`npx tsc --noEmit\` and \`npm run build\` from \`realvirtual-web/\`.\n\n` +
    `## Data protection and licensing\n\n` +
    `Source code, GLB models, and PDF documents can be processed by the selected AI provider when supplied to an assistant. Share only data that the provider is permitted to process.\n\n` +
    `Never add AGPL licence headers automatically to files under \`projects/${projectKey}/\`. Customer project code is commercial code and its ownership and usage are governed by the customer contract.\n`;
}

// The subagent carries no `model:` field on purpose: it then inherits the customer's own session
// model instead of silently overriding their choice on the perception phase, which is the part
// that most rewards a stronger model.
function writeCustomerAgents(root) {
  const agents = join(root, '.claude', 'agents');
  mkdirSync(agents, { recursive: true });
  writeFileSync(join(agents, 'kinematize.md'), `---\nname: kinematize\ndescription: Turn a raw CAD import in the realvirtual WEB asset editor into a usable asset - named and grouped parts, industrial materials, and kinematic axes with drives that are proven to move. Use after importing a STEP, JT, or GLB assembly whose nodes have no meaningful names.\n---\n\n` +
    `You build kinematic models from raw CAD assemblies in realvirtual WEB, working through the \`web_*\` MCP tools on a single asset document in the editor.\n\n` +
    `**[recipes/kinematize-cad-import.md](../../recipes/kinematize-cad-import.md) is canonical. Read it first and follow it step by step.** This file only frames how you work; the recipe holds every instruction, tool name, and pitfall. Where the two ever disagree, the recipe wins.\n\n` +
    `Your working discipline:\n\n` +
    `- **Perceive before you act.** Do not rename, group, or kinematize until you can describe what the machine does. Raw CAD gives you numbered nodes with no semantics, and every assumption you skip validating becomes a wrong axis someone else has to find.\n` +
    `- **Verify everything you build.** Every axis goes through \`web_editor_verify_drive\` immediately after it is created. Never report an axis as working that you have not seen move.\n` +
    `- **Never trust an \`ok\` flag alone.** Several tools report success for work they silently skipped; the recipe's "Common problems" section lists which, and what to check instead.\n` +
    `- **Leave the CAD alone.** Never rename a CAD node and never move one in the hierarchy. The kinematic model is a separate layer of axis nodes; parts only receive a Group component. Functional naming belongs in the knowledge folder.\n` +
    `- **Keep the knowledge folder current.** Ingest what a human dropped there before you start, and write back what you learned before you finish. Do not save the asset - hand it back dirty.\n\n` +
    `Report concretely and honestly. Name the mechanical evidence behind each decision - dimensions, positions, part numbers - and separate clearly what the geometry proves from what needs process knowledge you do not have. Travel limits, transfer positions, and cycle order are frequently not derivable from CAD. Never present an assumption as a verified fact.\n`);
}

function writeCustomerCommands(root) {
  const commands = join(root, '.claude', 'commands');
  mkdirSync(commands, { recursive: true });
  writeFileSync(join(commands, 'kinematize.md'), `# Kinematize a CAD import\n\nThis command is an adapter; [recipes/kinematize-cad-import.md](../../recipes/kinematize-cad-import.md) is canonical. Use the \`kinematize\` subagent for this work, because the perception phase consumes a lot of context and belongs in its own window. The recipe starts from an asset editor that is already open on an imported assembly - confirm that with \`web_editor_status\` first. It does not import and does not save.\n`);
  writeFileSync(join(commands, 'dev.md'), `# Start development\n\nThis command is an adapter; the [workspace recipes](../../recipes/README.md) are canonical. From the workspace root, run \`powershell -NoProfile -ExecutionPolicy Bypass -File .\\start.ps1\` (Linux: \`./start.sh\`). realvirtual CONNECT starts the development server itself and serves the Viewer at http://localhost:5100. After a \`git pull\` that changed the dependencies, run \`setup.ps1\` once. For model replacement or live signals, follow the linked recipe. Do not stop unrelated Node processes; if a port is occupied, pass \`-ConnectPort\` and \`-WebPort\` explicitly.\n`);
  writeFileSync(join(commands, 'build.md'), `# Verify and build\n\nThis command is an adapter; follow [Create a custom plugin](../../recipes/create-custom-plugin.md) for development checks and [Deploy the production web app](../../recipes/deploy-production-web.md) for deployment. From the workspace root, run \`cd realvirtual-web\`, then \`npx tsc --noEmit\`, then \`npm run build\`. Report either failure without changing unrelated files.\n`);
  writeFileSync(join(commands, 'debug.md'), `# Read-only diagnosis\n\nThis command is an adapter; follow [Troubleshoot the runtime](../../recipes/troubleshoot-runtime.md) as the canonical runbook. Start with read-only inspection. Read \`http://127.0.0.1:5100/__api/debug\` or use the read-only \`web_*\` MCP tools documented in \`realvirtual-web/webviewer.mcp.md\`. Do not change signals, scene state, files, or processes unless the user explicitly requests a mutation.\n`);
}

function writeWorkspaceFiles(root, coreRoot, privateRoot, project, projectKey, delivery, manifest, connectPin, deliveredDocs, hasDiagnosis = true) {
  const core = join(root, 'realvirtual-web');
  mkdirSync(join(core, 'public'), { recursive: true });
  writeFileSync(join(core, 'public', 'settings.json'), JSON.stringify(generatedSettings(project, delivery, connectPin), null, 2) + '\n');
  const features = selectedFeatures(manifest, delivery);
  const projectPlugins = listProjectPluginNames(root, projectKey);
  writeFileSync(join(root, 'README.md'), generateReadme(delivery, projectKey, bareDefaultModel(project), features, projectPlugins, hasDiagnosis));
  writeWorkspaceRecipes(root, projectKey, bareDefaultModel(project), coreRoot);
  writeFileSync(join(root, 'CONTRIBUTING.md'), generateContributing(projectKey));
  const workspaceGuide = generateWorkspaceGuide(projectKey, deliveredDocs);
  writeFileSync(join(root, 'CLAUDE.md'), workspaceGuide);
  writeFileSync(join(root, 'AGENTS.md'), workspaceGuide);
  writeCustomerCommands(root);
  writeCustomerAgents(root);
  const licence = join(privateRoot, 'LICENSE-commercial.md');
  if (!existsSync(licence)) throw new Error(`Commercial licence placeholder not found: ${licence}`);
  copyFileSync(licence, join(root, 'LICENSE-commercial.md'));
  writeFileSync(join(root, '.nvmrc'), `${REQUIRED_NODE_MAJOR}\n`);
  writeFileSync(join(root, '.gitattributes'), GENERATED_GIT_ATTRIBUTES.join('\n') + '\n');
  writeFileSync(join(root, '.gitignore'), '.runtime/\ntools/connect/\n**/node_modules/\n**/dist/\n.env*\n.npmrc\n');
  // Two pairs, and the naming is the message (plan-363 Phase 6): setup prepares, start starts.
  // The shims stay because shortcuts, older documentation and habit point at them.
  writeFileSync(join(root, 'setup.ps1'), generateSetupPowerShell(hasDiagnosis));
  writeFileSync(join(root, 'start.ps1'), generateStartPowerShell());
  writeFileSync(join(root, 'setup.sh'), generateSetupShell());
  writeFileSync(join(root, 'start.sh'), generateStartShell());
  writeFileSync(join(root, 'FEATURES.md'), renderFeatureMatrix(manifest, [delivery], projectKey, projectPlugins));
  // Internal ops helpers live in the private repo (never on the public AGPL
  // remote) but are still delivered into the customer workspace under tools/.
  const getConnectSource = join(privateRoot, 'scripts', 'get-connect.mjs');
  const fallbackGetConnect = join(dirname(manifest.path), 'scripts', 'get-connect.mjs');
  const source = existsSync(getConnectSource) ? getConnectSource : fallbackGetConnect;
  if (existsSync(source)) {
    mkdirSync(join(root, 'tools'), { recursive: true });
    copyFileSync(source, join(root, 'tools', 'get-connect.mjs'));
  }
  const getDependenciesSource = join(privateRoot, 'scripts', 'get-dependencies.mjs');
  if (existsSync(getDependenciesSource)) {
    mkdirSync(join(root, 'tools'), { recursive: true });
    copyFileSync(getDependenciesSource, join(root, 'tools', 'get-dependencies.mjs'));
  }
  // The shared launcher functions travel WITH the workspace, not only with the installer: a
  // customer updates the workspace by `git pull` far more often than by reinstalling, and the
  // workspaceId rules have to stay in step with the CONNECT that reads them.
  const launcherSource = join(privateRoot, 'installer', 'payload', 'rv-launcher.ps1');
  if (existsSync(launcherSource)) {
    mkdirSync(join(root, 'tools'), { recursive: true });
    copyFileSync(launcherSource, join(root, 'tools', 'rv-launcher.ps1'));
  }
  const provisionInfluxSource = join(privateRoot, 'scripts', 'provision-influx.mjs');
  if (!existsSync(provisionInfluxSource)) {
    throw new Error(`InfluxDB provisioning helper not found: ${provisionInfluxSource}`);
  }
  mkdirSync(join(root, 'tools'), { recursive: true });
  copyFileSync(provisionInfluxSource, join(root, 'tools', 'provision-influx.mjs'));
}

//! Rewrites a public `@rv-private` stub so its relative core imports resolve from
//! its staged location `realvirtual-web-pro/src/<stubRel>` in the flat workspace layout.
function stubFallbackContent(stubSource, stubRel) {
  const stubDir = posix.dirname(stubRel);
  const depth = stubDir === '.' ? 0 : stubDir.split('/').length;
  return stubSource.replace(/(from\s*|import\s*\(?\s*)(['"])(\.\.?\/[^'"]+)\2/g, (match, prefix, quote, spec) => {
    const resolved = posix.normalize(posix.join(PRIVATE_STUB_ROOT, stubDir, spec));
    if (resolved.startsWith(`${PRIVATE_STUB_ROOT}/`)) return match; // sibling stub keeps its relative layout
    if (!resolved.startsWith('src/')) throw new Error(`Stub ${stubRel} imports outside the core src tree: ${spec}`);
    return `${prefix}${quote}${'../'.repeat(depth + 2)}realvirtual-web/${resolved}${quote}`;
  });
}

//! Stages public no-op stubs for `@rv-private` modules the delivery does not include.
//! With realvirtual-web-pro present, Vite aliases `@rv-private` hard to the pro tree
//! (no per-file fallback to src/private-stubs), so tier-excluded modules that core
//! imports (e.g. plugins/des/*) must exist there as their public stubs.
function stagePrivateStubFallbacks(coreRoot, privateOutput) {
  walk(join(coreRoot, PRIVATE_STUB_ROOT), (absolute, rel, entry) => {
    if (!entry.isFile() || rel === 'private-plugins.ts') return;
    const target = join(privateOutput, 'src', rel);
    if (existsSync(target)) return;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, stubFallbackContent(readFileSync(absolute, 'utf8'), rel));
  });
}

//! Extends the staged vite.config so bare npm imports from the flat workspace
//! `projects/` tree resolve against the core node_modules (the dev-layout marker
//! checks in rv-private-resolver never match the customer projects/ path).
function patchCustomerViteResolver(coreOutput) {
  const path = join(coreOutput, 'vite.config.ts');
  if (!existsSync(path)) return;
  const source = readFileSync(path, 'utf8');
  const anchor = "&& !normalizedImporter.includes('realvirtual-web-pro')) return null;";
  if (!source.includes(anchor)) {
    throw new Error('vite.config.ts rv-private-resolver anchor not found; update patchCustomerViteResolver.');
  }
  writeFileSync(path, source.replace(anchor,
    "&& !normalizedImporter.includes('realvirtual-web-pro')\n"
    + "          && !normalizedImporter.startsWith(resolve(__dirname, '../projects').replace(/\\\\/g, '/') + '/')) return null;"));
}

function rewriteCustomerWorkspaceNames(root) {
  const textExtensions = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.md', '.html']);
  const codeExtensions = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs']);
  walk(root, (absolute, rel, entry) => {
    if (!entry.isFile()) return;
    const extension = rel.includes('.') ? rel.slice(rel.lastIndexOf('.')).toLowerCase() : '';
    if (!textExtensions.has(extension)) return;
    const source = readFileSync(absolute, 'utf8');
    let rewritten = source
      .replaceAll('realvirtual-WebViewer-Private~', 'realvirtual-web-pro')
      .replaceAll('realvirtual-WebViewer~', 'realvirtual-web');
    // Project files move one level up in the flat layout (dev: <private>/projects/<key>,
    // workspace: projects/<key>), so sibling-tree imports lose exactly one `../`.
    if (rel.startsWith('projects/') && codeExtensions.has(extension)) {
      rewritten = rewritten.replace(
        /(['"])((?:\.\.\/){2,})(realvirtual-web(?:-pro)?\/)/g,
        (_match, quote, ups, target) => `${quote}${ups.slice(3)}${target}`,
      );
    }
    if (rewritten !== source) writeFileSync(absolute, rewritten);
  });
}

function curateCoreMarkdownLinks(workspaceRoot, coreOutput) {
  const managedRootTargets = new Map([
    ['CLAUDE.md', '../CLAUDE.md'],
    ['CONTRIBUTING.md', '../CONTRIBUTING.md'],
    ['.claude/commands/', '../.claude/commands/'],
  ]);
  walk(coreOutput, (absolute, _rel, entry) => {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) return;
    const isCoreReadme = resolve(absolute) === resolve(join(coreOutput, 'README.md'));
    const source = readFileSync(absolute, 'utf8');
    const rewritten = mapMarkdownFencedProse(source, prose => prose.replace(
      /(!?)\[([^\]]*)\]\((<[^>\n]+>|[^)\n]+)\)/g,
      (full, marker, label, rawTarget) => {
        const target = normalizeMarkdownTarget(rawTarget);
        if (!target || marker === '!') return full;
        if (isCoreReadme && managedRootTargets.has(target)) {
          const replacement = managedRootTargets.get(target);
          return existsSync(resolve(dirname(absolute), replacement)) ? `[${label}](${replacement})` : label;
        }
        if (DELIVERY_DOC_LINK_REDIRECTS.has(target)) {
          const replacement = DELIVERY_DOC_LINK_REDIRECTS.get(target);
          if (existsSync(resolve(dirname(absolute), replacement))) return `[${label}](${replacement})`;
        }
        const destination = resolve(dirname(absolute), target);
        if (existsSync(destination)) return full;
        const fileName = basename(target);
        const normalizedTarget = target.replace(/\\/g, '/');
        if (NEVER_DELIVERED_DOCS.has(fileName) || CONDITIONAL_DELIVERED_DOCS.has(fileName)
            || normalizedTarget.startsWith('../realvirtual/') || normalizedTarget.includes('/Packages/')
            || NON_DELIVERED_DOC_LINK_PREFIXES.some((prefix) => normalizedTarget.startsWith(prefix))
            || !isWithin(workspaceRoot, destination)) return label;
        return full;
      }));
    if (rewritten !== source) writeFileSync(absolute, rewritten);
  });
}

//! Fails when a delivered Markdown file contains a relative link or image path that is absent.
export function assertNoBrokenDocLinks(stagingRoot) {
  const root = resolve(stagingRoot);
  walk(root, (absolute, rel, entry) => {
    if (isNonDeliveredBuildDir(entry)) return false;
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) return;
    for (const { target } of markdownLinks(readFileSync(absolute, 'utf8'))) {
      const destination = resolve(dirname(absolute), target);
      if (!isWithin(root, destination) || !existsSync(destination)) {
        throw new Error(`Broken Markdown link in ${rel}: ${target}`);
      }
    }
  });
}

//! Creates an allowlisted source tree in the flat customer workspace layout.
export function stageFilteredSourceTree(options) {
  const coreRoot = resolve(options.coreRoot);
  const privateRoot = resolve(options.privateRoot);
  // `projectKey` is the PRIMARY project: the one the generated README, settings,
  // recipes and CONNECT payload are written for. `projectKeys` is the full set a
  // customer repository carries (§2.10); a single-project delivery is simply the
  // case where the two agree. The primary always comes first.
  const projectKey = options.projectKey ?? options.projectKeys?.[0] ?? null;
  const projectKeys = options.projectKeys
    ? [projectKey, ...options.projectKeys.filter((key) => key !== projectKey)]
    : (projectKey ? [projectKey] : []);
  const profile = options.profile ?? { tier: 'core', restrictedFeatures: [] };
  const manifestPath = join(privateRoot, 'tier-manifest.json');
  const manifest = existsSync(manifestPath)
    ? loadTierManifest(manifestPath)
    : { defaults: 'internal', rules: [], registrations: {}, path: manifestPath };
  const destinationRoot = options.destinationRoot
    ? resolve(options.destinationRoot)
    : mkdtempSync(join(tmpdir(), 'rv-customer-workspace-'));
  if (existsSync(destinationRoot) && readdirSync(destinationRoot).length > 0) {
    throw new Error(`Destination must be empty: ${destinationRoot}`);
  }
  mkdirSync(destinationRoot, { recursive: true });
  const coreOutput = join(destinationRoot, 'realvirtual-web');
  mkdirSync(coreOutput, { recursive: true });
  const deliveredDocs = selectedDocumentation(manifest, profile);
  copyCore(coreRoot, coreOutput, deliveredDocs, deliveredPublicModels(coreRoot), {
    // Only the PUBLIC demo deploy (core tier, no project) ships scenes/ + aasx/.
    includePublicDemoContent: profile.tier === 'core' && !projectKey,
  });
  copyDemoAssetsIntoCore(coreRoot, coreOutput);

  let delivery = options.delivery ?? null;
  let project = options.project ?? null;
  let privateOutput = null;
  if (profile.tier !== 'core') {
    if (!projectKey) throw new Error('A projectKey is required for non-core staging.');
    delivery ??= loadDeliveryConfig(privateRoot, projectKey, manifest);
    for (const key of projectKeys) {
      if (!existsSync(join(privateRoot, 'projects', key))) {
        throw new Error(`Project not found: ${join(privateRoot, 'projects', key)}`);
      }
    }
    project ??= readJson(join(privateRoot, 'projects', projectKey, 'project.json'));
    privateOutput = join(destinationRoot, 'realvirtual-web-pro');
    mkdirSync(join(privateOutput, 'src'), { recursive: true });
    walk(join(privateRoot, 'src'), (absolute, rel, entry) => {
      if (!entry.isFile()) return;
      const sourceRel = `src/${rel}`;
      const resolvedTier = resolveTier(manifest, sourceRel);
      if (!sourceAllowed(resolvedTier, profile)) return;
      const target = join(privateOutput, sourceRel);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(absolute, target);
    });
    stagePrivateStubFallbacks(coreRoot, privateOutput);
    patchCustomerViteResolver(coreOutput);
    writeFileSync(join(privateOutput, 'src', 'private-plugins.ts'), generateCustomerPrivatePlugins(manifest, profile));
    const deliveredManifest = {
      defaults: 'internal',
      rules: manifest.rules.filter((rule) => sourceAllowed(rule, profile)).map(({ matcher: _matcher, ...rule }) => rule),
      registrations: Object.fromEntries(selectedFeatures(manifest, profile)
        .map((feature) => [feature, manifest.registrations[feature]])),
    };
    writeFileSync(join(privateOutput, 'tier-manifest.json'), JSON.stringify(deliveredManifest, null, 2) + '\n');
    writePrunedPrivatePackage(privateRoot, privateOutput);
    // `rag/` holds the embedded form of this project's document corpus - a build INPUT of
    // bundle-rag.mjs, versioned next to the documents it was computed from (LFS, hundreds of
    // MB). The customer receives its filtered OUTPUT as connect/rag.zip and has no use for the
    // seed; staging it would push the whole index into the customer repo and trip the
    // oversized-file guard, which is exactly how this was noticed.
    const projectExcluded = new Set(['.git', 'rag']);
    for (const key of projectKeys) {
      const projectOutput = join(destinationRoot, 'projects', key);
      copyTree(join(privateRoot, 'projects', key), projectOutput,
        (rel) => !rel.split('/').some((s) => projectExcluded.has(s)));
      const customerProjectConfig = readJson(join(projectOutput, 'project.json'));
      delete customerProjectConfig.delivery;
      writeFileSync(join(projectOutput, 'project.json'), JSON.stringify(customerProjectConfig, null, 2) + '\n');
    }
    // hasDiagnosis:false (a --no-rag delivery) ships no connect/ payload, so the generated README
    // and start.ps1 must not promise or hash a diagnosis package that is not there. It defaults to
    // true so every existing caller keeps describing a normal delivery; only the generator's
    // explicit --no-rag run turns it off.
    writeWorkspaceFiles(destinationRoot, coreRoot, privateRoot, project, projectKey, delivery, manifest, options.connectPin ?? null, deliveredDocs, options.hasDiagnosis ?? true);
  }
  writeWorkspaceTsconfig(coreOutput);

  if (options.connectArtifacts) {
    const connectOutput = join(destinationRoot, 'connect');
    mkdirSync(connectOutput, { recursive: true });
    for (const name of ['rag.zip', 'project-config.json']) {
      const source = join(options.connectArtifacts, name);
      if (!existsSync(source)) throw new Error(`CONNECT delivery artifact missing: ${source}`);
      copyFileSync(source, join(connectOutput, name));
    }
  }
  if (options.connectPin) writeFileSync(join(destinationRoot, 'connect.lock.json'), JSON.stringify(options.connectPin, null, 2) + '\n');
  rewriteCustomerWorkspaceNames(destinationRoot);
  curateCoreMarkdownLinks(destinationRoot, coreOutput);
  assertNoBrokenDocLinks(destinationRoot);
  return { workspaceRoot: destinationRoot, coreRoot: coreOutput, privateRoot: privateOutput, project, projectKey, projectKeys, delivery, manifest };
}

//! Rejects private source files that do not belong to the selected profile.
export function assertNoCrossTierLeak(workspaceRoot, manifest, profile) {
  const privateSource = join(workspaceRoot, 'realvirtual-web-pro', 'src');
  if (!existsSync(privateSource)) return;
  walk(privateSource, (absolute, rel, entry) => {
    if (!entry.isFile() || rel === 'private-plugins.ts') return;
    const resolved = resolveTier(manifest, `src/${rel}`);
    if (sourceAllowed(resolved, profile)) return;
    // Generated stub fallbacks are allowed: the file must be byte-identical to the
    // transformed public stub shipped in the core tree — nothing private fits in there.
    const stub = join(workspaceRoot, 'realvirtual-web', PRIVATE_STUB_ROOT, rel);
    if (existsSync(stub)
      && readFileSync(absolute, 'utf8') === stubFallbackContent(readFileSync(stub, 'utf8'), rel)) return;
    throw new Error(`Cross-tier source leak: ${rel} (${resolved.tier}).`);
  });
}

//! Rejects links, nested Git metadata, secrets, foreign projects and oversized files.
export function assertWorkspaceGuards(workspaceRoot, options = {}) {
  const root = resolve(workspaceRoot);
  // The foreign-name guard now works against the SET of projects this repository
  // legitimately carries (§2.10). With a single key it was impossible to deliver a
  // second project to the same customer: its own folder name would have read as a
  // foreign customer's name and aborted the delivery.
  const own = new Set((options.projectKeys ?? (options.projectKey ? [options.projectKey] : []))
    .map((value) => value.toLowerCase()));
  const foreign = (options.knownProjectKeys ?? []).map((value) => value.toLowerCase()).filter((value) => !own.has(value));
  walk(root, (absolute, rel, entry) => {
    if (isNonDeliveredBuildDir(entry)) return false;
    assertNotLink(absolute);
    const segments = rel.split('/');
    if (segments[0].toLowerCase() === '.git') return false;
    if (segments.some((segment) => segment.toLowerCase() === '.git')) throw new Error(`Nested .git is forbidden: ${rel}`);
    if (entry.isDirectory()) return;
    const lower = rel.toLowerCase();
    if (isSecretPath(rel)) throw new Error(`Secret-bearing file is forbidden: ${rel}`);
    const size = statSync(absolute).size;
    if (size > MAX_DELIVERY_FILE_BYTES
      && (!options.lfsRepoRoot || !hasLfsFilter(options.lfsRepoRoot, rel))) {
      throw new Error(`Oversized delivery file: ${rel}`);
    }
    if (foreign.some((name) => lower.includes(name))) throw new Error(`Foreign customer name found in ${rel}.`);
    const ext = lower.slice(lower.lastIndexOf('.'));
    if (!SECRET_SCAN_EXTENSIONS.has(ext)) return;
    const violation = secretContentViolation(lower, ext, readFileSync(absolute, 'utf8'));
    if (violation) throw new Error(violation);
  });
  assertNoBrokenDocLinks(root);
  if (options.lfsRepoRoot) assertLfsPointer(options.lfsRepoRoot);
}

function hasLfsFilter(repoRoot, path) {
  const attr = execFileSync('git', ['check-attr', 'filter', '--', path], { cwd: repoRoot, encoding: 'utf8' });
  return /:\s*filter:\s*lfs\s*$/m.test(attr);
}

//! Verifies that every Git LFS-filtered file is staged as a Git LFS v1 pointer.
export function assertLfsPointer(repoRoot) {
  const indexedPaths = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot })
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
  for (const path of indexedPaths.filter((candidate) => hasLfsFilter(repoRoot, candidate))) {
    const blob = execFileSync('git', ['show', `:${path}`], { cwd: repoRoot });
    const text = blob.toString('utf8');
    if (blob.length > 1024 || !text.startsWith('version https://git-lfs.github.com/spec/v1\n') || !/oid sha256:[0-9a-f]{64}/.test(text)) {
      throw new Error(`Staged ${path} is not a small Git LFS v1 pointer.`);
    }
  }
}

//! Scans build outputs for forbidden sentinel content, independent of chunk filenames.
export function assertNoSentinelInArtifacts(distRoot, sentinels) {
  walk(distRoot, (absolute, rel, entry) => {
    if (!entry.isFile() || !/\.(?:js|css|wasm|map)$/i.test(rel)) return;
    const bytes = readFileSync(absolute);
    for (const sentinel of sentinels) {
      if (bytes.includes(Buffer.from(sentinel))) throw new Error(`Foreign sentinel found in build artifact ${rel}.`);
    }
  });
}

//! Returns deterministic Git provenance and enforces clean/tagged source gates.
export function gitProvenance(repoRoot, { requireTag = false } = {}) {
  const cwd = resolve(repoRoot);
  const status = execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' }).trim();
  if (status) throw new Error(`Git tree is dirty: ${cwd}`);
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
  const tags = execFileSync('git', ['tag', '--points-at', 'HEAD'], { cwd, encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean);
  if (requireTag && !tags.some((tag) => /^viewer-v\d+\.\d+\.\d+(?:[-+].+)?$/.test(tag))) {
    throw new Error(`Core HEAD must carry a viewer-vX.Y.Z release tag: ${cwd}`);
  }
  return { commit, tags };
}

//! Reads the Plastic changeset from the workspace header; unavailable Plastic is non-fatal.
export function readPlasticChangeset(workspaceRoot) {
  try {
    const header = execFileSync('cm', ['status', '--header'], {
      cwd: resolve(workspaceRoot), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    const match = header.match(/\bcs:(\d+)\b/i);
    if (match) return Number.parseInt(match[1], 10);
    console.warn('[customer-workspace] Plastic changeset missing from cm status --header; version suffix omitted.');
  } catch (error) {
    console.warn(`[customer-workspace] Plastic changeset unavailable; version suffix omitted: ${error?.message ?? error}`);
  }
  return null;
}

//! Hashes a directory tree by relative path and content.
export function hashTree(root, excludes = []) {
  const hash = createHash('sha256');
  const files = [];
  walk(root, (absolute, rel, entry) => { if (entry.isFile() && !excludes.some((pattern) => globRegex(pattern).test(rel))) files.push([absolute, rel]); });
  for (const [absolute, rel] of files.sort((a, b) => a[1].localeCompare(b[1]))) {
    hash.update(rel); hash.update('\0'); hash.update(readFileSync(absolute)); hash.update('\0');
  }
  return hash.digest('hex');
}

function quoteNpmArg(argument) {
  return /[\s"^&|<>()%!]/.test(argument) ? `"${argument.replace(/"/g, '""')}"` : argument;
}

function runNpm(args, options) {
  if (process.platform !== 'win32') return execFileSync('npm', args, options);
  // Node >= 18.20/20.12 (CVE-2024-27980) refuses to spawn .cmd/.bat without a shell,
  // so build a controlled command string with cmd.exe-quoted arguments.
  return execFileSync(['npm.cmd', ...args.map(quoteNpmArg)].join(' '), { ...options, shell: true });
}

function buildProfileKey(workspaceRoot, coreRoot) {
  const lockfiles = [['realvirtual-web/package-lock.json', join(coreRoot, 'package-lock.json')]];
  const proLock = join(workspaceRoot, 'realvirtual-web-pro', 'package-lock.json');
  if (existsSync(proLock)) lockfiles.push(['realvirtual-web-pro/package-lock.json', proLock]);
  try {
    const hash = createHash('sha256');
    for (const [label, path] of lockfiles) {
      if (!existsSync(path)) return null;
      hash.update(label); hash.update('\0'); hash.update(readFileSync(path)); hash.update('\0');
    }
    return hash.digest('hex');
  } catch (error) {
    console.warn(`[build-cache] Lockfile hash unavailable; running npm ci: ${error?.message ?? error}`);
    return null;
  }
}

function restoreCachedNodeModules(cacheNodeModules, targetNodeModules) {
  rmSync(targetNodeModules, { recursive: true, force: true });
  try {
    symlinkSync(cacheNodeModules, targetNodeModules, process.platform === 'win32' ? 'junction' : 'dir');
    return 'link';
  } catch (linkError) {
    rmSync(targetNodeModules, { recursive: true, force: true });
    try {
      cpSync(cacheNodeModules, targetNodeModules, { recursive: true, force: true });
      return 'copy';
    } catch (copyError) {
      rmSync(targetNodeModules, { recursive: true, force: true });
      console.warn(`[build-cache] Cache restore failed; running npm ci: ${copyError?.message ?? copyError} (link: ${linkError?.message ?? linkError})`);
      return null;
    }
  }
}

function populateBuildCache(cacheBase, profileRoot, sourceNodeModules) {
  if (!existsSync(sourceNodeModules)) {
    console.warn('[build-cache] npm ci did not create node_modules; cache was not populated.');
    return false;
  }
  mkdirSync(cacheBase, { recursive: true });
  if (existsSync(join(profileRoot, 'node_modules'))) return true;
  if (existsSync(profileRoot)) rmSync(profileRoot, { recursive: true, force: true });
  const temporaryProfile = mkdtempSync(join(cacheBase, '.rv-build-profile-'));
  try {
    cpSync(sourceNodeModules, join(temporaryProfile, 'node_modules'), { recursive: true, force: true });
    try {
      renameSync(temporaryProfile, profileRoot);
    } catch (error) {
      if (!existsSync(join(profileRoot, 'node_modules'))) throw error;
      rmSync(temporaryProfile, { recursive: true, force: true });
    }
    return true;
  } catch (error) {
    rmSync(temporaryProfile, { recursive: true, force: true });
    console.warn(`[build-cache] Cache population failed; this build remains valid: ${error?.message ?? error}`);
    return false;
  }
}

//! Runs npm ci and the production build from the filtered workspace core.
export function runBuild(workspaceRoot, options = {}) {
  const candidate = resolve(workspaceRoot);
  const coreRoot = existsSync(join(candidate, 'realvirtual-web', 'package.json')) ? join(candidate, 'realvirtual-web') : candidate;
  if (options.dryRun) return { coreRoot, distDir: join(coreRoot, 'dist'), dryRun: true, cacheStatus: 'disabled' };
  const env = { ...process.env };
  if (options.mode === 'public') env.VITE_PUBLIC_BUILD = '1';
  else { delete env.VITE_PUBLIC_BUILD; env.VITE_PRIVATE_BUILD = '1'; }
  if (options.base) env.VITE_BASE = options.base;
  const npmRunner = options.npmRunner ?? runNpm;
  const targetNodeModules = join(coreRoot, 'node_modules');
  let cacheStatus = options.fast ? 'rebuild' : 'disabled';
  let cacheMethod = null;
  let profileKey = null;
  let installDependencies = true;
  let populateCache = false;
  let cacheBase = null;
  let profileRoot = null;
  if (options.fast) {
    profileKey = buildProfileKey(candidate, coreRoot);
    if (profileKey) {
      cacheBase = join(process.env.RV_BUILD_CACHE || tmpdir(), 'rv-build-cache');
      profileRoot = join(cacheBase, profileKey);
      const cachedNodeModules = join(profileRoot, 'node_modules');
      if (existsSync(cachedNodeModules)) {
        cacheMethod = restoreCachedNodeModules(cachedNodeModules, targetNodeModules);
        if (cacheMethod) {
          cacheStatus = 'hit';
          installDependencies = false;
        } else {
          rmSync(profileRoot, { recursive: true, force: true });
        }
      }
    }
  }
  if (installDependencies) {
    if (existsSync(targetNodeModules) && lstatSync(targetNodeModules).isSymbolicLink()) {
      rmSync(targetNodeModules, { recursive: true, force: true });
    }
    npmRunner(['ci'], { cwd: coreRoot, env, stdio: 'inherit' });
    populateCache = Boolean(options.fast && profileKey && cacheBase && profileRoot);
  }
  npmRunner(['run', 'build'], { cwd: coreRoot, env, stdio: 'inherit' });
  if (populateCache) populateBuildCache(cacheBase, profileRoot, targetNodeModules);
  const distDir = join(coreRoot, 'dist');
  writeFileSync(join(distDir, '.rv-build-provenance.json'), JSON.stringify({
    sourceTreeSha256: hashTree(candidate, ['realvirtual-web/dist/**', '**/node_modules/**']),
    mode: options.mode ?? 'private',
    project: options.projectKey ?? null,
    fast: Boolean(options.fast),
  }, null, 2) + '\n');
  return { coreRoot, distDir, dryRun: false, cacheStatus, cacheMethod, profileKey };
}

//! Rejects a build directory without matching generated provenance.
export function assertBuildProvenance(distDir, expected = {}) {
  const path = join(distDir, '.rv-build-provenance.json');
  if (!existsSync(path)) throw new Error(`Build provenance is missing: ${path}`);
  const provenance = readJson(path);
  if (expected.mode && provenance.mode !== expected.mode) throw new Error('Build provenance mode mismatch.');
  if (expected.projectKey && provenance.project !== expected.projectKey) throw new Error('Build provenance project mismatch.');
  return provenance;
}

// ─── Merged snapshot (plan-700 §2.2, §2.4-§2.6) ──────────────────────────

//! Runs git in a repository and returns stdout; `allowFailure` turns an expected
//! non-zero exit (no HEAD yet, unknown tag) into `null` instead of a throw.
function gitIn(cwd, args, { allowFailure = false } = {}) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  } catch (error) {
    if (allowFailure) return null;
    throw error;
  }
}

//! Reads a delivery manifest out of a clone, tolerating absence and damage. Both
//! mean the same thing to the caller: there is no baseline to merge against.
function readCloneDeliveryManifest(clone) {
  const path = join(clone, 'delivery-manifest.json');
  if (!existsSync(path)) return readDeliveryManifest(null);
  try {
    return readDeliveryManifest(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return readDeliveryManifest(null);
  }
}

//! Renders the customer-facing report (§2.6). German, no internal paths or commits:
//! the customer reads it directly in Forgejo, next to the commit it arrived with.
export function renderDeliveryReport({ version, generatedAt, projects, drift }) {
  const lines = [`# Delivery-Report — viewer ${version} — ${generatedAt.slice(0, 10)}`, ''];
  const rows = (title, collect) => {
    const entries = [];
    for (const [key, project] of Object.entries(projects)) {
      for (const path of collect(project)) entries.push([key, path]);
    }
    if (!entries.length) return;
    lines.push(`## ${title}`, '', '| Projekt | Datei |', '| --- | --- |');
    for (const [key, path] of entries) lines.push(`| ${key} | \`${path}\` |`);
    lines.push('');
  };

  const conflicts = Object.entries(projects).flatMap(([key, project]) =>
    project.conflicts.map((conflict) => ({ key, ...conflict })));
  if (conflicts.length) {
    lines.push('## Konflikte (Ihre Version wurde behalten)', '');
    lines.push('| Projekt | Datei | Was passiert ist | Neue Version liegt unter |');
    lines.push('| --- | --- | --- | --- |');
    for (const conflict of conflicts) {
      lines.push(`| ${conflict.key} | \`${conflict.path}\` | ${CONFLICT_TEXT[conflict.reason] ?? conflict.reason}`
        + ` | ${conflict.sidecarPath ? `\`${conflict.sidecarPath}\`` : '— (nicht ablegbar, siehe unten)'} |`);
    }
    lines.push('');
    if (conflicts.some((conflict) => conflict.sidecar && !conflict.sidecarPath)) {
      lines.push('Fuer die mit — markierten Dateien konnte die neue Version in diesem Repository nicht',
        'abgelegt werden, weil sie dort nicht unter dieselbe Git-LFS-Regel faellt wie das Original.',
        'Ihre Version bleibt unveraendert; bitte melden Sie sich, wenn Sie die neue Fassung brauchen.', '');
    }
  }

  rows('Aktualisiert', (project) => project.updated);
  rows('Neu hinzugefuegt', (project) => project.added);
  rows('Entfernt', (project) => project.removed);
  rows('Fehlt bei Ihnen (nicht automatisch ergaenzt)', (project) => project.addPending);

  if (drift.length) {
    lines.push('## Ihre Aenderungen ausserhalb von projects/', '',
      'Dieser Bereich enthaelt den ausgelieferten Programmcode und wird bei jeder Auslieferung',
      'ersetzt. Die folgenden Abweichungen wurden dabei ueberschrieben bzw. entfernt:', '',
      '| Datei | Abweichung |', '| --- | --- |');
    for (const entry of drift) lines.push(`| \`${entry.path}\` | ${DRIFT_TEXT[entry.status] ?? entry.status} |`);
    lines.push('');
  }

  if (lines.length === 2) lines.push('Keine Aenderungen an Ihren Projektdaten.', '');
  return lines.join('\n');
}

const CONFLICT_TEXT = Object.freeze({
  'both-changed': 'Sie und wir haben die Datei geaendert',
  'added-both-sides': 'Sie haben die Datei selbst angelegt, wir liefern sie jetzt ebenfalls',
  'deleted-by-vendor-changed-by-customer': 'Wir liefern die Datei nicht mehr, Sie haben sie geaendert',
  'deleted-by-customer': 'Sie haben die Datei geloescht — sie wurde nicht erneut geliefert',
  'missing-without-baseline': 'Die Datei gehoert zur Auslieferung, fehlt bei Ihnen',
});

const DRIFT_TEXT = Object.freeze({ A: 'von Ihnen angelegt', M: 'von Ihnen geaendert', D: 'von Ihnen geloescht' });

/**
 * Writes one delivery into a freshly cloned customer repository, applying the
 * three-zone model (§2.2) instead of the old all-or-nothing per folder.
 *
 * Its predecessor `applySnapshotToClone` preserved `projects/<key>/`
 * byte-for-byte, which is why no project-side update ever reached a delivered
 * customer, and deleted everything outside it without a word, which is why
 * their own files there vanished silently. Here:
 *
 *   Zone A — everything outside `projects/`: replaced, and the difference
 *            against the previous delivery tag is reported instead of being
 *            quietly dropped.
 *   Zone B — vendor-managed paths inside a project: three-way merged; the
 *            customer always wins a conflict and the new version is parked
 *            beside theirs as a sidecar.
 *   Zone C — everything else in a project: not touched, not even read.
 *
 * **Only ever call this on a fresh `git clone` temp directory.** Verified, not
 * assumed: on a working checkout the zone-A loop would delete untracked local
 * files, and the customer-side blob map would describe a tree nobody delivered.
 *
 * Nothing is pushed here. The caller pushes after this returns, so an abort
 * mid-merge leaves the customer repository exactly as it was.
 *
 * @param options.projects  `[{ key, vendor }]` — the vendor block per project
 * @param options.version   viewer version; names the sidecars and the new tag
 * @param options.seedMissing  create `add-pending` paths after a human said so
 */
export function applyMergedSnapshot(stagedRoot, cloneRoot, options) {
  const staged = resolve(stagedRoot);
  const clone = resolve(cloneRoot);
  const version = options.version;
  const projects = options.projects ?? [];
  const seedMissing = options.seedMissing ?? false;
  const skipBuildDirs = (_rel, entry) => !isNonDeliveredBuildDir(entry);

  if (!existsSync(join(clone, '.git'))) throw new Error(`applyMergedSnapshot needs a git clone, but ${clone} has no .git.`);
  // R2-6. A dirty tree here means this is not a fresh clone, and the zone-A
  // deletion loop would take local work with it.
  const status = gitIn(clone, ['status', '--porcelain', '--untracked-files=all']);
  if (status.trim()) {
    throw new Error('applyMergedSnapshot requires a clean, freshly cloned working tree; '
      + `${clone} has local modifications and would lose them.`);
  }

  const remoteEmpty = gitIn(clone, ['rev-parse', '--verify', 'HEAD'], { allowFailure: true }) === null;
  const previous = readCloneDeliveryManifest(clone);
  // A tag named in the manifest but absent from the repository is no basis: the
  // tag push may have failed, or the customer may have deleted it. Treating a
  // missing tag as "no baseline" costs an update; trusting it would cost data.
  const baselineTag = !remoteEmpty && previous.baselineTag
    && gitIn(clone, ['rev-parse', '--verify', `refs/tags/${previous.baselineTag}`], { allowFailure: true }) !== null
    ? previous.baselineTag : null;

  // Zone-A drift, read from Git itself so it also names files the customer created
  // and we never delivered — the case a hash map carried in the manifest could not
  // have known about (§2.4, R2-3).
  const drift = [];
  if (baselineTag) {
    const output = gitIn(clone, ['diff', '--name-status', '-z', baselineTag, 'HEAD', '--', '.', ':!projects'],
      { allowFailure: true }) ?? '';
    const fields = output.split('\0').filter(Boolean);
    for (let i = 0; i + 1 < fields.length; i += 2) drift.push({ status: fields[i][0], path: fields[i + 1] });
  }

  const stagedIndex = parseLsFiles(gitIn(staged, ['ls-files', '-s', '-z']));
  const customerIndex = remoteEmpty ? {} : parseLsFiles(gitIn(clone, ['ls-files', '-s', '-z']));
  const baselineIndex = baselineTag ? parseLsTree(gitIn(clone, ['ls-tree', '-r', '-z', baselineTag])) : null;

  // ── Zone A: replace wholesale, exactly as before, but never reaching into
  // projects/ — every project folder, ours or a foreign one, is decided below.
  for (const entry of readdirSync(clone, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'projects') continue;
    rmSync(join(clone, entry.name), { recursive: true, force: true });
  }
  copyTree(staged, clone, (rel, entry) => rel !== '.git' && !rel.startsWith('.git/')
    && !isNonDeliveredBuildDir(entry)
    && rel !== 'projects' && !rel.startsWith('projects/'));

  const report = {};
  for (const { key, vendor } of projects) {
    const stagedProject = projectSubtree(stagedIndex, key);
    const customerProject = projectSubtree(customerIndex, key);
    const baselineProject = baselineIndex ? projectSubtree(baselineIndex, key) : null;
    const projectOut = join(clone, 'projects', key);
    const stagedProjectDir = join(staged, 'projects', key);
    const entry = { seeded: false, added: [], updated: [], removed: [], addPending: [], conflicts: [], keptByCustomer: [] };

    // Seeding, deliberately narrow: an empty remote, or a project that is absent
    // from the clone AND provably never delivered (the baseline exists and does not
    // mention it). Without that proof, "absent" could be a deliberate deletion, and
    // re-creating it would undo one silently — the case F4 exists to prevent.
    const neverDelivered = baselineProject !== null && Object.keys(baselineProject).length === 0;
    if (remoteEmpty || (Object.keys(customerProject).length === 0 && neverDelivered)) {
      entry.seeded = true;
      rmSync(projectOut, { recursive: true, force: true });
      if (existsSync(stagedProjectDir)) copyTree(stagedProjectDir, projectOut, skipBuildDirs);
      report[key] = entry;
      continue;
    }

    const previouslyKept = previous.projects?.[key]?.keptByCustomer;
    const merge = mergeVendorTree({
      baseline: baselineProject,
      customer: customerProject,
      staged: stagedProject,
      vendorGlobs: vendor,
      remoteEmpty: false,
      seedMissing,
      customerOwned: Array.isArray(previouslyKept) ? previouslyKept : [],
    });
    entry.keptByCustomer = nextCustomerOwned(previouslyKept, merge);

    for (const [rel, action] of Object.entries(merge.actions)) {
      const target = join(projectOut, rel);
      if (action === MERGE_ACTION.add || action === MERGE_ACTION.update
        || (action === MERGE_ACTION.addPending && seedMissing)) {
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(join(stagedProjectDir, rel), target);
        (action === MERGE_ACTION.update ? entry.updated : entry.added).push(rel);
      } else if (action === MERGE_ACTION.delete) {
        rmSync(target, { force: true });
        entry.removed.push(rel);
      } else if (action === MERGE_ACTION.addPending) {
        entry.addPending.push(rel);
      }
    }

    // Sidecars. `.gitattributes` is already the delivered one at this point (zone A
    // ran above), so check-attr answers for the tree the customer will actually
    // commit — not for the one they had before.
    const attributeOf = (path) => parseCheckAttr(
      gitIn(clone, ['check-attr', 'filter', '--', `projects/${key}/${path}`], { allowFailure: true }) ?? '');
    for (const conflict of merge.conflicts) {
      const record = { ...conflict, sidecarPath: null };
      if (conflict.sidecar && existsSync(join(stagedProjectDir, conflict.path))) {
        const sidecar = sidecarPathFor(conflict.path, version);
        if (sidecarIsSafe(conflict.path, sidecar, attributeOf)) {
          const target = join(projectOut, sidecar);
          mkdirSync(dirname(target), { recursive: true });
          copyFileSync(join(stagedProjectDir, conflict.path), target);
          record.sidecarPath = sidecar;
        }
      }
      entry.conflicts.push(record);
    }

    mergeCustomerProjectManifest({ projectOut, stagedProjectDir, vendor, version, entry, attributeOf });
    report[key] = entry;
  }

  // The kept-set is delivery state, not staging state — it can only be known after
  // the merge — so it is patched into the manifest that zone A just wrote. It is a
  // short list of paths, not a hash map: the thing §2.4 rejected was carrying a
  // second copy of Git's hash tree, not carrying a decision Git cannot express.
  const manifestPath = join(clone, 'delivery-manifest.json');
  if (existsSync(manifestPath)) {
    const manifest = readJson(manifestPath, 'delivery-manifest.json');
    manifest.projects ??= {};
    for (const [key, entry] of Object.entries(report)) {
      manifest.projects[key] = { ...manifest.projects[key], keptByCustomer: entry.keptByCustomer };
    }
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  }

  const generatedAt = new Date().toISOString();
  const summary = { version, generatedAt, remoteEmpty, baselineTag, projects: report, drift };
  writeFileSync(join(clone, 'DELIVERY-REPORT.md'), renderDeliveryReport(summary));
  return summary;
}

/**
 * Merges `project.json`, the one file that carries both zones (§2.7).
 *
 * It sits at the project root and matches no vendor glob, so the tree merge
 * leaves it alone — which would mean `schemaVersion` and the vendor block, i.e.
 * the entire schema-update channel, could never reach a delivered customer.
 */
function mergeCustomerProjectManifest({ projectOut, stagedProjectDir, vendor, version, entry, attributeOf }) {
  const vendorPath = join(stagedProjectDir, 'project.json');
  if (!existsSync(vendorPath)) return;
  const customerPath = join(projectOut, 'project.json');
  const vendorManifest = readJson(vendorPath, 'delivered project.json');
  if (!existsSync(customerPath)) {
    mkdirSync(projectOut, { recursive: true });
    writeFileSync(customerPath, JSON.stringify(vendorManifest, null, 2) + '\n');
    entry.added.push('project.json');
    return;
  }
  let customerManifest = null;
  try {
    customerManifest = JSON.parse(readFileSync(customerPath, 'utf8'));
  } catch {
    customerManifest = null;
  }
  const { merged, unreadable, changed } = mergeProjectManifest(customerManifest, vendorManifest, vendor);
  if (unreadable) {
    // Merging into a file we cannot parse is a guess, and the guess overwrites a
    // project index. The customer's file stays; ours goes beside it.
    const record = { path: 'project.json', reason: CONFLICT_REASON.bothChanged, sidecar: true, sidecarPath: null };
    const sidecar = sidecarPathFor('project.json', version);
    if (sidecarIsSafe('project.json', sidecar, attributeOf)) {
      writeFileSync(join(projectOut, sidecar), JSON.stringify(vendorManifest, null, 2) + '\n');
      record.sidecarPath = sidecar;
    }
    entry.conflicts.push(record);
    return;
  }
  if (!changed.length) return;
  writeFileSync(customerPath, JSON.stringify(merged, null, 2) + '\n');
  entry.updated.push('project.json');
}

//! Renders the customer-facing change summary between the previously delivered core commit
//! and HEAD. Only feat/fix subjects are listed — wip/chore/merge/test noise stays internal,
//! and the conventional-commit type and scope are stripped so the customer reads plain text.
//! Returns '' whenever the range cannot be resolved; the caller then keeps the bare header.
export function deliveryChangelog(coreRoot, previousCoreCommit, { limit = 25 } = {}) {
  if (typeof previousCoreCommit !== 'string' || !/^[0-9a-f]{7,40}$/i.test(previousCoreCommit)) return '';
  const cwd = resolve(coreRoot);
  let subjects;
  try {
    // The previous commit is unreachable after a history rewrite or a shallow core clone.
    execFileSync('git', ['cat-file', '-e', `${previousCoreCommit}^{commit}`], { cwd, stdio: 'ignore' });
    subjects = execFileSync('git', ['log', '--no-merges', '--format=%s', `${previousCoreCommit}..HEAD`], { cwd, encoding: 'utf8' })
      .split(/\r?\n/).filter(Boolean);
  } catch {
    return '';
  }
  const features = [];
  const fixes = [];
  const seen = new Set();
  for (const subject of subjects) {
    const match = /^(feat|fix)(?:\([^)]*\))?!?:\s*(.+)$/.exec(subject.trim());
    if (!match) continue;
    const text = match[2].trim();
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    (match[1] === 'feat' ? features : fixes).push(text);
  }
  const section = (title, entries) => {
    if (!entries.length) return [];
    const shown = entries.slice(0, limit).map((entry) => `- ${entry}`);
    if (entries.length > limit) shown.push(`- ... and ${entries.length - limit} more`);
    return [`${title}:`, ...shown, ''];
  };
  const body = [...section('New features', features), ...section('Fixes', fixes)];
  if (!body.length) return '';
  return [`Changes since core ${previousCoreCommit.slice(0, 8)}:`, '', ...body].join('\n').trimEnd();
}

/**
 * Creates the reproducibility manifest written into each customer workspace.
 *
 * With `projects` it becomes a v2 manifest and names `baselineTag` — the tag this
 * delivery is about to set, which the NEXT delivery reads back as its merge basis
 * (§2.4). Without it the v1 shape is returned unchanged, so every caller that does
 * not merge (and the existing tests) sees exactly what it saw before.
 *
 * What is deliberately absent: a per-file hash map. The customer repository already
 * keeps a complete hash tree — its own history.
 */
export function createDeliveryManifest({ core, privateRepo, profile, connect, projectRoot, viewerVersion, plasticChangeset = null, projects = null }) {
  const base = {
    viewerVersion,
    plasticChangeset: Number.isInteger(plasticChangeset) ? plasticChangeset : null,
    coreCommit: core.commit,
    privateCommit: privateRepo.commit,
    projectTreeSha256: hashTree(projectRoot),
    profile: { tier: profile.tier, restrictedFeatures: [...(profile.restrictedFeatures ?? [])] },
    generatedAt: new Date().toISOString(),
    connect,
  };
  return projects ? withDeliveryBaseline(base, { version: viewerVersion, projects }) : base;
}

//! One-line merge summary per project for the delivery CLI (§3.1).
export function formatMergeSummary(snapshot) {
  const lines = [];
  for (const [key, project] of Object.entries(snapshot.projects)) {
    if (project.seeded) {
      lines.push(`[merge]   ${key}: erstmalig eingerichtet (Seeding)`);
      continue;
    }
    lines.push(`[merge]   ${key}: +${project.added.length} neu   ~${project.updated.length} aktualisiert`
      + `   -${project.removed.length} entfernt   !${project.conflicts.length} Konflikt`
      + (project.addPending.length ? `   ?${project.addPending.length} fehlend (--seed-missing)` : ''));
  }
  if (snapshot.drift.length) {
    lines.push(`[drift]   ${snapshot.drift.length} Kundenaenderung(en) ausserhalb projects/ erkannt (ueberschrieben, siehe Report)`);
  }
  for (const [key, project] of Object.entries(snapshot.projects)) {
    for (const conflict of project.conflicts) {
      lines.push(`  KONFLIKT  ${key}/${conflict.path}`
        + (conflict.sidecarPath ? `\n            Ihre Version wurde behalten. Neu: ${conflict.sidecarPath}` : ''));
    }
  }
  return lines.join('\n');
}

//! Short conflict note for the delivery commit message, so it is visible in Forgejo.
export function mergeCommitNote(snapshot) {
  const conflicting = Object.entries(snapshot.projects)
    .filter(([, project]) => project.conflicts.length)
    .map(([key, project]) => `${key} (${project.conflicts.length})`);
  if (!conflicting.length) return '';
  return `Conflicts kept on your side: ${conflicting.join(', ')} — see DELIVERY-REPORT.md`;
}

export { summariseMerge };
