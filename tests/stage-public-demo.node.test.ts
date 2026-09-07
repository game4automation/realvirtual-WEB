// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * CONNECT public-demo staging — the bundle carries the demo FOLDER (plan-739
 * Phase 8, F11).
 *
 * ## What changed, and why the old tests could not see it
 *
 * plan-737 turned the demo from a set of documents spread over `public/`, each
 * row carrying a `section` that said what kind of thing it was, into ONE folder
 * — `public/demo-realvirtual/` — with its own `project.json`. A document is
 * declared by a `documents[]` row; the folder is a place, not a type
 * (plan-716/735).
 *
 * `stage-public.mjs` was never migrated, so `-PublicDemo` read
 * `public/project.json`, a file plan-737 deleted, and threw. The tests did not
 * catch it because their fixtures wrote the OLD layout and the two that touched
 * the real repository only READ `public/demo-realvirtual/project.json` — they
 * asserted a file, never a staging. A test that reads the same JSON the code
 * reads, without running the code, is green in exactly the situation this one
 * was: the manifest was fine and the staging was broken.
 *
 * So every fixture here is folder-shaped, and the real-repository tests go
 * through `preparePublicDemoSource()` + `assertPublicDemoOutput()`.
 *
 * ## The two switches this file pins (plan-739 F11)
 *
 * - `-PublicDemo` ships the demo folder, minus the `devOnly` document. The
 *   prune is `applyPublicScenePruning()` from `_bunny-lib.mjs` — the same pass
 *   the hosted deploy runs, imported rather than re-spelled.
 * - `-Public` ships no demo folder at all. It used to ship the whole thing:
 *   `stagePublic()` omitted `includePublicDemoContent`, and the default
 *   (`profile.tier === 'core' && !projectKey`) is exactly the shape CONNECT
 *   passes — so the switch was ON in both modes.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  assertPublicDemoOutput,
  preparePublicDemoSource,
  readDemoPayload,
} from '../../realvirtual-Connect~/tools/stage-public.mjs';
import { stageFilteredSourceTree } from '../scripts/_workspace-lib.mjs';
import { PUBLIC_DEMO_FOLDER } from '../scripts/_bunny-lib.mjs';
import { assertManifestResolves } from './helpers/assert-manifest-resolves';

/** The repository itself — the source tree the real staging runs against. */
const REPO = resolve(__dirname, '..');

const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env.RV_WEB_SOURCE_URL;
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(dir);
  return dir;
}

function write(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** Every file under a folder, as `/`-separated relative paths, sorted. */
function filesUnder(root: string, prefix = '', out: string[] = []): string[] {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) filesUnder(join(root, entry.name), rel, out);
    else out.push(rel);
  }
  return out.sort();
}

/**
 * The real demo manifest's shape: root-level documents inside the demo FOLDER,
 * the start document naming its own sidecar, and one `devOnly` fixture.
 */
const DEMO_MANIFEST = {
  schemaVersion: 2,
  id: 'prj_sample',
  name: 'DemoRealvirtual',
  canonicalName: 'demorealvirtual',
  kind: 'demo',
  settings: { defaultModel: 'DemoRealvirtualWeb.glb' },
  documents: [
    {
      id: 'doc_a', name: 'realvirtual WEB Demo', path: 'DemoRealvirtualWeb.glb',
      settingsPath: 'DemoRealvirtualWeb.settings.json',
    },
    { id: 'doc_b', name: 'Layout Planner Demo', path: 'DemoPlanner.glb', mode: 'planner' },
    {
      id: 'doc_f', name: 'Test DES Turntable Loop', path: 'Test-DES-Turntable-Loop.glb',
      mode: 'des', devOnly: true,
    },
    { id: 'doc_k', name: 'About this demo project', path: 'demo.knowledge.md' },
  ],
};

/** The dev-only fixture, by name — T21 asserts it never reaches an artefact. */
const DEV_ONLY_DOCUMENT = 'Test-DES-Turntable-Loop.glb';

/**
 * A source tree that stands in for the WebViewer repo, plus a staged core that
 * has already been through `stageFilteredSourceTree()`.
 *
 * The staged core deliberately carries an INCOMPLETE demo folder plus scratch:
 * that is what makes the restore and the prune observable. On the real
 * `-PublicDemo` path the filtered staging keeps the folder intact, so both are
 * normally no-ops — and they stay, because they are what makes the payload a
 * function of the manifest instead of of whatever the filter left behind.
 */
function makeFixture(manifest: unknown = DEMO_MANIFEST) {
  const fixture = temp('rv-public-demo-test-');
  const sourceRoot = join(fixture, 'source');
  const sourceDemo = join(sourceRoot, 'public', PUBLIC_DEMO_FOLDER);
  for (const name of [
    'DemoRealvirtualWeb.glb', 'DemoRealvirtualWeb.settings.json',
    'DemoPlanner.glb', DEV_ONLY_DOCUMENT, 'demo.knowledge.md',
  ]) write(join(sourceDemo, name), name);
  write(join(sourceDemo, 'project.json'), JSON.stringify(manifest));
  write(join(sourceRoot, 'LICENSE'), 'AGPL');

  const stagedCore = join(fixture, 'staged');
  const stagedPublic = join(stagedCore, 'public');
  const stagedDemo = join(stagedPublic, PUBLIC_DEMO_FOLDER);
  write(join(stagedDemo, 'DemoRealvirtualWeb.glb'), 'DemoRealvirtualWeb.glb');
  write(join(stagedDemo, 'Scratch.glb'), 'scratch');
  write(join(stagedPublic, 'settings.json'), JSON.stringify({ defaultModel: 'models/tests.glb' }));
  write(join(stagedPublic, 'index.html'), '<!doctype html>');

  process.env.RV_WEB_SOURCE_URL = 'https://example.invalid/source/tag';
  return { sourceRoot, sourceDemo, stagedCore, stagedPublic, stagedDemo };
}

// ─── readDemoPayload: the folder's manifest, read as documents ────────────

describe('readDemoPayload', () => {
  it('reads every document and the sidecars out of the manifest', () => {
    const { sourceDemo } = makeFixture();
    const payload = readDemoPayload(sourceDemo);
    // Manifest order, folder-relative. No models/scenes split: the row says
    // what a document is, the folder says nothing (plan-716).
    expect(payload.documents).toEqual([
      'DemoRealvirtualWeb.glb',
      'DemoPlanner.glb',
      DEV_ONLY_DOCUMENT,
      'demo.knowledge.md',
    ]);
    expect(payload.sidecars).toEqual(['DemoRealvirtualWeb.settings.json']);
  });

  it('reports the devOnly row like any other — the PRUNE decides, not the reader', () => {
    // Deliberate division of labour. If the reader dropped the row, the staging
    // would never copy the file and `applyPublicScenePruning` would have nothing
    // to delete — and the "no dev-only document shipped" assertion would then be
    // true because nothing had happened, which is the failure mode plan-731 2k
    // set out to remove.
    const { sourceDemo } = makeFixture();
    expect(readDemoPayload(sourceDemo).documents).toContain(DEV_ONLY_DOCUMENT);
  });

  it('throws when the folder has no manifest at all', () => {
    const { sourceDemo } = makeFixture();
    rmSync(join(sourceDemo, 'project.json'));
    // Guessing here would ship a bundle whose gate opens nothing.
    expect(() => readDemoPayload(sourceDemo)).toThrow(/needs project\.json/i);
  });

  it('throws when the manifest declares no documents', () => {
    const { sourceDemo } = makeFixture({ ...DEMO_MANIFEST, documents: [] });
    expect(() => readDemoPayload(sourceDemo)).toThrow(/declares no document/i);
  });

  it('refuses a document path that escapes the demo folder', () => {
    const { sourceDemo } = makeFixture({
      ...DEMO_MANIFEST,
      documents: [
        { id: 'doc_a', name: 'Demo', path: 'DemoRealvirtualWeb.glb' },
        { id: 'doc_x', name: 'Escape', path: '../../secret.glb' },
      ],
    });
    expect(readDemoPayload(sourceDemo).documents).toEqual(['DemoRealvirtualWeb.glb']);
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
 * The convention stays as the FALLBACK, so an older manifest keeps staging.
 */
describe('readDemoPayload — the settings sidecar (plan-731 F5)', () => {
  /** A minimal demo folder written straight to disk: this is a FILE question. */
  function demoDir(documents: unknown[], files: string[]): string {
    const dir = join(temp('rv-sidecar-test-'), PUBLIC_DEMO_FOLDER);
    mkdirSync(dir, { recursive: true });
    for (const rel of files) write(join(dir, ...rel.split('/')), rel);
    writeFileSync(join(dir, 'project.json'), JSON.stringify({
      schemaVersion: 2, id: 'prj_sample', name: 'DemoRealvirtual', documents,
    }));
    return dir;
  }

  it('resolves a sidecar the convention could never have found', () => {
    const dir = demoDir(
      [{ id: 'a', name: 'M', path: 'Demo.glb', settingsPath: 'hmi-config.json' }],
      ['Demo.glb', 'hmi-config.json'],
    );
    expect(readDemoPayload(dir).sidecars).toEqual(['hmi-config.json']);
  });

  it('falls back to the convention for a row that declares none', () => {
    const dir = demoDir(
      [{ id: 'a', name: 'M', path: 'Demo.glb' }],
      ['Demo.glb', 'Demo.settings.json'],
    );
    expect(readDemoPayload(dir).sidecars).toEqual(['Demo.settings.json']);
  });

  it('does not stage the same sidecar twice when both rules name it', () => {
    const dir = demoDir(
      [{ id: 'a', name: 'M', path: 'Demo.glb', settingsPath: 'Demo.settings.json' }],
      ['Demo.glb', 'Demo.settings.json'],
    );
    expect(readDemoPayload(dir).sidecars).toEqual(['Demo.settings.json']);
  });

  it('drops a declared sidecar with no file behind it', () => {
    // A row naming a file nobody committed. Staging the NAME would put a 404 in
    // the bundle that only the visitor ever meets.
    const dir = demoDir(
      [{ id: 'a', name: 'M', path: 'Demo.glb', settingsPath: 'ghost.json' }],
      ['Demo.glb'],
    );
    expect(readDemoPayload(dir).sidecars).toEqual([]);
  });

  it('refuses a settingsPath that traverses out of the folder', () => {
    const dir = demoDir(
      [{ id: 'a', name: 'M', path: 'Demo.glb', settingsPath: '../../secret.json' }],
      ['Demo.glb'],
    );
    expect(readDemoPayload(dir).sidecars).toEqual([]);
  });

  it('never counts a document as its own sidecar', () => {
    // `demo.knowledge.md` is a document, not a `.glb`, so the convention must
    // not invent `demo.knowledge.settings.json` — and a document path must never
    // reappear in `sidecars`, or the output gate would demand it twice.
    const dir = demoDir(
      [
        { id: 'a', name: 'M', path: 'Demo.glb' },
        { id: 'k', name: 'K', path: 'demo.knowledge.md' },
      ],
      ['Demo.glb', 'demo.knowledge.md'],
    );
    const payload = readDemoPayload(dir);
    expect(payload.sidecars).toEqual([]);
    expect(payload.documents).toEqual(['Demo.glb', 'demo.knowledge.md']);
  });
});

// ─── The staging itself ───────────────────────────────────────────────────

describe('CONNECT public-demo staging guard', () => {
  it('stages the declared documents, the manifest, and an authoritative gate config', () => {
    const { sourceRoot, stagedCore, stagedPublic, stagedDemo } = makeFixture();
    preparePublicDemoSource(stagedCore, sourceRoot);
    assertPublicDemoOutput(stagedPublic);

    // Exactly the shipped documents plus the manifest. `DemoPlanner.glb`, the
    // sidecar and `demo.knowledge.md` were restored from source; `Scratch.glb`
    // is gone; the dev-only fixture never made it (T21, asserted on its own
    // below as well).
    expect(filesUnder(stagedDemo)).toEqual([
      'DemoPlanner.glb',
      'DemoRealvirtualWeb.glb',
      'DemoRealvirtualWeb.settings.json',
      'demo.knowledge.md',
      'project.json',
    ]);

    // The SSOT, carried through: the same manifest minus the pruned row.
    const shipped = JSON.parse(readFileSync(join(stagedDemo, 'project.json'), 'utf8'));
    expect(shipped.id).toBe('prj_sample');
    expect(shipped.kind).toBe('demo');
    expect(shipped.documents.map((d: { path: string }) => d.path)).toEqual([
      'DemoRealvirtualWeb.glb', 'DemoPlanner.glb', 'demo.knowledge.md',
    ]);

    const settings = JSON.parse(readFileSync(join(stagedPublic, 'settings.json'), 'utf8'));
    // Still empty, and it MEANS something: the gate starts the demo, and what
    // it opens comes from the demo's own project.json. A global default here
    // would load a model behind the gate.
    expect(settings.defaultModel).toBe('');
    expect(settings.ui.initialContexts).toEqual(['connect-embed']);
    expect(existsSync(join(stagedPublic, 'AGPL-3.0.txt'))).toBe(true);
    expect(readFileSync(join(stagedPublic, 'WEB-SOURCE.txt'), 'utf8'))
      .toContain('https://example.invalid/source/tag');

    // No `models.json`. It was retired as a second catalogue in plan-737:
    // `main.ts` resolves its entries to `<BASE>models/<name>`, a path the demo
    // folder does not use, so writing one here would publish a list of 404s.
    expect(existsSync(join(stagedPublic, 'models.json'))).toBe(false);
  });

  // ── T21 ───────────────────────────────────────────────────────────────
  it('the devOnly document never reaches the artefact — file nor row', () => {
    const { sourceRoot, stagedCore, stagedPublic, stagedDemo } = makeFixture();
    // It IS in the source folder, so this is a prune and not an absence.
    expect(existsSync(join(sourceRoot, 'public', PUBLIC_DEMO_FOLDER, DEV_ONLY_DOCUMENT))).toBe(true);

    preparePublicDemoSource(stagedCore, sourceRoot);

    expect(existsSync(join(stagedDemo, DEV_ONLY_DOCUMENT))).toBe(false);
    const shipped = JSON.parse(readFileSync(join(stagedDemo, 'project.json'), 'utf8'));
    expect(shipped.documents.map((d: { path: string }) => d.path)).not.toContain(DEV_ONLY_DOCUMENT);
    expect(shipped.documents.some((d: { devOnly?: boolean }) => d.devOnly === true)).toBe(false);
    // …and the shared gate agrees, by its own rule.
    assertManifestResolves(stagedDemo);
    assertPublicDemoOutput(stagedPublic);
  });

  it('fails when a declared document is missing from the source tree', () => {
    const { sourceRoot, sourceDemo, stagedCore } = makeFixture();
    rmSync(join(sourceDemo, 'DemoPlanner.glb'));
    expect(() => preparePublicDemoSource(stagedCore, sourceRoot))
      .toThrow(/source artifact is missing: DemoPlanner\.glb/);
  });

  it('fails when a declared sidecar is missing from the source tree', () => {
    const { sourceRoot, sourceDemo, stagedCore } = makeFixture();
    rmSync(join(sourceDemo, 'DemoRealvirtualWeb.settings.json'));
    // The reader drops a sidecar with no file behind it, so the failure lands
    // one step later — on the gate, which is where a missing sidecar becomes a
    // demo that comes up unconfigured.
    preparePublicDemoSource(stagedCore, sourceRoot);
    const staged = join(stagedCore, 'public', PUBLIC_DEMO_FOLDER);
    expect(() => assertManifestResolves(staged)).toThrow(/did not travel/);
  });

  it('the output guard catches a payload that drifted from the manifest', () => {
    const { sourceRoot, stagedCore, stagedPublic, stagedDemo } = makeFixture();
    preparePublicDemoSource(stagedCore, sourceRoot);
    rmSync(join(stagedDemo, 'DemoPlanner.glb'));
    expect(() => assertPublicDemoOutput(stagedPublic))
      .toThrow(/missing: demo-realvirtual\/DemoPlanner\.glb/);
  });

  it('the output guard catches an extra file smuggled into the demo folder', () => {
    const { sourceRoot, stagedCore, stagedPublic, stagedDemo } = makeFixture();
    preparePublicDemoSource(stagedCore, sourceRoot);
    writeFileSync(join(stagedDemo, 'Smuggled.glb'), 'x');
    expect(() => assertPublicDemoOutput(stagedPublic))
      .toThrow(/Unexpected CONNECT public-demo payload/);
  });

  it('the output guard catches a devOnly row that survived the prune', () => {
    // The negative case for T21. A guard that cannot refuse asserts nothing, so
    // the prune is undone by hand here and the gate has to notice.
    const { sourceRoot, stagedCore, stagedPublic, stagedDemo } = makeFixture();
    preparePublicDemoSource(stagedCore, sourceRoot);
    const shipped = JSON.parse(readFileSync(join(stagedDemo, 'project.json'), 'utf8'));
    shipped.documents.push({
      id: 'doc_f', name: 'Test DES Turntable Loop', path: DEV_ONLY_DOCUMENT, devOnly: true,
    });
    writeFileSync(join(stagedDemo, 'project.json'), JSON.stringify(shipped));
    writeFileSync(join(stagedDemo, DEV_ONLY_DOCUMENT), 'fixture');
    expect(() => assertPublicDemoOutput(stagedPublic)).toThrow(/Dev-only document reached/);
  });

  it('the output guard insists on the manifest itself', () => {
    const { sourceRoot, stagedCore, stagedPublic, stagedDemo } = makeFixture();
    preparePublicDemoSource(stagedCore, sourceRoot);
    rmSync(join(stagedDemo, 'project.json'));
    expect(() => assertPublicDemoOutput(stagedPublic))
      .toThrow(/missing: demo-realvirtual\/project\.json/);
  });

  it('is idempotent — re-staging an already-staged tree changes nothing', () => {
    const { sourceRoot, stagedCore, stagedPublic, stagedDemo } = makeFixture();
    preparePublicDemoSource(stagedCore, sourceRoot);
    const first = filesUnder(stagedDemo);
    preparePublicDemoSource(stagedCore, sourceRoot);
    expect(filesUnder(stagedDemo)).toEqual(first);
    assertPublicDemoOutput(stagedPublic);
  });
});

// ─── The repository's own demo, through the real staging ──────────────────

/**
 * The two tests that used to live here read `public/demo-realvirtual/project.json`
 * and asserted its rows. That is a statement about a FILE, and the file was never
 * the thing that broke: the staging was. Both are replaced by one test that runs
 * the repository's real demo folder through the real staging functions and
 * checks what came out.
 */
describe('the repository demo stages, and the fixture does not travel', () => {
  it('the real public/demo-realvirtual/ passes the channel guard and the shared gate', () => {
    const stagedCore = temp('rv-real-demo-stage-');
    const stagedPublic = join(stagedCore, 'public');
    write(join(stagedPublic, 'settings.json'), '{}');
    write(join(stagedPublic, 'index.html'), '<!doctype html>');
    process.env.RV_WEB_SOURCE_URL = 'https://example.invalid/source/tag';

    preparePublicDemoSource(stagedCore, REPO);
    assertPublicDemoOutput(stagedPublic);

    const stagedDemo = join(stagedPublic, PUBLIC_DEMO_FOLDER);
    const gate = assertManifestResolves(stagedDemo);

    // The shipped surface, named. User decision 2026-08-30/31: only these
    // documents are public, they live at the root of the demo folder, and the
    // start document names its own sidecar (plan-731 F5).
    expect(gate.documents.map(d => d.path)).toEqual([
      'DemoRealvirtualWeb.glb',
      'DemoPlanner.glb',
      'demo.knowledge.md',
    ]);
    expect(gate.start.path).toBe('DemoRealvirtualWeb.glb');
    expect(gate.sidecars).toEqual(['DemoRealvirtualWeb.settings.json']);

    // The fixture the repository still authors is gone from the artefact — both
    // the file and its row. Asserting it against the SOURCE would only repeat
    // what the manifest says; asserting it here says the prune ran.
    expect(existsSync(join(stagedDemo, DEV_ONLY_DOCUMENT))).toBe(false);
    const source = JSON.parse(readFileSync(
      join(REPO, 'public', PUBLIC_DEMO_FOLDER, 'project.json'), 'utf8',
    ));
    expect(source.documents.some((d: { path: string; devOnly?: boolean }) =>
      d.path === DEV_ONLY_DOCUMENT && d.devOnly === true)).toBe(true);
  });
});

// ─── plan-731 Phase 4 (F6): the release gate on the staged payload ────────

/**
 * The CONNECT-embed payload must fully resolve, by the SAME rule as every other
 * channel — `assertManifestResolves`, applied to the demo FOLDER.
 */
describe('the staged CONNECT payload passes the release gate (plan-731 F6)', () => {
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
        settingsPath: 'DemoRealvirtualWeb.settings.json',
      },
      { id: 'doc_b', name: 'Layout Planner Demo', path: 'DemoPlanner.glb' },
      { id: 'doc_f', name: 'Fixture', path: 'Turntable-Fixture.glb', devOnly: true },
    ],
  };

  /** A staged demo folder, written directly — this is a question about files. */
  function stagedPayload(manifest: unknown, files: string[]): string {
    const root = join(temp('rv-payload-gate-'), PUBLIC_DEMO_FOLDER);
    mkdirSync(root, { recursive: true });
    for (const rel of files) write(join(root, ...rel.split('/')), rel);
    writeFileSync(join(root, 'project.json'), JSON.stringify(manifest, null, 2));
    return root;
  }

  it('a payload that still carries the dev-only fixture FAILS', () => {
    const root = stagedPayload(GATE_MANIFEST, [
      'DemoRealvirtualWeb.glb', 'DemoRealvirtualWeb.settings.json',
      'DemoPlanner.glb', 'Turntable-Fixture.glb',
    ]);
    expect(() => assertManifestResolves(root)).toThrow(/dev-only/);
  });

  it('a payload without the fixture passes, sidecar included', () => {
    const shipped = {
      ...GATE_MANIFEST,
      documents: GATE_MANIFEST.documents.filter(d => d.devOnly !== true),
    };
    const root = stagedPayload(shipped, [
      'DemoRealvirtualWeb.glb', 'DemoRealvirtualWeb.settings.json', 'DemoPlanner.glb',
    ]);
    const gate = assertManifestResolves(root);
    expect(gate.documents.map(d => d.path))
      .toEqual(['DemoRealvirtualWeb.glb', 'DemoPlanner.glb']);
    expect(gate.sidecars).toEqual(['DemoRealvirtualWeb.settings.json']);
    expect(gate.start.path).toBe('DemoRealvirtualWeb.glb');
  });

  it('a payload that declares a file it did not carry FAILS', () => {
    const shipped = {
      ...GATE_MANIFEST,
      documents: GATE_MANIFEST.documents.filter(d => d.devOnly !== true),
    };
    const root = stagedPayload(shipped, [
      'DemoRealvirtualWeb.glb', 'DemoRealvirtualWeb.settings.json',
    ]);
    expect(() => assertManifestResolves(root)).toThrow(/DemoPlanner\.glb/);
  });

  it('a payload whose sidecar did not travel FAILS (F5)', () => {
    const shipped = {
      ...GATE_MANIFEST,
      documents: GATE_MANIFEST.documents.filter(d => d.devOnly !== true),
    };
    const root = stagedPayload(shipped, ['DemoRealvirtualWeb.glb', 'DemoPlanner.glb']);
    expect(() => assertManifestResolves(root)).toThrow(/did not travel/);
  });
});

// ─── T22: the -Public shell carries no demo at all (plan-739 F11) ─────────

/**
 * The switch, and what it used to do.
 *
 * `stagePublic()` called `stageFilteredSourceTree()` WITHOUT
 * `includePublicDemoContent`, so the default decided:
 * `profile.tier === 'core' && !projectKey`. CONNECT passes exactly that shape —
 * tier `core`, no project — so the default answered `true` in BOTH modes and the
 * "app shell only, no project content" build carried the entire demo folder,
 * 33.9 MB of it, plus a document the repository marks `devOnly`.
 *
 * The mode is known in `stagePublic()` and nowhere else, so it is stated there.
 * This test pins both answers of the switch against the REAL staging function —
 * the flag is what decides, not the tier it happens to be paired with.
 */
describe('-Public carries no demo folder (plan-739 F11)', () => {
  /**
   * The smallest core tree `stageFilteredSourceTree()` accepts for tier `core`:
   * the files it copies unconditionally, the one static recipe it throws over,
   * and the demo folder this test is about.
   */
  function coreFixture() {
    const root = temp('rv-public-shell-');
    const core = join(root, 'core');
    const privateRoot = join(root, 'private');
    mkdirSync(privateRoot, { recursive: true });
    write(join(core, 'src', 'main.ts'), 'export {};');
    write(join(core, 'tsconfig.json'), JSON.stringify({ compilerOptions: { paths: {} } }));
    write(join(core, 'LICENSE'), 'AGPL');
    write(join(core, 'recipes', 'kinematize-cad-import.md'), '# recipe fixture\n');
    write(join(core, 'public', 'settings.json'), '{}');
    const demo = join(core, 'public', PUBLIC_DEMO_FOLDER);
    for (const name of ['DemoRealvirtualWeb.glb', 'DemoRealvirtualWeb.settings.json']) {
      write(join(demo, name), name);
    }
    write(join(demo, 'project.json'), JSON.stringify({
      schemaVersion: 2, id: 'prj_sample', name: 'DemoRealvirtual', kind: 'demo',
      settings: { defaultModel: 'DemoRealvirtualWeb.glb' },
      documents: [{
        id: 'doc_a', name: 'Demo', path: 'DemoRealvirtualWeb.glb',
        settingsPath: 'DemoRealvirtualWeb.settings.json',
      }],
    }));
    return { core, privateRoot };
  }

  it('includePublicDemoContent:false leaves no demo folder in the staged core', () => {
    const { core, privateRoot } = coreFixture();
    const staged = stageFilteredSourceTree({
      coreRoot: core,
      privateRoot,
      profile: { tier: 'core', restrictedFeatures: [] },
      includePublicDemoContent: false,
    });
    temporary.push(staged.workspaceRoot);

    // The staged core is what Vite builds into `dist/`, so this is the statement
    // that decides what the `-Public` zip contains.
    expect(existsSync(join(staged.coreRoot, 'public', PUBLIC_DEMO_FOLDER))).toBe(false);
    // …and `public/settings.json`, the file the shell genuinely needs, still
    // arrives — a filter that took everything would pass the line above too.
    expect(existsSync(join(staged.coreRoot, 'public', 'settings.json'))).toBe(true);
    // The demo is staged as a customer PROJECT on this branch (plan-737 F4),
    // beside the core rather than inside it. That folder is not part of the
    // build, so it never reaches the zip — but saying so here is what keeps a
    // future reader from "fixing" the assertion above by deleting it.
    expect(existsSync(join(staged.workspaceRoot, 'projects', PUBLIC_DEMO_FOLDER, 'project.json')))
      .toBe(true);
  });

  it('includePublicDemoContent:true keeps it — the flag decides, not the tier', () => {
    const { core, privateRoot } = coreFixture();
    const staged = stageFilteredSourceTree({
      coreRoot: core,
      privateRoot,
      profile: { tier: 'core', restrictedFeatures: [] },
      includePublicDemoContent: true,
    });
    temporary.push(staged.workspaceRoot);

    expect(existsSync(join(staged.coreRoot, 'public', PUBLIC_DEMO_FOLDER, 'project.json')))
      .toBe(true);
    // Not ALSO under projects/, or the bundle would list the demo twice.
    expect(existsSync(join(staged.workspaceRoot, 'projects', PUBLIC_DEMO_FOLDER))).toBe(false);
  });

  it('the CONNECT profile shape is exactly the one the old default answered TRUE for', () => {
    // The regression in one line: omitting the flag with CONNECT's own options
    // still yields a staged core WITH the demo folder. This is not a bug in the
    // default — it is the reason `stagePublic()` must state the mode instead of
    // letting a delivery heuristic guess it.
    const { core, privateRoot } = coreFixture();
    const staged = stageFilteredSourceTree({
      coreRoot: core,
      privateRoot,
      profile: { tier: 'core', restrictedFeatures: [] },
    });
    temporary.push(staged.workspaceRoot);
    expect(existsSync(join(staged.coreRoot, 'public', PUBLIC_DEMO_FOLDER))).toBe(true);
  });
});
