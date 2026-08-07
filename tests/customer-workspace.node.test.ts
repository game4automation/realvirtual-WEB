// SPDX-License-Identifier: AGPL-3.0-only
import { closeSync, existsSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyMergedSnapshot,
  assertNoCrossTierLeak,
  assertWorkspaceGuards,
  createDeliveryManifest,
  deliveryChangelog,
  gitProvenance,
  hashTree,
  loadTierManifest,
  runBuild,
  stageFilteredSourceTree,
} from '../scripts/_workspace-lib.mjs';

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
  write(join(core, 'public', 'models', 'DemoRealvirtualWeb.glb'), 'fixture:demo-glb');
  write(join(core, 'public', 'models', 'DemoRealvirtualWeb.settings.json'), '{}');
  write(join(privateRoot, 'scripts', 'get-dependencies.mjs'), '// get-dependencies fixture\n');
  // The shared launcher functions are delivered from the installer payload into the workspace, so
  // the fixture has to carry the same layout the private repository has.
  write(join(privateRoot, 'installer', 'payload', 'rv-launcher.ps1'), 'function Get-RvWorkspaceId { }\n');
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
  write(join(privateRoot, 'package-lock.json'), '{"packages":{"node_modules/@nvidia/test":{"version":"1"}}}');
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
      'commercial-feature': { adapter: './commercial/register', requires: [] },
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
    expect(existsSync(join(first.coreRoot, 'DESIGN.md'))).toBe(true);
    for (const name of ['doc-deploy.md', 'doc-plc-programming.md', 'doc-render-picking.md', 'PRODUCT.md']) {
      expect(existsSync(join(first.coreRoot, name)), name).toBe(false);
    }
    for (const name of [
      'realvirtual-web-demo.jpg', 'screenshot-hmi-overview.png', 'screenshot-layout-planner.jpg',
      'screenshot-drive-chart.png', 'screenshot-hierarchy.png', 'screenshot-settings.png',
    ]) expect(existsSync(join(first.coreRoot, 'docs', 'images', name)), name).toBe(true);
    expect(existsSync(join(first.coreRoot, 'docs', 'images', 'unreferenced.png'))).toBe(false);
    expect(readdirSync(join(first.workspaceRoot, 'projects'))).toEqual(['acme']);
    const readme = readFileSync(join(first.workspaceRoot, 'README.md'), 'utf8');
    expect(readme).toContain('Git LFS is critical');
    expect(readme).toContain('git clone git@example.invalid:acme.git');
    expect(readme).toContain('powershell -NoProfile -ExecutionPolicy Bypass -File .\\start.ps1');
    // A missing Node.js is the most common first-start failure: the README must name the
    // required major version, the PATH refresh, and where start.ps1 actually lives.
    expect(readme).toContain('Node.js 22 LTS (required');
    // The installer is the low-friction route on Windows and must be named before the
    // manual prerequisites, which it makes unnecessary.
    expect(readme).toContain('realvirtual WEB dev');
    expect(readme.indexOf('## Quick start (Windows)')).toBeGreaterThan(-1);
    expect(readme.indexOf('## Quick start (Windows)')).toBeLessThan(readme.indexOf('## Quick start (manual'));
    // The first executable instruction comes before the reference material, not after it.
    expect(readme.indexOf('## Quick start (Windows)')).toBeLessThan(readme.indexOf('## Reference'));
    expect(readme.indexOf('## Quick start (Windows)')).toBeLessThan(readme.indexOf('### Your private workspace'));
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
    expect(featuresMatrix).toContain('| commercial-feature | commercial | yes |');
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
  });

  // Customers need a reference model next to their own machine, and the planner needs its
  // component library. Both come from the DemoRealvirtual project; whatever is still lying
  // around in the core's public/models/ is scratch and must never be delivered.
  it('delivers the demo model and the curated library, never the core public models', () => {
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
    // The library is delivered NEXT TO models/, mirroring the project layout.
    const library = join(staged.coreRoot, 'public', 'library');
    expect(existsSync(join(models, 'DemoRealvirtualWeb.glb'))).toBe(true);
    expect(existsSync(join(models, 'DemoRealvirtualWeb.settings.json'))).toBe(true);
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

  it('omits the bundled library when the layout planner is not part of the core', () => {
    const { core, privateRoot, delivery } = fixture();
    write(join(core, 'public', 'library', 'PalletHandling', 'RollConveyor-1m.glb'), 'fixture:roll');

    const staged = stageFilteredSourceTree({ coreRoot: core, privateRoot, projectKey: 'acme', profile: delivery, delivery });
    temporary.push(staged.workspaceRoot);

    expect(existsSync(join(staged.coreRoot, 'public', 'models', 'DemoRealvirtualWeb.glb'))).toBe(true);
    expect(existsSync(join(staged.coreRoot, 'public', 'library'))).toBe(false);
  });

  it('refuses to deliver when the bundled demo model is missing', () => {
    const { core, privateRoot, delivery } = fixture();
    trackPublicModels(core, ['public/models/tests.glb']);
    // The reference model is named explicitly rather than globbed, so a core tree without it
    // must fail loudly rather than ship a model-less workspace.
    rmSync(join(core, 'public', 'models'), { recursive: true, force: true });

    expect(() => stageFilteredSourceTree({ coreRoot: core, privateRoot, projectKey: 'acme', profile: delivery, delivery }))
      .toThrow(/Demo model is missing/);
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
    expect(attributes).toContain('projects/*/models/*.glb filter=lfs diff=lfs merge=lfs -text');
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
  });

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
    write(join(staged, '.gitattributes'), 'projects/*/models/*.glb filter=lfs diff=lfs merge=lfs -text\n');
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
  }, 60000);

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
