// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-project-types.test — the manifest shape contract.
 *
 * Two things carry real risk here and are tested as such:
 *  - **Forward compatibility.** A validator that rejects an unknown field
 *    turns a project written by a newer build into an unopenable one.
 *  - **RR1.** Scene filenames must be derived from the id, because scene
 *    names are not unique and a colliding filename can overwrite or delete
 *    a different, still-valid scene.
 */

import { describe, it, expect } from 'vitest';
import {
  RV_PROJECT_SCHEMA_VERSION,
  canonicalNameOf,
  isValidProjectV1,
  newProject,
  newProjectId,
  sceneFileNameFor,
  sceneIdToken,
  sceneRelPathFor,
  type RvProject,
} from '../src/core/project/rv-project-types';

const minimal = (): RvProject => ({
  schemaVersion: 1,
  id: 'prj_test',
  name: 'Test project',
});

describe('isValidProjectV1 — required core', () => {
  it('accepts the minimal manifest', () => {
    expect(isValidProjectV1(minimal())).toBe(true);
  });

  it('rejects non-objects and arrays', () => {
    expect(isValidProjectV1(null)).toBe(false);
    expect(isValidProjectV1('project')).toBe(false);
    expect(isValidProjectV1([])).toBe(false);
  });

  it('requires schemaVersion, id and name', () => {
    expect(isValidProjectV1({ ...minimal(), schemaVersion: undefined })).toBe(false);
    expect(isValidProjectV1({ ...minimal(), id: '' })).toBe(false);
    expect(isValidProjectV1({ ...minimal(), name: '   ' })).toBe(false);
  });
});

describe('isValidProjectV1 — forward compatibility', () => {
  it('never rejects an unknown top-level section', () => {
    const withFuture = { ...minimal(), futureThing: { anything: [1, 2, 3] } };
    expect(isValidProjectV1(withFuture)).toBe(true);
  });

  it('never rejects an unknown field inside a scenes[] entry', () => {
    const p = {
      ...minimal(),
      scenes: [{ id: 'scn_a', name: 'A', path: 'scenes/a.scene.json', tags: ['wip'] }],
    };
    expect(isValidProjectV1(p)).toBe(true);
  });

  it('accepts a manifest carrying a higher schemaVersion', () => {
    expect(isValidProjectV1({ ...minimal(), schemaVersion: 99 })).toBe(true);
  });
});

describe('isValidProjectV1 — optional sections mean "absent", not "broken"', () => {
  it('accepts a project that is only scenes + settings', () => {
    const p: RvProject = {
      ...minimal(),
      scenes: [],
      settingsRef: { ref: 'settings/project-settings.json' },
    };
    expect(isValidProjectV1(p)).toBe(true);
  });

  it('accepts every artefact section being absent', () => {
    const p = minimal();
    expect(p.models).toBeUndefined();
    expect(p.docs).toBeUndefined();
    expect(isValidProjectV1(p)).toBe(true);
  });

  it('accepts the reserved sharedRoots slot but does not require it', () => {
    expect(isValidProjectV1({ ...minimal(), sharedRoots: [{ name: 'shared' }] })).toBe(true);
    expect(isValidProjectV1(minimal())).toBe(true);
  });

  it('still rejects a section present in the wrong shape', () => {
    expect(isValidProjectV1({ ...minimal(), scenes: 'nope' })).toBe(false);
    expect(isValidProjectV1({ ...minimal(), scenes: [{ id: 'a' }] })).toBe(false); // no path
    expect(isValidProjectV1({ ...minimal(), models: [{ label: 'x' }] })).toBe(false); // no path
    expect(isValidProjectV1({ ...minimal(), settingsRef: {} })).toBe(false); // no ref
    expect(isValidProjectV1({ ...minimal(), activeSceneId: 7 })).toBe(false);
  });
});

describe('isValidProjectV1 — deploy-manifest superset', () => {
  it('accepts the pre-existing deploy fields unchanged in name and place', () => {
    const p = {
      ...minimal(),
      code: 'toray',
      created: '2024-01-01T00:00:00.000Z',
      lastPublished: '2025-01-01T00:00:00.000Z',
      settings: { defaultModel: 'line.glb' },
    };
    expect(isValidProjectV1(p)).toBe(true);
    // `settings` stays the deploy object; the bundle ref lives elsewhere.
    expect((p as RvProject).settings?.defaultModel).toBe('line.glb');
  });

  it('keeps settingsRef separate from the deploy settings object', () => {
    const p = newProject('Demo');
    expect(p.settingsRef?.ref).toBe('settings/project-settings.json');
    expect(p.settings).toBeUndefined();
  });
});

describe('newProject / newProjectId / canonicalNameOf', () => {
  it('mints a valid manifest at the current schema version', () => {
    const p = newProject('My Customer Line');
    expect(isValidProjectV1(p)).toBe(true);
    expect(p.schemaVersion).toBe(RV_PROJECT_SCHEMA_VERSION);
    expect(p.canonicalName).toBe('my-customer-line');
  });

  it('mints distinct ids', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newProjectId()));
    expect(ids.size).toBe(50);
  });

  it('slugifies to a filesystem- and bundle-id-safe form', () => {
    expect(canonicalNameOf('Müller & Co. — Linie 2')).toMatch(/^[a-z0-9-]+$/);
    expect(canonicalNameOf('  ')).toBe('project');
    expect(canonicalNameOf('---')).toBe('project');
  });
});

// ─── RR1 ────────────────────────────────────────────────────────────────

describe('RR1 — scene filenames are derived from the id, not the name', () => {
  it('two identically-named scenes never collide on one file', () => {
    const a = { id: 'scn_aaa_111', name: 'Cell' };
    const b = { id: 'scn_bbb_222', name: 'Cell' };
    expect(sceneFileNameFor(a)).not.toBe(sceneFileNameFor(b));
    expect(sceneRelPathFor(a)).not.toBe(sceneRelPathFor(b));
  });

  it('the legacy name-only slug WOULD have collided (regression witness)', () => {
    const legacy = (name: string) => `${name.replace(/\s+/g, '_')}.scene.json`;
    expect(legacy('Cell')).toBe(legacy('Cell'));   // the bug, demonstrated
    expect(sceneFileNameFor({ id: 'scn_a', name: 'Cell' }))
      .not.toBe(sceneFileNameFor({ id: 'scn_b', name: 'Cell' }));
  });

  it('is stable for the same scene', () => {
    const s = { id: 'scn_x_1', name: 'Line A' };
    expect(sceneFileNameFor(s)).toBe(sceneFileNameFor({ ...s }));
  });

  it('stays filesystem-safe for hostile names', () => {
    const name = 'a/b\\c:d*e?f"g<h>i|j';
    const file = sceneFileNameFor({ id: 'scn_q_9', name });
    expect(file).toMatch(/^[a-z0-9_.-]+\.scene\.json$/);
    expect(file).not.toContain('/');
    expect(file).not.toContain('\\');
  });

  it('survives an empty name by falling back to a slug placeholder', () => {
    expect(sceneFileNameFor({ id: 'scn_z_8', name: '' })).toBe('project-z_8.scene.json');
    expect(sceneFileNameFor({ id: 'scn_z_8' })).toBe('project-z_8.scene.json');
  });

  it('keeps the id token distinct for distinct ids', () => {
    expect(sceneIdToken('scn_a_1')).toBe('a_1');
    expect(sceneIdToken('scn_a_2')).not.toBe(sceneIdToken('scn_a_1'));
    expect(sceneIdToken('')).toBe('unknown');
  });

  it('puts scene files under scenes/', () => {
    expect(sceneRelPathFor({ id: 'scn_a_1', name: 'X' })).toMatch(/^scenes\//);
  });
});
