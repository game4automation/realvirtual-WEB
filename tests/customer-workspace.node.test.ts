// SPDX-License-Identifier: AGPL-3.0-only
import { closeSync, existsSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyMergedSnapshot,
  assertNoCrossTierLeak,
  assertWorkspaceGuards,
  collectPrivateSourceInventory,
  copyDemoRealvirtualFolder,
  createDeliveryManifest,
  deliveryChangelog,
  gitProvenance,
  hashTree,
  loadTierManifest,
  runBuild,
  stageFilteredSourceTree,
} from '../scripts/_workspace-lib.mjs';
import { knownProjectKeys } from '../scripts/_rv-guards.mjs';
import { findStartDocument } from '../src/core/project/rv-project-documents';
import { assertManifestResolves } from './helpers/assert-manifest-resolves';

const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));
const write = (path: string, text: string) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text); };
const syntheticRequestyKey = () => ['rqsty', 'sk', 'aB3dE5gH7jK9mN2pQ4rS6tV8wX0yZ1cD3fG5hJ7kL9'].join('-');
const syntheticSkKey = () => ['sk', 'aB3dE5gH7jK9mN2pQ4rS6tV8wX0yZ1cD3fG5hJ7kL9'].join('-');
const syntheticJws = () => [
  'eyJhbGciOiJSUzI1NiJ9X1',
  'eyJzdWIiOiJmaXh0dXJlIn0',
  'SyntheticSignature123456',
].join('.');
const syntheticHighEntropyValue = () => ['aB3dE5gH7jK9mN2p', 'Q4rS6tV8wX0yZ1_-'].join('');
const alwaysDeliveredDocs = [
  'doc-webviewer.md', 'doc-extending-webviewer.md', 'doc-scripting.md', 'doc-behaviors.md',
  'doc-behavior-modelling.md', 'doc-events-and-hooks.md', 'doc-signal-architecture.md',
  'doc-webviewer-interface.md', 'doc-document-linking.md', 'doc-web-debugging.md',
  'doc-ai-integration.md', 'doc-unity-to-web.md', 'doc-lifecycle.md', 'doc-persistence.md',
  // Added to ALWAYS_DELIVERED_DOCS by "ship doc-node-paths.md to customers"; the generated
  // workspace guide links it, so a fixture core without it produces a broken-link failure.
  'doc-node-paths.md',
  // Same case, added to ALWAYS_DELIVERED_DOCS by "ship doc-ui-visibility.md, which a delivered
  // doc links to": without it in the fixture core the generated guide links a file that the
  // staged workspace does not carry.
  'doc-ui-visibility.md',
  // Same case again: README.md is a CORE_FILE, always delivered, and its documentation index
  // links here.
  'doc-signal-connection-logic.md',
  // And again, from the 6.3.19 release branch: doc-webviewer.md sends the reader here for the
  // path/AGV task primitive, so the delivered guide links a file the staged workspace must carry.
  'doc-path-fleet-control.md',
];
const workspaceRecipes = [
  'README.md', 'replace-machine-model.md', 'kinematize-cad-import.md', 'connect-live-signals.md',
  'setup-influxdb-historian.md', 'deploy-production-web.md',
  'create-custom-plugin.md', 'troubleshoot-runtime.md', 'setup-appliance.md',
];
// Recipes the delivery copies verbatim out of the core repo's `recipes/` instead of generating
// them (STATIC_CORE_RECIPES in _workspace-lib.mjs). The fixture core must carry them, otherwise
// it is not a faithful stand-in for the repository the delivery reads from.
const staticCoreRecipes = ['kinematize-cad-import.md'];

function buildFixture() {
  const root = mkdtempSync(join(tmpdir(), 'rv-build-cache-test-'));
  temporary.push(root);
  const workspaceRoot = join(root, 'workspace');
  const coreRoot = join(workspaceRoot, 'realvirtual-web');
  const cacheRoot = join(root, 'cache');
  write(join(coreRoot, 'package.json'), '{"name":"build-fixture","version":"1.0.0"}');
  write(join(coreRoot, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}');
  const state = {
    ciCalls: 0,
    buildCalls: 0,
    buildMarkers: [] as string[],
    runner(args: string[], options: { cwd: string }) {
      const nodeModules = join(options.cwd, 'node_modules');
      if (args.length === 1 && args[0] === 'ci') {
        state.ciCalls++;
        rmSync(nodeModules, { recursive: true, force: true });
        write(join(nodeModules, 'install-marker.txt'), `ci-${state.ciCalls}`);
        return;
      }
      if (args.join(' ') === 'run build') {
        state.buildCalls++;
        state.buildMarkers.push(readFileSync(join(nodeModules, 'install-marker.txt'), 'utf8'));
        write(join(options.cwd, 'dist', 'app.js'), `build-${state.buildCalls}`);
        return;
      }
      throw new Error(`Unexpected npm command: ${args.join(' ')}`);
    },
  };
  return { root, workspaceRoot, coreRoot, cacheRoot, state };
}

function withBuildCache<T>(cacheRoot: string, action: () => T): T {
  const previous = process.env.RV_BUILD_CACHE;
  process.env.RV_BUILD_CACHE = cacheRoot;
  try {
    return action();
  } finally {
    if (previous === undefined) delete process.env.RV_BUILD_CACHE;
    else process.env.RV_BUILD_CACHE = previous;
  }
}

// The real provisioning helper lives in the private sibling repo (internal ops
// tooling must never reach the public AGPL remote), so the fixture stands in for
// it — the delivery only copies the file, it never interprets its contents.
const PROVISION_INFLUX_FIXTURE = [
  '// SPDX-License-Identifier: LicenseRef-realvirtual-commercial',
  'export function provisionInflux() { return null; }',
  '',
].join('\n');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'rv-workspace-test-'));
  temporary.push(root);
  const core = join(root, 'core');
  const privateRoot = join(root, 'private');
  write(join(core, 'src', 'main.ts'), 'export {};');
  write(join(core, 'public', 'settings.json'), '{}');
  write(join(core, 'public', 'aasx', 'demo.aasx'), 'fixture');
  // The DEMO project, as ONE FOLDER (plan-737). It is filtered out of a customer
  // deploy by a single subdirectory rule now — the same shape as `scenes/` and
  // `aasx/` — and delivered to the customer as `projects/demo-realvirtual/`.
  write(join(core, 'public', 'demo-realvirtual', 'project.json'), JSON.stringify({
    schemaVersion: 2, id: 'prj_sample', name: 'DemoRealvirtual', kind: 'demo',
    settings: { defaultModel: 'DemoRealvirtualWeb.glb' },
    documents: [{ id: 'doc_a', name: 'Demo', path: 'DemoRealvirtualWeb.glb' }],
  }));
  write(join(core, 'package.json'), '{"name":"core","version":"1.0.0"}');
  write(join(core, 'package-lock.json'), '{"lockfileVersion":3}');
  write(join(core, 'tsconfig.json'), JSON.stringify({ compilerOptions: { paths: {} } }));
  write(join(core, 'webviewer.mcp.md'), '# realvirtual WEB MCP Tools fixture');
  for (const name of staticCoreRecipes) {
    write(join(core, 'recipes', name), `# ${name} fixture\n`);
  }
  // Internal ops helper: lives in the private repo, not on the public remote.
  write(join(privateRoot, 'scripts', 'provision-influx.mjs'), PROVISION_INFLUX_FIXTURE);
  // The delivered reference model is bundled in the core tree's own public/ — staging throws
  // when it is missing, so every fixture carries it.
  write(join(core, 'public', 'demo-realvirtual', 'DemoRealvirtualWeb.glb'), 'fixture:demo-glb');
  write(join(core, 'public', 'demo-realvirtual', 'DemoRealvirtualWeb.settings.json'), '{}');
  write(join(privateRoot, 'scripts', 'get-dependencies.mjs'), '// get-dependencies fixture\n');
  // The shared launcher functions are delivered from the installer payload into the workspace, so
  // the fixture has to carry the same layout the private repository has.
  write(join(privateRoot, 'installer', 'payload', 'rv-launcher.ps1'), 'function Get-RvWorkspaceId { }\n');
  // The optional on-premise appliance ships as a top-level folder from the commercial tier. The
  // fixture carries the runtime artefacts that must NOT travel with it, so the exclusions are
  // covered by every staging test rather than only by the dedicated one.
  write(join(privateRoot, 'appliance', 'install.sh'), '#!/usr/bin/env bash\nset -euo pipefail\n');
  write(join(privateRoot, 'appliance', 'setup-appliance.ps1'), '# appliance bootstrap fixture\n');
  write(join(privateRoot, 'appliance', 'env.sample'), 'RV_APPLIANCE_HOST=<host>\n');
  write(join(privateRoot, 'appliance', 'lib', 'decide.sh'), '# decide fixture\n');
  write(join(privateRoot, 'appliance', '.env'), 'RV_ADMIN_PASSWORD=must-not-ship\n');
  write(join(privateRoot, 'appliance', 'state', 'resume.json'), '{"phase":"E"}');
  write(join(privateRoot, 'appliance', 'tests', 'node_modules', 'vitest', 'index.js'), 'module.exports = {};');
  const referencedImages = [
    'realvirtual-web-demo.jpg', 'screenshot-hmi-overview.png', 'screenshot-layout-planner.jpg',
    'screenshot-drive-chart.png', 'screenshot-hierarchy.png', 'screenshot-settings.png',
  ];
  write(join(core, 'README.md'), '# Core\n\n'
    + referencedImages.map(name => `![${name}](docs/images/${name})`).join('\n')
    + '\n\n[Deploy](doc-deploy.md) [Agent guide](CLAUDE.md) [.claude commands](.claude/commands/)');
  for (const name of referencedImages) write(join(core, 'docs', 'images', name), `image:${name}`);
  write(join(core, 'docs', 'images', 'unreferenced.png'), 'must not ship');
  for (const name of alwaysDeliveredDocs) write(join(core, name), `# ${name}\n`);
  write(join(core, 'DESIGN.md'), '# Customer UI design system\n');
  write(join(core, 'doc-layout-planner.md'), '# Layout planner\n\n![Planner](docs/images/screenshot-layout-planner.jpg)\n');
  write(join(core, 'doc-multiuser-system.md'), '# Multiuser\n');
  for (const name of ['doc-deploy.md', 'doc-plc-programming.md', 'doc-render-picking.md', 'PRODUCT.md']) {
    write(join(core, name), `# forbidden ${name}\n`);
  }
  write(join(core, 'schema', 'v1', 'rv-odt.json'), '{"title":"rv-odt fixture"}');
  for (const name of ['editor.md', 'layout.md', 'simulation.md', 'plc.md', 'des.md']) {
    write(join(core, 'src', 'plugins', 'mcp-bridge', 'help', name), `# ${name} fixture\n`);
  }
  write(join(core, 'src', 'private-stubs', 'plugins', 'des', 'hmi', 'event-queue-overlay.tsx'), [
    "import type { UISlotProps } from '../../../../core/rv-ui-plugin';",
    'export function EventQueueOverlay(_props: UISlotProps): null { return null; }',
  ].join('\n'));
  write(join(core, 'vite.config.ts'), [
    'const normalizedImporter = importer.replace(/\\\\/g, \'/\');',
    "if (!normalizedImporter.includes('realvirtual-WebViewer-Private')",
    "    && !normalizedImporter.includes('realvirtual-web-pro')) return null;",
  ].join('\n'));
  write(join(privateRoot, 'package.json'), '{"name":"private","version":"1.0.0","dependencies":{"safe":"1","@nvidia/test":"1"}}');
  // Shaped like the real private lockfile: one dependency that survives the @nvidia pruning, one
  // that does not, and a transitive package only the pruned one reaches. `npm ci` in the delivered
  // workspace verifies each package against `resolved`/`integrity` from here, so the delivered
  // lockfile must be this file minus @nvidia - not a synthesized stand-in (plan-434 phase 2b).
  write(join(privateRoot, 'package-lock.json'), JSON.stringify({
    name: 'private',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'private', version: '1.0.0', dependencies: { safe: '1', '@nvidia/test': '1' } },
      'node_modules/safe': {
        version: '1.0.0',
        resolved: 'https://registry.npmjs.org/safe/-/safe-1.0.0.tgz',
        integrity: 'sha512-safeintegrity==',
        license: 'MIT',
      },
      'node_modules/@nvidia/test': {
        version: '1.0.0',
        resolved: 'https://edge.urm.nvidia.com/artifactory/api/npm/@nvidia/test/-/test-1.0.0.tgz',
        integrity: 'sha512-nvidiaintegrity==',
        dependencies: { 'nvidia-only': '^1.0.0' },
      },
      'node_modules/nvidia-only': {
        version: '1.0.0',
        resolved: 'https://registry.npmjs.org/nvidia-only/-/nvidia-only-1.0.0.tgz',
        integrity: 'sha512-nvidiaonlyintegrity==',
      },
    },
  }));
  write(join(privateRoot, 'LICENSE-commercial.md'), 'PLACEHOLDER - pending legal review');
  write(join(privateRoot, 'tier-manifest.json'), JSON.stringify({
    defaults: 'internal',
    rules: [
      { path: 'src/commercial/safe.ts', tier: 'commercial' },
      { path: 'src/commercial/register.ts', tier: 'commercial', feature: 'commercial-feature' },
      { path: 'src/restricted/**', tier: 'restricted', feature: 'premium' },
      { path: 'src/layout/**', tier: 'restricted', feature: 'layout-planner' },
      { path: 'src/multiuser/**', tier: 'restricted', feature: 'multiuser' },
    ],
    registrations: {
      // `status: 'beta'` is carried by the ONE feature this delivery selects, so both
      // renderings of it — the README list and the FEATURES.md matrix — are asserted
      // against a real generated workspace rather than against the renderer in isolation.
      'commercial-feature': { adapter: './commercial/register', requires: [], status: 'beta' },
      premium: { adapter: './restricted/register', requires: [] },
      'layout-planner': { adapter: './layout/register', requires: [] },
      multiuser: { adapter: './multiuser/register', requires: [] },
    },
  }));
  write(join(privateRoot, 'src', 'commercial', 'safe.ts'), 'export const safe = true;');
  write(join(privateRoot, 'src', 'commercial', 'register.ts'), 'export async function register() {}');
  write(join(privateRoot, 'src', 'restricted', 'register.ts'), 'export async function register() {}');
  write(join(privateRoot, 'src', 'layout', 'register.ts'), 'export async function register() {}');
  write(join(privateRoot, 'src', 'multiuser', 'register.ts'), 'export async function register() {}');
  write(join(privateRoot, 'src', 'internal', 'sentinel.ts'), 'FOREIGN_INTERNAL_SENTINEL');
  write(join(privateRoot, 'projects', 'acme', 'project.json'), JSON.stringify({ name: 'ACME', settings: { defaultModel: 'models/machine.glb' } }));
  write(join(privateRoot, 'projects', 'acme', 'models', 'machine.glb'), 'fixture');
  write(join(privateRoot, 'projects', 'acme', 'plugins', 'chart.tsx'), [
    "import { FloatingPanel } from '../../../../realvirtual-WebViewer~/src/core/hmi/FloatingPanel';",
    'export const chart = FloatingPanel;',
  ].join('\n'));
  write(join(privateRoot, 'projects', 'acme', 'plugins', 'energy-chart.tsx'), 'export const energyChart = null;');
  write(join(privateRoot, 'projects', 'acme', 'plugins', 'index.ts'), 'export {};');
  const delivery = {
    project: 'ACME', tier: 'commercial' as const, restrictedFeatures: [] as string[], remote: 'git@example.invalid:acme.git',
    mirror: null, connectChannel: 'stable' as const, connectLicenseKey: 'RVC1-PLACEHOLDER', projectKey: 'acme',
  };
  return { core, privateRoot, delivery };
}

//! Turns the fixture core into a Git repository with a known index: the delivery intersects its
//! public/models allowlist with `git ls-files`, so an untracked asset must never be delivered.
function trackPublicModels(core: string, tracked: string[], untracked: string[] = []) {
  for (const rel of tracked) if (!existsSync(join(core, rel))) write(join(core, rel), `fixture:${rel}`);
  execFileSync('git', ['init', '-q'], { cwd: core });
  execFileSync('git', ['add', '--', ...tracked], { cwd: core });
  for (const rel of untracked) write(join(core, rel), `fixture:${rel}`);
}

// Every test in this file stages one or two complete workspaces on disk and
// several of them shell out to git. That does not fit vitest's 5 s default while
// the rest of the node suite runs beside it, so the tests here used to fail by
// schedule rather than by behaviour — reliably enough that the failure was read
// as a known one. The budget is a load allowance, not a performance target.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

describe('customer workspace generator', () => {
  it('populates the tier-profile dependency cache after a fast cache miss', () => {
    const { workspaceRoot, coreRoot, cacheRoot, state } = buildFixture();
    const result = withBuildCache(cacheRoot, () => runBuild(workspaceRoot, {
      fast: true, npmRunner: state.runner,
    })) as ReturnType<typeof runBuild> & { cacheStatus: string };

    const profilesRoot = join(cacheRoot, 'rv-build-cache');
    const profiles = readdirSync(profilesRoot);
    expect(result.cacheStatus).toBe('rebuild');
    expect(state.ciCalls).toBe(1);
    expect(state.buildCalls).toBe(1);
    expect(profiles).toHaveLength(1);
    expect(readFileSync(join(profilesRoot, profiles[0], 'node_modules', 'install-marker.txt'), 'utf8')).toBe('ci-1');
    expect(JSON.parse(readFileSync(join(coreRoot, 'dist', '.rv-build-provenance.json'), 'utf8')).fast).toBe(true);
  });

  it('restores node_modules from cache on the second fast run without npm ci', () => {
    const { workspaceRoot, coreRoot, cacheRoot, state } = buildFixture();
    withBuildCache(cacheRoot, () => runBuild(workspaceRoot, { fast: true, npmRunner: state.runner }));
    const profile = readdirSync(join(cacheRoot, 'rv-build-cache'))[0];
    write(join(cacheRoot, 'rv-build-cache', profile, 'node_modules', 'cache-sentinel.txt'), 'cache-hit');
    rmSync(join(coreRoot, 'node_modules'), { recursive: true, force: true });

    const result = withBuildCache(cacheRoot, () => runBuild(workspaceRoot, {
      fast: true, npmRunner: state.runner,
    })) as ReturnType<typeof runBuild> & { cacheStatus: string };

    expect(result.cacheStatus).toBe('hit');
    expect(state.ciCalls).toBe(1);
    expect(state.buildCalls).toBe(2);
    expect(readFileSync(join(coreRoot, 'node_modules', 'cache-sentinel.txt'), 'utf8')).toBe('cache-hit');
  });

  it('rebuilds the fast cache when an optional pro lockfile changes', () => {
    const { workspaceRoot, coreRoot, cacheRoot, state } = buildFixture();
    const proLock = join(workspaceRoot, 'realvirtual-web-pro', 'package-lock.json');
    write(proLock, '{"lockfileVersion":3,"packages":{"pro":{"version":"1.0.0"}}}');
    withBuildCache(cacheRoot, () => runBuild(workspaceRoot, { fast: true, npmRunner: state.runner }));
    write(proLock, '{"lockfileVersion":3,"packages":{"pro":{"version":"2.0.0"}}}');

    const result = withBuildCache(cacheRoot, () => runBuild(workspaceRoot, {
      fast: true, npmRunner: state.runner,
    })) as ReturnType<typeof runBuild> & { cacheStatus: string };

    expect(result.cacheStatus).toBe('rebuild');
    expect(state.ciCalls).toBe(2);
    expect(state.buildCalls).toBe(2);
    expect(state.buildMarkers).toEqual(['ci-1', 'ci-2']);
    expect(readdirSync(join(cacheRoot, 'rv-build-cache'))).toHaveLength(2);
    expect(readFileSync(join(coreRoot, 'node_modules', 'install-marker.txt'), 'utf8')).toBe('ci-2');
  });

  it('keeps the default build path on a fresh npm ci without using the cache', () => {
    const { workspaceRoot, coreRoot, cacheRoot, state } = buildFixture();
    withBuildCache(cacheRoot, () => {
      runBuild(workspaceRoot, { npmRunner: state.runner });
      runBuild(workspaceRoot, { npmRunner: state.runner });
    });

    expect(state.ciCalls).toBe(2);
    expect(state.buildCalls).toBe(2);
    expect(state.buildMarkers).toEqual(['ci-1', 'ci-2']);
    expect(existsSync(join(cacheRoot, 'rv-build-cache'))).toBe(false);
    expect(JSON.parse(readFileSync(join(coreRoot, 'dist', '.rv-build-provenance.json'), 'utf8')).fast).toBe(false);
  });

  // The delivered workspace installs realvirtual-web-pro with `npm ci`, which rejects any lockfile
  // that does not describe the tree package.json asks for. The generator used to synthesize a
  // root-only lockfile; that passed unnoticed only as long as the @nvidia pruning left no
  // dependency behind at all. Since @dimforge/rapier3d-compat is a regular private dependency the
  // installer really runs `npm ci` there, and a synthetic lockfile kills the delivery (EUSAGE).
  it('delivers a real pruned lockfile for the private package, not a synthetic one', () => {
    const { core, privateRoot, delivery } = fixture();
    const staged = stageFilteredSourceTree({ coreRoot: core, privateRoot, projectKey: 'acme', profile: delivery, delivery });
    temporary.push(staged.workspaceRoot);

    const raw = readFileSync(join(staged.privateRoot!, 'package-lock.json'), 'utf8');
    const lock = JSON.parse(raw);
    const manifest = JSON.parse(readFileSync(join(staged.privateRoot!, 'package.json'), 'utf8'));

    // (a) Surviving dependencies keep their own entry, with the integrity hash npm ci verifies.
    expect(lock.packages['node_modules/safe']).toMatchObject({
      version: '1.0.0',
      resolved: 'https://registry.npmjs.org/safe/-/safe-1.0.0.tgz',
      integrity: 'sha512-safeintegrity==',
    });
    // (b) Nothing @nvidia survives - neither the entry, nor the root edge, nor the private
    // registry URL, which a customer could not reach anyway.
    expect(raw).not.toContain('@nvidia');
    expect(raw).not.toContain('nvidia.com');
    expect(Object.keys(lock.packages).some((key) => key.toLowerCase().includes('@nvidia'))).toBe(false);
    // Transitively reachable only through @nvidia, so it goes with it.
    expect(lock.packages['node_modules/nvidia-only']).toBeUndefined();
    // (c) The root entry states exactly the pruned manifest dependencies; npm ci compares the two.
    expect(lock.packages[''].dependencies).toEqual(manifest.dependencies);
    expect(lock.packages[''].dependencies).toEqual({ safe: '1' });
    expect(lock.lockfileVersion).toBe(3);
    expect(lock.name).toBe(manifest.name);
    expect(lock.version).toBe(manifest.version);
  });

  it('physically excludes internal/restricted source and emits deterministic customer settings', () => {
    const { core, privateRoot, delivery } = fixture();
    const first = stageFilteredSourceTree({ coreRoot: core, privateRoot, projectKey: 'acme', profile: delivery, delivery });
    const second = stageFilteredSourceTree({ coreRoot: core, privateRoot, projectKey: 'acme', profile: delivery, delivery });
    temporary.push(first.workspaceRoot, second.workspaceRoot);
    expect(readFileSync(join(first.privateRoot!, 'src', 'commercial', 'safe.ts'), 'utf8')).toContain('safe');
    expect(() => readFileSync(join(first.privateRoot!, 'src', 'internal', 'sentinel.ts'))).toThrow();
    expect(() => readFileSync(join(first.privateRoot!, 'src', 'restricted', 'register.ts'))).toThrow();
    const settings = JSON.parse(readFileSync(join(first.coreRoot, 'public', 'settings.json'), 'utf8'));
    expect(settings).toMatchObject({ defaultModel: 'machine.glb', connectChannel: 'stable', connectLicensePrefill: 'RVC1-PLACEHOLDER' });
    expect(settings.analytics.googleAnalyticsId).toBe('');
    expect(settings.news).toBeUndefined();
    expect(readFileSync(join(first.privateRoot!, 'package.json'), 'utf8')).not.toContain('@nvidia');
    expect(existsSync(join(first.coreRoot, 'public', 'aasx'))).toBe(false);
    expect(existsSync(join(first.workspaceRoot, 'realvirtual-web', 'webviewer.mcp.md'))).toBe(true);
    expect(existsSync(join(first.workspaceRoot, 'realvirtual-web', 'schema', 'v1', 'rv-odt.json'))).toBe(true);
    // Imported as ?raw by src/plugins/mcp-bridge/rv-mcp-help-tool.ts — the customer build
    // fails to resolve them when they are not staged. They travel inside src/ now, so this
    // asserts the staging of src/ rather than a hand-listed extra directory.
    for (const name of ['editor.md', 'layout.md', 'simulation.md', 'plc.md', 'des.md']) {
      expect(
        existsSync(join(first.coreRoot, 'src', 'plugins', 'mcp-bridge', 'help', name)), name).toBe(true);
    }
    for (const name of alwaysDeliveredDocs) expect(existsSync(join(first.coreRoot, name)), name).toBe(true);
    // DESIGN.md joined PRODUCT.md on the not-from-here list: brand and strategy live in the
    // private sibling and are not published on the public mirror, so this tree cannot deliver
    // them. The customer's authority for the visual system is the code (src/core/hmi/theme.ts).
    for (const name of ['DESIGN.md', 'doc-deploy.md', 'doc-plc-programming.md', 'doc-render-picking.md', 'PRODUCT.md']) {
      expect(existsSync(join(first.coreRoot, name)), name).toBe(false);
    }
    for (const name of [
      'realvirtual-web-demo.jpg', 'screenshot-hmi-overview.png', 'screenshot-layout-planner.jpg',
      'screenshot-drive-chart.png', 'screenshot-hierarchy.png', 'screenshot-settings.png',
    ]) expect(existsSync(join(first.coreRoot, 'docs', 'images', name)), name).toBe(true);
    expect(existsSync(join(first.coreRoot, 'docs', 'images', 'unreferenced.png'))).toBe(false);
    // The customer project AND the demo project (plan-737 F4): every delivery
    // carries the demo as a normal, writable project of its own.
    expect(readdirSync(join(first.workspaceRoot, 'projects')).sort()).toEqual(['acme', 'demo-realvirtual']);
    const readme = readFileSync(join(first.workspaceRoot, 'README.md'), 'utf8');
    expect(readme).toContain('Git LFS is critical');
    expect(readme).toContain('git clone git@example.invalid:acme.git');
    expect(readme).toContain('powershell -NoProfile -ExecutionPolicy Bypass -File .\\start.ps1');
    // A missing Node.js is the most common first-start failure: the README must name the
    // required major version, the PATH refresh, and where start.ps1 actually lives.
    expect(readme).toContain('Node.js 22 LTS (required');
    // The one-click installer is switched off and must not be advertised anywhere in a
    // delivered README - not as the main route and not as an alternative. A download link
    // to something we do not currently support is worse than no link at all.
    expect(readme).not.toContain('setup.exe');
    expect(readme).not.toContain('realvirtual-WEB-dev-setup');
    expect(readme).not.toContain('realvirtual WEB dev');
    // Git is THE documented route, and its prerequisites are stated because nothing
    // brings them along any more.
    expect(readme.indexOf('## How to get started')).toBeGreaterThan(-1);
    expect(readme.indexOf('## How to get started')).toBeLessThan(readme.indexOf('### Set the workspace up'));
    expect(readme).toContain('### What you need installed');
    expect(readme).toContain('**Git and Git LFS:**');
    // The first executable instruction comes before the reference material, not after it.
    expect(readme.indexOf('## How to get started')).toBeLessThan(readme.indexOf('## Reference'));
    expect(readme.indexOf('## How to get started')).toBeLessThan(readme.indexOf('### Your private workspace'));
    expect(readme).toContain('close the terminal and open a new one');
    expect(readme).toContain('from the repository root');
    expect(readme).toContain('is not recognized as a command');
    // Preparation lives in setup.ps1/setup.sh since plan-363 Phase 6; start.ps1/start.sh only
    // start. Both preparation scripts must refuse to run without Node.js instead of failing
    // somewhere inside `npm ci`.
    const setupPs1 = readFileSync(join(first.workspaceRoot, 'setup.ps1'), 'utf8');
    expect(setupPs1).toContain("Get-Command node -ErrorAction SilentlyContinue");
    expect(setupPs1.indexOf('Node.js 22 LTS is required')).toBeLessThan(setupPs1.indexOf('npm ci'));
    // A silent console during the multi-minute first run reads as "hung" to customers, so every
    // stage reports itself.
    for (const stage of ['[1/3]', '[2/3]', '[3/3]']) expect(setupPs1, stage).toContain(stage);
    // The dependency archive must be tried before npm ci, and npm ci must remain the fallback.
    expect(setupPs1.indexOf('tools/get-dependencies.mjs')).toBeLessThan(setupPs1.indexOf('npm ci'));
    expect(setupPs1).toContain('if (-not $restored) {');
    expect(existsSync(join(first.workspaceRoot, 'tools', 'get-dependencies.mjs'))).toBe(true);
    expect(readme).toContain('If the start hangs while installing the dependencies');
    expect(readme).toContain('dependencies.lock.json');
    const startSh = readFileSync(join(first.workspaceRoot, 'start.sh'), 'utf8');
    const setupSh = readFileSync(join(first.workspaceRoot, 'setup.sh'), 'utf8');
    expect(setupSh).toContain('command -v node');
    expect(setupSh.indexOf('Node.js 22 LTS is required')).toBeLessThan(setupSh.indexOf('npm ci'));
    expect(setupSh.indexOf('tools/get-dependencies.mjs')).toBeLessThan(setupSh.indexOf('npm ci'));
    expect(startSh).toContain('"$ROOT/setup.sh"');
    expect(readFileSync(join(first.workspaceRoot, '.nvmrc'), 'utf8').trim()).toBe('22');
    expect(readme).toContain('## Your private workspace');
    expect(readme).toContain('there is no anonymous read access');
    expect(readme).toContain('Hetzner data centre in Helsinki');
    expect(readme).toContain('EU-hosted AI endpoint');
    expect(readme).toContain('Diagnosis.Enabled=false');
    expect(readme).toContain('## Working with the workspace');
    expect(readme).toContain('[workspace recipes](recipes/README.md)');
    // Customer contact address is professional@realvirtual.io — never support@.
    expect(readme).toContain('professional@realvirtual.io');
    expect(readme).not.toContain('support@realvirtual.io');
    // One address for every setup (plan-363 Phase 6): CONNECT serves the Viewer and starts the dev
    // server itself, so the README names a port rather than a second command to run.
    expect(readme).toContain('One address, whichever way the workspace runs');
    expect(readme).toContain('-ConnectPort 5101 -WebPort 5174');
    expect(readme).toContain('projects/acme/plugins/');
    // The feature section is a three-part story: AGPL core + licensed + the customer's own plugins.
    expect(readme).toContain('## Features');
    expect(readme).not.toContain('## Enabled features');
    expect(readme).toContain('Every delivery includes the AGPL core');
    expect(readme).toContain('**Licensed features**');
    expect(readme).toContain('`commercial-feature`');
    // A feature the manifest still calls beta says so where the customer reads it.
    // Before this, only FEATURES.md carried the Status column and the README —
    // the file the delivery actually points at — presented beta work as finished.
    expect(readme).toContain('- `commercial-feature` (BETA)');
    expect(readme).toContain('**Your project**');
    expect(readme).toContain('`chart` (chart.tsx)');
    expect(readme).toContain('`energy-chart` (energy-chart.tsx)');
    expect(readme).not.toContain('`index` (index.ts)');
    // FEATURES.md separates the always-included core, the licensed matrix, and the project plugins.
    const featuresMatrix = readFileSync(join(first.workspaceRoot, 'FEATURES.md'), 'utf8');
    expect(featuresMatrix).toContain('## Core (AGPL) - always included');
    expect(featuresMatrix).toContain('## Licensed features');
    expect(featuresMatrix).toContain('## Your project');
    expect(featuresMatrix).toContain('- Drives (linear and rotational motion)');
    // The layout planner lives in the AGPL core and is registered from src/main.ts, so it
    // ships with every delivery. The asset editor does NOT belong in this list: it is a
    // commercial feature and moves into the private repository.
    expect(featuresMatrix).toContain('- Layout planner');
    expect(featuresMatrix).not.toContain('- Asset editor');
    // In an own repository the delivery is named by its display name - that is the case the
    // shared repository deliberately departs from.
    expect(featuresMatrix).toContain('| Feature | Tier | Status | ACME |');
    expect(readme.startsWith('# ACME\n')).toBe(true);
    expect(featuresMatrix).toContain('| commercial-feature | commercial | beta | yes |');
    // A customer matrix lists only that customer's entitled features, so the unassigned
    // restricted ones do not appear at all - not even as a "no" row (plan-434 Phase 2b).
    expect(featuresMatrix).not.toContain('| premium |');
    expect(featuresMatrix).not.toContain('| layout-planner |');
    expect(featuresMatrix).toContain('- `chart` (chart.tsx)');
    expect(featuresMatrix).toContain('- `energy-chart` (energy-chart.tsx)');
    expect(featuresMatrix).not.toContain('- `index` (index.ts)');
    expect(readme).toContain('## Editions');
    expect(readme).toContain('**Community:**');
    expect(readme).toContain('same licence and codebase as the public Community version');
    expect(readme).toContain('public Community version can be newer or older than this delivered snapshot');
    expect(readme).toContain('`delivery-manifest.json` is authoritative for the version, commit, and changeset');
    expect(readme).not.toContain('It matches the public realvirtual WEB source');
    expect(readme).toContain('realvirtual-web/doc-scripting.md');
    expect(readme).toContain('npx tsc --noEmit');
    const claudeGuide = readFileSync(join(first.workspaceRoot, 'CLAUDE.md'), 'utf8');
    const agentsGuide = readFileSync(join(first.workspaceRoot, 'AGENTS.md'), 'utf8');
    expect(agentsGuide).toBe(claudeGuide);
    expect(claudeGuide).toContain('projects/acme/plugins/index.ts');
    expect(claudeGuide).toContain('realvirtual-web/doc-webviewer.md');
    expect(claudeGuide).toContain('realvirtual-web/webviewer.mcp.md');
    expect(claudeGuide).toContain('[workspace recipes](recipes/README.md)');
    expect(claudeGuide).toContain('canonical, vendor-neutral instructions');
    for (const internalTerm of ['Bunny', 'RV_INTERNAL', 'Assets/realvirtual-WebViewer~']) {
      expect(claudeGuide).not.toContain(internalTerm);
    }
    expect(existsSync(join(first.workspaceRoot, '.claude', 'commands', 'dev.md'))).toBe(true);
    expect(existsSync(join(first.workspaceRoot, '.claude', 'commands', 'build.md'))).toBe(true);
    expect(existsSync(join(first.workspaceRoot, '.claude', 'commands', 'debug.md'))).toBe(true);
    expect(existsSync(join(first.workspaceRoot, '.claude', 'commands', 'inspect.md'))).toBe(false);
    expect(existsSync(join(first.workspaceRoot, '.claude', 'commands', 'test.md'))).toBe(false);
    expect(existsSync(join(first.workspaceRoot, '.claude', 'commands', 'license-check.md'))).toBe(false);
    expect(existsSync(join(first.workspaceRoot, '.claude', 'settings.json'))).toBe(false);
    expect(existsSync(join(first.workspaceRoot, 'docs'))).toBe(false);
    for (const name of workspaceRecipes) {
      expect(existsSync(join(first.workspaceRoot, 'recipes', name)), name).toBe(true);
    }
    const recipeIndex = readFileSync(join(first.workspaceRoot, 'recipes', 'README.md'), 'utf8');
    for (const name of workspaceRecipes.slice(1)) expect(recipeIndex).toContain(`](${name})`);
    const replaceRecipe = readFileSync(join(first.workspaceRoot, 'recipes', 'replace-machine-model.md'), 'utf8');
    expect(replaceRecipe).toContain('../realvirtual-web/doc-unity-to-web.md');
    const deployRecipe = readFileSync(join(first.workspaceRoot, 'recipes', 'deploy-production-web.md'), 'utf8');
    expect(deployRecipe).toContain('Never put secrets in `VITE_*` variables or `settings.json`');
    expect(deployRecipe).toContain('`wss://`');
    expect(deployRecipe).toContain('A public CDN cannot automatically reach an OT network');
    const historianRecipe = readFileSync(join(first.workspaceRoot, 'recipes', 'setup-influxdb-historian.md'), 'utf8');
    expect(historianRecipe).toContain('There is no free-form Bucket field');
    expect(historianRecipe).toContain('CONNECT Settings -> Historian (InfluxDB)');
    expect(historianRecipe).toContain('`acme_raw`');
    expect(historianRecipe).toContain('../tools/provision-influx.mjs');
    expect(historianRecipe).toContain('`Record: true`');
    expect(existsSync(join(first.workspaceRoot, 'tools', 'provision-influx.mjs'))).toBe(true);
    for (const command of ['dev.md', 'build.md', 'debug.md']) {
      expect(readFileSync(join(first.workspaceRoot, '.claude', 'commands', command), 'utf8')).toContain('../../recipes/');
    }
    expect(() => assertWorkspaceGuards(first.workspaceRoot)).not.toThrow();
    expect(hashTree(first.workspaceRoot)).toBe(hashTree(second.workspaceRoot));
    // Explicit timeout: this test stages two full workspaces and hashes both
    // trees. It fits into the 5 s default on an idle machine and does not when
    // the rest of the suite is running beside it, which made it fail by
    // schedule rather than by behaviour.
  }, 60000);

  // Customers get the demo as a PROJECT (plan-737) and the planner gets its component
  // library beside it. Whatever is lying around in the core's public/models/ is scratch
  // and must never be delivered.
  it('delivers the demo project and the curated library, never the core public models', () => {
    const { core, privateRoot, delivery } = fixture();
    write(join(core, 'src', 'plugins', 'layout-planner', 'index.ts'), 'export const LayoutPlannerPlugin = null;');
    const projectRoot = join(core, 'public');
    write(join(projectRoot, 'library', 'catalog.json'), JSON.stringify({
      version: '1.0',
      name: 'realvirtual Library',
      entries: [
        { id: 'pallethandling-roll-conveyor-1m', name: 'Roll Conveyor 1m', category: 'Pallet Handling', glbUrl: 'PalletHandling/RollConveyor-1m.glb' },
        { id: 'custom-other-customer', name: 'Other Customer', category: 'Custom', glbUrl: 'Custom/other-customer.glb' },
      ],
    }));
    write(join(projectRoot, 'library', 'PalletHandling', 'RollConveyor-1m.glb'), 'fixture:roll');
    write(join(projectRoot, 'library', 'Custom', 'other-customer.glb'), 'fixture:custom');
    trackPublicModels(core, ['public/models/tests.glb']);

    const staged = stageFilteredSourceTree({ coreRoot: core, privateRoot, projectKey: 'acme', profile: delivery, delivery });
    temporary.push(staged.workspaceRoot);

    const models = join(staged.coreRoot, 'public', 'models');
    // The library stays APP-LEVEL, in the deploy — one copy, shared by every project.
    const library = join(staged.coreRoot, 'public', 'library');
    // The demo is a PROJECT now, so it arrives under projects/ — writable, complete,
    // and carrying its own manifest instead of being a loose GLB on the deploy root.
    const demo = join(staged.workspaceRoot, 'projects', 'demo-realvirtual');
    expect(existsSync(join(demo, 'project.json'))).toBe(true);
    expect(existsSync(join(demo, 'DemoRealvirtualWeb.glb'))).toBe(true);
    expect(existsSync(join(demo, 'DemoRealvirtualWeb.settings.json'))).toBe(true);
    // …and NOT as a loose reference model on the deploy root any more.
    expect(existsSync(join(models, 'DemoRealvirtualWeb.glb'))).toBe(false);
    expect(existsSync(join(library, 'PalletHandling', 'RollConveyor-1m.glb'))).toBe(true);
    // A core scratch model, and a library category that is never delivered — neither may
    // appear, not even as an empty directory.
    expect(existsSync(join(models, 'tests.glb'))).toBe(false);
    expect(existsSync(join(library, 'Custom'))).toBe(false);
    // Delivering the project catalog verbatim would 404 on the undelivered entries and expose
    // their names in the planner library UI.
    const catalog = JSON.parse(readFileSync(join(library, 'catalog.json'), 'utf8'));
    expect(catalog.entries.map((entry: { id: string }) => entry.id)).toEqual(['pallethandling-roll-conveyor-1m']);
    expect(readFileSync(join(staged.workspaceRoot, '.gitattributes'), 'utf8'))
      .toContain('realvirtual-web/public/models/*.glb filter=lfs diff=lfs merge=lfs -text');
  });

  // ── plan-726 F13: the demo manifest must not leak into a delivery ─────
  //
  // `public/project.json` is the DEMO project's manifest, and a customer deploy
  // that carries it at its root gets it read by `BundledBackend.readManifest()`
  // — which is the same code path that reads the customer's own project. The
  // customer would see realvirtual's demo project instead of their machine.
  //
  // It needed its own filter branch because every pre-existing exclusion in
  // `copyCore()` filters a SUBDIRECTORY (`scenes/`, `aasx/`, `library/`), and a
  // top-level file sails straight past all of them.
  it('never delivers the demo project onto a customer deploy root', () => {
    const { core, privateRoot, delivery } = fixture();
    const staged = stageFilteredSourceTree({ coreRoot: core, privateRoot, projectKey: 'acme', profile: delivery, delivery });
    temporary.push(staged.workspaceRoot);

    expect(existsSync(join(staged.coreRoot, 'public', 'demo-realvirtual'))).toBe(false);
    // It is not absent, though — it is somewhere better (plan-737 F4).
    expect(existsSync(join(staged.workspaceRoot, 'projects', 'demo-realvirtual', 'project.json'))).toBe(true);
    // The neighbours it is filtered alongside, restated so a regression that
    // widened the filter the wrong way is visible here too.
    expect(existsSync(join(staged.coreRoot, 'public', 'aasx'))).toBe(false);
    expect(existsSync(join(staged.coreRoot, 'public', 'scenes'))).toBe(false);
    // …and the file the customer DOES get at that level still arrives.
    expect(existsSync(join(staged.coreRoot, 'public', 'settings.json'))).toBe(true);
  });

  it('DOES stage the demo manifest for the public demo build', () => {
    // The other side of the same switch: `bunny-deploy --demo` and the public
    // deploy both pass `includePublicDemoContent`, and for them the manifest is
    // the point — it is what the hosted demo boots from.
    const { core, privateRoot } = fixture();
    const staged = stageFilteredSourceTree({
      coreRoot: core,
      privateRoot,
      profile: { tier: 'commercial', restrictedFeatures: [] },
      includePublicDemoContent: true,
      workspaceFiles: false,
    });
    temporary.push(staged.workspaceRoot);

    expect(existsSync(join(staged.coreRoot, 'public', 'demo-realvirtual', 'project.json'))).toBe(true);
    expect(existsSync(join(staged.coreRoot, 'public', 'aasx', 'demo.aasx'))).toBe(true);
    // The public demo reads the folder in place; it must NOT also be staged as a
    // second copy under projects/, or the hosted demo would list itself twice.
    expect(existsSync(join(staged.workspaceRoot, 'projects', 'demo-realvirtual'))).toBe(false);
  });

  // The plan-735 regression, pinned: `--demo` is ALSO projectless and ALSO
  // commercial-tier, so it reaches the branch that generates the vendor delivery
  // manifest — and that generator overwrote the very file `copyCore()` had just
  // been told to keep. The hosted demo then booted `prj_delivery_standard`
  // (kind `delivery`, reference model only) instead of the authored demo
  // project. Existence alone did not catch it; the IDENTITY has to be asserted.
  it('keeps the AUTHORIZED demo manifest for the public demo build', () => {
    const { core, privateRoot } = fixture();
    write(join(core, 'public', 'demo-realvirtual', 'DemoPlanner.glb'), 'fixture:planner');
    write(join(core, 'public', 'demo-realvirtual', 'project.json'), JSON.stringify({
      schemaVersion: 2,
      id: 'prj_sample',
      name: 'DemoRealvirtual',
      kind: 'demo',
      settings: { defaultModel: 'DemoRealvirtualWeb.glb' },
      documents: [
        { id: 'doc_a', name: 'Demo', path: 'DemoRealvirtualWeb.glb' },
        { id: 'doc_d', name: 'Layout Planner Demo', path: 'DemoPlanner.glb' },
      ],
    }));

    const staged = stageFilteredSourceTree({
      coreRoot: core,
      privateRoot,
      profile: { tier: 'commercial', restrictedFeatures: [] },
      includePublicDemoContent: true,
      workspaceFiles: false,
    });
    temporary.push(staged.workspaceRoot);

    const manifest = JSON.parse(
      readFileSync(join(staged.coreRoot, 'public', 'demo-realvirtual', 'project.json'), 'utf8'));
    expect(manifest.id).toBe('prj_sample');
    expect(manifest.kind).toBe('demo');
    expect(manifest.documents.map((d: { path: string }) => d.path))
      .toContain('DemoPlanner.glb');
    // …and not a trace of the generated one.
    expect(manifest.id).not.toMatch(/^prj_delivery_/);
    expect(manifest._generated).toBeUndefined();
  });

  it('omits the bundled library when the layout planner is not part of the core', () => {
    const { core, privateRoot, delivery } = fixture();
    write(join(core, 'public', 'library', 'PalletHandling', 'RollConveyor-1m.glb'), 'fixture:roll');

    const staged = stageFilteredSourceTree({ coreRoot: core, privateRoot, projectKey: 'acme', profile: delivery, delivery });
    temporary.push(staged.workspaceRoot);

    // The demo project still travels — it does not depend on the planner.
    expect(existsSync(join(staged.workspaceRoot, 'projects', 'demo-realvirtual', 'DemoRealvirtualWeb.glb'))).toBe(true);
    expect(existsSync(join(staged.coreRoot, 'public', 'library'))).toBe(false);
  });

  // The "reference model is missing" guard went with the reference model itself
  // (plan-737). What replaced it is stronger: the demo travels as a whole project,
  // and `assertManifestResolves()` checks that EVERY row of it resolves to bytes —
  // where the old guard only ever checked that one named file existed.
  it('delivers a demo project whose every document resolves', () => {
    const { core, privateRoot, delivery } = fixture();
    trackPublicModels(core, ['public/models/tests.glb']);
    const staged = stageFilteredSourceTree({ coreRoot: core, privateRoot, projectKey: 'acme', profile: delivery, delivery });
    temporary.push(staged.workspaceRoot);

    const demo = join(staged.workspaceRoot, 'projects', 'demo-realvirtual');
    const gate = assertManifestResolves(demo);
    expect(gate.documents.map(d => d.path)).toContain('DemoRealvirtualWeb.glb');
    expect(gate.start.path).toBe('DemoRealvirtualWeb.glb');
  });

  // Always-overwrite (user decision): the demo is vendor-owned sample content, so a
  // re-delivery REPLACES it rather than merging — anything the customer left in that
  // folder is gone, which is what `demo.knowledge.md` tells them in as many words.
  it('replaces an existing demo project wholesale on re-delivery', () => {
    const { core, privateRoot, delivery } = fixture();
    const first = stageFilteredSourceTree({ coreRoot: core, privateRoot, projectKey: 'acme', profile: delivery, delivery });
    temporary.push(first.workspaceRoot);

    // The customer edits the demo and leaves a file of their own in it.
    const demo = join(first.workspaceRoot, 'projects', 'demo-realvirtual');
    write(join(demo, 'MyOwnEdit.glb'), 'customer:edit');
    write(join(demo, 'DemoRealvirtualWeb.glb'), 'customer:overwritten');

    // A second delivery into the SAME workspace root — what a re-delivery does.
    copyDemoRealvirtualFolder(core, first.workspaceRoot);

    expect(existsSync(join(demo, 'MyOwnEdit.glb'))).toBe(false);
    expect(readFileSync(join(demo, 'DemoRealvirtualWeb.glb'), 'utf8')).toBe('fixture:demo-glb');
  });

  it('stages stub fallbacks for excluded private modules and adapts the flat customer layout', () => {
    const { core, privateRoot, delivery } = fixture();
    const manifest = loadTierManifest(privateRoot);
    const staged = stageFilteredSourceTree({ coreRoot: core, privateRoot, projectKey: 'acme', profile: delivery, delivery });
    temporary.push(staged.workspaceRoot);
    // Tier-excluded @rv-private module exists as its public stub with rewritten core imports.
    const stubPath = join(staged.privateRoot!, 'src', 'plugins', 'des', 'hmi', 'event-queue-overlay.tsx');
    expect(readFileSync(stubPath, 'utf8')).toContain("from '../../../../../realvirtual-web/src/core/rv-ui-plugin'");
    expect(() => assertNoCrossTierLeak(staged.workspaceRoot, manifest, delivery)).not.toThrow();
    // Customer project files move one level up: sibling imports lose exactly one `../`.
    const chart = readFileSync(join(staged.workspaceRoot, 'projects', 'acme', 'plugins', 'chart.tsx'), 'utf8');
    expect(chart).toContain("from '../../../realvirtual-web/src/core/hmi/FloatingPanel'");
    // Staged vite.config resolves bare imports from the workspace projects/ tree.
    const viteConfig = readFileSync(join(staged.coreRoot, 'vite.config.ts'), 'utf8');
    expect(viteConfig).toContain("resolve(__dirname, '../projects')");
    // A tampered stub is no longer exempt from the cross-tier leak check.
    writeFileSync(stubPath, readFileSync(stubPath, 'utf8') + '\nexport const tampered = true;');
    expect(() => assertNoCrossTierLeak(staged.workspaceRoot, manifest, delivery)).toThrow(/Cross-tier source leak/);
  });

  it('adds restricted source only for an explicit entitlement', () => {
    const { core, privateRoot, delivery } = fixture();
    const staged = stageFilteredSourceTree({
      coreRoot: core, privateRoot, projectKey: 'acme', delivery,
      profile: { ...delivery, restrictedFeatures: ['premium'] },
    });
    temporary.push(staged.workspaceRoot);
    expect(existsSync(join(staged.privateRoot!, 'src', 'restricted', 'register.ts'))).toBe(true);
    expect(existsSync(join(staged.privateRoot!, 'src', 'internal', 'sentinel.ts'))).toBe(false);
  });

  it('delivers entitlement-bound documentation only with the matching feature', () => {
    const { core, privateRoot, delivery } = fixture();
    const staged = stageFilteredSourceTree({
      coreRoot: core, privateRoot, projectKey: 'acme', delivery,
      profile: { ...delivery, restrictedFeatures: ['layout-planner'] },
    });
    temporary.push(staged.workspaceRoot);
    expect(existsSync(join(staged.coreRoot, 'doc-layout-planner.md'))).toBe(true);
    expect(existsSync(join(staged.coreRoot, 'doc-multiuser-system.md'))).toBe(false);
  });

  it('generates only ASCII-printable text in delivered workspace documents', () => {
    // Regression guard: a customer delivery once shipped mojibake ("â€”", "â†’", U+FFFD)
    // because generator template strings contained non-ASCII bytes. Every generated text
    // file must contain only printable ASCII plus line breaks (and tabs).
    const { core, privateRoot, delivery } = fixture();
    const staged = stageFilteredSourceTree({ coreRoot: core, privateRoot, projectKey: 'acme', profile: delivery, delivery });
    temporary.push(staged.workspaceRoot);
    const targets: string[] = [];
    for (const entry of readdirSync(staged.workspaceRoot)) {
      if (entry.toLowerCase().endsWith('.md')) targets.push(join(staged.workspaceRoot, entry));
    }
    for (const directory of ['recipes', join('.claude', 'commands')]) {
      const absolute = join(staged.workspaceRoot, directory);
      if (!existsSync(absolute)) continue;
      for (const entry of readdirSync(absolute)) targets.push(join(absolute, entry));
    }
    for (const required of ['README.md', 'CLAUDE.md', 'AGENTS.md', 'FEATURES.md']) {
      expect(targets.some((path) => path.endsWith(required)), `${required} staged`).toBe(true);
    }
    expect(targets.length).toBeGreaterThanOrEqual(workspaceRecipes.length + 4);
    const offenders: string[] = [];
    for (const file of targets) {
      // latin1 maps every raw byte to one char, so the scan sees the bytes as written to disk.
      const bytes = readFileSync(file, 'latin1');
      const offending = /[^\x20-\x7E\r\n\t]/.exec(bytes);
      if (!offending) continue;
      const byte = offending[0].charCodeAt(0);
      offenders.push(`${file}: first offending byte 0x${byte.toString(16).padStart(2, '0')} at offset ${offending.index}`);
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('fails the documentation guard when a referenced image is missing', () => {
    const { core, privateRoot, delivery } = fixture();
    const staged = stageFilteredSourceTree({ coreRoot: core, privateRoot, projectKey: 'acme', profile: delivery, delivery });
    temporary.push(staged.workspaceRoot);
    rmSync(join(staged.coreRoot, 'docs', 'images', 'screenshot-settings.png'));
    expect(() => assertWorkspaceGuards(staged.workspaceRoot)).toThrow(/Broken Markdown link.*screenshot-settings\.png/);
  });

  it('fails the documentation guard when an indexed workspace recipe is missing', () => {
    const { core, privateRoot, delivery } = fixture();
    const staged = stageFilteredSourceTree({ coreRoot: core, privateRoot, projectKey: 'acme', profile: delivery, delivery });
    temporary.push(staged.workspaceRoot);
    rmSync(join(staged.workspaceRoot, 'recipes', 'troubleshoot-runtime.md'));
    expect(() => assertWorkspaceGuards(staged.workspaceRoot)).toThrow(/Broken Markdown link.*troubleshoot-runtime\.md/);
  });

  it('tracks oversized customer GLB models with the generated Git LFS rule', () => {
    const { core, privateRoot, delivery } = fixture();
    const staged = stageFilteredSourceTree({ coreRoot: core, privateRoot, projectKey: 'acme', profile: delivery, delivery });
    temporary.push(staged.workspaceRoot);
    const modelPath = join(staged.workspaceRoot, 'projects', 'acme', 'models', 'machine.glb');
    const handle = openSync(modelPath, 'w');
    ftruncateSync(handle, 91 * 1024 * 1024);
    closeSync(handle);
    execFileSync('git', ['init', '-b', 'main'], { cwd: staged.workspaceRoot });
    execFileSync('git', ['add', '--', '.gitattributes'], { cwd: staged.workspaceRoot });
    const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${'0'.repeat(64)}\nsize ${91 * 1024 * 1024}\n`;
    const pointerOid = execFileSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: staged.workspaceRoot,
      input: pointer,
      encoding: 'utf8',
    }).trim();
    execFileSync('git', [
      'update-index', '--add', '--cacheinfo',
      `100644,${pointerOid},projects/acme/models/machine.glb`,
    ], { cwd: staged.workspaceRoot });

    const attributes = readFileSync(join(staged.workspaceRoot, '.gitattributes'), 'utf8');
    expect(attributes).toContain('connect/rag.zip filter=lfs diff=lfs merge=lfs -text');
    // plan-716: the folder is a place, not a type — any GLB anywhere inside a
    // project is tracked, not only a mandated models/ subfolder.
    expect(attributes).toContain('projects/**/*.glb filter=lfs diff=lfs merge=lfs -text');
    const attr = execFileSync('git', ['check-attr', 'filter', '--', 'projects/acme/models/machine.glb'], {
      cwd: staged.workspaceRoot,
      encoding: 'utf8',
    });
    expect(attr).toMatch(/filter:\s*lfs\s*$/);
    expect(() => assertWorkspaceGuards(staged.workspaceRoot, { lfsRepoRoot: staged.workspaceRoot })).not.toThrow();
  });

  it('allows only the schema-exact delivered secret locations', () => {
    const root = mkdtempSync(join(tmpdir(), 'rv-guard-test-'));
    temporary.push(root);
    write(join(root, 'connect', 'project-config.json'), JSON.stringify({
      Diagnosis: { RequestyApiKey: syntheticRequestyKey() },
      Agents: { DeliveredApiKeys: { 'cloud-eu-france': syntheticRequestyKey() } },
    }));
    write(join(root, 'realvirtual-web', 'public', 'settings.json'), JSON.stringify({ connectLicensePrefill: 'RVC1-PLACEHOLDER' }));
    expect(() => assertWorkspaceGuards(root)).not.toThrow();
    write(join(root, 'connect', 'project-config.json'), JSON.stringify({ Agents: { ApiKey: syntheticRequestyKey() } }));
    expect(() => assertWorkspaceGuards(root)).toThrow(/allowed schema path/);
    write(join(root, 'connect', 'project-config.json'), JSON.stringify({
      Agents: { Backends: { injected: { CloudApiKey: syntheticRequestyKey() } } },
    }));
    expect(() => assertWorkspaceGuards(root)).toThrow(/allowed schema path/);
    write(join(root, 'wrong.json'), JSON.stringify({ RequestyApiKey: syntheticRequestyKey() }));
    expect(() => assertWorkspaceGuards(root)).toThrow(/allowed schema path/);
  });

  it('ignores secret-related words in source comments, identifiers, types, and documentation strings', () => {
    const root = mkdtempSync(join(tmpdir(), 'rv-guard-test-'));
    temporary.push(root);
    write(join(root, 'password-gate.tsx'), [
      '// The password gate never stores a secret or token.',
      'type SecretTokenState = { passwordAccepted: boolean };',
      'const apiKeyDocumentation = "Enter your API key or password in the secure prompt.";',
      'export const passwordGate: SecretTokenState = { passwordAccepted: false };',
    ].join('\n'));
    expect(() => assertWorkspaceGuards(root)).not.toThrow();
  });

  it('allows GLB node and import paths while rejecting a slash-free high-entropy value', () => {
    const root = mkdtempSync(join(tmpdir(), 'rv-guard-test-'));
    temporary.push(root);
    write(join(root, 'paths.ts'), [
      'const nodePath = "MauserCageline30glb/3125524_low_qual_071125_CL/DriveTechnology";',
      'const componentRegistry = "rv/core/engine/rv-component-registry";',
    ].join('\n'));
    expect(() => assertWorkspaceGuards(root)).not.toThrow();

    write(join(root, 'random-value.ts'), `export const value = "${syntheticHighEntropyValue()}";`);
    expect(() => assertWorkspaceGuards(root)).toThrow(/High-entropy string literal/);
  });

  it('allows a standard slash-free package integrity digest', () => {
    const root = mkdtempSync(join(tmpdir(), 'rv-guard-test-'));
    temporary.push(root);
    const integrity = 'sha512-z69Ne9pVetSA745fVyCoiNnv9cIy4KLe29T6NDSFcB6EZHdAO8MCzwvonigCO1T3WWGl1Yiw+hv3lJB8j4jwIA==';
    write(join(root, 'package-lock.json'), JSON.stringify({ packages: { dependency: { integrity } } }));
    expect(() => assertWorkspaceGuards(root)).not.toThrow();
  });

  it('allows hexadecimal digests while still rejecting mixed-class high-entropy values', () => {
    const root = mkdtempSync(join(tmpdir(), 'rv-guard-test-'));
    temporary.push(root);
    const sha256 = '0123456789abcdefABCDEF0123456789'.repeat(2);
    write(join(root, 'connect.lock.json'), JSON.stringify({
      channel: 'stable',
      version: '0.1.0+21',
      url: 'https://web.realvirtual.io/download/versions/realvirtual-Connect-0.1.0+21.exe',
      sha256,
    }));
    expect(() => assertWorkspaceGuards(root)).not.toThrow();

    const mixedClassValue = syntheticHighEntropyValue();
    write(join(root, 'delivery-manifest.json'), JSON.stringify({ value: mixedClassValue }));
    expect(() => assertWorkspaceGuards(root)).toThrow(/High-entropy string literal/);
  });

  it('still rejects key-format secrets embedded in URL query strings', () => {
    const root = mkdtempSync(join(tmpdir(), 'rv-guard-test-'));
    temporary.push(root);
    write(join(root, 'connect.lock.json'), JSON.stringify({
      url: `https://web.realvirtual.io/download/versions/connect.exe?key=${syntheticSkKey()}`,
    }));
    expect(() => assertWorkspaceGuards(root)).toThrow(/Token-like secret/);
  });

  it('blocks nested Git metadata, env files, compact JWS values, and oversized blobs', () => {
    const root = mkdtempSync(join(tmpdir(), 'rv-guard-test-'));
    temporary.push(root);
    write(join(root, 'nested', '.git', 'config'), 'fixture');
    expect(() => assertWorkspaceGuards(root)).toThrow(/Nested .git/);
    rmSync(join(root, 'nested'), { recursive: true, force: true });
    write(join(root, '.env.local'), 'FIXTURE=value');
    expect(() => assertWorkspaceGuards(root)).toThrow(/Secret-bearing/);
    rmSync(join(root, '.env.local'));
    write(join(root, 'source.ts'), `export const requesty = "${syntheticRequestyKey()}";`);
    expect(() => assertWorkspaceGuards(root)).toThrow(/allowed schema path/);
    rmSync(join(root, 'source.ts'));
    write(join(root, 'source.test.ts'), `export const fixture = "${syntheticHighEntropyValue()}";`);
    expect(() => assertWorkspaceGuards(root)).not.toThrow();
    rmSync(join(root, 'source.test.ts'));
    write(join(root, 'source.ts'), `export const value = "${syntheticHighEntropyValue()}";`);
    expect(() => assertWorkspaceGuards(root)).toThrow(/High-entropy string literal/);
    rmSync(join(root, 'source.ts'));
    write(join(root, 'data.txt'), syntheticJws());
    expect(() => assertWorkspaceGuards(root)).toThrow(/Compact JWS/);
    rmSync(join(root, 'data.txt'));
    const large = join(root, 'projects', 'acme', 'docs', 'big.bin');
    mkdirSync(join(large, '..'), { recursive: true });
    const handle = openSync(large, 'w');
    ftruncateSync(handle, 91 * 1024 * 1024);
    closeSync(handle);
    expect(() => assertWorkspaceGuards(root)).toThrow(/Oversized delivery file: projects\/acme\/docs\/big\.bin/);
  });

  it('skips node_modules and dist at every level in the link scan and snapshot copy', () => {
    const { core, privateRoot, delivery } = fixture();
    const staged = stageFilteredSourceTree({ coreRoot: core, privateRoot, projectKey: 'acme', profile: delivery, delivery });
    temporary.push(staged.workspaceRoot);
    // A --fast build restores the dependency cache as a junction (Windows) or symlink
    // into the staging tree; both directories are excluded by the generated .gitignore.
    const cachedNodeModules = mkdtempSync(join(tmpdir(), 'rv-cached-node-modules-'));
    temporary.push(cachedNodeModules);
    write(join(cachedNodeModules, 'left-pad', 'index.js'), 'module.exports = 1;');
    symlinkSync(cachedNodeModules, join(staged.coreRoot, 'node_modules'), 'junction');
    symlinkSync(cachedNodeModules, join(staged.workspaceRoot, 'projects', 'acme', 'plugins', 'node_modules'), 'junction');
    write(join(staged.coreRoot, 'dist', 'assets', 'app.js'), 'built');
    expect(() => assertWorkspaceGuards(staged.workspaceRoot)).not.toThrow();

    const clone = mkdtempSync(join(tmpdir(), 'rv-snapshot-clone-'));
    temporary.push(clone);
    // applyMergedSnapshot reads blob OIDs out of Git on both sides, so both are real
    // repositories now; an empty clone is the first-delivery (seeding) case.
    execFileSync('git', ['init', '-b', 'main'], { cwd: clone, stdio: 'ignore' });
    execFileSync('git', ['init', '-b', 'main'], { cwd: staged.workspaceRoot, stdio: 'ignore' });
    execFileSync('git', ['add', '-A'], { cwd: staged.workspaceRoot, stdio: 'ignore' });
    applyMergedSnapshot(staged.workspaceRoot, clone, { projects: [{ key: 'acme', vendor: null }], version: '9.9.9' });
    expect(existsSync(join(clone, 'realvirtual-web', 'node_modules'))).toBe(false);
    expect(existsSync(join(clone, 'realvirtual-web', 'dist'))).toBe(false);
    expect(existsSync(join(clone, 'realvirtual-web', 'package.json'))).toBe(true);
    // Same reason as above: staging plus two `git init`/`git add` subprocesses
    // does not fit the 5 s default while the suite runs in parallel.
  }, 60000);

  it('still rejects a link inside delivered project content', () => {
    const { core, privateRoot, delivery } = fixture();
    const staged = stageFilteredSourceTree({ coreRoot: core, privateRoot, projectKey: 'acme', profile: delivery, delivery });
    temporary.push(staged.workspaceRoot);
    const linkTarget = mkdtempSync(join(tmpdir(), 'rv-link-target-'));
    temporary.push(linkTarget);
    symlinkSync(linkTarget, join(staged.workspaceRoot, 'projects', 'acme', 'linked-docs'), 'junction');
    expect(() => assertWorkspaceGuards(staged.workspaceRoot)).toThrow(/Links are not allowed/);
  });

  it('pushes the snapshot of an LFS-indexed staging tree to an empty bare remote with pointer blobs', async () => {
    // generate-customer-workspace.mjs has no .d.mts; a non-literal specifier keeps tsc out of it.
    const generatorModule = (await import(
      new URL('../scripts/generate-customer-workspace.mjs', import.meta.url).href
    )) as {
      snapshotPush: (options: {
        workspaceRoot: string; remote: string;
        projects: Array<{ key: string; vendor?: unknown }>; version: string;
        plasticChangeset?: number | null; push?: boolean; coreRoot?: string | null; seedMissing?: boolean;
      }) => { pushed: boolean; remote: string; message: string; snapshot: any; baselineTag?: string };
    };
    const root = mkdtempSync(join(tmpdir(), 'rv-snapshot-push-test-'));
    temporary.push(root);
    const staged = join(root, 'staged');
    write(join(staged, '.gitattributes'), 'projects/**/*.glb filter=lfs diff=lfs merge=lfs -text\n');
    write(join(staged, 'realvirtual-web', 'src', 'main.ts'), 'export {};');
    write(join(staged, 'projects', 'acme', 'models', 'machine.glb'), 'large-binary-model-fixture-payload');
    // A core repository whose HEAD moves between the two deliveries below.
    const core = join(root, 'core');
    write(join(core, 'file.txt'), 'baseline');
    execFileSync('git', ['init', '-b', 'main'], { cwd: core });
    // Reproduce the generator's staging state: a local LFS guard index WITHOUT any remote.
    // Regression guard: its .git must never leak into the snapshot clone (lost `origin`).
    execFileSync('git', ['init', '-b', 'main'], { cwd: staged });
    execFileSync('git', ['lfs', 'install', '--local'], { cwd: staged });
    execFileSync('git', ['add', '-A'], { cwd: staged });
    const bare = join(root, 'remote.git');
    execFileSync('git', ['init', '--bare', '-b', 'main', bare]);
    const identity: Record<string, string> = {
      GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    };
    const previous = Object.fromEntries(Object.keys(identity).map((key) => [key, process.env[key]]));
    const coreGit = (...args: string[]) => execFileSync('git', args, { cwd: core, encoding: 'utf8', env: { ...process.env, ...identity } });
    coreGit('add', '-A');
    coreGit('commit', '-m', 'chore: baseline');
    const deliveredCore = coreGit('rev-parse', 'HEAD').trim();
    // The first delivery carries the manifest that the second one reads back off the remote.
    write(join(staged, 'delivery-manifest.json'), JSON.stringify({ coreCommit: deliveredCore }));
    execFileSync('git', ['add', '-A'], { cwd: staged });
    Object.assign(process.env, identity);
    try {
      const result = generatorModule.snapshotPush({
        workspaceRoot: staged, remote: pathToFileURL(bare).href, projects: [{ key: 'acme' }], version: '9.9.9',
        plasticChangeset: 9434, push: true,
      });
      expect(result).toMatchObject({ pushed: true, message: 'viewer 9.9.9-9434' });
      // Without a coreRoot (and against a remote that carries no manifest) the message
      // stays the bare header — the changelog is additive, never a hard requirement.
      expect(result.message).not.toContain('Changes since core');
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    // Second delivery: the remote now carries the manifest naming the previously delivered
    // core commit, so the snapshot commit body must summarise what changed since then.
    writeFileSync(join(core, 'file.txt'), 'next');
    coreGit('add', '-A');
    coreGit('commit', '-m', 'feat(webviewer): something the customer can see');
    // A real second delivery ships changed sources and a rewritten manifest; without any
    // difference `git commit` would refuse the snapshot.
    write(join(staged, 'realvirtual-web', 'src', 'main.ts'), 'export const changed = true;');
    write(join(staged, 'delivery-manifest.json'), JSON.stringify({ coreCommit: coreGit('rev-parse', 'HEAD').trim() }));
    execFileSync('git', ['add', '-A'], { cwd: staged });
    Object.assign(process.env, identity);
    try {
      const second = generatorModule.snapshotPush({
        workspaceRoot: staged, remote: pathToFileURL(bare).href, projects: [{ key: 'acme' }], version: '9.9.10',
        plasticChangeset: 9435, push: true, coreRoot: core,
      });
      expect(second.message).toContain('viewer 9.9.10-9435');
      expect(second.message).toContain(`Changes since core ${deliveredCore.slice(0, 8)}`);
      expect(second.message).toContain('- something the customer can see');
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    const files = execFileSync('git', ['-C', bare, 'ls-tree', '-r', '--name-only', 'main'], { encoding: 'utf8' });
    expect(files).toContain('realvirtual-web/src/main.ts');
    expect(files).toContain('projects/acme/models/machine.glb');
    // The LFS-filtered model must land in the remote as a small Git LFS v1 pointer, not a full blob.
    const blob = execFileSync('git', ['-C', bare, 'cat-file', 'blob', 'main:projects/acme/models/machine.glb'], { encoding: 'utf8' });
    expect(blob.startsWith('version https://git-lfs.github.com/spec/v1\n')).toBe(true);
    expect(blob).toMatch(/oid sha256:[0-9a-f]{64}/);
    // 60 s was already too tight: this drives git init, add, commit, an LFS
    // upload, a clone and a second delivery, and it exceeded the budget once
    // the suite grew. The number is a load allowance, not a performance target.
  }, 180000);

  it('summarises feat/fix changes since the previously delivered core commit', () => {
    const core = mkdtempSync(join(tmpdir(), 'rv-changelog-core-'));
    temporary.push(core);
    const git = (...args: string[]) => execFileSync('git', args, {
      cwd: core,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      },
    });
    git('init', '-b', 'main');
    const commit = (subject: string) => {
      writeFileSync(join(core, 'file.txt'), subject);
      git('add', '-A');
      git('commit', '-m', subject);
      return git('rev-parse', 'HEAD').trim();
    };
    const base = commit('chore: baseline');
    commit('feat(webviewer): add a visible thing');
    commit('wip(webviewer): secure accumulated work');
    commit('fix(delivery): repair a broken thing');
    commit('chore(release): viewer 1.2.3');
    commit('feat: add a visible thing');

    const summary = deliveryChangelog(core, base);
    expect(summary).toContain('New features:');
    expect(summary).toContain('- add a visible thing');
    expect(summary).toContain('Fixes:');
    expect(summary).toContain('- repair a broken thing');
    // Internal noise stays internal, and the conventional-commit type/scope is stripped.
    expect(summary).not.toContain('wip');
    expect(summary).not.toContain('chore');
    expect(summary).not.toContain('feat(webviewer)');
    // The duplicate subject is listed once.
    expect(summary.match(/- add a visible thing/g)).toHaveLength(1);
    // An unresolvable range degrades to no summary rather than failing the delivery.
    expect(deliveryChangelog(core, 'deadbeefdeadbeef')).toBe('');
    expect(deliveryChangelog(core, null as unknown as string)).toBe('');
    expect(deliveryChangelog(core, 'not-a-sha')).toBe('');
  }, 30000);

  it('falls back to the stable CONNECT channel when the beta manifest is missing (404)', async () => {
    // deliver.mjs has no .d.mts; a non-literal specifier keeps tsc out of it.
    const deliverModule = (await import(
      new URL('../scripts/deliver.mjs', import.meta.url).href
    )) as {
      resolveConnectLock: (channel: string, tmpBase: string, fetchImpl?: typeof fetch) =>
        Promise<{ lockPath: string; source: string; channel: string }>;
    };
    const root = mkdtempSync(join(tmpdir(), 'rv-connect-lock-test-'));
    temporary.push(root);
    const sha256 = 'ab'.repeat(32);
    const manifest = {
      version: '1.2.3',
      build: 42,
      platforms: { 'win-x64': { url: 'https://web.realvirtual.io/download/versions/realvirtual-Connect-1.2.3+42.exe', sha256 } },
    };
    const fetched: string[] = [];
    const fetchMock = (async (input: unknown) => {
      const url = String(input);
      fetched.push(url);
      // plan-343 Phase 0: the beta manifest is download/connect-beta.json — the former
      // download/beta/connect-latest.json form no longer exists anywhere in the tree.
      if (url.endsWith('/connect-beta.json')) return { ok: false, status: 404 } as Response;
      return { ok: true, status: 200, json: async () => manifest } as unknown as Response;
    }) as typeof fetch;

    const previousLock = process.env.RV_CONNECT_LOCK;
    delete process.env.RV_CONNECT_LOCK;
    try {
      const result = await deliverModule.resolveConnectLock('beta', root, fetchMock);
      expect(result.channel).toBe('stable');
      expect(fetched[0]).toBe('https://web.realvirtual.io/download/connect-beta.json');
      expect(fetched[1]).toBe('https://web.realvirtual.io/download/connect-latest.json');
      const lock = JSON.parse(readFileSync(result.lockPath, 'utf8'));
      expect(lock).toMatchObject({ channel: 'stable', version: '1.2.3', sha256 });

      // A non-404 beta failure must still fail hard — no silent fallback.
      const failingFetch = (async () => ({ ok: false, status: 500 } as Response)) as typeof fetch;
      await expect(deliverModule.resolveConnectLock('beta', root, failingFetch)).rejects.toThrow(/HTTP 500/);
    } finally {
      if (previousLock === undefined) delete process.env.RV_CONNECT_LOCK;
      else process.env.RV_CONNECT_LOCK = previousLock;
    }
  });

  it('rejects dirty or untagged provenance and records reproducibility fields', () => {
    const root = mkdtempSync(join(tmpdir(), 'rv-provenance-test-'));
    temporary.push(root);
    execFileSync('git', ['init', '-b', 'main'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: root });
    writeFileSync(join(root, 'tracked.txt'), 'clean');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'fixture'], { cwd: root });
    expect(() => gitProvenance(root, { requireTag: true })).toThrow(/release tag/);
    execFileSync('git', ['tag', 'viewer-v1.2.3'], { cwd: root });
    const core = gitProvenance(root, { requireTag: true });
    writeFileSync(join(root, 'tracked.txt'), 'dirty');
    expect(() => gitProvenance(root)).toThrow(/dirty/);
    writeFileSync(join(root, 'tracked.txt'), 'clean');
    const manifest = createDeliveryManifest({
      core, privateRepo: core, profile: { tier: 'commercial', restrictedFeatures: [] },
      connect: { version: '1.0.0', url: 'https://example.invalid/versions/1/connect.exe', sha256: '0'.repeat(64) },
      projectRoot: root, viewerVersion: '1.2.3',
      plasticChangeset: 9434,
    });
    expect(manifest).toMatchObject({
      coreCommit: core.commit, privateCommit: core.commit, viewerVersion: '1.2.3', plasticChangeset: 9434,
    });
    const fallbackManifest = createDeliveryManifest({
      core, privateRepo: core, profile: { tier: 'commercial', restrictedFeatures: [] },
      connect: {}, projectRoot: root, viewerVersion: '1.2.3',
    });
    expect(fallbackManifest.plasticChangeset).toBeNull();
  });

  // --no-rag delivers a workspace without the CONNECT diagnosis package. The generated files
  // must not reference a connect/ payload that is not there: setup.ps1 runs under
  // $ErrorActionPreference=Stop, so touching a missing rag.zip would abort the customer's setup.
  it("omits every diagnosis reference when the delivery carries no RAG package", () => {
    const { core, privateRoot, delivery } = fixture();
    const staged = stageFilteredSourceTree({
      coreRoot: core, privateRoot, projectKey: "acme", profile: delivery, delivery, hasDiagnosis: false,
    });
    temporary.push(staged.workspaceRoot);
    const startPs1 = readFileSync(join(staged.workspaceRoot, "setup.ps1"), "utf8");
    expect(startPs1).not.toContain("connect/rag.zip");
    expect(startPs1).not.toContain("connect/project-config.json");
    const readme = readFileSync(join(staged.workspaceRoot, "README.md"), "utf8");
    expect(readme).toContain("contains no AI diagnosis package");
    expect(readme).not.toContain("EU-hosted AI endpoint");
    expect(readme).not.toContain("Diagnosis.Enabled=false");
    expect(readme).not.toContain("connect/rag.zip");
    // No connect/ folder is written at all when no artifacts are supplied.
    expect(existsSync(join(staged.workspaceRoot, "connect"))).toBe(false);
  });

  // The default stays a normal diagnosis delivery, so no existing caller changes behaviour.
  it("keeps the diagnosis wording by default", () => {
    const { core, privateRoot, delivery } = fixture();
    const staged = stageFilteredSourceTree({ coreRoot: core, privateRoot, projectKey: "acme", profile: delivery, delivery });
    temporary.push(staged.workspaceRoot);
    expect(readFileSync(join(staged.workspaceRoot, "README.md"), "utf8")).toContain("EU-hosted AI endpoint");
    // Git LFS missing during the clone leaves a few-KB pointer in place of the bundle, and the
    // symptom otherwise appears much later as a diagnosis that will not start.
    expect(readFileSync(join(staged.workspaceRoot, "setup.ps1"), "utf8")).toContain("connect/rag.zip");
  });

  /**
   * plan-363 Phase 6 — the acceptance criterion for the generated customer documentation.
   *
   * The generator writes far more than the start scripts: a README, a workspace guide, six
   * recipes and three assistant commands. All of them told the customer to run `npm run dev` and
   * to browse :5173, which is precisely the second web server this plan removes. Left in place,
   * the documentation would keep teaching the workflow the product no longer has.
   *
   * Scoped to the generated MARKDOWN on purpose: the start scripts themselves still mention the
   * dev port (it is the port CONNECT proxies) and start.sh still knows `npm run dev` for the
   * documented rollback onto a CONNECT that predates the launcher.
   */
  it("never points the customer at the second web server again", () => {
    const { core, privateRoot, delivery } = fixture();
    const staged = stageFilteredSourceTree({ coreRoot: core, privateRoot, projectKey: "acme", profile: delivery, delivery });
    temporary.push(staged.workspaceRoot);

    const documents: string[] = [];
    const collect = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const full = join(directory, entry.name);
        // Only what the GENERATOR wrote. realvirtual-web/ is the delivered product tree and
        // carries its own developer documentation, which is not this plan's subject.
        if (entry.isDirectory()) {
          if (['realvirtual-web', 'realvirtual-web-pro', 'node_modules', '.git', 'projects', 'connect'].includes(entry.name)) continue;
          collect(full);
        } else if (entry.name.endsWith('.md')) documents.push(full);
      }
    };
    collect(staged.workspaceRoot);
    expect(documents.length).toBeGreaterThan(8); // README, guide, CONTRIBUTING, recipes, commands

    for (const document of documents) {
      const text = readFileSync(document, 'utf8');
      expect(text, `${document} still tells the customer to run the dev server by hand`).not.toContain('npm run dev');
      expect(text, `${document} still names the old dev-server port`).not.toContain(':5173');
    }

    // And the replacement is actually stated, rather than merely deleted.
    const readme = readFileSync(join(staged.workspaceRoot, 'README.md'), 'utf8');
    expect(readme).toContain('http://localhost:5100');
    expect(readme).toContain('Going back to an earlier realvirtual CONNECT');
    expect(readme).toContain('After a `git pull` that changes the dependencies');
  });

  /**
   * The two-script split and the shim contract. A setup that started CONNECT would recurse the
   * moment CONNECT points a customer at it, and a start.ps1 that still launched Vite itself would
   * put a second dev server next to the one CONNECT starts.
   */
  it("splits preparation from starting, and the shim starts nothing of its own", () => {
    const { core, privateRoot, delivery } = fixture();
    const staged = stageFilteredSourceTree({ coreRoot: core, privateRoot, projectKey: "acme", profile: delivery, delivery });
    temporary.push(staged.workspaceRoot);

    const setupPs1 = readFileSync(join(staged.workspaceRoot, 'setup.ps1'), 'utf8');
    const startPs1 = readFileSync(join(staged.workspaceRoot, 'start.ps1'), 'utf8');
    const setupSh = readFileSync(join(staged.workspaceRoot, 'setup.sh'), 'utf8');
    const startSh = readFileSync(join(staged.workspaceRoot, 'start.sh'), 'utf8');

    // No recursion: preparation must not start CONNECT, on either platform.
    expect(setupPs1).not.toContain('realvirtual-Connect.exe');
    expect(setupSh).not.toContain('tools/connect/realvirtual-Connect"');
    // No second dev server: the shim never runs npm itself.
    expect(startPs1).not.toContain('npm');
    expect(startPs1).toContain("-File (Join-Path $workspace 'setup.ps1')");
    expect(startPs1).toContain('Invoke-RvActivateIfRunning');
    expect(startPs1).toContain('Start-RvConnectAndOpen');
    expect(startSh).toContain('"$ROOT/setup.sh"');

    // --latest, or a customer cloning an old repository starts on an old CONNECT.
    expect(setupPs1).toContain("'tools/get-connect.mjs') $workspace --latest");
    expect(setupSh).toContain('tools/get-connect.mjs" "$ROOT" --latest');

    // The fingerprint is what makes a `git pull` repairable here, and it may only be recorded
    // after a restore that succeeded.
    expect(setupPs1).toContain('Get-RvDependencyFingerprint');
    expect(setupPs1).toContain('Set-RvRecordedDependencyFingerprint');
    expect(setupSh).toContain('rv_record');

    // The shared launcher functions travel with the workspace, not only with the installer.
    expect(existsSync(join(staged.workspaceRoot, 'tools', 'rv-launcher.ps1'))).toBe(true);
    expect(readFileSync(join(staged.workspaceRoot, 'tools', 'rv-launcher.ps1'), 'utf8')).toContain('function Get-RvWorkspaceId');
  });

  /**
   * The appliance folder. Before this staging path existed, the generated README and
   * `recipes/setup-appliance.md` both pointed at `appliance/` while nothing ever copied it — the
   * customer got a runbook for a folder that was not in the delivery.
   *
   * The exclusions matter more than the inclusion: `.env` carries every generated secret and
   * would additionally trip the secret-bearing-file guard, `state/` is the resume marker of an
   * installation in progress on a DIFFERENT machine, and `tests/node_modules/` is build output.
   */
  it('stages the appliance installer and never its runtime state', () => {
    const { core, privateRoot, delivery } = fixture();
    const staged = stageFilteredSourceTree({ coreRoot: core, privateRoot, projectKey: 'acme', profile: delivery, delivery });
    temporary.push(staged.workspaceRoot);
    const appliance = join(staged.workspaceRoot, 'appliance');
    expect(existsSync(join(appliance, 'install.sh'))).toBe(true);
    expect(existsSync(join(appliance, 'setup-appliance.ps1'))).toBe(true);
    expect(existsSync(join(appliance, 'lib', 'decide.sh'))).toBe(true);
    // env.sample is the delivered template; it has no leading dot precisely so it may ship.
    expect(readFileSync(join(appliance, 'env.sample'), 'utf8')).toContain('RV_APPLIANCE_HOST');

    expect(existsSync(join(appliance, '.env'))).toBe(false);
    expect(existsSync(join(appliance, 'state'))).toBe(false);
    expect(existsSync(join(appliance, 'tests', 'node_modules'))).toBe(false);

    // The recipe that walks the customer through it has to be reachable from the index, or the
    // broken-link guard is the only thing that would ever notice.
    expect(readFileSync(join(staged.workspaceRoot, 'recipes', 'README.md'), 'utf8'))
      .toContain('setup-appliance.md');
    expect(existsSync(join(staged.workspaceRoot, 'recipes', 'setup-appliance.md'))).toBe(true);
  });

  /**
   * A commercial delivery without the appliance is a defect, not a variant: the README promises
   * the folder. Failing loudly here is the only thing that keeps the two in step.
   */
  it('refuses a commercial delivery whose appliance folder is missing', () => {
    const { core, privateRoot, delivery } = fixture();
    rmSync(join(privateRoot, 'appliance'), { recursive: true, force: true });
    expect(() => stageFilteredSourceTree({ coreRoot: core, privateRoot, projectKey: 'acme', profile: delivery, delivery }))
      .toThrow(/Appliance installer not found/);
  });

  /**
   * The generated PowerShell has to PARSE. It is assembled from template strings full of `$`, `\`
   * and nested quotes, and nothing else in this repository would notice a typo — the first reader
   * would be a customer, whose workspace then does not start for a reason no message explains.
   *
   * Windows only, because there is no PowerShell parser to ask elsewhere; the file is Windows-only
   * anyway.
   */
  it.skipIf(process.platform !== 'win32')("emits PowerShell that actually parses", () => {
    const { core, privateRoot, delivery } = fixture();
    const staged = stageFilteredSourceTree({ coreRoot: core, privateRoot, projectKey: "acme", profile: delivery, delivery });
    temporary.push(staged.workspaceRoot);

    for (const name of ['setup.ps1', 'start.ps1']) {
      const path = join(staged.workspaceRoot, name).replace(/'/g, "''");
      const script = "$e = $null; "
        + `$null = [System.Management.Automation.Language.Parser]::ParseFile('${path}', [ref]$null, [ref]$e); `
        + "if ($e -and $e.Count -gt 0) { $e | ForEach-Object { Write-Output \"$($_.Extent.StartLineNumber): $($_.Message)\" } } "
        + "else { Write-Output 'clean' }";
      const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { encoding: 'utf8', windowsHide: true });
      expect(result.stdout.trim(), `${name}: ${result.stdout}${result.stderr}`).toBe('clean');
    }
  });

  // Customer knowledge documents are full of long German compound identifiers - drawing
  // numbers, machine designations, EPLAN signal names - written as backticked file names,
  // which is exactly what the .md literal scan reads. They reach 32+ characters by joining
  // short words and must not read as secrets, while a prefixed token still has to be caught.
  it("allows separator-delimited engineering identifiers but not prefixed tokens", () => {
    const root = mkdtempSync(join(tmpdir(), 'rv-guard-test-'));
    temporary.push(root);
    const tick = String.fromCharCode(96);
    const identifiers = [
      'P1002_SAIER_DeckelhandlingM46_Verfahrwege',
      'P1002_Deckelhandling_Saier_Hauptarm_2026-04-08',
      'P1002_M46_bg_SGM_BMB_eKW22_PI-700_Hybrid_5305',
      'HA_Entnahmehub_VentilEinfahren_ReferenzSensor',
    ];
    write(join(root, 'notes.md'), identifiers.map((n) => tick + n + tick).join('\n'));
    // Guard against a vacuous assertion: the scan must actually see these literals.
    expect(readFileSync(join(root, 'notes.md'), 'utf8')).toContain(tick + 'P1002_SAIER');
    expect(() => assertWorkspaceGuards(root)).not.toThrow();

    // A separator prefix must not launder a dense random run.
    write(join(root, 'leak.md'), tick + 'sk_live_' + '51H8xQ2eZvKYlo2CkYbGvXqRt9pLmNwZa' + tick);
    expect(() => assertWorkspaceGuards(root)).toThrow(/High-entropy string literal/);
  });
});

/**
 * plan-434 §2.6 — the foreign-customer-name guard now asks the project's `kind`.
 *
 * The guard aborts a delivery when another project's NAME appears anywhere in
 * the staged tree, because a customer's name in another customer's repository is
 * a leak. Fed with every folder under `projects/`, it also aborted on `festo`,
 * `new-project` and `demo-realvirtual` — words a demo scene or a fixture path
 * legitimately contains, and none of them anybody's secret.
 */
describe('foreign-customer-name guard against project kinds', () => {
  const projectsFixture = () => {
    const privateRoot = mkdtempSync(join(tmpdir(), 'rv-kind-private-'));
    temporary.push(privateRoot);
    write(join(privateRoot, 'projects', 'acme', 'project.json'), '{"kind":"customer"}');
    write(join(privateRoot, 'projects', 'festo', 'project.json'), '{"kind":"internal"}');
    return privateRoot;
  };

  it('ignores an internal project name and still refuses a customer one', () => {
    const privateRoot = projectsFixture();
    const customerKeys = knownProjectKeys(privateRoot, { kind: 'customer' });
    expect(customerKeys).toEqual(['acme']);

    const tree = mkdtempSync(join(tmpdir(), 'rv-kind-tree-'));
    temporary.push(tree);
    write(join(tree, 'models', 'festo-cell.txt'), 'a fixture named after the internal playground');

    expect(() => assertWorkspaceGuards(tree, { projectKey: 'other', knownProjectKeys: customerKeys })).not.toThrow();
    // ...and the unfiltered list is exactly the false positive the filter removes.
    expect(() => assertWorkspaceGuards(tree, { projectKey: 'other', knownProjectKeys: knownProjectKeys(privateRoot) }))
      .toThrow(/Foreign customer name found in models\/festo-cell\.txt/);

    write(join(tree, 'docs', 'acme-layout.md'), 'no links here');
    expect(() => assertWorkspaceGuards(tree, { projectKey: 'other', knownProjectKeys: customerKeys }))
      .toThrow(/Foreign customer name found in docs\/acme-layout\.md/);
  });

  it('never treats the project being delivered as foreign to itself', () => {
    const privateRoot = projectsFixture();
    const tree = mkdtempSync(join(tmpdir(), 'rv-kind-own-'));
    temporary.push(tree);
    write(join(tree, 'projects', 'acme', 'notes.txt'), 'the customer we are delivering to');

    expect(() => assertWorkspaceGuards(tree, {
      projectKey: 'acme',
      knownProjectKeys: knownProjectKeys(privateRoot, { kind: 'customer' }),
    })).not.toThrow();
  });
});

/**
 * The projectless (standard) delivery — plan-434 Phase 4.
 *
 * A `standard` customer buys the product, not a project: their repository ships
 * the viewer, CONNECT and the demo model, and `projects/` arrives empty for them
 * to fill. Everything below asserts one half of that sentence — what is NOT
 * delivered (no project folder, no diagnosis package, no default model, no PR
 * workflow), and what the customer keeps forever (everything under `projects/`).
 */
describe('projectless customer workspace', () => {
  //! The delivery config a standard customer translates to: an empty `projects[]`
  //! and a null primary key. Shaped exactly like loadDeliveryConfigByCustomer's result.
  const standardDelivery = {
    project: 'Hochschule Beispiel',
    customer: 'beispiel',
    projects: [] as string[],
    kind: 'standard' as const,
    tier: 'commercial' as const,
    restrictedFeatures: [] as string[],
    remote: 'git@example.invalid:beispiel.git',
    mirror: null,
    connectChannel: 'stable' as const,
    connectLicenseKey: 'RVC1-PLACEHOLDER',
    projectKey: null,
  };

  function stageProjectless(overrides: Record<string, unknown> = {}) {
    const { core, privateRoot } = fixture();
    const staged = stageFilteredSourceTree({
      coreRoot: core,
      privateRoot,
      projectKeys: [],
      profile: standardDelivery,
      delivery: standardDelivery,
      // A projectless delivery never carries a diagnosis package; the generator
      // reaches the same branch as --no-rag, by what the customer is.
      hasDiagnosis: false,
      ...overrides,
    });
    temporary.push(staged.workspaceRoot);
    return { core, privateRoot, staged };
  }

  it('delivers an empty projects/ folder and no project material at all', () => {
    const { staged } = stageProjectless();

    // `.gitkeep` (Git cannot carry an empty directory) and the demo project,
    // which every channel gets since plan-737. Nothing else: no CUSTOMER project.
    expect(readdirSync(join(staged.workspaceRoot, 'projects')).sort())
      .toEqual(['.gitkeep', 'demo-realvirtual']);
    expect(readFileSync(join(staged.workspaceRoot, 'projects', '.gitkeep'), 'utf8')).toBe('');
    // The private repo's own `acme` project must not have followed along.
    expect(existsSync(join(staged.workspaceRoot, 'projects', 'acme'))).toBe(false);
    expect(staged.projectKey).toBeNull();
    expect(staged.projectKeys).toEqual([]);
    expect(staged.project).toBeNull();

    // No diagnosis payload: no connect/ folder, no rag.zip.
    expect(existsSync(join(staged.workspaceRoot, 'connect'))).toBe(false);

    // The product itself IS delivered — the customer has something to open. Since
    // plan-737 that something is the demo PROJECT, not a loose reference model.
    expect(existsSync(join(staged.workspaceRoot, 'projects', 'demo-realvirtual', 'DemoRealvirtualWeb.glb'))).toBe(true);
    expect(existsSync(join(staged.coreRoot, 'public', 'models', 'DemoRealvirtualWeb.glb'))).toBe(false);
    expect(existsSync(join(staged.privateRoot!, 'src', 'commercial', 'safe.ts'))).toBe(true);
  });

  // ── plan-735 F2/F3: the projectless delivery carries a real manifest ─────
  //
  // The regression this closes (Vektor A, §2.1): a standard customer's
  // workspace shipped the reference model in `public/models/` and NOTHING that
  // declared it. `public/project.json` is filtered out of every customer
  // delivery (the demo manifest must not leak, plan-726 F13), so the deploy root
  // had no manifest at all and the viewer papered over it with a synthetic
  // project assembled from a build-time glob. Both are gone; this is what took
  // their place.
  it('generates a vendor-owned project.json for the customer own, still-empty project', () => {
    const { staged } = stageProjectless();
    const manifestPath = join(staged.coreRoot, 'public', 'project.json');
    expect(existsSync(manifestPath)).toBe(true);

    // EMPTY since plan-737, and that is the honest statement: this manifest
    // describes the CUSTOMER's project, and they have authored nothing yet. It used
    // to declare a vendor reference model so the delivery had something to open —
    // the demo project (projects/demo-realvirtual/) is that something now, so this
    // file stops naming a file it does not own.
    const generated = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(generated.kind).toBe('delivery');
    expect(generated.documents).toEqual([]);
    expect(generated.settings?.defaultModel).toBeUndefined();

    // F3, asserted as a STRING and not merely implied: the generated file says
    // out loud that it is vendor-owned and replaced by every update. It sits in
    // Zone A (§3.2) and has no sidecar protection — visibility IS the mitigation
    // (user decision), so it has to be visible.
    const raw = readFileSync(manifestPath, 'utf8');
    expect(raw).toMatch(/GENERATED BY realvirtual/);
    expect(raw).toMatch(/replaced in full by every delivery update/);

    // …and the README carries the same sentence, next to the Zone-A rule.
    const readme = readFileSync(join(staged.workspaceRoot, 'README.md'), 'utf8');
    expect(readme).toMatch(/realvirtual-web\/public\/project\.json/);
    expect(readme).toMatch(/generated by realvirtual/i);
  });

  // The 1d collision, pinned from the other side: the DEMO manifest still must
  // not reach a customer (the plan-726 F13 test above), while the GENERATED one
  // must. They are the same path in the same tree, and the only thing keeping
  // them apart is the order — the generator writes after `copyCore()`'s filter.
  it('generates its own manifest without letting the demo manifest through', () => {
    const { core, staged } = stageProjectless();
    const generated = JSON.parse(
      readFileSync(join(staged.coreRoot, 'public', 'project.json'), 'utf8'));
    const demo = JSON.parse(readFileSync(
      join(core, 'public', 'demo-realvirtual', 'project.json'), 'utf8'));
    expect(generated.id).not.toBe(demo.id);
    expect(generated.id).toMatch(/^prj_delivery_/);
    // None of the demo's own documents came along with it.
    const demoPaths = new Set((demo.documents ?? []).map((d: { path: string }) => d.path));
    for (const doc of generated.documents) expect(demoPaths.has(doc.path)).toBe(false);
  });

  it('generates settings without a default model, and keeps the rest of the profile', () => {
    const { staged } = stageProjectless({
      connectPin: {
        channel: 'stable', version: '1.2.3',
        url: 'https://example.invalid/versions/x.exe', sha256: 'a'.repeat(64),
      },
    });
    const settings = JSON.parse(readFileSync(join(staged.coreRoot, 'public', 'settings.json'), 'utf8'));

    // Empty, not absent and not invented: there is no project, so there is no
    // model to open by default — the viewer offers the selector instead.
    //
    // NOT touched by plan-735 1b, and the distinction is easy to get wrong:
    // `public/settings.json` and `public/project.json` are different files with
    // different owners. This one is the GLOBAL default of the deployment and
    // stays empty for a standard customer. The generated `project.json` above
    // carries its own `settings.defaultModel`, which is the PROJECT's start
    // document, and that one DOES name the reference model. Whoever changes
    // either must not "fix" the other to match.
    expect(settings.defaultModel).toBe('');
    expect(settings.connectChannel).toBe('stable');
    expect(settings.connectLicensePrefill).toBe('RVC1-PLACEHOLDER');
    expect(settings.connectDownload).toMatchObject({ channel: 'stable', version: '1.2.3' });
  });

  /**
   * The shared commercial repository (plan-434 §2.7) — the measured leak.
   *
   * `settings.json` is a delivered file. In a repository every standard customer
   * can read, one customer's `connectLicensePrefill` is every customer's licence
   * key. The guard is on the channel and not on the value, so a delivery whose
   * key happens to resolve still writes nothing; and the key is left OUT rather
   * than blanked, because an empty string reads as "no licence" to CONNECT while
   * an absent one lets it ask.
   */
  it('writes no licence prefill into the shared repository, even when a key resolves', () => {
    const { staged } = stageProjectless({
      profile: { ...standardDelivery, sharedRepo: true },
      delivery: { ...standardDelivery, sharedRepo: true },
    });
    const settings = JSON.parse(readFileSync(join(staged.coreRoot, 'public', 'settings.json'), 'utf8'));

    expect('connectLicensePrefill' in settings).toBe(false);
    // Everything else about the delivery is unchanged — it is the same
    // projectless workspace, only the destination is shared.
    expect(settings.defaultModel).toBe('');
    expect(settings.connectChannel).toBe('stable');

    const readme = readFileSync(join(staged.workspaceRoot, 'README.md'), 'utf8');
    expect(readme).toContain('Enter your licence key on first start');
    expect(readme).not.toContain('already filled in');
  });

  /**
   * The second measured leak in the shared repository: the customer's IDENTITY.
   *
   * One delivery run produces the push that every standard customer then pulls, so
   * whichever customer happened to trigger it must not be named in the result. It
   * was: the README title carried the display name, the clone-folder suggestion the
   * slug, and the feature matrix used the display name as its column head — which is
   * how "Hochschule Heilbronn" and `D:\git\hs-heilbronn` reached delivery/6.3.24 of a
   * repository shared by everyone.
   *
   * The remote is overridden here to the real shared one. In the default fixture it
   * carries the slug, which would be a false positive: a shared delivery's remote
   * genuinely is `rv-commercial/realvirtual-commercial`.
   */
  const sharedDelivery = {
    ...standardDelivery,
    sharedRepo: true,
    remote: 'https://git.example.invalid/rv-commercial/realvirtual-commercial.git',
  };

  //! Every generated text file in the workspace, as [relative path, content].
  //! The staged product tree is skipped: it is core source, identical for everyone.
  function generatedTexts(root: string): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    const walk = (dir: string, prefix: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (['realvirtual-web', 'realvirtual-web-pro', 'node_modules', '.git'].includes(entry.name)) continue;
          walk(join(dir, entry.name), rel);
        } else if (/\.(md|json|ps1|sh|txt|ts|nvmrc|gitattributes|gitignore)$/.test(entry.name)
          || entry.name.startsWith('.git')) {
          out.push([rel, readFileSync(join(dir, entry.name), 'utf8')]);
        }
      }
    };
    walk(root, '');
    return out;
  }

  it('names no customer anywhere in the shared repository, and calls the product by its own name', () => {
    const { staged } = stageProjectless({ profile: sharedDelivery, delivery: sharedDelivery });

    // Not one generated file may carry the display name or the slug of the customer
    // whose run produced the push — README, FEATURES, CONTRIBUTING, CLAUDE/AGENTS,
    // recipes, scripts, settings, all of them.
    for (const [rel, text] of generatedTexts(staged.workspaceRoot)) {
      expect(text, `${rel} names the display name`).not.toContain('Hochschule Beispiel');
      expect(text, `${rel} names the slug`).not.toContain('beispiel');
    }

    const readme = readFileSync(join(staged.workspaceRoot, 'README.md'), 'utf8');
    const features = readFileSync(join(staged.workspaceRoot, 'FEATURES.md'), 'utf8');
    expect(readme.startsWith('# realvirtual Commercial\n')).toBe(true);
    expect(features).toContain('| Feature | Tier | Status | realvirtual Commercial |');
    // The suggested folder is the repository's own name, which is also what the
    // clone in the step above actually produces.
    expect(readme).toContain('D:\\git\\realvirtual-commercial');
  });

  it('leads the shared README with git clone and mentions no installer at all', () => {
    const { staged } = stageProjectless({ profile: sharedDelivery, delivery: sharedDelivery });
    const readme = readFileSync(join(staged.workspaceRoot, 'README.md'), 'utf8');

    // Git is the documented route: clone, start, `git pull`.
    expect(readme).toContain('## How to get started');
    expect(readme).toContain('git clone https://git.example.invalid/rv-commercial/realvirtual-commercial.git');
    expect(readme).toContain('.\\start.ps1');
    expect(readme).toContain('git pull');
    // ...and its prerequisites are named, because nothing brings them along any more.
    expect(readme).toContain('### What you need installed');
    expect(readme).toContain('Node.js 22 LTS (required)');
    expect(readme).toContain('**Git and Git LFS:**');
    // The one-click installer is switched off and appears nowhere — not as the main
    // route, not as a fallback, and above all not as a download link.
    expect(readme).not.toContain('setup.exe');
    expect(readme).not.toContain('realvirtual-WEB-dev-setup');
    expect(readme).not.toContain('realvirtual WEB dev');
    expect(readme.indexOf('git clone')).toBeLessThan(readme.indexOf('## Reference'));
  });

  it('lists the layout planner as a core feature, and never the asset editor', () => {
    const { staged } = stageProjectless({ profile: sharedDelivery, delivery: sharedDelivery });
    const features = readFileSync(join(staged.workspaceRoot, 'FEATURES.md'), 'utf8');
    const readme = readFileSync(join(staged.workspaceRoot, 'README.md'), 'utf8');

    // The planner ships with every delivery: AGPL core, statically imported by main.ts.
    // Its tier registration only gates the DOCUMENT, not the code.
    expect(features).toContain('## Core (AGPL) - always included');
    expect(features).toContain('- Layout planner');
    // The asset editor is commercial as of this decision and its future versions move
    // into the private repository, so the core list must not promise it.
    expect(features).not.toContain('- Asset editor');
    // The README's inline enumeration is the same list in prose and must agree with it.
    expect(readme).toContain('and the layout planner)');
    expect(readme).toMatch(/AGPL core \(10 capabilities/);
  });

  it('writes a README that tells the customer to create a project, and never to open a pull request', () => {
    const { staged } = stageProjectless();
    const readme = readFileSync(join(staged.workspaceRoot, 'README.md'), 'utf8');

    expect(readme).toContain('Create your first project');
    // The delivery channel decision (§2.2): read-only repository, updates by pull.
    expect(readme).toContain('read-only for you');
    expect(readme).toContain('git pull');
    expect(readme).not.toMatch(/open a pull request/i);
    expect(readme).not.toContain('### Submit changes');
    // No diagnosis promise, because no diagnosis package was delivered.
    expect(readme).toContain('contains no AI diagnosis package');
    // And no path into a project folder that does not exist — as a link OR as text.
    expect(readme).not.toContain('projects/acme');
    expect(readme).not.toMatch(/\]\(\.\.?\/?projects\//);
  });

  it('writes a CONTRIBUTING that states the repository is read-only, with no CLA', () => {
    const { staged } = stageProjectless();
    const contributing = readFileSync(join(staged.workspaceRoot, 'CONTRIBUTING.md'), 'utf8');

    expect(contributing).toContain('read-only for you');
    expect(contributing).toContain('no pull request to open');
    // No contribution route, therefore no instruction to take one and no CLA.
    expect(contributing).not.toMatch(/open a pull request|reviewed pull request/i);
    expect(contributing).not.toMatch(/grant realvirtual GmbH the rights/i);
    expect(contributing).toContain('projects/');
  });

  it('keeps the feature matrix customer-scoped and drops the "Your project" section', () => {
    const { staged } = stageProjectless();
    const features = readFileSync(join(staged.workspaceRoot, 'FEATURES.md'), 'utf8');

    expect(features).toContain('## Licensed features');
    expect(features).not.toContain('## Your project');
    // Customer-scoped means the customer's entitlements, not the internal
    // registration list: `premium` is restricted and was never granted here.
    expect(features).toContain('commercial-feature');
    expect(features).not.toMatch(/^\| premium \|/m);
  });

  it('records an empty project set in the delivery manifest, and still the private-source inventory', () => {
    const { staged } = stageProjectless();
    const inventory = collectPrivateSourceInventory(staged.workspaceRoot);
    const manifest = createDeliveryManifest({
      core: { commit: 'c'.repeat(40) },
      privateRepo: { commit: 'p'.repeat(40) },
      profile: { tier: 'commercial', restrictedFeatures: [] },
      connect: { channel: 'stable', version: '1.2.3' },
      // There is no project tree to hash.
      projectRoot: null,
      viewerVersion: '9.9.9',
      plasticChangeset: 4711,
      projects: {},
      privateSources: inventory,
    });

    expect(manifest.projects).toEqual({});
    expect(manifest.projectTreeSha256).toBeNull();
    expect(manifest.baselineTag).toBeTruthy();
    // The tier diff gate keeps working: the next delivery still has an inventory
    // to compare against, project or no project (§2.4).
    expect(manifest.privateSources.paths.length).toBeGreaterThan(0);
    expect(manifest.privateSources.paths.every((path: string) => path.startsWith('realvirtual-web-pro/src'))).toBe(true);
  });

  it('passes the workspace guards with an empty project set, foreign-name check still armed', () => {
    const { staged } = stageProjectless();
    const foreignRoot = mkdtempSync(join(tmpdir(), 'rv-projectless-foreign-'));
    temporary.push(foreignRoot);
    write(join(foreignRoot, 'projects', 'rivalcorp', 'project.json'), '{"kind":"customer"}');
    const foreign = knownProjectKeys(foreignRoot, { kind: 'customer' });
    expect(foreign).toEqual(['rivalcorp']);

    // Nothing is "own" here, so every known customer name is foreign — and none
    // of them appears in a workspace that carries no project material.
    expect(() => assertWorkspaceGuards(staged.workspaceRoot, {
      projectKey: null, projectKeys: [], knownProjectKeys: foreign,
    })).not.toThrow();

    // The guard is armed, not merely quiet.
    write(join(staged.workspaceRoot, 'projects', 'rivalcorp-notes.txt'), 'leaked');
    expect(() => assertWorkspaceGuards(staged.workspaceRoot, {
      projectKey: null, projectKeys: [], knownProjectKeys: foreign,
    })).toThrow(/Foreign customer name found in projects\/rivalcorp-notes\.txt/);
  });

  /**
   * The §6.7 zone-C proof, as a unit test.
   *
   * A projectless delivery delivers nothing OF THE CUSTOMER'S under `projects/`, so
   * nothing of theirs is vendor-managed — and the merge must leave their own project
   * exactly as it found it. This follows from the existing logic without a special
   * case (the per-project loop has nothing to iterate), which is precisely what
   * makes it worth pinning: a future "seed the folder" convenience would break it.
   *
   * ## The one exception, since plan-737
   *
   * `projects/demo-realvirtual/` DOES arrive, on this channel too (F5). It is
   * vendor-owned sample content, classified Zone A and replaced in full on every
   * delivery — see the dedicated case in `merged-snapshot.node.test.ts`. So the
   * claim here is no longer "nothing appears under projects/" but the sharper and
   * more useful one: nothing appears there EXCEPT the demo, and nothing of the
   * customer's is touched either way.
   */
  it('leaves a customer-created project under projects/ byte-identical across an update', () => {
    const { staged } = stageProjectless();
    execFileSync('git', ['init', '-b', 'main'], { cwd: staged.workspaceRoot, stdio: 'ignore' });
    execFileSync('git', ['add', '-A'], { cwd: staged.workspaceRoot, stdio: 'ignore' });

    const clone = mkdtempSync(join(tmpdir(), 'rv-projectless-clone-'));
    temporary.push(clone);
    execFileSync('git', ['init', '-b', 'main'], { cwd: clone, stdio: 'ignore' });
    // A previous delivery, plus the project the customer built themselves.
    write(join(clone, 'README.md'), '# an older delivery\n');
    write(join(clone, 'realvirtual-web', 'main.ts'), 'export const old = true;');
    const own: Record<string, string> = {
      'projects/mymachine/project.json': '{"canonicalName":"mymachine"}\n',
      'projects/mymachine/models/mine.glb': 'binary-ish content the delivery must never touch',
      'projects/mymachine/plugins/index.ts': 'export const mine = 1;\n',
      'projects/mymachine/notes.md': '# my notes\n',
    };
    for (const [rel, content] of Object.entries(own)) write(join(clone, rel), content);
    execFileSync('git', ['add', '-A'], { cwd: clone, stdio: 'ignore' });
    execFileSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t',
      'commit', '-m', 'customer state'], { cwd: clone, stdio: 'ignore' });

    const snapshot = applyMergedSnapshot(staged.workspaceRoot, clone, { projects: [], version: '9.9.9' });

    // Nothing was reported for any project, because nothing was delivered into one.
    expect(snapshot.projects).toEqual({});
    // Every one of the customer's files is still there, byte for byte.
    for (const [rel, content] of Object.entries(own)) {
      expect(readFileSync(join(clone, rel), 'utf8'), rel).toBe(content);
    }
    // Git agrees: not one path under projects/ is modified or deleted.
    //
    // The GLB is excluded from this Git-level check on purpose. The delivered
    // `.gitattributes` puts `projects/**/*.glb` under the LFS filter, so a
    // GLB the customer committed BEFORE that attribute reached their repository
    // re-reads as "modified" the first time — an attribute effect on their own
    // file, not a change the merge made to it. The byte comparison above is the
    // claim that matters, and it covers the GLB too.
    const status = execFileSync('git', ['status', '--porcelain', '--', 'projects'],
      { cwd: clone, encoding: 'utf8' })
      .split('\n')
      .filter(line => line.trim() && !line.includes('.gitkeep') && !line.endsWith('.glb'));
    // The demo folder is the ONE expected arrival (plan-737 F5) — untracked,
    // because this clone has never seen it before. Everything else must be
    // absent from this list, which is what makes the assertion still bite.
    const demoLines = status.filter(line => line.includes('demo-realvirtual'));
    const rest = status.filter(line => !line.includes('demo-realvirtual'));
    expect(rest).toEqual([]);
    expect(demoLines.every(line => line.trimStart().startsWith('??'))).toBe(true);
    // Nothing of the CUSTOMER'S was added, modified or deleted — the actual claim.
    expect(status.some(line => line.includes('mymachine'))).toBe(false);
    // And zone A did happen: the delivered README replaced the old one.
    expect(readFileSync(join(clone, 'README.md'), 'utf8')).toContain('Create your first project');
  });
});

// ─── plan-726 F12: every delivered manifest still resolves its own start ──
//
// The regression this guards is the one the plan review found and the reason
// `findStartDocument()` is tolerant at all: `settings.defaultModel` was NEVER
// consumed on the unlocked boot, so nothing ever checked that it matched the
// manifest's own document paths — and in five delivered customer projects it
// does not (a bare filename against a `models/` path).
//
// plan-726 switches that branch on. From here the invariant has to hold for
// every manifest we ship, not just for the demo, and this sweep is what says
// so over the REAL files rather than over a fixture. It also catches a
// mis-generated CONNECT demo manifest (Phase 4), which is how the private
// demo-realvirtual manifest was found to be broken in the first place.
describe('every private project manifest resolves its own start document', () => {
  const projectsRoot = join(__dirname, '..', '..', 'realvirtual-WebViewer-Private~', 'projects');
  const projectKeys = existsSync(projectsRoot)
    ? readdirSync(projectsRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .filter(name => existsSync(join(projectsRoot, name, 'project.json')))
    : [];

  it('found the private projects to sweep', () => {
    // A silent empty sweep is the failure mode here: it would report green
    // while checking nothing at all.
    expect(projectKeys.length).toBeGreaterThan(0);
  });

  it.each(projectKeys)('%s', (key) => {
    const manifest = JSON.parse(readFileSync(join(projectsRoot, key, 'project.json'), 'utf8'));
    const start = manifest?.settings?.defaultModel;
    // A project that names no start document is fine — it resumes from its own
    // `activeSceneId` or falls through to the deploy's catalogue.
    if (typeof start !== 'string' || start.trim() === '') return;

    // ── The short-circuit is GONE (plan-735 2c, R7) ────────────────────────
    //
    // This used to return early for a manifest that declared no `models`
    // section, on the grounds that `_withBundledSections()` would fill it from
    // the deploy's runtime discovery — so the file on disk could not answer
    // whether its start document resolved. That branch was a FALSE-GREEN
    // WINDOW: a manifest with a dangling `defaultModel` fell through it and was
    // never checked at all, on disk or anywhere else, until a live boot came up
    // with an empty viewport. `demo-process-industry` and `wmyb` were both
    // sitting in it.
    //
    // Since plan-735 Phase 2 there is no runtime fill to defer to: every private
    // manifest declares its own `models` section, so the file on disk IS the
    // final word and this is an unconditional check. A project that names no
    // start document (the early return above) is still fine — it resumes from
    // its own `activeSceneId` or offers the selector.
    expect(
      findStartDocument(manifest, start),
      `${key}: settings.defaultModel "${start}" matches no document in documents[] — `
      + 'declare the model in documents[] or clear settings.defaultModel. There is no '
      + 'runtime fill behind this any more (plan-735).',
    ).not.toBeNull();
  });
});

// ─── plan-731 Phase 4 (F6): the release gate on a delivered project ───────

/**
 * A project-bearing delivery must ship a project whose manifest resolves.
 *
 * This is the channel where the gap was widest. The other three stage OUR demo
 * and were at least checked against it; a customer workspace stages the
 * CUSTOMER's project, and nothing ever asked whether the `documents[]` it
 * carries still name files that travelled. A missing row here is not a broken
 * demo — it is a delivered product that opens nothing, discovered by the
 * customer.
 *
 * Only the project-bearing case is covered. A PROJECTLESS delivery ships no
 * `projects/<key>/project.json` at all, so there is no manifest to resolve;
 * asserting one there would be plan-735's F2, not this plan's F6.
 */
describe('a delivered project passes the release gate (plan-731 F6)', () => {
  /**
   * The staged project root of a project-bearing delivery, with a manifest we
   * control — the fixture's own `acme/project.json` is a bare v1 shape that
   * predates `documents[]`, and rewriting it would change what a dozen other
   * assertions in this file are about.
   */
  function deliveredProject(manifest: unknown, files: string[]): string {
    const { core, privateRoot, delivery } = fixture();
    write(join(privateRoot, 'projects', 'acme', 'project.json'), JSON.stringify(manifest));
    for (const rel of files) {
      write(join(privateRoot, 'projects', 'acme', ...rel.split('/')), rel);
    }
    const staged = stageFilteredSourceTree({
      coreRoot: core, privateRoot, projectKey: 'acme', profile: delivery, delivery,
    });
    temporary.push(staged.workspaceRoot);
    return join(staged.workspaceRoot, 'projects', 'acme');
  }

  const HEALTHY = {
    schemaVersion: 2,
    id: 'prj_acme',
    name: 'ACME',
    settings: { defaultModel: 'models/machine.glb' },
    documents: [
      {
        id: 'doc_machine', name: 'Machine', path: 'models/machine.glb', section: 'models',
        settingsPath: 'models/machine.settings.json',
      },
      { id: 'doc_cell', name: 'Cell', path: 'scenes/cell.glb', section: 'scenes' },
    ],
  };

  it('the delivered manifest resolves every document it declares', () => {
    const root = deliveredProject(HEALTHY, [
      'models/machine.glb', 'models/machine.settings.json', 'scenes/cell.glb',
    ]);
    const gate = assertManifestResolves(root);
    expect(gate.documents.map((d) => d.path))
      .toEqual(['models/machine.glb', 'scenes/cell.glb']);
    expect(gate.start.path).toBe('models/machine.glb');
    expect(gate.sidecars).toEqual(['models/machine.settings.json']);
  });

  it('a delivery whose document did not travel FAILS the gate', () => {
    // The negative case (4f): the row is there, the bytes are not. Without this
    // the customer is the one who finds out.
    const root = deliveredProject(HEALTHY, [
      'models/machine.glb', 'models/machine.settings.json',
    ]);
    expect(() => assertManifestResolves(root)).toThrow(/scenes\/cell\.glb/);
  });

  it('a delivery whose start document matches nothing FAILS the gate', () => {
    const root = deliveredProject(
      { ...HEALTHY, settings: { defaultModel: 'models/gone.glb' } },
      ['models/machine.glb', 'models/machine.settings.json', 'scenes/cell.glb'],
    );
    expect(() => assertManifestResolves(root)).toThrow(/start document/);
  });

  it('a delivery carrying a devOnly row FAILS the gate', () => {
    // A fixture has no business in a customer's product, and `devOnly` is what
    // makes that checkable from the manifest (plan-731 2k).
    const root = deliveredProject(
      {
        ...HEALTHY,
        documents: [
          ...HEALTHY.documents,
          { id: 'doc_fix', name: 'Fixture', path: 'scenes/fixture.glb', section: 'scenes', devOnly: true },
        ],
      },
      [
        'models/machine.glb', 'models/machine.settings.json',
        'scenes/cell.glb', 'scenes/fixture.glb',
      ],
    );
    expect(() => assertManifestResolves(root)).toThrow(/dev-only/);
  });
});
