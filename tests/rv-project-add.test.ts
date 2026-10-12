// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * §9.3 — what "Add" decides a folder is (plan-743 F2).
 *
 * Three folder shapes, one classifier, and the invariant that carries the
 * user's decision from the grill: the `parent` case links its children and
 * WRITES NOTHING to the folder it was pointed at. That is asserted directly —
 * a spy on every mutating call the parent handle offers — rather than by
 * checking the folder afterwards, because "no file appeared" would also pass if
 * the write had been attempted and thrown.
 */

import { describe, it, expect, vi } from 'vitest';
import { FakeDir, asDirHandle } from './helpers/fake-fs-handles';
import { classifyAddTarget, probeAddTarget } from '../src/core/project/rv-project-add';

const MANIFEST = 'project.json';
const BAK = 'project.json.bak';

const validManifest = (id: string, name: string) => JSON.stringify({
  schemaVersion: 2, id, name, documents: [],
});

describe('probeAddTarget / classifyAddTarget', () => {
  it('a folder with its own project.json is a project', async () => {
    const dir = new FakeDir('MyPlant');
    dir.seedText(MANIFEST, validManifest('prj_a', 'MyPlant'));

    const { probe, target } = await classifyAddTarget(asDirHandle(dir));

    expect(target.kind).toBe('project');
    expect(probe.hasManifest).toBe(true);
    expect(probe.manifestBroken).toBe(false);
  });

  it('a folder with only project.json.bak is still a project', async () => {
    // A project whose main manifest was lost mid-write. Treating it as `plain`
    // would run the scan and write a NEW manifest over the recoverable one.
    const dir = new FakeDir('Interrupted');
    dir.seedText(BAK, validManifest('prj_b', 'Interrupted'));

    const { target } = await classifyAddTarget(asDirHandle(dir));

    expect(target.kind).toBe('project');
  });

  it('a folder holding only child projects is a parent', async () => {
    const dir = new FakeDir('OldWorkspaceRoot');
    dir.seedDir('PlantA').seedText(MANIFEST, validManifest('prj_a', 'A'));
    dir.seedDir('PlantB').seedText(MANIFEST, validManifest('prj_b', 'B'));
    dir.seedDir('Notes');

    const { target } = await classifyAddTarget(asDirHandle(dir));

    expect(target.kind).toBe('parent');
    expect(target.childProjects).toEqual(['PlantA', 'PlantB']);
  });

  it('writes nothing at all to a parent folder', async () => {
    const dir = new FakeDir('OldWorkspaceRoot');
    dir.seedDir('PlantA').seedText(MANIFEST, validManifest('prj_a', 'A'));
    const getFile = vi.spyOn(dir, 'getFileHandle');
    const getDir = vi.spyOn(dir, 'getDirectoryHandle');

    await classifyAddTarget(asDirHandle(dir));

    // Probing reads `project.json` — legitimately, and without `create`. What
    // must never happen is a creating call: that is how a stray manifest would
    // land in somebody's Documents folder.
    for (const spy of [getFile, getDir]) {
      for (const call of spy.mock.calls) {
        expect((call[1] as { create?: boolean } | undefined)?.create).not.toBe(true);
      }
    }
  });

  it('a folder that is neither is plain', async () => {
    const dir = new FakeDir('CadExport');
    dir.seedText('Belt.glb', 'glb');
    dir.seedDir('Sub').seedText('Roll.glb', 'glb');

    const { target } = await classifyAddTarget(asDirHandle(dir));

    expect(target.kind).toBe('plain');
    expect(target.childProjects).toEqual([]);
  });

  it('an entirely empty folder is plain, not an error', async () => {
    const { target } = await classifyAddTarget(asDirHandle(new FakeDir('Empty')));
    expect(target.kind).toBe('plain');
  });

  it('reports an unparseable root manifest as broken, still classified as project', async () => {
    const dir = new FakeDir('Corrupt');
    dir.seedText(MANIFEST, '{ this is not json');

    const { probe, target } = await classifyAddTarget(asDirHandle(dir));

    // Both facts matter: it IS a project (so the scan must not overwrite it),
    // and it cannot be opened (so the caller reports instead of opening).
    expect(target.kind).toBe('project');
    expect(probe.manifestBroken).toBe(true);
  });

  it('the project wins over its child projects', async () => {
    const dir = new FakeDir('MyPlant');
    dir.seedText(MANIFEST, validManifest('prj_a', 'MyPlant'));
    dir.seedDir('SubPlant').seedText(MANIFEST, validManifest('prj_s', 'Sub'));

    const probe = await probeAddTarget(asDirHandle(dir));

    expect(probe.hasManifest).toBe(true);
    expect(probe.childProjectFolders).toEqual(['SubPlant']);
  });
});
