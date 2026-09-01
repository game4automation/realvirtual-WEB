// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * CONNECT public-demo staging — the bundle carries a PROJECT (plan-726 Phase 4).
 *
 * The community download used to be reduced to exactly one model pair, and
 * `assertPublicDemoOutput()` restated that pair as a literal — so it could only
 * ever fail on a build accident, never on a wrong decision.
 *
 * Since plan-726 `public/project.json` is the single source of truth for what
 * the demo contains, on every channel, and this staging READS it instead of
 * carrying its own list. The guard therefore became a real gate: what shipped
 * has to match what the shipped manifest declares.
 *
 * Two things this staging has to do that the hosted deploy does not, both
 * because `stagePublic()` calls `stageFilteredSourceTree()` WITHOUT
 * `includePublicDemoContent`: it restores `public/project.json` (which the F13
 * delivery filter now removes) and `public/scenes/` (which was already
 * filtered). Both are demo content this bundle genuinely wants.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  assertPublicDemoOutput,
  preparePublicDemoSource,
  readDemoPayload,
} from '../../realvirtual-Connect~/tools/stage-public.mjs';
import { assertManifestResolves } from './helpers/assert-manifest-resolves';

let fixture = '';
afterEach(() => {
  if (fixture) rmSync(fixture, { recursive: true, force: true });
  delete process.env.RV_WEB_SOURCE_URL;
});

/** The real demo manifest shape: three models and the planner scene. */
const DEMO_MANIFEST = {
  schemaVersion: 2,
  id: 'prj_sample',
  name: 'DemoRealvirtual',
  canonicalName: 'demorealvirtual',
  kind: 'demo',
  settings: { defaultModel: 'models/DemoRealvirtualWeb.glb' },
  documents: [
    { id: 'doc_a', name: 'realvirtual WEB Demo', path: 'models/DemoRealvirtualWeb.glb', section: 'models' },
    { id: 'doc_b', name: 'Robot IK Demo', path: 'models/DemoRobotIK.glb', section: 'models' },
    { id: 'doc_c', name: 'CSG Machining Demo', path: 'models/DemoCSGMachining.glb', section: 'models' },
    { id: 'doc_d', name: 'Layout Planner Demo', path: 'scenes/DemoPlanner.glb', section: 'scenes' },
  ],
};

/**
 * A source tree that stands in for the WebViewer repo, plus a staged core that
 * has already been through `stageFilteredSourceTree()` — i.e. one whose
 * `scenes/` and `project.json` have been filtered out, which is exactly the
 * state `preparePublicDemoSource()` has to repair.
 */
function makeFixture(manifest: unknown = DEMO_MANIFEST) {
  fixture = mkdtempSync(join(tmpdir(), 'rv-public-demo-test-'));
  const sourceRoot = join(fixture, 'source');
  const sourcePublic = join(sourceRoot, 'public');
  mkdirSync(join(sourcePublic, 'models'), { recursive: true });
  mkdirSync(join(sourcePublic, 'scenes'), { recursive: true });
  for (const name of [
    'DemoRealvirtualWeb.glb', 'DemoRealvirtualWeb.settings.json',
    'DemoRobotIK.glb', 'DemoCSGMachining.glb', 'tests.glb',
  ]) writeFileSync(join(sourcePublic, 'models', name), name);
  for (const name of ['DemoPlanner.glb', 'Test-DES-Turntable-Loop.glb']) {
    writeFileSync(join(sourcePublic, 'scenes', name), name);
  }
  writeFileSync(join(sourcePublic, 'scenes', 'index.json'), '[]');
  writeFileSync(join(sourcePublic, 'project.json'), JSON.stringify(manifest));
  writeFileSync(join(sourceRoot, 'LICENSE'), 'AGPL');

  // The STAGED core: filtered, so it has models/ (with scratch still in it) but
  // neither scenes/ nor project.json.
  const stagedCore = join(fixture, 'staged');
  const stagedPublic = join(stagedCore, 'public');
  mkdirSync(join(stagedPublic, 'models', 'library'), { recursive: true });
  for (const name of [
    'DemoRealvirtualWeb.glb', 'DemoRealvirtualWeb.settings.json',
    'DemoRobotIK.glb', 'tests.glb',
  ]) writeFileSync(join(stagedPublic, 'models', name), name);
  writeFileSync(join(stagedPublic, 'models', 'library', 'asset.glb'), 'library');
  writeFileSync(join(stagedPublic, 'settings.json'), JSON.stringify({ defaultModel: 'models/tests.glb' }));
  writeFileSync(join(stagedPublic, 'index.html'), '<!doctype html>');

  process.env.RV_WEB_SOURCE_URL = 'https://example.invalid/source/tag';
  return { sourceRoot, sourcePublic, stagedCore, stagedPublic };
}

describe('readDemoPayload', () => {
  it('reads models, scenes and the sidecars out of the manifest', () => {
    const { sourcePublic } = makeFixture();
    const payload = readDemoPayload(sourcePublic);
    expect(payload.models.sort()).toEqual(
      ['models/DemoCSGMachining.glb', 'models/DemoRealvirtualWeb.glb', 'models/DemoRobotIK.glb'],
    );
    expect(payload.scenes).toEqual(['scenes/DemoPlanner.glb']);
    // Sidecars are addressed by filename convention, so no manifest row names
    // them; only the ones that exist are picked up.
    expect(payload.sidecars).toEqual(['models/DemoRealvirtualWeb.settings.json']);
  });

  it('reads root-level documents through their explicit section', () => {
    // The real demo manifest since 2026-08-31: documents at the MAIN level of
    // public/, typed by the row's `section` rather than a folder name.
    const { sourcePublic } = makeFixture({
      ...DEMO_MANIFEST,
      settings: { defaultModel: 'DemoRealvirtualWeb.glb' },
      documents: [
        { id: 'doc_a', name: 'realvirtual WEB Demo', path: 'DemoRealvirtualWeb.glb', section: 'models' },
        { id: 'doc_d', name: 'Layout Planner Demo', path: 'DemoPlanner.glb', section: 'scenes' },
      ],
    });
    writeFileSync(join(sourcePublic, 'DemoRealvirtualWeb.glb'), 'model');
    writeFileSync(join(sourcePublic, 'DemoRealvirtualWeb.settings.json'), 'sidecar');
    writeFileSync(join(sourcePublic, 'DemoPlanner.glb'), 'scene');
    const payload = readDemoPayload(sourcePublic);
    expect(payload.models).toEqual(['DemoRealvirtualWeb.glb']);
    expect(payload.scenes).toEqual(['DemoPlanner.glb']);
    expect(payload.sidecars).toEqual(['DemoRealvirtualWeb.settings.json']);
  });

  it('throws when the bundle has no manifest at all', () => {
    const { sourcePublic } = makeFixture();
    rmSync(join(sourcePublic, 'project.json'));
    // Guessing here would ship a bundle whose gate opens nothing.
    expect(() => readDemoPayload(sourcePublic)).toThrow(/needs project\.json/i);
  });

  it('throws when the manifest declares no models', () => {
    const { sourcePublic } = makeFixture({ ...DEMO_MANIFEST, documents: [] });
    expect(() => readDemoPayload(sourcePublic)).toThrow(/declares no model document/i);
  });
});

describe('CONNECT public-demo staging guard', () => {
  it('stages all four documents, the manifest, and an authoritative gate config', () => {
    const { sourceRoot, stagedCore, stagedPublic } = makeFixture();
    preparePublicDemoSource(stagedCore, sourceRoot);
    assertPublicDemoOutput(stagedPublic);

    // All three models, restored from source where the staged tree lacked them.
    const models = readdirSync(join(stagedPublic, 'models')).sort();
    expect(models).toEqual([
      'DemoCSGMachining.glb', 'DemoRealvirtualWeb.glb',
      'DemoRealvirtualWeb.settings.json', 'DemoRobotIK.glb',
    ]);
    // Scratch and the library subtree are pruned — the bundle is the manifest.
    expect(existsSync(join(stagedPublic, 'models', 'tests.glb'))).toBe(false);
    expect(existsSync(join(stagedPublic, 'models', 'library'))).toBe(false);

    // The planner scene, restored: `scenes/` is filtered out of the staged core.
    expect(readdirSync(join(stagedPublic, 'scenes'))).toEqual(['DemoPlanner.glb']);

    // The SSOT itself, verbatim — the whole point of Phase 4.
    expect(JSON.parse(readFileSync(join(stagedPublic, 'project.json'), 'utf8')))
      .toEqual(DEMO_MANIFEST);

    const settings = JSON.parse(readFileSync(join(stagedPublic, 'settings.json'), 'utf8'));
    // Still empty, and now it MEANS something: the gate starts the demo, and
    // what it opens comes from project.json. A global default here would load a
    // model behind the gate.
    expect(settings.defaultModel).toBe('');
    expect(settings.ui.initialContexts).toEqual(['connect-embed']);
    expect(JSON.parse(readFileSync(join(stagedPublic, 'models.json'), 'utf8')))
      .toEqual(['DemoCSGMachining.glb', 'DemoRealvirtualWeb.glb', 'DemoRobotIK.glb']);
  });

  it('fails when a declared model is missing from the source tree', () => {
    const { sourceRoot, sourcePublic, stagedCore } = makeFixture();
    rmSync(join(sourcePublic, 'models', 'DemoCSGMachining.glb'));
    expect(() => preparePublicDemoSource(stagedCore, sourceRoot))
      .toThrow(/source artifact is missing: models\/DemoCSGMachining\.glb/);
  });

  it('fails when a declared scene is missing from the source tree', () => {
    const { sourceRoot, sourcePublic, stagedCore } = makeFixture();
    rmSync(join(sourcePublic, 'scenes', 'DemoPlanner.glb'));
    expect(() => preparePublicDemoSource(stagedCore, sourceRoot))
      .toThrow(/source artifact is missing: scenes\/DemoPlanner\.glb/);
  });

  it('the output guard catches a payload that drifted from the manifest', () => {
    const { sourceRoot, stagedCore, stagedPublic } = makeFixture();
    preparePublicDemoSource(stagedCore, sourceRoot);
    // Something downstream deleted a model the manifest still names.
    rmSync(join(stagedPublic, 'models', 'DemoRobotIK.glb'));
    expect(() => assertPublicDemoOutput(stagedPublic))
      .toThrow(/missing: models\/DemoRobotIK\.glb/);
  });

  it('the output guard catches an extra file smuggled into models/', () => {
    const { sourceRoot, stagedCore, stagedPublic } = makeFixture();
    preparePublicDemoSource(stagedCore, sourceRoot);
    writeFileSync(join(stagedPublic, 'models', 'Smuggled.glb'), 'x');
    expect(() => assertPublicDemoOutput(stagedPublic))
      .toThrow(/Unexpected CONNECT public-demo model payload/);
  });

  it('the output guard catches a missing scene document', () => {
    const { sourceRoot, stagedCore, stagedPublic } = makeFixture();
    preparePublicDemoSource(stagedCore, sourceRoot);
    rmSync(join(stagedPublic, 'scenes', 'DemoPlanner.glb'));
    expect(() => assertPublicDemoOutput(stagedPublic))
      .toThrow(/missing: scenes\/DemoPlanner\.glb/);
  });

  it('the output guard insists on the manifest itself', () => {
    const { sourceRoot, stagedCore, stagedPublic } = makeFixture();
    preparePublicDemoSource(stagedCore, sourceRoot);
    rmSync(join(stagedPublic, 'project.json'));
    expect(() => assertPublicDemoOutput(stagedPublic))
      .toThrow(/missing: project\.json/);
  });

  it('is idempotent — re-staging an already-staged tree changes nothing', () => {
    const { sourceRoot, stagedCore, stagedPublic } = makeFixture();
    preparePublicDemoSource(stagedCore, sourceRoot);
    const first = readdirSync(join(stagedPublic, 'models')).sort();
    preparePublicDemoSource(stagedCore, sourceRoot);
    expect(readdirSync(join(stagedPublic, 'models')).sort()).toEqual(first);
    assertPublicDemoOutput(stagedPublic);
  });
});

describe('the shipped manifest is the one the repo authored', () => {
  it('public/project.json declares exactly the public demo documents', () => {
    // The bundle reads the real file, so a drift between this test fixture and
    // the repository would hide a change to what the community download ships.
    // User decision 2026-08-30: DemoRobotIK and DemoCSGMachining are internal
    // dev/test models and must NOT be declared here.
    const real = JSON.parse(readFileSync(
      resolve(__dirname, '..', 'public', 'project.json'), 'utf8',
    ));
    // User decision 2026-08-31: both demo documents live at the MAIN level of
    // public/ — sections are declared on the rows, not implied by folders.
    const documents = real.documents as { path: string; devOnly?: boolean }[];

    // The PUBLIC surface is what survives the `devOnly` prune: every staging
    // path drops those rows (plan-731 2k), so a marked row is by definition not
    // part of what the community download ships. Filtering here is what keeps
    // this assertion about the shipped surface rather than about the file.
    expect(documents.filter((d) => d.devOnly !== true).map((d) => d.path)).toEqual([
      'DemoRealvirtualWeb.glb',
      'DemoPlanner.glb',
    ]);

    // ...and the row the filter removed is the dev-only turntable fixture
    // (plan-731 2a), still carrying its marking. Without this half the fixture
    // could quietly lose `devOnly`, become public on every channel, and leave
    // the filtered assertion above green — the exact drift F6 exists to catch.
    expect(documents.map((d) => ({ path: d.path, devOnly: d.devOnly === true }))).toEqual([
      { path: 'DemoRealvirtualWeb.glb', devOnly: false },
      { path: 'DemoPlanner.glb', devOnly: false },
      { path: 'Test-DES-Turntable-Loop.glb', devOnly: true },
    ]);
  });
});

// ─── plan-731 F5: the sidecar is addressed by the manifest ────────────────

/**
 * `settingsPath` decides, the filename convention fills in.
 *
 * The sidecar used to be found by ONE rule, spelled in the staging script:
 * `<model>.settings.json`. A convention cannot name a sidecar whose filename
 * does not follow it, and — the reason plan-731 moved it — it cannot be seen
 * from the manifest, so no release gate could assert the sidecar had travelled.
 *
 * The convention stays as the FALLBACK, the same shape as the one-folder
 * `models/` path fallback beside it: an older manifest keeps staging.
 */
describe('readDemoPayload — the settings sidecar (plan-731 F5)', () => {
  /** A minimal public/ tree written straight to disk: this is a FILE question. */
  function publicDir(documents: unknown[], files: string[]): string {
    fixture = mkdtempSync(join(tmpdir(), 'rv-sidecar-test-'));
    const dir = join(fixture, 'public');
    mkdirSync(dir, { recursive: true });
    for (const rel of files) {
      const full = join(dir, ...rel.split('/'));
      mkdirSync(resolve(full, '..'), { recursive: true });
      writeFileSync(full, rel);
    }
    writeFileSync(join(dir, 'project.json'), JSON.stringify({
      schemaVersion: 2, id: 'prj_sample', name: 'DemoRealvirtual', documents,
    }));
    return dir;
  }

  it('resolves a sidecar the convention could never have found', () => {
    const dir = publicDir(
      [{ id: 'a', name: 'M', path: 'Demo.glb', section: 'models', settingsPath: 'hmi-config.json' }],
      ['Demo.glb', 'hmi-config.json'],
    );
    expect(readDemoPayload(dir).sidecars).toEqual(['hmi-config.json']);
  });

  it('falls back to the convention for a row that declares none', () => {
    const dir = publicDir(
      [{ id: 'a', name: 'M', path: 'Demo.glb', section: 'models' }],
      ['Demo.glb', 'Demo.settings.json'],
    );
    expect(readDemoPayload(dir).sidecars).toEqual(['Demo.settings.json']);
  });

  it('does not stage the same sidecar twice when both rules name it', () => {
    const dir = publicDir(
      [{
        id: 'a', name: 'M', path: 'Demo.glb', section: 'models',
        settingsPath: 'Demo.settings.json',
      }],
      ['Demo.glb', 'Demo.settings.json'],
    );
    expect(readDemoPayload(dir).sidecars).toEqual(['Demo.settings.json']);
  });

  it('drops a declared sidecar with no file behind it', () => {
    // A row naming a file nobody committed. Staging the NAME would put a 404
    // in the bundle that only the visitor ever meets — the failure Phase 4's
    // gate exists to catch, refused one step earlier here.
    const dir = publicDir(
      [{ id: 'a', name: 'M', path: 'Demo.glb', section: 'models', settingsPath: 'ghost.json' }],
      ['Demo.glb'],
    );
    expect(readDemoPayload(dir).sidecars).toEqual([]);
  });

  it('refuses a settingsPath that traverses out of the project', () => {
    const dir = publicDir(
      [{
        id: 'a', name: 'M', path: 'Demo.glb', section: 'models',
        settingsPath: '../../secret.json',
      }],
      ['Demo.glb'],
    );
    expect(readDemoPayload(dir).sidecars).toEqual([]);
  });

  it('lets a scene row declare one too — it is a row property, not a model rule', () => {
    const dir = publicDir(
      [
        { id: 'a', name: 'M', path: 'Demo.glb', section: 'models' },
        { id: 'b', name: 'S', path: 'Scene.glb', section: 'scenes', settingsPath: 'Scene.cfg.json' },
      ],
      ['Demo.glb', 'Scene.glb', 'Scene.cfg.json'],
    );
    const payload = readDemoPayload(dir);
    expect(payload.sidecars).toContain('Scene.cfg.json');
    expect(payload.models).toEqual(['Demo.glb']);
    expect(payload.scenes).toEqual(['Scene.glb']);
  });

  it('the shipped demo manifest declares its own sidecar', () => {
    // The end of the chain: our own `public/project.json` uses the new rule, so
    // the fallback is genuinely a fallback and not the live path.
    const demo = JSON.parse(readFileSync(
      resolve(__dirname, '..', 'public', 'project.json'), 'utf8',
    ));
    const start = demo.documents.find(
      (d: { path: string }) => d.path === demo.settings?.defaultModel,
    );
    expect(start?.settingsPath).toBe('DemoRealvirtualWeb.settings.json');
  });
});

// ─── plan-731 Phase 4 (F6): the release gate on the staged payload ────────

/**
 * The CONNECT-embed payload must fully resolve, by the SAME rule as every
 * other channel.
 *
 * `assertPublicDemoOutput()` already checks that what shipped matches what the
 * shipped manifest declares — which is most of the gate, and is why this
 * channel was the healthiest of the four. What it did not have was the
 * `devOnly` rule (there was nothing to check before plan-731 2a marked the
 * fixture) or the sidecar rule (F5 made the sidecar nameable), and it was a
 * private spelling of the rule rather than the shared one. Both harnesses run
 * now: the channel's own guard, then the common gate.
 */
describe('the staged CONNECT payload passes the release gate (plan-731 F6)', () => {
  /** The current manifest shape: root-level documents, a marked fixture. */
  const GATE_MANIFEST = {
    schemaVersion: 2,
    id: 'prj_sample',
    name: 'DemoRealvirtual',
    canonicalName: 'demorealvirtual',
    kind: 'demo',
    settings: { defaultModel: 'DemoRealvirtualWeb.glb' },
    documents: [
      {
        id: 'doc_a', name: 'realvirtual WEB Demo', path: 'DemoRealvirtualWeb.glb',
        section: 'models', settingsPath: 'DemoRealvirtualWeb.settings.json',
      },
      { id: 'doc_b', name: 'Layout Planner Demo', path: 'DemoPlanner.glb', section: 'scenes' },
      {
        id: 'doc_f', name: 'Fixture', path: 'Turntable-Fixture.glb',
        section: 'scenes', devOnly: true,
      },
    ],
  };

  /** A staged payload root, written directly — this is a question about files. */
  function stagedPayload(manifest: unknown, files: string[]): string {
    fixture = mkdtempSync(join(tmpdir(), 'rv-payload-gate-'));
    const root = join(fixture, 'public');
    mkdirSync(root, { recursive: true });
    for (const rel of files) {
      const full = join(root, ...rel.split('/'));
      mkdirSync(resolve(full, '..'), { recursive: true });
      writeFileSync(full, rel);
    }
    writeFileSync(join(root, 'project.json'), JSON.stringify(manifest, null, 2));
    return root;
  }

  it('a payload that still carries the dev-only fixture FAILS', () => {
    // The negative case (4f). It is also the reason the positive one below
    // means anything: a gate that cannot refuse is a gate that asserts nothing.
    const root = stagedPayload(GATE_MANIFEST, [
      'DemoRealvirtualWeb.glb', 'DemoRealvirtualWeb.settings.json',
      'DemoPlanner.glb', 'Turntable-Fixture.glb',
    ]);
    expect(() => assertManifestResolves(root)).toThrow(/dev-only/);
  });

  it('a payload without the fixture passes, sidecar included', () => {
    const shipped = {
      ...GATE_MANIFEST,
      documents: GATE_MANIFEST.documents.filter((d) => d.devOnly !== true),
    };
    const root = stagedPayload(shipped, [
      'DemoRealvirtualWeb.glb', 'DemoRealvirtualWeb.settings.json', 'DemoPlanner.glb',
    ]);
    const gate = assertManifestResolves(root);
    expect(gate.documents.map((d) => d.path))
      .toEqual(['DemoRealvirtualWeb.glb', 'DemoPlanner.glb']);
    expect(gate.sidecars).toEqual(['DemoRealvirtualWeb.settings.json']);
    expect(gate.start.path).toBe('DemoRealvirtualWeb.glb');
  });

  it('a payload that declares a file it did not carry FAILS', () => {
    const shipped = {
      ...GATE_MANIFEST,
      documents: GATE_MANIFEST.documents.filter((d) => d.devOnly !== true),
    };
    const root = stagedPayload(shipped, [
      'DemoRealvirtualWeb.glb', 'DemoRealvirtualWeb.settings.json',
    ]);
    expect(() => assertManifestResolves(root)).toThrow(/DemoPlanner\.glb/);
  });

  it('a payload whose sidecar did not travel FAILS (F5)', () => {
    const shipped = {
      ...GATE_MANIFEST,
      documents: GATE_MANIFEST.documents.filter((d) => d.devOnly !== true),
    };
    const root = stagedPayload(shipped, ['DemoRealvirtualWeb.glb', 'DemoPlanner.glb']);
    expect(() => assertManifestResolves(root)).toThrow(/did not travel/);
  });

  it('the real staging output passes both guards, not just its own', () => {
    // End to end through the channel's REAL harness — `preparePublicDemoSource`
    // then `assertPublicDemoOutput` — with the shared gate applied to exactly
    // what it produced. The manifest here is the module-level fixture, whose
    // documents sit in `models/` and `scenes/` subfolders: the gate is about
    // resolution, not about layout, and must not care which.
    const { sourceRoot, stagedCore, stagedPublic } = makeFixture();
    preparePublicDemoSource(stagedCore, sourceRoot);
    assertPublicDemoOutput(stagedPublic);

    const gate = assertManifestResolves(stagedPublic);
    expect(gate.documents.map((d) => d.path)).toEqual(
      readDemoPayload(stagedPublic).models.concat(readDemoPayload(stagedPublic).scenes),
    );
  });
});
