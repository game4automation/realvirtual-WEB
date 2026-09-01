// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-395 §7.3/§7.4 — `public/models/` contains only what is shipped.
 *
 * This file exists because the acceptance criterion it replaces did not
 * survive: "contains exactly these two files" was written three times in two
 * days and was wrong all three times. `public/models/` was the directory
 * everybody wrote into, because there was nowhere else to put an experiment.
 *
 * So the criterion is a RULE with a guard, and the rule is:
 *
 *   `public/models/` holds shipped demo models. Everything internal — every
 *   fixture, every experiment, every NDA-covered machine — lives in the private
 *   sibling's `projects/Development/`.
 *
 * Two guards are needed and they are not the same guard (SOL round 2,
 * finding 4). `publicModels_OnlyShippedDemos` asks whether a file is DELIVERED,
 * against the manifest that decides delivery. `publicModels_NoTestConsumers`
 * asks whether anything LOADS it from `tests/`, `e2e/` or `scripts/`. A file can
 * fail either independently: `DemoCSGMachining.glb` had no test consumers at all
 * and was still pruned from every public deploy.
 *
 * `scratch/` is the other half of this, and the half a guard cannot supply: a
 * prohibition with no named alternative just moves the pile somewhere else.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEV_GLB } from './fixtures/glb-paths.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// These guards interrogate the PUBLISHER's git index. The community precheck
// stages the tracked files into a bare directory without `.git` (deliberate
// mirror fidelity), where `git ls-files` cannot answer — and a community clone
// satisfies the guards trivially, since it only ever received tracked files.
// So: no git repo, no guard to run.
const IN_GIT_REPO = existsSync(resolve(REPO, '.git'));

const git = (...args: string[]): string =>
  execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const lines = (out: string): string[] => out.split('\n').map(l => l.trim()).filter(Boolean);

/**
 * Every path git tracks AND that is present in the working tree.
 *
 * The second half matters while a removal is staged but not yet committed —
 * exactly the state this plan's own change passes through. `git ls-files` still
 * names a file that has been deleted on disk, so a guard reading it alone would
 * report the very removal it exists to check as a failure. What the guard means
 * by "in the repo" is "ships from the repo", and a file that is not on disk
 * ships from nowhere.
 */
const tracked = (): string[] => {
  const deleted = new Set(lines(git('ls-files', '--deleted')));
  return lines(git('ls-files')).filter(p => !deleted.has(p));
};

/** The model documents of the shipped manifest — the delivery decision. */
function shippedModelFiles(): Set<string> {
  const manifestPath = resolve(REPO, 'public/project.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    documents?: Array<{ path?: string; section?: string }>;
  };
  const files = new Set<string>();
  for (const doc of manifest.documents ?? []) {
    const path = typeof doc.path === 'string' ? doc.path : '';
    // The demo documents live at the ROOT of public/ since 2026-08-31, typed by
    // `section`; a `models/` path spelling is still honoured for older rows.
    const isModel = doc.section === 'models' || path.startsWith('models/');
    if (!isModel) continue;
    const name = path.startsWith('models/') ? path.slice('models/'.length) : path;
    if (name && !name.includes('/')) files.add(name);
  }
  return files;
}

describe.skipIf(!IN_GIT_REPO)('publicModels_OnlyShippedDemos (plan-395 §2.10, F1)', () => {
  it('every tracked file in public/models/ is a model the manifest ships, or its settings sidecar', () => {
    const shipped = shippedModelFiles();
    // Asserted, not assumed: an empty shipped set would make this whole test
    // vacuously true, which is the failure mode of every allowlist guard.
    expect(shipped.size, 'public/project.json must list at least one model document').toBeGreaterThan(0);

    const topLevel = tracked()
      .filter(p => p.startsWith('public/models/'))
      .map(p => p.slice('public/models/'.length))
      .filter(name => !name.includes('/'));

    const offenders = topLevel.filter((name) => {
      if (shipped.has(name)) return false;
      // A `<Model>.settings.json` belongs to the model it names and ships with it.
      const owner = name.endsWith('.settings.json')
        ? `${name.slice(0, -'.settings.json'.length)}.glb`
        : null;
      return !(owner && shipped.has(owner));
    });

    expect(
      offenders,
      'these files sit in public/models/ but are not shipped. Internal material belongs in '
      + 'the private sibling: projects/Development/models/ for real models, '
      + 'projects/Development/fixtures/ for test fixtures, projects/Development/scratch/ '
      + 'for experiments (plan-395)',
    ).toEqual([]);
  });

  it('nothing is tracked under public/models/library/ any more', () => {
    // Both landing zones are gone: Custom/ moved into the Development project,
    // imports/ was deleted (F6). The .gitignore rules that keep them out stay.
    const nested = tracked().filter(p => p.startsWith('public/models/library/'));
    expect(nested).toEqual([]);
  });
});

describe.skipIf(!IN_GIT_REPO)('publicModels_NoTestConsumers (plan-395 §2.10, F1/R15)', () => {
  it('no test composes a public /models/ URL for anything but a shipped model', () => {
    // The literal form of §2.10's second guard — "no file in public/models/ has
    // test consumers" — was written before this was measured, and measuring it
    // produced its first real finding: `DemoRealvirtualWeb.glb` has fifteen. It
    // is the SHIPPED demo, and smoke-testing the thing customers actually get is
    // not a defect; moving it would delete that coverage to satisfy a rule whose
    // purpose it already meets.
    //
    // So the guard is stated as what R15 protects rather than as a proxy for it:
    // an internal fixture must not come back as a public `/models/` URL. Any
    // `/models/<name>.glb` a test composes must name a model the manifest ships.
    // That still catches the regression the plan feared — a fixture reappearing
    // under `/models/` — and catches it even before the file exists, while
    // leaving the shipped demo alone.
    // The names are taken from `DEV_GLB` itself, not from a list written here.
    // Two reasons, and the second is the one that matters: a hand-kept list ages
    // (§2.1 — this plan's own inventory aged three times in two days), and a
    // free-text scan for any `/models/<x>.glb` produces mostly noise, because
    // unit tests are full of synthetic paths like `/models/Quux.glb` that name
    // nothing and load nothing. Anchoring on DEV_GLB asks the precise question:
    // is an INTERNAL asset being reached through a public URL again?
    const internalNames = new Set(
      Object.values(DEV_GLB as Record<string, string>).map(url => url.split('/').pop() ?? ''),
    );
    expect(internalNames.size, 'DEV_GLB must still name the internal assets').toBeGreaterThan(0);

    const sources = tracked().filter(p =>
      (p.startsWith('tests/') || p.startsWith('e2e/') || p.startsWith('scripts/'))
      && /\.(ts|mts|mjs|js)$/.test(p)
      // These three NAME disallowed models on purpose, as the input that proves
      // the deploy prune removes them. A constant would stop them testing that.
      && !p.endsWith('bunny-deploy.node.test.ts')
      && !p.endsWith('stage-public-demo.node.test.ts')
      && !p.endsWith('customer-workspace.node.test.ts')
      && !p.endsWith('public-models-boundary.node.test.ts')
      // Same class, different guard: assert-public-safe.mjs names these paths as
      // FORBIDDEN on the public mirror. Reading a deny-list as an offence would
      // make every guard its own violation.
      && !p.endsWith('assert-public-safe.mjs')
      // The SSOT builds its URLs from a `${DEV}` template, so the literal
      // `/models/<name>` appears there without the `Development/` prefix that
      // marks a private URL. It is the definition, not a consumer.
      && !p.endsWith('fixtures/glb-paths.mjs')
      // The plan-455 inventory keys assets by repo-relative PATH, not by URL —
      // `projects/Development/models/<name>` is a file location it reads off
      // disk, not a public route it fetches.
      && !p.endsWith('behavior-extras-inventory.node.test.ts'));

    const offenders: string[] = [];
    for (const source of sources) {
      const src = readFileSync(resolve(REPO, source), 'utf8');
      for (const name of internalNames) {
        // `/private-assets/Development/models/<name>` contains `/models/<name>`
        // too, and that IS the private route — the whole point of the move. Only
        // a hit that is not part of a private URL counts.
        const publicHits = src.split(`/models/${name}`).length - 1;
        const privateHits = src.split(`Development/models/${name}`).length - 1;
        if (publicHits > privateHits) offenders.push(`${source} → /models/${name}`);
      }
    }

    expect(
      [...new Set(offenders)].sort(),
      'these reach an internal asset through a public /models/ URL. It lives in the '
      + "private sibling's projects/Development/ and is reached through DEV_GLB "
      + '(plan-395 §2.3)',
    ).toEqual([]);
  });
});

describe.skipIf(!IN_GIT_REPO)('publicRepo_HasNoInternalAssets (plan-395 §7.3, F4/F6/R7)', () => {
  /** Every file plan-395 moved out or deleted, by the name it had here. */
  const MOVED_OUT = [
    'public/models/tests.glb',
    'public/models/physics-zone-test.glb',
    'public/models/mechanism-delta.glb',
    'public/models/mechanism-fourbar.glb',
    'public/models/mechanism-scissor.glb',
    'public/models/DemoRobotIK.glb',
    'public/models/EuropalletEmpty.glb',
    'public/models/DemoCSGMachining.glb',
  ];

  it('git tracks none of the relocated internal assets', () => {
    const all = new Set(tracked());
    expect(MOVED_OUT.filter(p => all.has(p))).toEqual([]);
  });

  it('none of them is left lying in the working tree either', () => {
    // Tracking is the security property; presence is the hygiene one. An
    // untracked 36 MB fixture still gets copied into `dist/` by Vite, and that
    // is how internal geometry reached a public deploy before.
    expect(MOVED_OUT.filter(p => existsSync(resolve(REPO, p)))).toEqual([]);
  });

  it('the two NDA-covered file names appear nowhere in the tracked tree', () => {
    // Named explicitly rather than covered by a folder rule: these are the two
    // files whose exposure would be a contractual problem, not a tidiness one.
    const all = tracked();
    for (const nda of ['Side Cutting.glb', 'SideCuttingMachine.glb']) {
      expect(all.filter(p => p.endsWith(nda)), `${nda} must not be tracked here`).toEqual([]);
    }
  });
});

describe('publicRepo_HasNoImports (plan-395 F6)', () => {
  it('the CAD import landing zone is gone from the working tree', () => {
    expect(existsSync(resolve(REPO, 'public/models/library/imports'))).toBe(false);
  });
});

describe.skipIf(!IN_GIT_REPO)('devAssets_HaveTheSkipMechanic (plan-395 §2.3)', () => {
  it('every test that imports DEV_GLB also imports the skip probe', () => {
    // The coupling the whole scheme rests on: a DEV_GLB import without a probe
    // is a suite that will fail hard in a public checkout instead of skipping.
    // Cheap to state here, and it is the rule a new test author will break.
    const consumers = tracked().filter(p =>
      (p.startsWith('tests/') || p.startsWith('e2e/'))
      && /\.(test|spec)\.ts$/.test(p)
      && readFileSync(resolve(REPO, p), 'utf8').includes('glb-paths.mjs'));

    expect(consumers.length, 'expected DEV_GLB to still have test consumers').toBeGreaterThan(0);

    const missing = consumers.filter((p) => {
      const src = readFileSync(resolve(REPO, p), 'utf8');
      return !src.includes('dev-asset-available')  // browser probe
        && !src.includes('HAS_DEV_ASSETS')         // Playwright, asset-precise
        // Playwright, older and stricter: those specs also need the private
        // SOURCE, so its absence already covers the assets. Accepted rather
        // than rewritten — two conditions that are always true together, and
        // the existing one is the more demanding of the two.
        && !src.includes('HAS_PRIVATE_SOURCE')
        // Parked outright for a reason of its own (a fixture that has to be
        // re-exported from Unity first). A permanently skipped suite cannot
        // fail in a public checkout, so it needs no probe.
        && !src.includes('describe.skip(')
        && !src.includes('dev-asset-probe');       // the probe's own test
    });

    expect(
      missing,
      'these load an internal asset without a skip guard. Browser tests: '
      + "`const DEV_ASSETS = await devAssetAvailable(DEV_GLB.x)` + `describe.skipIf(!DEV_ASSETS)`. "
      + "Playwright: `test.skip(!HAS_DEV_ASSETS, DEV_ASSETS_SKIP_REASON)`. See plan-395 §2.6",
    ).toEqual([]);
  });
});
