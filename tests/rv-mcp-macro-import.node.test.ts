// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-641 Phase 2b — `web_macro_import` and `web_macro_list({ files })`.
 *
 * A macro comes into the book of the OPEN document either from the project
 * folder (`source` = macro name → `macros/<name>.macro.json`, or a
 * project-relative path) or inline (`json`, the public demo has no folder).
 * Validation through `normalizeMacro`; a name collision is refused unless
 * `overwrite`; a macro recorded on another document is imported with a warning.
 *
 * The document is a real `RvDocument` behind the active asset context; the
 * project folder is the in-memory File System Access fake behind a mocked
 * project store (the store itself needs IndexedDB / a browser).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RVViewer } from '../src/core/rv-viewer';
import { setActiveAssetContext, type ActiveAssetContext } from '../src/core/editor/active-asset-store';
import { RvDocument } from '../src/core/ops/rv-document';
import type { RvExecutor } from '../src/core/ops/rv-unified-executors';
import { McpMacroTools, macroSourcePath } from '../src/plugins/mcp-bridge/rv-mcp-macro-tools';
import { macroBookOf, macroJobs, macroRecorder, type RvMacro } from '../src/plugins/mcp-bridge/rv-mcp-macro';
import { FakeDir, asDirHandle } from './helpers/fake-fs-handles';

/** The backend the mocked project store hands out (null = no project open). */
let backend: { writable: boolean; directory: FileSystemDirectoryHandle } | null = null;

vi.mock('../src/core/project/project-store', () => ({
  getProjectStore: () => ({ getBackend: () => backend }),
}));

class StubExecutor implements RvExecutor {
  async applyForward(): Promise<void> {}
  async applyInverse(): Promise<void> {}
}

const viewer = {
  modes: { activeMode: 'hmi' },
  selectionManager: { getSnapshot: () => ({ selectedPaths: [] }) },
} as unknown as RVViewer;

const mac = new McpMacroTools(() => viewer);
const parse = async (p: Promise<string>): Promise<Record<string, unknown>> => JSON.parse(await p);

let doc: RvDocument;
let folder: FakeDir;
/** Sub-folders already seeded in `folder`, by `/a/b` key (seedDir replaces an existing one). */
let seededDirs = new Map<string, FakeDir>();

function publish(d: RvDocument): void {
  setActiveAssetContext({ viewer, doc: { id: d.id, name: d.name, document: d, whenIdle: () => d.whenIdle() } as unknown as ActiveAssetContext['doc'] });
}

function macro(name: string, documentName = 'Festo', extra: Partial<RvMacro> = {}): RvMacro {
  return {
    $schema: 'rv-macro/1', name, document: { name: documentName },
    steps: [
      {
        kind: 'command', command: 'editor.setField',
        args: { path: 'Cell/Slide', componentType: 'Drive', fieldName: 'TargetSpeed', valueJson: '250' },
        note: { author: 'agent', reason: 'cycle time', source: 'customer:festo/2026-10-21' },
        result: { status: 'ok' }, at: '2026-10-21T00:00:00.000Z',
      },
      {
        kind: 'assert', check: 'gap', args: { a: 'Cell/Slide', b: 'Cell/Plate' }, expect: { gapMm: { min: 4.9, max: 5.1 } },
        note: { author: 'agent', reason: '5 mm to the plate' }, at: '2026-10-21T00:00:01.000Z',
      },
    ],
    ...extra,
  };
}

function seedMacroFile(path: string, content: string): void {
  const parts = path.split('/');
  const file = parts.pop()!;
  const dirs = new Map<string, FakeDir>(seededDirs);
  let dir = folder;
  let key = '';
  for (const p of parts) {
    key = `${key}/${p}`;
    dir = dirs.get(key) ?? dir.seedDir(p);
    dirs.set(key, dir);
  }
  seededDirs = dirs;
  dir.seedText(file, content);
}

const book = () => macroBookOf(doc);

beforeEach(() => {
  doc = new RvDocument({ id: 'doc_t641i', name: 'Festo', mode: 'asset', executor: new StubExecutor() });
  publish(doc);
  folder = new FakeDir('project');
  seededDirs = new Map();
  backend = { writable: true, directory: asDirHandle(folder) };
});

afterEach(() => {
  macroRecorder._resetForTest();
  macroJobs._resetForTest();
  setActiveAssetContext(null);
  doc.dispose();
  backend = null;
});

describe('macroSourcePath', () => {
  it('maps a name to macros/<name>.macro.json and keeps a project-relative path', () => {
    expect(macroSourcePath('round-2')).toBe('macros/round-2.macro.json');
    expect(macroSourcePath('festo round 2')).toBe('macros/festo_round_2.macro.json');
    expect(macroSourcePath('macros/round-2.macro.json')).toBe('macros/round-2.macro.json');
    expect(macroSourcePath('./archive\\old/r1.macro.json')).toBe('archive/old/r1.macro.json');
    expect(macroSourcePath('r1.json')).toBe('r1.json');
  });

  it('refuses absolute paths and ".." segments', () => {
    expect(macroSourcePath('/etc/x.json')).toBeNull();
    expect(macroSourcePath('C:/x/r.macro.json')).toBeNull();
    expect(macroSourcePath('../other/r.macro.json')).toBeNull();
    expect(macroSourcePath('macros/../../r.json')).toBeNull();
  });
});

describe('web_macro_import', () => {
  it('imports by macro name from macros/<name>.macro.json, marks the book touched and the document meta-dirty', async () => {
    seedMacroFile('macros/round-2.macro.json', JSON.stringify(macro('round-2')));
    const metaSpy = vi.spyOn(doc, 'markMetaDirty');
    const r = await parse(mac.webMacroImport('round-2'));
    expect(r).toEqual({ name: 'round-2', steps: 2, warnings: [], from: 'macros/round-2.macro.json' });
    const m = book().macros.get('round-2');
    expect(m?.steps.map((s) => s.kind)).toEqual(['command', 'assert']);
    expect(m?.steps[0]).toMatchObject({ note: { reason: 'cycle time', source: 'customer:festo/2026-10-21' } });
    expect(book().touched).toBe(true);
    expect(metaSpy).toHaveBeenCalled();
    // The imported macro is what the other tools see.
    expect(await parse(mac.webMacroList())).toMatchObject({ macros: [{ name: 'round-2', steps: 2, replayable: 2 }] });
    expect(await parse(mac.webMacroReplay('round-2', true))).toMatchObject({ dryRun: true });
  });

  it('imports from a nested project-relative path; the macro name comes from the file', async () => {
    seedMacroFile('archive/2026/r1.macro.json', JSON.stringify(macro('festo-round-1')));
    const r = await parse(mac.webMacroImport('archive/2026/r1.macro.json'));
    expect(r).toMatchObject({ name: 'festo-round-1', steps: 2, from: 'archive/2026/r1.macro.json' });
    expect(book().macros.has('festo-round-1')).toBe(true);
  });

  it('imports inline JSON (no project folder needed) and reads a missing $schema as rv-macro/1', async () => {
    backend = null;
    const { $schema: _drop, ...noSchema } = macro('inline-1');
    const r = await parse(mac.webMacroImport(undefined, JSON.stringify(noSchema)));
    expect(r).toEqual({ name: 'inline-1', steps: 2, warnings: [], from: 'json' });
    expect(book().macros.get('inline-1')?.$schema).toBe('rv-macro/1');
  });

  it('without a project folder only json works — source answers with a clear error', async () => {
    backend = null;
    const r = await parse(mac.webMacroImport('round-2'));
    expect(r['error']).toMatch(/No project folder is open .* json/);
    expect(book().macros.size).toBe(0);
  });

  it('refuses invalid input with a reason and imports nothing', async () => {
    expect((await parse(mac.webMacroImport()))['error']).toMatch(/exactly one of source .* or json/);
    expect((await parse(mac.webMacroImport('round-2', '{}')))['error']).toMatch(/exactly one/);
    expect((await parse(mac.webMacroImport(undefined, '{not json')))['error']).toMatch(/json is not valid JSON/);
    expect((await parse(mac.webMacroImport(undefined, JSON.stringify({ steps: [] }))))['error']).toMatch(/Not a macro \(json\)/);
    expect((await parse(mac.webMacroImport(undefined, JSON.stringify({ ...macro('x'), $schema: 'rv-macro/2' }))))['error'])
      .toMatch(/Not a macro/);
    expect((await parse(mac.webMacroImport('missing')))['error']).toMatch(/macros\/missing\.macro\.json not found/);
    seedMacroFile('macros/broken.macro.json', '{ "name": ');
    expect((await parse(mac.webMacroImport('broken')))['error']).toMatch(/macros\/broken\.macro\.json is not valid JSON/);
    expect((await parse(mac.webMacroImport('../outside.json')))['error']).toMatch(/not a project-relative path/);
    expect(book().macros.size).toBe(0);
    expect(book().touched).toBe(false);
  });

  it('a name collision is refused without overwrite and replaces with overwrite: true', async () => {
    await mac.webMacroImport(undefined, JSON.stringify(macro('round-2')));
    const second = macro('round-2', 'Festo', { steps: [macro('round-2').steps[0]] });
    const refused = await parse(mac.webMacroImport(undefined, JSON.stringify(second)));
    expect(refused['error']).toMatch(/already exists .* overwrite: true/);
    expect(book().macros.get('round-2')?.steps).toHaveLength(2);
    const replaced = await parse(mac.webMacroImport(undefined, JSON.stringify(second), true));
    expect(replaced).toMatchObject({ name: 'round-2', steps: 1, replaced: true });
    expect(book().macros.get('round-2')?.steps).toHaveLength(1);
  });

  it('a macro recorded on another document is imported with a warning, not refused', async () => {
    const r = await parse(mac.webMacroImport(undefined, JSON.stringify(macro('round-2', 'Festo-base-2026-10-20'))));
    expect(r).toMatchObject({ name: 'round-2', steps: 2, from: 'json' });
    expect(r['warnings']).toEqual([expect.stringMatching(/Recorded on document "Festo-base-2026-10-20", imported into "Festo"/)]);
    expect(book().macros.has('round-2')).toBe(true);
  });

  it('unreadable lines are dropped by the upcaster and reported as a warning', async () => {
    const m = macro('round-2') as unknown as { steps: unknown[] };
    m.steps.push({ kind: 'weird' }, { kind: 'command' });
    const r = await parse(mac.webMacroImport(undefined, JSON.stringify(m)));
    expect(r).toMatchObject({ steps: 2 });
    expect(r['warnings']).toEqual([expect.stringMatching(/2 of 4 lines are unreadable/)]);
  });

  it('a macro being recorded is not replaced, and no document means no import', async () => {
    expect(await parse(mac.webMacroRecordStart('rec-1'))).toMatchObject({ recording: 'rec-1' });
    const r = await parse(mac.webMacroImport(undefined, JSON.stringify(macro('rec-1')), true));
    expect(r['error']).toMatch(/being recorded/);
    macroRecorder.stop();
    setActiveAssetContext(null);
    expect((await parse(mac.webMacroImport(undefined, JSON.stringify(macro('x')))))['error']).toMatch(/No document is open/);
  });
});

describe('web_macro_list files', () => {
  it('lists macros/*.macro.json that are not in the book (name, path), and flags unreadable files', async () => {
    seedMacroFile('macros/round-1.macro.json', JSON.stringify(macro('round-1')));
    seedMacroFile('macros/round-2.macro.json', JSON.stringify(macro('round-2')));
    seedMacroFile('macros/bad.macro.json', '[]');
    seedMacroFile('macros/notes.txt', 'ignored');
    await mac.webMacroImport('round-1');
    const r = await parse(mac.webMacroList(true));
    expect(r['macros']).toMatchObject([{ name: 'round-1' }]);
    expect(r['files']).toEqual([
      { path: 'macros/bad.macro.json', error: 'not a valid macro' },
      { name: 'round-2', path: 'macros/round-2.macro.json', steps: 2 },
    ]);
  });

  it('without a project folder: empty list plus the reason; without files the answer is unchanged', async () => {
    backend = null;
    const r = await parse(mac.webMacroList(true));
    expect(r['files']).toEqual([]);
    expect(r['filesNote']).toMatch(/No project folder is open/);
    const plain = await parse(mac.webMacroList());
    expect(plain).not.toHaveProperty('files');
    expect(plain).not.toHaveProperty('filesNote');
    expect(Object.keys(plain).sort()).toEqual(['document', 'jobs', 'macros', 'recording']);
  });

  it('a project folder without macros/ answers an empty list with the reason', async () => {
    const r = await parse(mac.webMacroList(true));
    expect(r).toMatchObject({ files: [], filesNote: expect.stringMatching(/no macros\/ folder/) });
  });
});
