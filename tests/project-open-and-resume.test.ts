// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * §9.15 — one "Open…", and what it lands on (plan-703 Phase 6, §2.6.3,
 * decisions 1, 2, 3, 24; F14, F15).
 *
 * Four things, and the fourth is the one that is easiest to break by accident:
 *
 *  1. Auto-detection, all three cases — project, workspace, "create one here?".
 *  2. A folder that is BOTH a project and a workspace opens as the project, with
 *     the child projects surfaced as a hint (decision 2).
 *  3. The resume order: URL > remembered (asset + mode) > `defaultModel`.
 *  4. Kiosk always takes `defaultModel`, and **an asset switch never changes the
 *     mode** (decision 24).
 *
 * The File System Access side is faked through `tests/helpers/fake-fs-handles`,
 * which is what the six existing project tests already use — so the probe this
 * file feeds `detectOpenTarget` is built the same way the production caller
 * builds it, from a directory listing.
 */

import { describe, it, expect } from 'vitest';
import {
  detectOpenTarget,
  diagnoseKioskBoot,
  parseRememberedSession,
  projectStartDocument,
  rememberedSessionOf,
  resolveResumeTarget,
  resumeStorageKey,
  resumeTargetForAssetSwitch,
  type OpenProbe,
} from '../src/core/project/rv-project-open';
import {
  forgetRememberedSession,
  readRememberedSession,
  rememberSession,
} from '../src/core/project/rv-project-resume-store';
import { FakeDir } from './helpers/fake-fs-handles';

// ─── Probing a folder through the fake File System Access API ────────────

const MANIFEST = 'project.json';

const MANIFEST_TEXT = JSON.stringify({ schemaVersion: 2, name: 'A project' });

/**
 * The listing the production "Open…" does, against a fake handle.
 *
 * Direct children only, and only for a manifest — the same rule
 * `discoverWorkspaceProjects` already follows. Written out here rather than
 * imported so §9.15 states the probe it is testing rather than inheriting it.
 */
async function probeFolder(dir: FakeDir): Promise<OpenProbe> {
  let hasManifest = false;
  const childProjectFolders: string[] = [];
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind === 'file') { if (name === MANIFEST) hasManifest = true; continue; }
    try {
      await handle.getFileHandle(MANIFEST);
      childProjectFolders.push(name);
    } catch { /* an ordinary folder — notes, exports, scratch */ }
  }
  return { hasManifest, childProjectFolders };
}

/**
 * A folder tree from a spec: `{ 'project.json': true, Sub: { … } }`.
 *
 * `true` means "a manifest lives here"; a nested object is a subfolder.
 */
type FolderSpec = { [name: string]: true | FolderSpec };

function fill(dir: FakeDir, spec: FolderSpec): FakeDir {
  for (const [key, value] of Object.entries(spec)) {
    if (value === true) dir.seedText(key, MANIFEST_TEXT);
    else fill(dir.seedDir(key), value);
  }
  return dir;
}

function folder(name: string, spec: FolderSpec): FakeDir {
  return fill(new FakeDir(name), spec);
}

describe('§9.15 — auto-detection (F14, decisions 1 and 2)', () => {
  it('a folder with its own project.json is a project', async () => {
    const dir = folder('MyPlant', { [MANIFEST]: true });
    expect(detectOpenTarget(await probeFolder(dir)))
      .toEqual({ kind: 'project', childProjects: [] });
  });

  it('a folder holding child projects is a workspace', async () => {
    const dir = folder('Workspace', {
      PlantA: { [MANIFEST]: true },
      PlantB: { [MANIFEST]: true },
      Notes: {},
    });
    const target = detectOpenTarget(await probeFolder(dir));
    expect(target.kind).toBe('workspace');
    expect(target.childProjects.sort()).toEqual(['PlantA', 'PlantB']);
  });

  it('a folder that is neither offers to create a project', async () => {
    const dir = folder('Downloads', { Stuff: {} });
    expect(detectOpenTarget(await probeFolder(dir)))
      .toEqual({ kind: 'empty', childProjects: [] });
  });

  it('the project wins over its child projects, and they become a hint', async () => {
    // Decision 2: a folder can legitimately be both. Opening it as a workspace
    // would hide the manifest the user actually pointed at.
    const dir = folder('MyPlant', {
      [MANIFEST]: true,
      SubPlant: { [MANIFEST]: true },
    });
    const target = detectOpenTarget(await probeFolder(dir));
    expect(target.kind).toBe('project');
    expect(target.childProjects).toEqual(['SubPlant']);
  });

  it('an entirely empty folder is "create one here?", not an error', async () => {
    expect(detectOpenTarget(await probeFolder(folder('Empty', {}))))
      .toEqual({ kind: 'empty', childProjects: [] });
  });

  it('is total — every probe shape has an answer', () => {
    expect(detectOpenTarget({ hasManifest: false }).kind).toBe('empty');
    expect(detectOpenTarget({ hasManifest: true }).kind).toBe('project');
    expect(detectOpenTarget({ hasManifest: false, childProjectFolders: [] }).kind).toBe('empty');
  });
});

// ─── Resume order (F15, decision 3) ──────────────────────────────────────

describe('§9.15 — the resume order', () => {
  const remembered = { asset: 'machines/Filler.glb', mode: 'planner' };

  it('the URL beats everything a session remembers', () => {
    expect(resolveResumeTarget({
      search: '?scene=scenes/Line.glb',
      remembered,
      defaultModel: 'models/Default.glb',
    })).toEqual({ asset: 'scenes/Line.glb', mode: null, source: 'url' });
  });

  it('?model= is the same statement as ?scene= — every GLB is an asset', () => {
    expect(resolveResumeTarget({ search: '?model=models/Roll.glb' }).asset)
      .toBe('models/Roll.glb');
  });

  it('a URL never carries a mode — a link must not relocate the recipient', () => {
    expect(resolveResumeTarget({ search: '?scene=a.glb', remembered }).mode).toBeNull();
  });

  it('the remembered PAIR is next, and it is the one place a mode is restored', () => {
    expect(resolveResumeTarget({
      search: '',
      remembered,
      defaultModel: 'models/Default.glb',
    })).toEqual({ asset: 'machines/Filler.glb', mode: 'planner', source: 'remembered' });
  });

  it('defaultModel is last, and answers when nothing is remembered', () => {
    expect(resolveResumeTarget({ search: '', defaultModel: 'models/Default.glb' }))
      .toEqual({ asset: 'models/Default.glb', mode: null, source: 'defaultModel' });
  });

  it('answers "nothing" rather than inventing a document', () => {
    expect(resolveResumeTarget({ search: '' }))
      .toEqual({ asset: null, mode: null, source: 'none' });
    expect(resolveResumeTarget({ search: '?scene=%20%20', defaultModel: '  ' }).source)
      .toBe('none');
  });

  it('?project= selects the project, not the asset', () => {
    expect(resolveResumeTarget({ search: '?project=myplant', defaultModel: 'd.glb' }))
      .toEqual({ asset: 'd.glb', mode: null, source: 'defaultModel' });
  });

  it('remembers per project id, so two projects cannot overwrite each other', () => {
    expect(resumeStorageKey('proj_a')).not.toBe(resumeStorageKey('proj_b'));
    expect(resumeStorageKey('proj_a')).toContain('proj_a');
  });
});

// ─── The kiosk exception (decision 3) ────────────────────────────────────

describe('§9.15 — a locked deployment always takes defaultModel', () => {
  it('beats the URL', () => {
    expect(resolveResumeTarget({
      search: '?scene=scenes/Somewhere.glb',
      defaultModel: 'models/Machine.glb',
      modeLocked: true,
    })).toEqual({ asset: 'models/Machine.glb', mode: null, source: 'defaultModel' });
  });

  it('beats the remembered pair — including its MODE', () => {
    // The failure this prevents: a kiosk opened once in planner comes back up in
    // planner, on a terminal with no keyboard.
    const target = resolveResumeTarget({
      search: '',
      remembered: { asset: 'machines/Filler.glb', mode: 'planner' },
      defaultModel: 'models/Machine.glb',
      modeLocked: true,
    });
    expect(target.asset).toBe('models/Machine.glb');
    expect(target.mode).toBeNull();
  });

  it('answers "nothing" when a locked deployment configured no default', () => {
    expect(resolveResumeTarget({ search: '?scene=x.glb', modeLocked: true }))
      .toEqual({ asset: null, mode: null, source: 'none' });
  });
});

// ─── The appliance kiosk boot (plan-721 §2.4, F1) ────────────────────────

/**
 * The regression these guard is subtle: the kiosk branch of
 * `resolveResumeTarget` has never actually run in production. CONNECT-embed
 * never reaches the function, and the Mauser/Toray project plugins lock in the
 * model-plugin hook, i.e. AFTER the boot resolved — so `modeLocked` was always
 * false at that point. plan-721 is the first deployment to run this branch for
 * real, which is why the order below is asserted stage by stage rather than
 * as one happy path.
 */
describe('appliance kiosk boot (plan-721)', () => {
  it('locked mode resolves the manifest start document, not null', () => {
    const t = resolveResumeTarget({
      search: '?model=evil.glb',
      modeLocked: true,
      remembered: { asset: 'x', mode: 'planner' },
      projectActive: 'doc-7',
      // Fed by the call sites as `project.settings.defaultModel`, not from
      // settings.json — the appliance ships no global value at all.
      defaultModel: 'Machine.glb',
    });
    expect(t).toMatchObject({ asset: 'Machine.glb', mode: null, source: 'defaultModel' });
  });

  it('locked mode falls back to projectActive when the manifest field is empty', () => {
    const t = resolveResumeTarget({
      search: '', modeLocked: true, projectActive: 'doc-7', defaultModel: '',
    });
    expect(t).toEqual({ asset: 'doc-7', mode: null, source: 'projectActive' });
  });

  it('still discards the URL and the remembered pair at BOTH new stages', () => {
    // Stage 1 (defaultModel) is covered above; this is stage 2, where the old
    // code returned `none` and the boot fell into the legacy catalogue block.
    const t = resolveResumeTarget({
      search: '?scene=pasted.glb',
      modeLocked: true,
      remembered: { asset: 'remembered.glb', mode: 'editor' },
      projectActive: 'doc-7',
    });
    expect(t.asset).toBe('doc-7');
    expect(t.mode).toBeNull();
  });

  it('a project naming neither still answers "nothing", never a guess', () => {
    expect(resolveResumeTarget({
      search: '', modeLocked: true, projectActive: '   ', defaultModel: '  ',
    })).toEqual({ asset: null, mode: null, source: 'none' });
  });

  it('the unlocked cascade is untouched — projectActive still sits below remembered', () => {
    // The one thing that must NOT change: adding a kiosk stage for
    // `projectActive` must not promote it on the normal path.
    expect(resolveResumeTarget({
      search: '',
      remembered: { asset: 'remembered.glb' },
      projectActive: 'doc-7',
      defaultModel: 'd.glb',
    }).source).toBe('remembered');
  });
});

// ─── The call-site input rule (plan-721 §2.4) ────────────────────────────

describe('plan-721 — the manifest start document beats the global one', () => {
  it('reads project.settings.defaultModel, defensively', () => {
    expect(projectStartDocument({ settings: { defaultModel: 'Machine.glb' } }))
      .toBe('Machine.glb');
    expect(projectStartDocument({ settings: { defaultModel: '  Padded.glb  ' } }))
      .toBe('Padded.glb');
  });

  it('a missing, blank or non-string field is "the project names none"', () => {
    // `settings` is Record<string, unknown> from a FOREIGN deploy manifest, so
    // every one of these is a shape that can actually arrive over HTTP.
    expect(projectStartDocument(null)).toBeNull();
    expect(projectStartDocument(undefined)).toBeNull();
    expect(projectStartDocument({})).toBeNull();
    expect(projectStartDocument({ settings: {} })).toBeNull();
    expect(projectStartDocument({ settings: { defaultModel: '   ' } })).toBeNull();
    expect(projectStartDocument({ settings: { defaultModel: 42 } })).toBeNull();
    expect(projectStartDocument({ settings: { defaultModel: null } })).toBeNull();
  });

  it('composes with the global value exactly as both call sites do', () => {
    const globalValue = 'models/Demo.glb';
    const withManifest = { settings: { defaultModel: 'Machine.glb' } };
    const withoutManifest = { settings: {} };
    expect(projectStartDocument(withManifest) ?? globalValue).toBe('Machine.glb');
    // The appliance ships no global value; every other delivered build ships
    // the same value in both places (`bareDefaultModel()` derives it from the
    // manifest), so this branch is what keeps them bit-compatible.
    expect(projectStartDocument(withoutManifest) ?? globalValue).toBe(globalValue);
  });
});

// ─── No silent misboot (plan-721 F8, test 9.2) ───────────────────────────

/**
 * The seam for test 9.2. Every cause below is silent in production today: a
 * 404, a 500 and a corrupt `project.json` are swallowed identically by the
 * bundled backend, which then answers with the synthetic demo manifest — so a
 * mistyped `?projectUrl=` looks exactly like a working box that happens to show
 * the wrong machine, on a panel with no keyboard and no DevTools.
 */
describe('§9.2 — a kiosk boot that lands nowhere says so (plan-721 F8)', () => {
  const OK = {
    projectUrl: '/p/mauser/',
    hasDeployedManifest: true,
    documentCount: 3,
    resolvedAsset: 'models/Machine.glb',
    assetExists: true,
  };

  it('passes a boot that resolved a real document', () => {
    expect(diagnoseKioskBoot(OK)).toEqual({ ok: true, reason: null, detail: '' });
  });

  it('no served project.json is a failure, not the synthetic demo manifest', () => {
    const v = diagnoseKioskBoot({ ...OK, hasDeployedManifest: false });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('no-manifest');
    // The URL is IN the message: on a kiosk that sentence is the only
    // diagnostic anybody will ever see.
    expect(v.detail).toContain('/p/mauser/');
  });

  it('an empty documents[] is a failure, not an empty viewport', () => {
    expect(diagnoseKioskBoot({ ...OK, documentCount: 0 }).reason).toBe('no-documents');
  });

  it('naming no start document at all is a failure', () => {
    const v = diagnoseKioskBoot({ ...OK, resolvedAsset: null });
    expect(v.reason).toBe('no-start-document');
  });

  it('a start document that is not in the manifest is a failure', () => {
    const v = diagnoseKioskBoot({ ...OK, resolvedAsset: 'Gone.glb', assetExists: false });
    expect(v.reason).toBe('start-document-missing');
    expect(v.detail).toContain('Gone.glb');
  });

  it('is scoped to the served boot — every other deployment is none of its business', () => {
    // Without a `?projectUrl=` this is not an appliance boot. The verdict must
    // stay a diagnosis rather than becoming a new gate on the CDN/dev paths.
    expect(diagnoseKioskBoot({ hasDeployedManifest: false }).ok).toBe(true);
    expect(diagnoseKioskBoot({ projectUrl: '   ', documentCount: 0 }).ok).toBe(true);
    expect(diagnoseKioskBoot({}).ok).toBe(true);
  });

  it('reports the FIRST cause, so the message names what to fix', () => {
    // A box with no manifest also has no documents and no start document.
    // Reporting "no documents" there would send the operator after the wrong
    // thing entirely.
    expect(diagnoseKioskBoot({ projectUrl: '/p/x/' }).reason).toBe('no-manifest');
  });
});

// ─── The mode follows the session, not the asset (decision 24) ───────────

describe('§9.15 — switching asset does not switch mode', () => {
  it('the asset-switch answer cannot carry a mode at all', () => {
    const next = resumeTargetForAssetSwitch('parts/Roll2m.glb');
    expect(next).toEqual({ asset: 'parts/Roll2m.glb' });
    expect('mode' in next).toBe(false);
  });

  it('the remembered snapshot is one pair, written when the session settles', () => {
    expect(rememberedSessionOf('a.glb', 'editor')).toEqual({ asset: 'a.glb', mode: 'editor' });
    // No mode is not "mode: undefined" — the key is absent, so a reader cannot
    // tell it apart from a snapshot written before modes were remembered.
    expect(rememberedSessionOf('a.glb')).toEqual({ asset: 'a.glb' });
    expect(rememberedSessionOf('a.glb', '  ')).toEqual({ asset: 'a.glb' });
  });

  it('a snapshot with an asset but no mode resumes into the caller default', () => {
    expect(resolveResumeTarget({ search: '', remembered: { asset: 'a.glb' } }))
      .toEqual({ asset: 'a.glb', mode: null, source: 'remembered' });
  });

  it('a broken snapshot is "nothing remembered", never a crash', () => {
    expect(parseRememberedSession(null)).toBeNull();
    expect(parseRememberedSession('not json')).toBeNull();
    expect(parseRememberedSession('{"mode":"planner"}')).toBeNull();
    expect(parseRememberedSession('[]')).toBeNull();
    expect(parseRememberedSession('{"asset":"   "}')).toBeNull();
    expect(parseRememberedSession('{"asset":"a.glb","mode":"planner"}'))
      .toEqual({ asset: 'a.glb', mode: 'planner' });
    expect(parseRememberedSession({ asset: 'a.glb', mode: 42 }))
      .toEqual({ asset: 'a.glb' });
  });

  it('round-trips through the string form localStorage holds', () => {
    const stored = JSON.stringify(rememberedSessionOf('machines/Filler.glb', 'planner'));
    expect(parseRememberedSession(stored))
      .toEqual({ asset: 'machines/Filler.glb', mode: 'planner' });
  });
});

// ─── The persisted half, now readable outside the dashboard ──────────────

/**
 * The pair was written on every open all along and read in exactly one place:
 * the dashboard effect that fires when a user opens a project BY HAND. A reload
 * RESTORES the project instead, so that effect stayed disarmed and the boot fell
 * through to `defaultModel` — the demo model, however far away the user had
 * navigated. These tests pin the shared read/write the boot path now uses.
 */
describe('§9.15 — the resume pair survives a reload', () => {
  const PROJECT = 'proj_reload';

  function clear(): void {
    localStorage.removeItem(resumeStorageKey(PROJECT));
    localStorage.removeItem(resumeStorageKey('proj_other'));
  }

  it('a written pair is readable by anyone holding the project id', () => {
    clear();
    rememberSession(PROJECT, 'models/Filler.glb', 'editor');
    expect(readRememberedSession(PROJECT))
      .toEqual({ asset: 'models/Filler.glb', mode: 'editor' });
    // And it is what the boot then feeds the resume rule — the whole point.
    expect(resolveResumeTarget({
      search: '',
      remembered: readRememberedSession(PROJECT),
      defaultModel: 'models/DemoRealvirtualWeb.glb',
    })).toEqual({ asset: 'models/Filler.glb', mode: 'editor', source: 'remembered' });
    clear();
  });

  it('is per project — reopening A does not resume into B', () => {
    clear();
    rememberSession(PROJECT, 'models/A.glb', 'editor');
    rememberSession('proj_other', 'models/B.glb', 'planner');
    expect(readRememberedSession(PROJECT)?.asset).toBe('models/A.glb');
    expect(readRememberedSession('proj_other')?.asset).toBe('models/B.glb');
    clear();
  });

  it('writes nothing without a project id or an asset', () => {
    clear();
    rememberSession(undefined, 'models/A.glb', 'editor');
    rememberSession(PROJECT, undefined, 'editor');
    rememberSession(PROJECT, '', 'editor');
    expect(readRememberedSession(PROJECT)).toBeNull();
  });

  it('reads null for an unknown project, a missing id and a corrupt entry', () => {
    clear();
    expect(readRememberedSession(PROJECT)).toBeNull();
    expect(readRememberedSession(undefined)).toBeNull();
    expect(readRememberedSession('')).toBeNull();
    localStorage.setItem(resumeStorageKey(PROJECT), 'not json at all');
    expect(readRememberedSession(PROJECT)).toBeNull();
    clear();
  });

  it('forgets a dead resume point so the next boot stops retrying it', () => {
    clear();
    rememberSession(PROJECT, 'models/Deleted.glb', 'editor');
    forgetRememberedSession(PROJECT);
    expect(readRememberedSession(PROJECT)).toBeNull();
    // Total: forgetting nothing is not an error either.
    forgetRememberedSession(undefined);
    forgetRememberedSession('proj_never_written');
  });
});
