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
  readSceneGlbFile,
  readSettingsFile,
  splitRelPath,
  writeManifest,
  writeSceneGlbFile,
  writeSettingsFile,
} from '../src/core/project/rv-project-storage';
import { sceneDocumentsOf } from '../src/core/project/rv-project-documents';
import { LegacyFormatError } from '../src/core/project/rv-legacy-format';
import {
  RV_PROJECT_SCHEMA_VERSION,
  isValidProjectV1,
  normaliseFolderPath,
  readProjectFolders,
  withProjectFolders,
  type RvProject,
} from '../src/core/project/rv-project-types';

const manifest = (extra: Record<string, unknown> = {}): RvProject => ({
  schemaVersion: 1,
  id: 'prj_1',
  name: 'Demo',
  ...extra,
});

/** A stand-in scene body. Nothing here parses it — a body is bytes now. */
const glbBytes = (marker: string): Uint8Array => new TextEncoder().encode('glb:' + marker);

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
    expect(out.schemaVersion).toBe(RV_PROJECT_SCHEMA_VERSION);
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
    expect(result.project.schemaVersion).toBe(RV_PROJECT_SCHEMA_VERSION);
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
    const original = manifest({ futureThing: { deep: { value: 42 } }, documents: [] });
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

describe('mergeManifest — documents[] entry-level forward compatibility', () => {
  // A scene upsert is expressed in scene-entry shape and lands in `documents[]`:
  // the three legacy arrays are gone (plan-413 phase 6) and there is nowhere
  // else for it to go.
  const withEntry = () => manifest({
    documents: [
      {
        id: 'scn_a', name: 'A', path: 'scenes/a-a.scene.glb',
        section: 'scenes', tags: ['wip'], custom: 1,
      },
      { id: 'scn_b', name: 'B', path: 'scenes/b-b.scene.glb', section: 'scenes' },
    ],
  });

  const docs = (p: RvProject) => p.documents!;

  it('keeps an unknown field on an updated entry (fresh construction would drop it)', () => {
    const merged = mergeManifest(withEntry(), {
      scenes: [{ id: 'scn_a', name: 'A renamed', path: 'scenes/a-renamed-a.scene.glb' }],
    });
    const a = docs(merged).find(e => e.id === 'scn_a')!;
    expect(a.name).toBe('A renamed');
    expect(a.path).toBe('scenes/a-renamed-a.scene.glb');
    expect(a.tags).toEqual(['wip']);   // the field a fresh construction would lose
    expect(a.custom).toBe(1);
  });

  it('leaves untouched entries entirely alone', () => {
    const merged = mergeManifest(withEntry(), {
      scenes: [{ id: 'scn_a', name: 'A2', path: 'scenes/a2-a.scene.glb' }],
    });
    expect(docs(merged).find(e => e.id === 'scn_b')).toEqual({
      id: 'scn_b', name: 'B', path: 'scenes/b-b.scene.glb', section: 'scenes',
    });
  });

  it('appends genuinely new entries and keeps insertion order', () => {
    const merged = mergeManifest(withEntry(), {
      scenes: [{ id: 'scn_c', name: 'C', path: 'scenes/c-c.scene.glb' }],
    });
    expect(docs(merged).map(e => e.id)).toEqual(['scn_a', 'scn_b', 'scn_c']);
  });

  it('removes only the ids it was asked to remove', () => {
    const merged = mergeManifest(withEntry(), { removeSceneIds: ['scn_a'] });
    expect(docs(merged).map(e => e.id)).toEqual(['scn_b']);
  });

  it('applies removals after upserts', () => {
    const merged = mergeManifest(withEntry(), {
      scenes: [{ id: 'scn_c', name: 'C', path: 'scenes/c-c.scene.glb' }],
      removeSceneIds: ['scn_c'],
    });
    expect(docs(merged).map(e => e.id)).toEqual(['scn_a', 'scn_b']);
  });

  it('leaves documents[] alone when the update does not mention scenes', () => {
    const merged = mergeManifest(withEntry(), { activeSceneId: 'scn_a' });
    expect(docs(merged)).toHaveLength(2);
  });

  it('creates documents[] for a manifest that has none yet', () => {
    const merged = mergeManifest(manifest(), {
      scenes: [{ id: 'scn_a', name: 'A', path: 'scenes/a-a.scene.glb' }],
    });
    expect(docs(merged).map(e => e.id)).toEqual(['scn_a']);
    expect(docs(merged)[0].section).toBe('scenes');
  });
});

// ─── Round trip through disk ────────────────────────────────────────────

describe('manifest round trip', () => {
  it('an older client saving a newer project does not drop its sections', async () => {
    const fromNewerBuild = {
      ...manifest(),
      futureThing: { rendering: 'raytraced' },
      documents: [{
        id: 'scn_a', name: 'A', path: 'scenes/a-a.scene.glb',
        section: 'scenes', tags: ['x'],
      }],
    };
    root.seedText('project.json', JSON.stringify(fromNewerBuild));

    const read = (await readManifest(asDirHandle(root)))!;
    const merged = mergeManifest(read.project, { activeSceneId: 'scn_a' });
    await writeManifest(asDirHandle(root), merged);

    const back = JSON.parse((await root.readText('project.json'))!);
    expect(back.futureThing).toEqual({ rendering: 'raytraced' });
    expect(back.documents[0].tags).toEqual(['x']);
    expect(back.activeSceneId).toBe('scn_a');
  });

  // 2.4 step B: the three legacy arrays are converted on read and never written
  // again. A stale copy of the document list in the manifest would be worse than
  // none — the delivery pipeline reads `scenes[]` as "this customer has not
  // converted yet".
  it('converts the legacy arrays into documents[] and stops writing them', async () => {
    root.seedText('project.json', JSON.stringify({
      ...manifest(),
      scenes: [{ id: 'scn_a', name: 'A', path: 'scenes/a-a.scene.glb' }],
      models: [{ path: 'models/m.glb', label: 'M' }],
      library: [{ path: 'library/l.glb' }],
    }));

    const read = (await readManifest(asDirHandle(root)))!;
    expect(read.documentsMigrated).toBe(true);
    expect(read.project.documents!.map(d => d.path)).toEqual([
      'scenes/a-a.scene.glb', 'models/m.glb', 'library/l.glb',
    ]);
    expect(sceneDocumentsOf(read.project).map(e => e.id)).toEqual(['scn_a']);

    await writeManifest(asDirHandle(root), read.project);
    const back = JSON.parse((await root.readText('project.json'))!);
    expect(back.scenes).toBeUndefined();
    expect(back.models).toBeUndefined();
    expect(back.library).toBeUndefined();
    expect(back.documents).toHaveLength(3);
  });

  it('a second read of a converted manifest reports "already"', async () => {
    root.seedText('project.json', JSON.stringify({
      ...manifest(),
      scenes: [{ id: 'scn_a', name: 'A', path: 'scenes/a-a.scene.glb' }],
    }));
    const first = (await readManifest(asDirHandle(root)))!;
    await writeManifest(asDirHandle(root), first.project);
    const second = (await readManifest(asDirHandle(root)))!;
    expect(second.documentsMigrated).toBe(false);
    expect(second.project.documents!.map(d => d.id)).toEqual(['scn_a']);
  });
});

// ─── F10 — the hard, spoken refusal ────────────────────────

describe('a manifest that stayed behind (plan-413 F10)', () => {
  it('refuses a scene row pointing at a .scene.json body, naming the release', async () => {
    root.seedText('project.json', JSON.stringify({
      ...manifest(),
      scenes: [{ id: 'scn_a', name: 'A', path: 'scenes/a-a.scene.json' }],
    }));
    await expect(readManifest(asDirHandle(root))).rejects.toThrow(LegacyFormatError);
    await expect(readManifest(asDirHandle(root))).rejects.toThrow(/6\.3\.16/);
  });

  it('refuses a document carrying the json format even with a .glb path', async () => {
    root.seedText('project.json', JSON.stringify({
      ...manifest(),
      documents: [{
        id: 'scn_a', name: 'A', path: 'scenes/a-a.scene.glb',
        section: 'scenes', format: 'json',
      }],
    }));
    await expect(readManifest(asDirHandle(root))).rejects.toThrow(LegacyFormatError);
  });

  it('never half-loads: nothing comes back from a refused manifest', async () => {
    root.seedText('project.json', JSON.stringify({
      ...manifest(),
      scenes: [
        { id: 'scn_ok', name: 'Fine', path: 'scenes/ok.scene.glb' },
        { id: 'scn_old', name: 'Old', path: 'scenes/old.scene.json' },
      ],
    }));
    await expect(readManifest(asDirHandle(root))).rejects.toThrow(LegacyFormatError);
  });

  it('an asset document ending in .json is NOT a legacy scene', async () => {
    root.seedText('project.json', JSON.stringify({
      ...manifest(),
      library: [{ path: 'library/catalog.json' }],
    }));
    const read = (await readManifest(asDirHandle(root)))!;
    expect(read.project.documents!.map(d => d.path)).toEqual(['library/catalog.json']);
  });
});

// ─── Scene bodies ───────────────────────────────────────────────────────

describe('scene bodies', () => {
  it('writes into scenes/, creating the folder lazily on first write', async () => {
    expect(root.has('scenes')).toBe(false);
    await writeSceneGlbFile(asDirHandle(root), 'scenes/a-a.scene.glb', glbBytes('a'));
    expect(root.has('scenes')).toBe(true);
    expect(await root.readTextAt('scenes', 'a-a.scene.glb')).toBe('glb:a');
  });

  it('round-trips a scene body', async () => {
    await writeSceneGlbFile(asDirHandle(root), 'scenes/a-a.scene.glb', glbBytes('a'));
    const back = await readSceneGlbFile(asDirHandle(root), 'scenes/a-a.scene.glb');
    expect(new TextDecoder().decode(back!)).toBe('glb:a');
  });

  it('returns null for a missing folder or file rather than throwing', async () => {
    expect(await readSceneGlbFile(asDirHandle(root), 'scenes/none.scene.glb')).toBeNull();
    root.seedDir('scenes');
    expect(await readSceneGlbFile(asDirHandle(root), 'scenes/none.scene.glb')).toBeNull();
  });

  it('deletes idempotently', async () => {
    await writeSceneGlbFile(asDirHandle(root), 'scenes/a-a.scene.glb', glbBytes('a'));
    await deleteSceneFile(asDirHandle(root), 'scenes/a-a.scene.glb');
    expect(await root.readTextAt('scenes', 'a-a.scene.glb')).toBeNull();
    await expect(deleteSceneFile(asDirHandle(root), 'scenes/a-a.scene.glb')).resolves.toBeUndefined();
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
    failures.fail({ point: 'write', name: 'a-a.scene.glb' });
    await expect(
      writeSceneGlbFile(asDirHandle(dir), 'scenes/a-a.scene.glb', glbBytes('a')),
    ).rejects.toThrow();
  });
});

// ─── folders[] — the empty folders a project declares ────────────────────
//
// Same two rules `libraries[]` follows: parse defensively, and write the
// section away entirely when the list is empty so an untouched manifest stays
// byte-identical.
describe('project folders[]', () => {
  const base = (): RvProject => ({
    schemaVersion: RV_PROJECT_SCHEMA_VERSION,
    id: 'prj_x',
    name: 'X',
    documents: [],
  });

  it('normalises the spellings a manifest may carry', () => {
    expect(normaliseFolderPath('/a/b/')).toBe('a/b');
    expect(normaliseFolderPath('a\\b')).toBe('a/b');
    expect(normaliseFolderPath('  a / b ')).toBe('a/b');
    expect(normaliseFolderPath('   ')).toBe('');
    expect(normaliseFolderPath(null)).toBe('');
  });

  it('reads, normalises and de-duplicates', () => {
    expect(readProjectFolders({ ...base(), folders: ['/a/', 'a', 'b/c', 7 as never, ''] }))
      .toEqual(['a', 'b/c']);
  });

  it('never throws on a malformed section', () => {
    expect(readProjectFolders({ ...base(), folders: 'nope' as never })).toEqual([]);
    expect(readProjectFolders(null)).toEqual([]);
    expect(readProjectFolders(base())).toEqual([]);
  });

  it('writes exactly what it is given', () => {
    expect(withProjectFolders(base(), ['b', 'a', 'b']).folders).toEqual(['b', 'a']);
  });

  it('removes the section rather than writing an empty array', () => {
    const withNone = withProjectFolders({ ...base(), folders: ['a'] }, []);
    expect('folders' in withNone).toBe(false);
  });

  it('leaves a manifest that never had the section untouched', () => {
    const before = base();
    expect(withProjectFolders(before, [])).toBe(before);
  });

  it('survives a manifest write/read round-trip', async () => {
    const dir = new FakeDir('project');
    await writeManifest(asDirHandle(dir), withProjectFolders(base(), ['staging', 'wip/a']));
    const read = await readManifest(asDirHandle(dir));
    expect(readProjectFolders(read!.project)).toEqual(['staging', 'wip/a']);
  });
});
