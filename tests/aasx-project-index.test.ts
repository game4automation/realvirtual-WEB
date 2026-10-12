// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-596 Phase 3 — the project AASX scan and `aasx/index.json`, against a
 * real FolderBackend over the in-memory File System Access fake.
 *
 *  - the scan writes the index; a second scan without changes writes nothing;
 *  - only changed files are parsed again, removed files leave the index;
 *  - a duplicate id resolves deterministically and lands in the Problems panel;
 *  - a read-only folder keeps the index in memory and never writes;
 *  - a project switch during a scan writes nothing.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FakeDir, asDirHandle } from './helpers/fake-fs-handles';
import { makeAasx, aasxFile } from './helpers/aasx-fixtures';
import { FolderBackend } from '../src/core/project/backends/folder-backend';
import {
  requestAasxScan,
  resetAasxProjectIndex,
  setAasxScanDeps,
  AASX_DUPLICATE_CODE,
  AASX_UNREADABLE_CODE,
} from '../src/core/aas/rv-aasx-project-index';
import { projectAasSourceFor, resetAasSources, readIndexJson } from '../src/core/aas/rv-aas-source';
import { readAasxSummary } from '../src/core/aas/rv-aasx-package';
import { getProblems, resetProblemsForTests } from '../src/core/hmi/problems-store';

async function putFile(dir: FakeDir, name: string, file: Blob): Promise<void> {
  const handle = await dir.getFileHandle(name, { create: true });
  const w = await handle.createWritable();
  await w.write(file);
  await w.close();
}

interface Rig {
  root: FakeDir;
  aasx: FakeDir;
  backend: FolderBackend;
}

async function rig(opts: { writable?: boolean } = {}): Promise<Rig> {
  const root = new FakeDir('Festo');
  const aasx = root.seedDir('aasx');
  const backend = new FolderBackend(asDirHandle(root), { writable: opts.writable ?? true, id: 'folder:festo' });
  await backend.activate();
  return { root, aasx, backend };
}

const A = { id: 'urn:festo:a', idShort: 'CylinderA', productName: 'Cylinder A', manufacturer: 'Festo SE & Co. KG' };
const B = { id: 'urn:festo:b', idShort: 'MotorB', productName: 'Motor B' };

beforeEach(() => {
  resetAasxProjectIndex();
  resetAasSources();
  resetProblemsForTests();
});

describe('project AASX scan', () => {
  it('writes aasx/index.json; a second scan without changes writes nothing', async () => {
    const { aasx, backend } = await rig();
    await putFile(aasx, 'a.aasx', aasxFile(await makeAasx([A]), 'a.aasx', 1000));
    await putFile(aasx, 'b.aasx', aasxFile(await makeAasx([B]), 'b.aasx', 1000));
    const writes = vi.spyOn(backend, 'writeDocument');

    const first = await requestAasxScan(backend, 'p1', { isCurrent: () => true });
    expect(first?.wrote).toBe(true);
    expect(first?.parsed).toEqual(['a.aasx', 'b.aasx']);
    const text = await aasx.readText('index.json');
    expect(text).not.toBeNull();
    const read = readIndexJson(JSON.parse(text!));
    expect(read?.entries[A.id]).toEqual({ file: 'a.aasx', idShort: 'CylinderA', productName: 'Cylinder A', manufacturer: 'Festo SE & Co. KG', globalAssetId: `${A.id}/asset` });
    expect(read?.file?.version).toBe(1);

    const second = await requestAasxScan(backend, 'p1', { isCurrent: () => true });
    expect(second?.wrote).toBe(false);
    expect(second?.parsed).toEqual([]);
    expect(writes).toHaveBeenCalledTimes(1);

    // The project source answers from the scan.
    const idx = await projectAasSourceFor(backend, 'p1').readIndex();
    expect(idx.kind).toBe('available');
  });

  it('re-parses a changed file and drops a removed one', async () => {
    const { aasx, backend } = await rig();
    await putFile(aasx, 'a.aasx', aasxFile(await makeAasx([A]), 'a.aasx', 1000));
    await putFile(aasx, 'b.aasx', aasxFile(await makeAasx([B]), 'b.aasx', 1000));
    await requestAasxScan(backend, 'p1', { isCurrent: () => true });

    const A2 = { ...A, productName: 'Cylinder A (rev 2)' };
    await putFile(aasx, 'a.aasx', aasxFile(await makeAasx([A2]), 'a.aasx', 2000));
    await aasx.removeEntry('b.aasx');
    const out = await requestAasxScan(backend, 'p1', { isCurrent: () => true });

    expect(out?.parsed).toEqual(['a.aasx']);
    expect(out?.file.entries[A.id]?.productName).toBe('Cylinder A (rev 2)');
    expect(out?.file.entries[B.id]).toBeUndefined();
    expect(Object.keys(out!.file.files)).toEqual(['a.aasx']);
  });

  it('resolves a duplicate id to the alphabetically first file and reports it', async () => {
    const { aasx, backend } = await rig();
    await putFile(aasx, 'z-copy.aasx', aasxFile(await makeAasx([{ ...A, productName: 'Z' }]), 'z-copy.aasx'));
    await putFile(aasx, 'a.aasx', aasxFile(await makeAasx([A]), 'a.aasx'));
    const out = await requestAasxScan(backend, 'p1', { isCurrent: () => true });

    expect(out?.file.entries[A.id]?.file).toBe('a.aasx');
    expect(out?.file.duplicates?.[A.id]).toEqual(['a.aasx', 'z-copy.aasx']);
    const dup = getProblems().filter(p => p.code === AASX_DUPLICATE_CODE);
    expect(dup).toHaveLength(1);
    expect(dup[0].detail).toContain('aasx/z-copy.aasx');
  });

  it('records a broken file and keeps scanning the others', async () => {
    const { aasx, backend } = await rig();
    await putFile(aasx, 'broken.aasx', new File([new Uint8Array([1, 2, 3])], 'broken.aasx'));
    await putFile(aasx, 'a.aasx', aasxFile(await makeAasx([A]), 'a.aasx'));
    const out = await requestAasxScan(backend, 'p1', { isCurrent: () => true });

    expect(out?.file.entries[A.id]).toBeDefined();
    expect(out?.file.files['broken.aasx']?.error).toBeTruthy();
    expect(getProblems().some(p => p.code === AASX_UNREADABLE_CODE)).toBe(true);
  });

  it('ignores files outside aasx/ and nested folders (not recursive)', async () => {
    const { root, aasx, backend } = await rig();
    await putFile(root, 'stray.aasx', aasxFile(await makeAasx([B]), 'stray.aasx'));
    const nested = aasx.seedDir('old');
    await putFile(nested, 'n.aasx', aasxFile(await makeAasx([B]), 'n.aasx'));
    await putFile(aasx, 'a.aasx', aasxFile(await makeAasx([A]), 'a.aasx'));
    const out = await requestAasxScan(backend, 'p1', { isCurrent: () => true });
    expect(Object.keys(out!.file.entries)).toEqual([A.id]);
  });

  it('a read-only folder keeps the index in memory and never writes', async () => {
    const { aasx, backend } = await rig({ writable: false });
    await putFile(aasx, 'a.aasx', aasxFile(await makeAasx([A]), 'a.aasx'));
    const writes = vi.spyOn(backend, 'writeDocument');
    const out = await requestAasxScan(backend, 'p1', { isCurrent: () => true });

    expect(out?.wrote).toBe(false);
    expect(writes).not.toHaveBeenCalled();
    expect(await aasx.readText('index.json')).toBeNull();
    const idx = await projectAasSourceFor(backend, 'p1').readIndex();
    expect(idx.kind === 'available' && idx.index[A.id]?.file).toBe('a.aasx');
  });

  it('a project switch during the scan writes and publishes nothing', async () => {
    const { aasx, backend } = await rig();
    await putFile(aasx, 'a.aasx', aasxFile(await makeAasx([A]), 'a.aasx'));
    let current = true;
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    setAasxScanDeps({ readSummary: async (blob) => { await gate; return readAasxSummary(blob); } });
    const writes = vi.spyOn(backend, 'writeDocument');

    const pending = requestAasxScan(backend, 'p1', { isCurrent: () => current });
    current = false;           // another project was adopted meanwhile
    release();
    const out = await pending;

    expect(out?.stale).toBe(true);
    expect(writes).not.toHaveBeenCalled();
    expect(await aasx.readText('index.json')).toBeNull();
    expect((await projectAasSourceFor(backend, 'p1').readIndex()).kind).toBe('missing');
  });
});
