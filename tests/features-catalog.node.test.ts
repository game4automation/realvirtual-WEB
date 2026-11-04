// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>
//
// plan-646 Phase 1: the public feature catalog + the private tier manifest are the ONE source
// of the README editions block, the internal FEATURES.md and `generated/features.json`.
//
// The rule-level cases run against a fixture manifest, so they hold in a Community clone too.
// The drift cases (README, FEATURES.md, the real catalog against the real manifest) need the
// private sibling and are skipped without it.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  type FeatureCatalog,
  coreCapabilities,
  listDeliveryConfigs,
  loadFeatureCatalog,
  loadTierManifest,
  renderFeatureMatrix,
  validateFeatureCatalog,
} from '../scripts/_workspace-lib.mjs';
import {
  assertNoHiddenIds,
  buildFeaturesJson,
  extractEditionsBlock,
  generateFeatures,
  hiddenFeatureIds,
  renderEditionsBlock,
  serializeFeaturesJson,
} from '../scripts/gen-features-json.mjs';
import { FEATURES_JSON_SOURCE, featuresJsonPlugin } from '../scripts/vite-plugin-features-json.mjs';

const CORE_ROOT = resolve(__dirname, '..');
const PRIVATE_ROOT = resolve(CORE_ROOT, '../realvirtual-WebViewer-Private~');
const HAS_PRIVATE = existsSync(join(PRIVATE_ROOT, 'tier-manifest.json'));
/** Ids that are restricted/internal today and must never reach anything public. */
const NEVER_PUBLIC = ['agents', 'omniverse', 'aml-import'];

const temps: string[] = [];
afterAll(() => { for (const dir of temps) rmSync(dir, { recursive: true, force: true }); });
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rv-features-catalog-'));
  temps.push(dir);
  return dir;
}

/** A small manifest with every tier the generator has to tell apart. */
function fixtureManifest() {
  const root = tempDir();
  writeFileSync(join(root, 'tier-manifest.json'), JSON.stringify({
    defaults: 'commercial',
    rules: [
      { path: 'src/features/secret.register.ts', tier: 'restricted', feature: 'secret' },
      { path: 'src/features/hush.register.ts', tier: 'internal', feature: 'hush' },
      // An internal provider with a register file but no registration (like aml-import).
      { path: 'src/features/quiet-import.register.ts', tier: 'internal' },
    ],
    registrations: {
      alpha: { adapter: './features/alpha.register', status: 'beta' },
      bravo: { adapter: './features/bravo.register' },
      tools: { adapter: './features/tools.register' },
      secret: { adapter: './features/secret.register' },
      hush: { adapter: './features/hush.register' },
    },
  }));
  return loadTierManifest(root);
}

const BASE_GROUPS = [{ id: 'visualize', label: 'Visualize & HMI' }, { id: 'simulate', label: 'Simulate' }];

function fixtureCatalog(rows: unknown[], groups: unknown[] = BASE_GROUPS): FeatureCatalog {
  return validateFeatureCatalog(JSON.parse(JSON.stringify({
    version: 1,
    editions: { community: 'Community (AGPL)', commercial: 'Commercial', demo: 'Public demo' },
    groups,
    rows,
  })));
}

const BASE_ROWS = [
  { id: 'viewer', label: 'Viewer', group: 'visualize', summary: 'Shows things.', edition: 'community' },
  { id: 'planner', label: 'Planner', group: 'visualize', summary: 'Plans things.', edition: 'community', status: 'beta', demo: { doc: 'doc_plan', mode: 'planner' } },
  { id: 'alpha-row', label: 'Alpha', group: 'simulate', summary: 'Alpha things.', ids: ['alpha'] },
  { id: 'bravo-row', label: 'Bravo', group: 'simulate', summary: 'Bravo things.', ids: ['bravo'], docs: 'components/bravo/' },
  { id: 'internal-tools', label: 'Tools', group: 'simulate', summary: 'Tools.', ids: ['tools'], public: false },
];
const DEMO_DOCS = new Set(['doc_plan']);

function build(rows: unknown[] = BASE_ROWS, groups: unknown[] = BASE_GROUPS) {
  return buildFeaturesJson({ catalog: fixtureCatalog(rows, groups), manifest: fixtureManifest(), demoDocIds: DEMO_DOCS });
}

// The CONNECT interfaces: a group with a footnote and rows that state their cell texts.
const INTERFACE_GROUPS = [...BASE_GROUPS, { id: 'interfaces', label: 'Industrial interfaces', note: '* with a licence. Every tier supports every protocol.' }];
const CELLS = { community: 'Free tier: 20 signals', commercial: 'Unlimited*', demo: 'Free tier: 20 signals' };
const CELL_ROW = { id: 'iface-x', label: 'Fieldbus X', group: 'interfaces', summary: 'Couples X.', docs: 'connect/interfaces/protocols/#x', cells: CELLS };

describe('features.catalog.json schema (plan-646 F1)', () => {
  it('loads the real catalog and keeps the asset editor out of the community rows', () => {
    const catalog = loadFeatureCatalog();
    expect(catalog.rows.length).toBeGreaterThan(10);
    const community = catalog.rows.filter((row) => row.edition === 'community').map((row) => row.id);
    expect(community).toContain('layout-planner');
    expect(community).not.toContain('editor');
    // Every community row and every cells row carries no manifest id; every other row carries ids.
    for (const row of catalog.rows) {
      if (row.edition === 'community' || row.cells) expect(row.ids, row.id).toBeUndefined();
      else expect(row.ids?.length, row.id).toBeGreaterThan(0);
    }
    // The CONNECT interfaces are cells rows, never a community (Core AGPL) row.
    const interfaces = catalog.rows.filter((row) => row.group === 'interfaces');
    expect(interfaces.length).toBeGreaterThan(0);
    for (const row of interfaces) {
      expect(row.cells, row.id).toBeDefined();
      expect(row.edition, row.id).toBeUndefined();
    }
    expect(coreCapabilities(catalog).join('\n')).not.toMatch(/OPC UA|PLCSIM|FANUC/);
  });

  it('accepts a cells row, a group note and a docs anchor', () => {
    const catalog = fixtureCatalog([...BASE_ROWS, CELL_ROW], INTERFACE_GROUPS);
    expect(catalog.rows.at(-1)?.cells).toEqual(CELLS);
    expect(catalog.rows.at(-1)?.docs).toBe('connect/interfaces/protocols/#x');
    expect(catalog.groups.at(-1)?.note).toContain('Every tier');
  });

  it.each([
    ['an empty cell', { cells: { ...CELLS, demo: ' ' } }, /cells\.demo must be a non-empty string/],
    ['a missing cell', { cells: { community: 'a', commercial: 'b' } }, /cells\.demo must be a non-empty string/],
    ['a non-string cell', { cells: { ...CELLS, commercial: true } }, /cells\.commercial must be a non-empty string/],
    ['an unknown cell key', { cells: { ...CELLS, pro: 'x' } }, /unknown field "pro"/],
    ['cells that are not an object', { cells: 'Included' }, /cells/],
    ['a cells row with an edition', { edition: 'community' }, /a cells row carries no edition/],
    ['a cells row with manifest ids', { ids: ['bravo'] }, /a cells row carries no ids/],
    ['a cells row with a status', { status: 'beta' }, /a cells row carries no status/],
    ['a docs anchor with upper case', { docs: 'connect/interfaces/protocols/#Siemens' }, /docs must be a relative path/],
  ])('rejects %s', (_name, patch, message) => {
    expect(() => fixtureCatalog([...BASE_ROWS, { ...CELL_ROW, ...patch }], INTERFACE_GROUPS)).toThrow(message);
  });

  it('rejects an empty group note and an unknown group key', () => {
    expect(() => fixtureCatalog(BASE_ROWS, [...BASE_GROUPS, { id: 'interfaces', label: 'I', note: '' }])).toThrow(/note must be a non-empty string/);
    expect(() => fixtureCatalog(BASE_ROWS, [...BASE_GROUPS, { id: 'interfaces', label: 'I', footnote: 'x' }])).toThrow(/unknown field "footnote"/);
  });

  it.each([
    ['a commercial edition stated in the catalog', { edition: 'commercial' }, /edition may only be "community"/],
    ['a status on a commercial row', { status: 'beta' }, /comes from the manifest/],
    ['an unknown key (e.g. a tier)', { tier: 'commercial' }, /unknown field "tier"/],
    ['an unknown group', { group: 'nowhere' }, /group "nowhere" is not declared/],
    ['an absolute docs path', { docs: '/doc/web/x/' }, /docs must be a relative path/],
    ['an empty summary', { summary: ' ' }, /summary must be a non-empty string/],
  ])('rejects %s', (_name, patch, message) => {
    const rows = BASE_ROWS.map((row) => (row.id === 'alpha-row' ? { ...row, ...patch } : row));
    expect(() => fixtureCatalog(rows)).toThrow(message);
  });

  it('rejects a community row with ids, a hidden community row and a doubled id', () => {
    expect(() => fixtureCatalog([...BASE_ROWS, { id: 'x', label: 'X', group: 'visualize', summary: 'X.', edition: 'community', ids: ['bravo'] }]))
      .toThrow(/community row carries no manifest ids/);
    expect(() => fixtureCatalog([...BASE_ROWS, { id: 'x', label: 'X', group: 'visualize', summary: 'X.', edition: 'community', public: false }]))
      .toThrow(/community row cannot be hidden/);
    expect(() => fixtureCatalog([...BASE_ROWS, { id: 'x', label: 'X', group: 'simulate', summary: 'X.', ids: ['alpha'] }]))
      .toThrow(/"alpha" is assigned to more than one row/);
  });
});

describe('gen-features-json validation (plan-646 F3)', () => {
  it('accepts a catalog that covers every commercial registration, hidden rows included', () => {
    const features = build();
    const ids = features.groups.flatMap((group) => group.rows.map((row) => row.id));
    expect(ids).toEqual(['viewer', 'planner', 'alpha-row', 'bravo-row']);
    expect(ids).not.toContain('internal-tools');
  });

  it('fails when a commercial registration is not assigned to any row', () => {
    const rows = BASE_ROWS.filter((row) => row.id !== 'internal-tools');
    expect(() => build(rows)).toThrow(/commercial registration "tools" is not assigned/);
  });

  it.each([
    ['a restricted id', 'secret', /"secret" is restricted/],
    ['an internal registration', 'hush', /"hush" is internal/],
    ['an internal register file without registration', 'quiet-import', /"quiet-import" is internal/],
    ['an unknown id', 'nope', /unknown manifest id "nope"/],
  ])('fails on %s, also with public:false', (_name, id, message) => {
    const rows = [...BASE_ROWS, { id: 'extra', label: 'Extra', group: 'simulate', summary: 'Extra.', ids: [id], public: false }];
    expect(() => build(rows)).toThrow(message);
  });

  it('fails when a demo document is not part of the demo project', () => {
    const rows = BASE_ROWS.map((row) => (row.id === 'planner' ? { ...row, demo: { doc: 'doc_gone' } } : row));
    expect(() => build(rows)).toThrow(/demo\.doc "doc_gone" is not a document/);
  });

  it('derives beta from the manifest for commercial rows and from status for community rows', () => {
    const status = Object.fromEntries(build().groups.flatMap((group) => group.rows.map((row) => [row.id, row.status])));
    expect(status).toEqual({ viewer: 'stable', planner: 'beta', 'alpha-row': 'beta', 'bravo-row': 'stable' });
  });

  it('writes edition, demo link and docs path per row, every row in the demo', () => {
    const rows = build().groups.flatMap((group) => group.rows);
    expect(rows.find((row) => row.id === 'viewer')?.edition).toBe('community');
    expect(rows.find((row) => row.id === 'bravo-row')).toMatchObject({ edition: 'commercial', docs: 'components/bravo/' });
    expect(rows.find((row) => row.id === 'planner')?.demoUrl).toBe('https://web.realvirtual.io/demo/?doc=doc_plan&mode=planner');
    expect(rows.every((row) => row.inDemo === true)).toBe(true);
  });

  it('passes cells and the group note through, without an edition on the cells row', () => {
    const features = build([...BASE_ROWS, CELL_ROW], INTERFACE_GROUPS);
    const group = features.groups.find((g) => g.id === 'interfaces');
    expect(group?.note).toBe('* with a licence. Every tier supports every protocol.');
    expect(group?.rows).toEqual([{
      id: 'iface-x', label: 'Fieldbus X', summary: 'Couples X.', status: 'stable', inDemo: true,
      docs: 'connect/interfaces/protocols/#x', cells: CELLS,
    }]);
    expect(features.groups.find((g) => g.id === 'visualize')).not.toHaveProperty('note');
  });

  it('renders cell texts and the group note into the README block, Markdown-escaped', () => {
    const block = renderEditionsBlock(build([...BASE_ROWS, CELL_ROW], INTERFACE_GROUPS));
    expect(block).toContain('| [Fieldbus X](https://realvirtual.io/doc/web/connect/interfaces/protocols/#x) | Free tier: 20 signals | Unlimited\\* | Free tier: 20 signals |');
    expect(block).toContain('**Industrial interfaces:** \\* with a licence. Every tier supports every protocol.');
  });

  it('names every restricted/internal feature as hidden and refuses to write one', () => {
    const hidden = hiddenFeatureIds(fixtureManifest());
    expect([...hidden].sort()).toEqual(['hush', 'quiet-import', 'secret']);
    expect(() => assertNoHiddenIds('Includes Secret? no: secret', hidden, 'x')).toThrow(/hidden id "secret"/);
    // Whole tokens only: a longer id that merely contains a hidden one is not a leak.
    expect(() => assertNoHiddenIds('secret-sauce hushed', hidden, 'x')).not.toThrow();
  });

  it('is deterministic: the same inputs give the same bytes', () => {
    expect(serializeFeaturesJson(build())).toBe(serializeFeaturesJson(build()));
    expect(renderEditionsBlock(build())).toBe(renderEditionsBlock(build()));
  });

  it('uses only the agreed edition vocabulary in the README block', () => {
    const block = renderEditionsBlock(build());
    expect(block).toContain('| Feature | Community (AGPL) | Commercial | Public demo |');
    expect(block).not.toMatch(/\bPro(fessional)?\b/);
    // The demo sentence carries no licence wording (plan-646 decision log). Usage: evaluation and
    // non-commercial only (Thomas 2026-11-04, same as the demo notice "Non-commercial use only").
    const demoSentence = block.split('\n').find((line) => line.startsWith('**Public demo:**')) ?? '';
    expect(demoSentence).toContain('free to use for evaluation and non-commercial purposes');
    expect(demoSentence).not.toMatch(/licen[cs]e/i);
  });
});

describe('without the private sibling (Community clone)', () => {
  it('generateFeatures reports the manifest as unavailable', () => {
    const result = generateFeatures({ privateRoot: tempDir() });
    expect(result.available).toBe(false);
  });

  it('the CLI says "manifest not available", exits 0 and writes nothing', () => {
    const dir = tempDir();
    const out = join(dir, 'out', 'features.json');
    const stdout = execFileSync(process.execPath,
      [join(CORE_ROOT, 'scripts', 'gen-features-json.mjs'), '--private', join(dir, 'no-private'), '--out', out],
      { encoding: 'utf8' });
    expect(stdout).toContain('manifest not available');
    expect(existsSync(out)).toBe(false);
  });
});

describe.skipIf(!HAS_PRIVATE)('real catalog against the real manifest (drift, plan-646 F5)', () => {
  const generated = () => {
    const result = generateFeatures();
    if (!result.available) throw new Error('private manifest expected');
    return result;
  };

  it('validates: every commercial registration is covered, no hidden id is referenced', () => {
    expect(() => generated()).not.toThrow();
  });

  it('keeps restricted/internal ids out of the catalog, the README block and features.json', () => {
    const { json, block } = generated();
    const catalogText = readFileSync(join(CORE_ROOT, 'features.catalog.json'), 'utf8');
    const readmeBlock = extractEditionsBlock(readFileSync(join(CORE_ROOT, 'README.md'), 'utf8')) ?? '';
    for (const id of NEVER_PUBLIC) {
      const token = new RegExp(`(?<![A-Za-z0-9-])${id}(?![A-Za-z0-9-])`, 'i');
      expect(catalogText, `catalog names ${id}`).not.toMatch(token);
      expect(readmeBlock, `README names ${id}`).not.toMatch(token);
      expect(block, `generated block names ${id}`).not.toMatch(token);
      expect(json, `features.json names ${id}`).not.toMatch(token);
    }
    expect(json).not.toContain('demo-welcome');
  });

  it('marks the manifest beta features and the community beta rows as beta', () => {
    const rows = Object.fromEntries(generated().features.groups.flatMap((group) => group.rows.map((row) => [row.id, row])));
    expect(rows.physics).toMatchObject({ edition: 'commercial', status: 'beta' });
    expect(rows['virtual-plc']).toMatchObject({ edition: 'commercial', status: 'stable' });
    expect(rows.editor).toMatchObject({ edition: 'commercial', status: 'stable' });
    expect(rows.multiuser).toMatchObject({ edition: 'community', status: 'beta' });
    // Out of beta since 2026-11-03 (Thomas): the planner and guided maintenance are stable.
    expect(rows['layout-planner']).toMatchObject({ edition: 'community', status: 'stable' });
    expect(rows['guided-maintenance']).toMatchObject({ edition: 'commercial', status: 'stable' });
    expect(rows['internal-tools']).toBeUndefined();
  });

  it('the README editions block equals the generated one', () => {
    const readme = readFileSync(join(CORE_ROOT, 'README.md'), 'utf8');
    expect(extractEditionsBlock(readme)).toBe(generated().block);
  });

  it('the CLI --check agrees, and two runs write identical bytes', () => {
    const script = join(CORE_ROOT, 'scripts', 'gen-features-json.mjs');
    expect(execFileSync(process.execPath, [script, '--check'], { encoding: 'utf8' })).toContain('agree');
    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    execFileSync(process.execPath, [script, '--out', join(dir, 'a.json')]);
    execFileSync(process.execPath, [script, '--out', join(dir, 'b.json')]);
    expect(readFileSync(join(dir, 'a.json'), 'utf8')).toBe(readFileSync(join(dir, 'b.json'), 'utf8'));
  });

  it('PRIV/FEATURES.md equals the generated feature matrix, core block from the catalog', () => {
    const manifest = loadTierManifest(PRIVATE_ROOT);
    const expected = renderFeatureMatrix(manifest, listDeliveryConfigs(PRIVATE_ROOT, manifest), null);
    const actual = readFileSync(join(PRIVATE_ROOT, 'FEATURES.md'), 'utf8').replace(/\r\n/g, '\n');
    expect(actual, 'run `node scripts/feature-matrix.mjs --output ../realvirtual-WebViewer-Private~/FEATURES.md`').toBe(expected);
    const core = actual.slice(actual.indexOf('## Core (AGPL)'), actual.indexOf('## Licensed features'));
    for (const capability of coreCapabilities()) expect(core).toContain(`- ${capability}\n`);
    expect(core).not.toContain('Asset and kinematics editor');
    // Every registration has a row, labelled from the catalog where it has a public row.
    for (const feature of Object.keys(manifest.registrations)) expect(actual).toContain(`| ${feature} |`);
    expect(actual).toMatch(/^\| step-import \| commercial \| .* \| CAD import \(STEP/m);
  });
});

// plan-646 Phase 2: the Vite emit only copies generated/features.json; it never generates.
describe('featuresJsonPlugin (dist/features.json)', () => {
  function runEmit(rootDir: string) {
    const emitted: Array<{ type: string; fileName: string; source: Buffer }> = [];
    const plugin = featuresJsonPlugin(rootDir) as unknown as {
      name: string; apply: string; generateBundle(this: { emitFile: (file: unknown) => void }): void;
    };
    plugin.generateBundle.call({ emitFile: (file) => { emitted.push(file as typeof emitted[number]); } });
    return { plugin, emitted };
  }

  it('emits features.json byte for byte when generated/features.json exists', () => {
    const root = tempDir();
    mkdirSync(join(root, FEATURES_JSON_SOURCE, '..'), { recursive: true });
    const body = '{"version":1,"groups":[]}\n';
    writeFileSync(join(root, FEATURES_JSON_SOURCE), body);
    const { plugin, emitted } = runEmit(root);
    expect(plugin.apply).toBe('build');
    expect(emitted).toHaveLength(1);
    expect(emitted[0].type).toBe('asset');
    expect(emitted[0].fileName).toBe('features.json');
    expect(emitted[0].source.toString('utf8')).toBe(body);
  });

  it('emits nothing and does not throw when the file is absent (Community clone, dev build)', () => {
    const root = tempDir();
    mkdirSync(root, { recursive: true });
    const { emitted } = runEmit(root);
    expect(emitted).toEqual([]);
  });

  it('vite.config.ts registers the plugin and imports nothing of the generator', () => {
    const config = readFileSync(join(CORE_ROOT, 'vite.config.ts'), 'utf8');
    expect(config).toContain("from './scripts/vite-plugin-features-json.mjs'");
    expect(config).toContain('featuresJsonPlugin(__dirname)');
    expect(config).not.toMatch(/from\s*['"][^'"]*(gen-features-json|_workspace-lib)/);
  });
});
