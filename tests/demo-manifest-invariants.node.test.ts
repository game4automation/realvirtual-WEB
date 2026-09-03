// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * demo-manifest-invariants — the authored demo manifest is a CONTRACT, not a
 * config file (plan-726 §9.1).
 *
 * Since plan-726 `public/project.json` is the single source of truth for what
 * the demo contains and what it opens, on all four channels. Three of its
 * properties cannot be checked by reading it and cannot be recovered once they
 * are wrong in a shipped build:
 *
 *  - **the project id.** `prj_sample` is written into `localStorage` and into
 *    cache-ownership markers by every build ever shipped. Renaming it orphans
 *    all of them at once (`bundled-backend.ts` says so at the constant).
 *  - **the document ids.** `openDocument()` puts them in the address bar as
 *    `?doc=<id>`, so they are the links people have already sent each other.
 *    They must be `stableDocumentId(path)` — a hand-written literal would send
 *    every existing link to `reportMissingDocument()`.
 *  - **the start document.** `settings.defaultModel` is what the boot opens. If
 *    it matches no document, the demo comes up with an empty viewport.
 *
 * A Node test rather than a browser one because it is a statement about a FILE.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isValidProjectV2 } from '../src/core/project/rv-project-types';
import {
  findStartDocument,
  stableDocumentId,
} from '../src/core/project/rv-project-documents';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Read rather than `import`: this asserts the bytes that ship in `public/`, and
 * a JSON import would let a bundler transform stand between the test and the
 * file it is about.
 */
const demo = JSON.parse(readFileSync(join(ROOT, 'public', 'demo-realvirtual', 'project.json'), 'utf8'));

/**
 * The two constants `bundled-backend.ts` exports, restated as literals.
 *
 * Deliberately NOT imported from that module: it pulls the published-scene
 * catalogue and the whole project-types graph behind it, and this test would
 * then fail for reasons that have nothing to do with the manifest. The values
 * are pinned in `project-backend.test.ts` against the real exports, so a drift
 * between these literals and the module cannot pass unnoticed.
 */
const DEMO_PROJECT_ID = 'prj_sample';
const DEMO_PROJECT_SLUG = 'demorealvirtual';

describe('the demo project manifest', () => {
  it('is a valid v2 manifest', () => {
    // The gate `BundledBackend.readManifest()` now actually applies (F11b).
    // Failing it here means the shipped demo would silently fall back to the
    // synthetic project instead of showing the curated one.
    expect(isValidProjectV2(demo)).toBe(true);
  });

  it('keeps the id that localStorage and cache markers depend on', () => {
    expect(demo.id).toBe(DEMO_PROJECT_ID);
    expect(demo.canonicalName).toBe(DEMO_PROJECT_SLUG);
  });

  it('is marked as a demo project', () => {
    expect(demo.kind).toBe('demo');
  });

  // F8b — hand-written ids would break every ?doc= link the app itself produced
  it('derives every document id from stableDocumentId(path)', () => {
    for (const d of demo.documents) {
      expect(d.id, `document ${d.path}`).toBe(stableDocumentId(d.path));
    }
  });

  it('has no duplicate document ids or paths', () => {
    const ids = demo.documents.map((d: { id: string }) => d.id);
    const paths = demo.documents.map((d: { path: string }) => d.path);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('names a start document that actually exists in documents[]', () => {
    const start = demo.settings?.defaultModel;
    expect(start).toBeTruthy();
    expect(findStartDocument(demo, start)).not.toBeNull();
  });

  it('contains exactly the public demo surface: the demo model and the planner scene', () => {
    // User decision 2026-08-30: DemoRobotIK and DemoCSGMachining are internal
    // dev/test models only — they stay in the repo as test fixtures but must
    // never appear in the public manifest (which IS the deploy surface since
    // plan-726). DemoPlanner is public.
    // User decision 2026-08-31: both demo documents live at the MAIN level of
    // public/, not in scenes//models/ subfolders — the folder is a place, not
    // a type; their sections are declared explicitly on the rows.
    const paths = demo.documents.map((d: { path: string }) => d.path);
    expect(paths).toEqual(expect.arrayContaining([
      'DemoRealvirtualWeb.glb',
      'DemoPlanner.glb',
    ]));
    expect(paths).not.toContain('models/DemoRobotIK.glb');
    expect(paths).not.toContain('models/DemoCSGMachining.glb');
  });

  it('every document names a file that is actually in public/', () => {
    // The runtime half of the deploy guard: a manifest row with no file behind
    // it is a 404 the visitor hits and nobody else does.
    for (const d of demo.documents) {
      expect(() => readFileSync(join(ROOT, 'public', 'demo-realvirtual', d.path)), d.path).not.toThrow();
    }
  });

  it('declares NO section on any document (plan-736 F3)', () => {
    /**
     * The inverse of the invariant that stood here, and deliberately so.
     *
     * It used to demand an explicit `section` on every row, on the grounds that
     * "root-level paths imply no section, so the row must say what it is". That
     * was true while something CONSUMED the field — the storage routing did,
     * until plan-736 replaced it with one `writeDocument`. Nothing reads it now,
     * so a row carrying it is a row asserting something no code can be wrong
     * about, and the demo manifest is the reference every hand-written and
     * generated manifest is copied from.
     *
     * This is an invariant this repository imposes on ITS OWN manifest, not a
     * schema rule: a delivered customer `project.json` that still carries
     * `section` keeps it forever (§F4, `mergeManifest` passthrough), and
     * `isValidProjectV1` still rejects nothing for having it.
     */
    for (const d of demo.documents) {
      expect(d.section, `${d.path} still carries a section`).toBeUndefined();
    }
  });

  it('owns no library documents — the library is app-level (plan-737 F7)', () => {
    // The 17 `library/…` rows that used to sit here made the demo the OWNER of
    // the shipped component library. Since plan-737 the library is app-level
    // (`public/library/`, one copy, delivered by DELIVERED_LIBRARY_CATEGORIES)
    // and the demo is one SUBSCRIBER through its `libraries[]` — which is what
    // keeps the demo folder a self-contained, always-overwritable artefact.
    const owned = demo.documents.filter((d: { path: string }) => /^library\//i.test(d.path));
    expect(owned.map((d: { path: string }) => d.path)).toEqual([]);
    expect((demo.libraries ?? []).map((l: { url: string }) => l.url)).toContain('library/catalog.json');
  });

  it('ships the knowledge sidecar the dashboard renders (plan-737 F8)', () => {
    // `*.knowledge.md`, not a bare `knowledge.md`: only the SUFFIX is listed as
    // knowledge (KNOWLEDGE_FILE_SUFFIX, rv-project-refs.ts). A plain `.md` would
    // get the generic preview and never reach the knowledge pane.
    const knowledge = demo.documents.filter((d: { path: string }) => d.path.endsWith('.knowledge.md'));
    expect(knowledge.length, 'the demo must explain that it is an overwritable sandbox').toBe(1);
    expect(() => readFileSync(join(ROOT, 'public', 'demo-realvirtual', knowledge[0].path))).not.toThrow();
  });

  it('every document says where it is in its PATH', () => {
    // What the section invariant was really protecting: a row you can locate.
    // The path is the whole answer now, so it has to be one.
    for (const d of demo.documents) {
      expect(typeof d.path === 'string' && d.path.trim() !== '', String(d.path)).toBe(true);
      expect(d.path.startsWith('/'), d.path).toBe(false);
    }
  });
});

// ─── F10: one definition of "the demo model", not seven ────────────────────

/**
 * Walk the trees plan-726 Phase 6 counted, and answer the question that phase
 * asked: which files still spell out the demo model as an executable value?
 *
 * The count was 7 when the plan was written. Three collapsed into the manifest
 * (`public/settings.json`, `connect-embed-store.ts`, `WelcomeModal.tsx`), one
 * into `stage-public.mjs`'s manifest read. The three that remain are kept
 * ON PURPOSE — each answers a different question than "what does the demo
 * open", and the plan says so in as many words ("Nicht anfassen"). Encoding
 * them here turns a one-off grep into the thing it was standing in for: an
 * alarm when an EIGHTH definition appears.
 */
const LITERAL = 'DemoRealvirtualWeb';
const SCAN_EXT = ['.ts', '.tsx', '.mjs', '.json'];
const SCAN_ROOTS = [
  join(ROOT, 'public'),
  join(ROOT, 'src'),
  join(ROOT, 'scripts'),
  join(ROOT, '..', 'realvirtual-Connect~', 'tools'),
];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // A Connect~ sibling need not exist in every checkout.
  }
  for (const e of entries) {
    if (e === 'node_modules' || e === 'dist' || e.startsWith('.')) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (SCAN_EXT.some(x => e.endsWith(x))) out.push(p);
  }
  return out;
}

/**
 * Best-effort comment removal, so prose mentioning the demo does not have to be
 * allowlisted. `//` is only treated as a comment when not preceded by `:`, which
 * keeps `https://…` intact. The failure mode is a false NEGATIVE only in the
 * contrived case of the literal appearing after a `//` inside a string — and the
 * file-set assertion below would still catch a newly-added file.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

describe('the demo model is defined once (plan-726 F10)', () => {
  const hits = SCAN_ROOTS
    .flatMap(r => walk(r))
    .filter(f => stripComments(readFileSync(f, 'utf8')).includes(LITERAL))
    .map(f => relative(ROOT, f).split(sep).join('/'))
    .sort();

  it('names the model in exactly the files that legitimately do', () => {
    // Grouped by REASON and sorted at the comparison, because the grouping is
    // the point: a new entry has to be argued into one of these buckets.
    expect(hits).toEqual([
      // ── The one definition of what the demo opens ──
      'public/demo-realvirtual/project.json',

      // ── Bound to the filename, not to "the default" ──
      // A per-model settings sidecar is addressed BY the model's name; it
      // cannot be expressed through the manifest without inverting that.
      'public/demo-realvirtual/DemoRealvirtualWeb.settings.json',

      // ── Model-plugin bindings: naming their model is their whole job ──
      // `models`/`baseModel` say "attach this plugin when THAT model loads".
      // Routing them through the manifest would make every model plugin load
      // for the demo's start document, which is the opposite of a binding.
      'src/plugins/models/DemoRealvirtualWeb/index.ts',
      'src/plugins/models/DemoRealvirtualWeb/model-options.ts',

      // ── One FEWER since plan-737 ──
      // `scripts/_workspace-lib.mjs` used to belong here, for
      // `DELIVERED_DEMO_MODEL_FILES` — the list of demo files a customer
      // delivery copied to its deploy root as a "reference model". plan-737
      // delivers the demo as a whole PROJECT folder, so the delivery no longer
      // names any file inside it: it copies the folder and lets the folder's
      // own manifest say what is in it. The count this test tracks went 7 → 6 →
      // 5, and the direction is the point.

      // ── Dev tooling input ──
      // A vignette render script naming its source GLB.
      'scripts/vignettes/conveyor-sensor.json',
    ].sort());
  });

  it('WelcomeModal no longer carries a filename fallback (Phase 5 rest)', () => {
    // The last of the three that collapsed. Its fallback is the PROJECT slug
    // route now, which resolves through the manifest on the next load.
    const src = readFileSync(join(ROOT, 'src', 'core', 'hmi', 'WelcomeModal.tsx'), 'utf8');
    expect(src).not.toContain(`?model=${LITERAL}`);
    expect(src).toContain('DEMO_PROJECT_SLUG');
  });
});

describe('the global settings.json no longer names a default model', () => {
  /**
   * The other half of plan-726 Phase 2, and the reason that phase is atomic:
   * `settings.defaultModel` and the manifest's start document are now ONE
   * decision, taken in the manifest. A value left here would quietly win in the
   * `?model=` legacy resolution and put the two back out of step.
   */
  it('settings.json has no defaultModel — the manifest owns that', () => {
    const settings = JSON.parse(readFileSync(join(ROOT, 'public', 'settings.json'), 'utf8'));
    expect(settings.defaultModel ?? '').toBe('');
  });
});

// ─── plan-731 F2/F3: one catalogue, one identity space ────────────────────

/**
 * The second catalogue is gone, and the second identity space with it.
 *
 * Stated here, against FILES, for the same reason the rest of this file is:
 * these are properties nobody can recover once a build has shipped them wrong.
 * A leftover `public/scenes/index.json` would be parsed by any `discover`
 * backend pointed at our own deploy root and would put a second, disagreeing
 * answer to "what scenes does this project have" back on the wire; a source
 * file still declaring `availablePublishedScenes` would put the boot's ordering
 * hazard back.
 */
describe('the published-scene catalogue is gone (plan-731 F2)', () => {
  it('public/scenes/ does not exist', () => {
    expect(existsSync(join(ROOT, 'public', 'scenes'))).toBe(false);
  });

  it('public/scenes/index.json does not exist', () => {
    expect(existsSync(join(ROOT, 'public', 'scenes', 'index.json'))).toBe(false);
  });

  it('the fixture that lived there is a manifest row now, marked devOnly', () => {
    // plan-731 2a. Reachable only through the second catalogue before, which is
    // exactly why no release gate could see it; `devOnly` is what every staging
    // path prunes on and what Phase 4 asserts against.
    const fixture = demo.documents.find(
      (d: { path: string }) => d.path === 'Test-DES-Turntable-Loop.glb',
    );
    expect(fixture, 'the turntable fixture is a document row').toBeTruthy();
    expect(fixture.devOnly).toBe(true);
    expect(fixture.id).toBe(stableDocumentId(fixture.path));
  });

  it('the start document declares its settings sidecar (plan-731 F5)', () => {
    // Phase 3: the sidecar is addressed by the manifest, not by a filename
    // convention hard-coded in a staging script.
    const start = findStartDocument(demo, demo.settings?.defaultModel);
    expect(start, 'the start document resolves').toBeTruthy();
    expect(start!.settingsPath).toBe('DemoRealvirtualWeb.settings.json');
    expect(() => readFileSync(join(ROOT, 'public', 'demo-realvirtual', start!.settingsPath as string)))
      .not.toThrow();
  });
});

/**
 * No source file declares the removed identity space.
 *
 * A SOURCE guard, in the `json-removal-guard` pattern the dashboard's own test
 * uses: the failure mode is a future edit re-introducing the field by copying a
 * neighbouring line, which no behavioural test would notice. It lives in the
 * Node suite because that is where a file can simply be read — a `?raw` import
 * of a `.ts` module does not resolve in the browser-mode suite.
 */
describe('no source declares a second scene list (plan-731 F3)', () => {
  /** Whole-line comments stripped: prose may still name what was removed. */
  const codeOf = (...parts: string[]) => readFileSync(join(ROOT, ...parts), 'utf8')
    .split('\n')
    .filter(line => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .join('\n');

  it('the viewer facade has no availablePublishedScenes field', () => {
    expect(codeOf('src', 'core', 'rv-viewer.ts')).not.toContain('availablePublishedScenes');
  });

  it('boot neither discovers nor injects a published-scene list', () => {
    const main = codeOf('src', 'main.ts');
    expect(main).not.toContain('availablePublishedScenes');
    expect(main).not.toContain('discoverPublishedScenes');
    expect(main).not.toContain('scenes/index.json');
  });

  it('the scene store has no second catalogue and no second open verb', () => {
    const store = codeOf('src', 'core', 'hmi', 'scene', 'scene-store.ts');
    for (const gone of [
      'listPublished(', '_activePublishedName', 'openPublishedExample(',
      'materializePublishedExample(',
    ]) {
      expect(store, `${gone} is gone from SceneStore`).not.toContain(gone);
    }
  });

  it('the alias module resolves against documents, and holds no catalogue', () => {
    const alias = codeOf('src', 'core', 'hmi', 'scene', 'rv-published-scenes.ts');
    expect(alias).toContain('resolvePublishedAlias');
    // The catalogue parser moved to the boundary that reads a FOREIGN one —
    // and then, with plan-735, out of the codebase entirely.
    expect(alias).not.toContain('parsePublishedIndex');
    expect(alias).not.toContain('fetch(');
  });

  // ── plan-735 F5 (5f): the build-time glob is gone, and stays gone ────────
  //
  // A source guard rather than a behavioural one, because that is what the
  // requirement actually is: `import.meta.glob` is resolved by the BUNDLER, so
  // its effect exists only in a built artefact and no unit test can observe its
  // absence at runtime. What can be observed is the line, and the line is the
  // whole mechanism — it is how the dev checkout's `public/models/` leaked into
  // every build's catalogue and, through `_syntheticManifest()`, into a project
  // nobody had published.
  it('main.ts discovers no models from a build-time glob', () => {
    const main = codeOf('src', 'main.ts');
    expect(main).not.toContain("import.meta.glob('/public/models/");
    expect(main).not.toContain('import.meta.glob("/public/models/');
    // The channels that DO feed the catalogue are still there — this is a
    // removal, not an amputation of model discovery.
    expect(main).toContain('models.json');
    expect(main).toContain('/__api/private-models');
  });

  // ── plan-735 F6 (3b): the synthetic manifest and its feeders are gone ────
  it('the bundled backend invents no project', () => {
    const backend = codeOf('src', 'core', 'project', 'backends', 'bundled-backend.ts');
    for (const gone of [
      '_syntheticManifest',
      '_bundledDocuments',
      '_modelEntries',
      '_publishedEntries',
      '_withBundledSections',
      'parsePublishedIndex',
      'publishedScenePath',
      "scenes/index.json",
    ]) {
      expect(backend, `${gone} is gone from BundledBackend`).not.toContain(gone);
    }
  });
});
