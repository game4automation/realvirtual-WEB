// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-project-storage.test — manifest I/O, inline migration and the
 * read-modify-write contract.
 *
 * The read-modify-write tests are the important ones: a writer that
 * reserialises from the TS type deletes any section or field a newer client
 * wrote, and it does so *silently* — the loss only shows up in a git diff,
 * as a deletion the user never made.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FakeDir, FailureInjector, asDirHandle } from './helpers/fake-fs-handles';
import {
  deleteSceneFile,
  mergeManifest,
  migrateManifest,
  readManifest,
  readSceneFile,
  readSettingsFile,
  splitRelPath,
  writeManifest,
  writeSceneFile,
  writeSettingsFile,
} from '../src/core/project/rv-project-storage';
import { isValidProjectV1, type RvProject } from '../src/core/project/rv-project-types';
import type { RvScene } from '../src/core/hmi/scene/rv-scene-types';

const manifest = (extra: Record<string, unknown> = {}): RvProject => ({
  schemaVersion: 1,
  id: 'prj_1',
  name: 'Demo',
  ...extra,
});

const scene = (id: string, name: string): RvScene => ({
  id,
  name,
  createdAt: '2025-01-01T00:00:00.000Z',
  modifiedAt: '2025-01-01T00:00:00.000Z',
  schemaVersion: 2,
  base: { kind: 'empty' },
  edits: { ops: [], settings: { catalogUrls: [], gridSizeMm: 500 } },
});

let root: FakeDir;

beforeEach(() => {
  root = new FakeDir('project');
});

// ─── Migration (R4 — inline, Phase 1 runs before the offline migrator) ───

describe('migrateManifest', () => {
  it('adds the new core fields to a legacy deploy manifest', () => {
    const legacy = {
      name: 'Toray',
      code: 'toray',
      created: '2024-05-05T00:00:00.000Z',
      lastPublished: '2025-02-02T00:00:00.000Z',
      settings: { defaultModel: 'line.glb' },
    };
    const out = migrateManifest(legacy)!;
    expect(out).not.toBeNull();
    expect(isValidProjectV1(out)).toBe(true);
    expect(out.schemaVersion).toBe(1);
    expect(typeof out.id).toBe('string');
    expect(out.canonicalName).toBe('toray');
    expect(out.createdAt).toBe('2024-05-05T00:00:00.000Z');
  });

  it('leaves every pre-existing deploy field exactly where it was', () => {
    const legacy = {
      name: 'Toray',
      code: 'toray',
      created: '2024-05-05T00:00:00.000Z',
      lastPublished: '2025-02-02T00:00:00.000Z',
      settings: { defaultModel: 'line.glb' },
    };
    const out = migrateManifest(legacy)!;
    expect(out.name).toBe('Toray');
    expect(out.code).toBe('toray');
    expect(out.created).toBe('2024-05-05T00:00:00.000Z');
    expect(out.lastPublished).toBe('2025-02-02T00:00:00.000Z');
    expect(out.settings).toEqual({ defaultModel: 'line.glb' });
  });

  it('is idempotent — a second pass changes nothing but modifiedAt', () => {
    const once = migrateManifest({ name: 'X', code: 'x' })!;
    const twice = migrateManifest(once)!;
    expect(twice.id).toBe(once.id);
    expect(twice.schemaVersion).toBe(once.schemaVersion);
    expect(twice.canonicalName).toBe(once.canonicalName);
    expect(twice.createdAt).toBe(once.createdAt);
  });

  it('carries unknown fields through untouched', () => {
    const out = migrateManifest({ name: 'X', code: 'x', futureThing: { a: 1 } })!;
    expect(out.futureThing).toEqual({ a: 1 });
  });

  it('falls back to code when name is missing rather than refusing', () => {
    expect(migrateManifest({ code: 'wmyb' })!.name).toBe('wmyb');
  });

  it('returns null for a non-object', () => {
    expect(migrateManifest(null)).toBeNull();
    expect(migrateManifest([1, 2])).toBeNull();
  });
});

// ─── Read ───────────────────────────────────────────────────────────────

describe('readManifest', () => {
  it('returns null when the folder has no manifest', async () => {
    expect(await readManifest(asDirHandle(root))).toBeNull();
  });

  it('reads a valid manifest without claiming migration', async () => {
    root.seedText('project.json', JSON.stringify(manifest()));
    const result = (await readManifest(asDirHandle(root)))!;
    expect(result.project.id).toBe('prj_1');
    expect(result.migrated).toBe(false);
    expect(result.recoveredFromBackup).toBe(false);
  });

  it('migrates a legacy manifest on read instead of rejecting it (R4)', async () => {
    root.seedText('project.json', JSON.stringify({ name: 'Festo', code: 'festo' }));
    const result = (await readManifest(asDirHandle(root)))!;
    expect(result.migrated).toBe(true);
    expect(result.project.code).toBe('festo');
    expect(result.project.schemaVersion).toBe(1);
  });

  it('recovers from project.json.bak when the primary is torn', async () => {
    root.seedText('project.json', '{ this is not json');
    root.seedText('project.json.bak', JSON.stringify(manifest({ name: 'Recovered' })));
    const result = (await readManifest(asDirHandle(root)))!;
    expect(result.project.name).toBe('Recovered');
    expect(result.recoveredFromBackup).toBe(true);
  });

  it('returns null when neither primary nor backup is usable', async () => {
    root.seedText('project.json', 'garbage');
    root.seedText('project.json.bak', 'also garbage');
    expect(await readManifest(asDirHandle(root))).toBeNull();
  });
});

// ─── Write ──────────────────────────────────────────────────────────────

describe('writeManifest', () => {
  it('writes the manifest as readable, indented JSON', async () => {
    await writeManifest(asDirHandle(root), manifest());
    const text = (await root.readText('project.json'))!;
    expect(text).toContain('\n  ');
    expect(JSON.parse(text).id).toBe('prj_1');
  });

  it('preserves the previous content in .bak before overwriting', async () => {
    await writeManifest(asDirHandle(root), manifest({ name: 'First' }));
    await writeManifest(asDirHandle(root), manifest({ name: 'Second' }));
    expect(JSON.parse((await root.readText('project.json'))!).name).toBe('Second');
    expect(JSON.parse((await root.readText('project.json.bak'))!).name).toBe('First');
  });

  it('still writes the manifest when the backup step fails', async () => {
    await writeManifest(asDirHandle(root), manifest({ name: 'First' }));
    root.failures.fail({ point: 'write', name: 'project.json.bak' });
    await writeManifest(asDirHandle(root), manifest({ name: 'Second' }));
    expect(JSON.parse((await root.readText('project.json'))!).name).toBe('Second');
  });

  it('propagates a failure of the primary write (the caller must see it)', async () => {
    root.failures.fail({ point: 'write', name: 'project.json' });
    await expect(writeManifest(asDirHandle(root), manifest())).rejects.toThrow();
  });
});

// ─── Read-modify-write, BOTH levels ─────────────────────────────────────

describe('mergeManifest — top-level forward compatibility', () => {
  it('keeps an unknown top-level section through a save', () => {
    const original = manifest({ futureThing: { deep: { value: 42 } }, scenes: [] });
    const merged = mergeManifest(original, { scenes: [] });
    expect(merged.futureThing).toEqual({ deep: { value: 42 } });
  });

  it('keeps the deploy fields through a save', () => {
    const original = manifest({
      code: 'toray',
      lastPublished: '2025-02-02T00:00:00.000Z',
      settings: { defaultModel: 'line.glb' },
    });
    const merged = mergeManifest(original, { activeSceneId: 'scn_a' });
    expect(merged.code).toBe('toray');
    expect(merged.lastPublished).toBe('2025-02-02T00:00:00.000Z');
    expect(merged.settings).toEqual({ defaultModel: 'line.glb' });
    expect(merged.activeSceneId).toBe('scn_a');
  });

  it('always refreshes modifiedAt', () => {
    const merged = mergeManifest(manifest({ modifiedAt: 'old' }), { activeSceneId: null });
    expect(merged.modifiedAt).not.toBe('old');
  });
});

describe('mergeManifest — scenes[] entry-level forward compatibility', () => {
  const withEntry = () => manifest({
    scenes: [
      { id: 'scn_a', name: 'A', path: 'scenes/a-a.scene.json', tags: ['wip'], custom: 1 },
      { id: 'scn_b', name: 'B', path: 'scenes/b-b.scene.json' },
    ],
  });

  it('keeps an unknown field on an updated entry (metaOf would have dropped it)', () => {
    const merged = mergeManifest(withEntry(), {
      scenes: [{ id: 'scn_a', name: 'A renamed', path: 'scenes/a-renamed-a.scene.json' }],
    });
    const a = merged.scenes!.find(e => e.id === 'scn_a')!;
    expect(a.name).toBe('A renamed');
    expect(a.path).toBe('scenes/a-renamed-a.scene.json');
    expect(a.tags).toEqual(['wip']);   // ← the field a fresh construction would lose
    expect(a.custom).toBe(1);
  });

  it('leaves untouched entries entirely alone', () => {
    const merged = mergeManifest(withEntry(), {
      scenes: [{ id: 'scn_a', name: 'A2', path: 'scenes/a2-a.scene.json' }],
    });
    expect(merged.scenes!.find(e => e.id === 'scn_b')).toEqual({
      id: 'scn_b', name: 'B', path: 'scenes/b-b.scene.json',
    });
  });

  it('appends genuinely new entries and keeps insertion order', () => {
    const merged = mergeManifest(withEntry(), {
      scenes: [{ id: 'scn_c', name: 'C', path: 'scenes/c-c.scene.json' }],
    });
    expect(merged.scenes!.map(e => e.id)).toEqual(['scn_a', 'scn_b', 'scn_c']);
  });

  it('removes only the ids it was asked to remove', () => {
    const merged = mergeManifest(withEntry(), { removeSceneIds: ['scn_a'] });
    expect(merged.scenes!.map(e => e.id)).toEqual(['scn_b']);
  });

  it('applies removals after upserts', () => {
    const merged = mergeManifest(withEntry(), {
      scenes: [{ id: 'scn_c', name: 'C', path: 'scenes/c-c.scene.json' }],
      removeSceneIds: ['scn_c'],
    });
    expect(merged.scenes!.map(e => e.id)).toEqual(['scn_a', 'scn_b']);
  });

  it('leaves scenes[] alone when the update does not mention it', () => {
    const merged = mergeManifest(withEntry(), { activeSceneId: 'scn_a' });
    expect(merged.scenes).toHaveLength(2);
  });
});

// ─── Round trip through disk ────────────────────────────────────────────

describe('manifest round trip', () => {
  it('an older client saving a newer project does not drop its sections', async () => {
    const fromNewerBuild = {
      ...manifest(),
      futureThing: { rendering: 'raytraced' },
      scenes: [{ id: 'scn_a', name: 'A', path: 'scenes/a-a.scene.json', tags: ['x'] }],
    };
    root.seedText('project.json', JSON.stringify(fromNewerBuild));

    const read = (await readManifest(asDirHandle(root)))!;
    const merged = mergeManifest(read.project, { activeSceneId: 'scn_a' });
    await writeManifest(asDirHandle(root), merged);

    const back = JSON.parse((await root.readText('project.json'))!);
    expect(back.futureThing).toEqual({ rendering: 'raytraced' });
    expect(back.scenes[0].tags).toEqual(['x']);
    expect(back.activeSceneId).toBe('scn_a');
  });
});

// ─── Scene bodies ───────────────────────────────────────────────────────

describe('scene bodies', () => {
  it('writes into scenes/, creating the folder lazily on first write', async () => {
    expect(root.has('scenes')).toBe(false);
    await writeSceneFile(asDirHandle(root), 'scenes/a-a.scene.json', scene('scn_a', 'A'));
    expect(root.has('scenes')).toBe(true);
    expect(await root.readTextAt('scenes', 'a-a.scene.json')).toContain('"scn_a"');
  });

  it('round-trips a scene body', async () => {
    const s = scene('scn_a', 'A');
    await writeSceneFile(asDirHandle(root), 'scenes/a-a.scene.json', s);
    const back = await readSceneFile(asDirHandle(root), 'scenes/a-a.scene.json');
    expect(back).toEqual(s);
  });

  it('returns null for a missing folder or file rather than throwing', async () => {
    expect(await readSceneFile(asDirHandle(root), 'scenes/none.scene.json')).toBeNull();
    root.seedDir('scenes');
    expect(await readSceneFile(asDirHandle(root), 'scenes/none.scene.json')).toBeNull();
  });

  it('returns null for a corrupt body — one bad file must not sink the project', async () => {
    root.seedDir('scenes').seedText('bad.scene.json', 'not json');
    expect(await readSceneFile(asDirHandle(root), 'scenes/bad.scene.json')).toBeNull();
  });

  it('returns null for a valid JSON file that is not a schemaVersion-2 scene', async () => {
    root.seedDir('scenes').seedText('v1.scene.json', JSON.stringify({ schemaVersion: 1 }));
    expect(await readSceneFile(asDirHandle(root), 'scenes/v1.scene.json')).toBeNull();
  });

  it('deletes idempotently', async () => {
    await writeSceneFile(asDirHandle(root), 'scenes/a-a.scene.json', scene('scn_a', 'A'));
    await deleteSceneFile(asDirHandle(root), 'scenes/a-a.scene.json');
    expect(await root.readTextAt('scenes', 'a-a.scene.json')).toBeNull();
    await expect(deleteSceneFile(asDirHandle(root), 'scenes/a-a.scene.json')).resolves.toBeUndefined();
  });
});

// ─── Settings ───────────────────────────────────────────────────────────

describe('settings bundle', () => {
  it('round-trips through settings/project-settings.json', async () => {
    const bundle = { $schema: 'rv-settings-bundle/1.0', settings: { visual: { shadows: true } } };
    await writeSettingsFile(asDirHandle(root), bundle);
    expect(await readSettingsFile(asDirHandle(root))).toEqual(bundle);
  });

  it('returns null when the settings folder does not exist', async () => {
    expect(await readSettingsFile(asDirHandle(root))).toBeNull();
  });
});

// ─── Path helper ────────────────────────────────────────────────────────

describe('splitRelPath', () => {
  it('splits folder and filename', () => {
    expect(splitRelPath('scenes/a.scene.json')).toEqual({ folder: 'scenes', filename: 'a.scene.json' });
    expect(splitRelPath('project.json')).toEqual({ folder: null, filename: 'project.json' });
    expect(splitRelPath('./scenes/a.json')).toEqual({ folder: 'scenes', filename: 'a.json' });
  });
});

// ─── §4e error surfaces ─────────────────────────────────────────────────

describe('I/O failures are not silently swallowed', () => {
  it('a write failure on a scene body propagates to the caller', async () => {
    const failures = new FailureInjector();
    const dir = new FakeDir('project', failures);
    failures.fail({ point: 'write', name: 'a-a.scene.json' });
    await expect(
      writeSceneFile(asDirHandle(dir), 'scenes/a-a.scene.json', scene('scn_a', 'A')),
    ).rejects.toThrow();
  });
});
