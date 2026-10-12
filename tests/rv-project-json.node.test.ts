// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * `updateDocumentRow` — stamping a `project.json` document row by PARSING the
 * JSON instead of rewriting text lines (`scripts/lib/rv-project-json.mjs`,
 * plan-587 F6).
 *
 * The code this replaces searched for the line holding `"id": "<docid>"` and
 * then looked for `sizeBytes` / `mtimeMs` / `sha256` within the next FOURTEEN
 * lines (`build-plc-model.mjs:1318` before this plan). The centre of gravity of
 * this file is therefore `Test_UpdateDocumentRow_ReformattedJson`: a manifest
 * with reordered fields and a key beyond line 14 of the row, on which the old
 * line regex aborts with `key not found`. The legacy updater is reproduced here
 * VERBATIM as an oracle so the test states a behaviour difference and not just
 * its own implementation — it must fail where the new one succeeds.
 *
 * The remaining tests nail the per-caller differences down. They are
 * parameters, not defaults, and each test says which caller has it today:
 * `removeScriptRef` (PLC only), `setModifiedAt` (AGV only), the `mtimeMs`
 * rounding (`floor` PLC vs `round` AGV) and the missing-row behaviour (PLC
 * throws, AGV ignores).
 *
 * File system only (a tmp dir per test); no process, no network.
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Typed through the sibling declaration file scripts/lib/rv-project-json.d.mts.
import { findDocumentRow, updateDocumentRow } from '../scripts/lib/rv-project-json.mjs';
// The same hash helper the module uses internally — imported here so the test
// asserts ITS answer and not a second hash implementation of its own.
import { sha256File } from '../scripts/lib/rv-hash.mjs';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rv-project-json-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

//! Writes a fake GLB and pins its mtime to a value with a FRACTION, so
//! `floor` and `round` provably disagree (…​.7 → 100 vs 101).
function writeGlb(name: string, bytes: Buffer, mtimeSeconds: number) {
  const path = join(dir, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  utimesSync(path, mtimeSeconds, mtimeSeconds);
  return path;
}

function writeManifest(manifest: unknown, { trailingNewline = true } = {}) {
  const path = join(dir, 'project.json');
  writeFileSync(path, JSON.stringify(manifest, null, 2) + (trailingNewline ? '\n' : ''));
  return path;
}

function readManifest(path: string) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * The line-window updater of `build-plc-model.mjs:1318` before plan-587,
 * verbatim apart from the injected `docId` and the 14 being named. Kept as the
 * ORACLE for the reformat test: it is what the new code has to beat.
 */
function legacyUpdateProjectRow(projectFile: string, glbFile: string, docId: string) {
  const st = statSync(glbFile);
  const sha = createHash('sha256').update(readFileSync(glbFile)).digest('hex');
  const lines = readFileSync(projectFile, 'utf8').split('\n');
  const start = lines.findIndex((l) => l.includes(`"id": "${docId}"`));
  if (start < 0) throw new Error(`row ${docId} not found in ${projectFile}`);
  const set = (key: string, value: string) => {
    for (let i = start; i < start + 14; i++) {
      const m = lines[i]?.match(new RegExp(`^(\\s*"${key}": )([^,]*)(,?)\\s*$`));
      if (m) { lines[i] = `${m[1]}${value}${m[3]}`; return; }
    }
    throw new Error(`${key} not found in row ${docId}`);
  };
  const ref = lines.findIndex((l, i) => i > start && i < start + 14 && /^\s*"scriptRef": /.test(l));
  if (ref >= 0) lines.splice(ref, 1);
  set('sizeBytes', String(st.size));
  set('mtimeMs', String(Math.floor(st.mtimeMs)));
  set('sha256', JSON.stringify(sha));
  writeFileSync(projectFile, lines.join('\n'));
  JSON.parse(readFileSync(projectFile, 'utf8'));
}

describe('updateDocumentRow', () => {
  it('Test_UpdateDocumentRow_ReformattedJson', () => {
    // A row whose fields are REORDERED (sha256 and sizeBytes last) and which
    // carries a nested block long enough to push them past line 14 of the row.
    // Both shapes occur in this repo: rows written by different tooling start
    // with `sizeBytes` or with `id`, and a `documentInfo` block is routinely
    // longer than fourteen lines.
    const docId = 'doc_reformatted_1';
    const manifest = {
      v: 1,
      documents: [
        {
          id: docId,
          name: 'Reformatted',
          path: 'scenes/Reformatted.glb',
          documentInfo: {
            v: 1,
            a: 'one', b: 'two', c: 'three', d: 'four', e: 'five',
            f: 'six', g: 'seven', h: 'eight', i: 'nine', j: 'ten',
            k: 'eleven', l: 'twelve', m: 'thirteen', n: 'fourteen',
          },
          mtimeMs: 0,
          sha256: 'deadbeef',
          sizeBytes: 0,
        },
      ],
    };
    const glb = writeGlb('scenes/Reformatted.glb', Buffer.from('glTF-ish payload'), 1_700_000_000.7);
    const expected = createHash('sha256').update(Buffer.from('glTF-ish payload')).digest('hex');

    // 1) The old line-window updater aborts on exactly this file.
    const legacyFile = writeManifest(manifest);
    expect(() => legacyUpdateProjectRow(legacyFile, glb, docId)).toThrow(/not found in row/);

    // 2) The new one does not.
    const file = writeManifest(manifest);
    const row = updateDocumentRow(file, { id: docId }, { glbPath: glb, mtimeRounding: 'floor' });
    expect(row).not.toBeNull();

    const after = readManifest(file);
    const updated = after.documents[0];
    expect(updated.sizeBytes).toBe(16);
    expect(updated.sha256).toBe(expected);
    expect(updated.mtimeMs).toBe(Math.floor(1_700_000_000.7 * 1000));
    // Field order survives: assigning to an existing key does not move it.
    expect(Object.keys(updated)).toEqual(['id', 'name', 'path', 'documentInfo', 'mtimeMs', 'sha256', 'sizeBytes']);
    // Everything else is untouched, and the file is still JSON.stringify(…, 2).
    expect(after.v).toBe(1);
    expect(updated.documentInfo).toEqual(manifest.documents[0].documentInfo);
    expect(readFileSync(file, 'utf8')).toBe(JSON.stringify(after, null, 2) + '\n');
  });

  it('Test_UpdateDocumentRow_LegacyOracleStillWorksOnACompactRow', () => {
    // Guards the test above from being vacuous: the oracle must FAIL ONLY
    // because of the reformat, not because it is broken here. On a compact row
    // (the shape `public/demo-realvirtual/project.json` happens to have today)
    // the line window still reaches every key, and the two updaters agree on
    // the result — which is also why the bug was latent instead of loud.
    const docId = 'doc_compact_1';
    const manifest = {
      documents: [{ id: docId, name: 'Compact', path: 'c.glb', sizeBytes: 0, mtimeMs: 0, sha256: 'x' }],
    };
    const glb = writeGlb('c.glb', Buffer.from('compact'), 1_700_000_000);

    const legacyFile = writeManifest(manifest);
    expect(() => legacyUpdateProjectRow(legacyFile, glb, docId)).not.toThrow();

    const file = writeManifest(manifest);
    updateDocumentRow(file, { id: docId }, { glbPath: glb, mtimeRounding: 'floor', removeScriptRef: true });

    expect(readFileSync(file, 'utf8')).toBe(readFileSync(legacyFile, 'utf8'));
  });

  it('Test_UpdateDocumentRow_UsesSha256File', () => {
    // `sha256File` from rv-hash.mjs is the one hash implementation of the Node
    // tooling (the library catalog uses it too, and the browser verifies
    // against it). This asserts the row carries ITS answer — both halves of
    // it, `sha256` AND `sizeBytes`, which is the whole return value.
    const bytes = Buffer.from([0x67, 0x6c, 0x54, 0x46, 1, 2, 3, 4, 5]);
    const glb = writeGlb('model.glb', bytes, 1_600_000_000);
    const file = writeManifest({ documents: [{ id: 'd1', path: 'model.glb', sizeBytes: 0, mtimeMs: 0, sha256: '' }] });

    updateDocumentRow(file, { id: 'd1' }, { glbPath: glb, mtimeRounding: 'round' });

    const expected = sha256File(glb);
    const row = readManifest(file).documents[0];
    expect(row.sha256).toBe(expected.sha256);
    expect(row.sizeBytes).toBe(expected.sizeBytes);
    expect(row.sha256).toHaveLength(64);
  });

  it('Test_UpdateDocumentRow_SelectorById', () => {
    const glb = writeGlb('b.glb', Buffer.from('bbb'), 1_600_000_000);
    const file = writeManifest({
      documents: [
        { id: 'a', path: 'a.glb', sizeBytes: 1, mtimeMs: 1, sha256: 'x' },
        { id: 'b', path: 'b.glb', sizeBytes: 1, mtimeMs: 1, sha256: 'x' },
      ],
    });

    updateDocumentRow(file, { id: 'b' }, { glbPath: glb, mtimeRounding: 'floor' });

    const after = readManifest(file);
    expect(after.documents[0]).toEqual({ id: 'a', path: 'a.glb', sizeBytes: 1, mtimeMs: 1, sha256: 'x' });
    expect(after.documents[1].sizeBytes).toBe(3);
  });

  it('Test_UpdateDocumentRow_SelectorByPath', () => {
    // The AGV caller selects by the path RELATIVE TO THE MANIFEST, not by id.
    const glb = writeGlb('scenes/AGVFactory.glb', Buffer.from('aaaa'), 1_600_000_000);
    const file = writeManifest({
      documents: [
        { id: 'a', path: 'scenes/AGVDemo.glb', sizeBytes: 1, mtimeMs: 1, sha256: 'x' },
        { id: 'b', path: 'scenes/AGVFactory.glb', sizeBytes: 1, mtimeMs: 1, sha256: 'x' },
      ],
    });

    const row = updateDocumentRow(file, { path: 'scenes/AGVFactory.glb' }, { glbPath: glb, mtimeRounding: 'round' });

    expect(row?.id).toBe('b');
    const after = readManifest(file);
    expect(after.documents[0].sizeBytes).toBe(1);
    expect(after.documents[1].sizeBytes).toBe(4);
  });

  it('Test_UpdateDocumentRow_SelectorMustBeExactlyOneOfIdOrPath', () => {
    const manifest = { documents: [{ id: 'a', path: 'a.glb' }] };
    expect(() => findDocumentRow(manifest, { id: 'a', path: 'a.glb' } as never)).toThrow(/exactly one/);
    expect(() => findDocumentRow(manifest, {} as never)).toThrow(/exactly one/);
  });

  it('Test_UpdateDocumentRow_RemoveScriptRef_OnlyWhereThePlcCallerHasIt', () => {
    // PLC removes `scriptRef` (plan-543: the operator panel is data in the
    // GLB). AGV must NOT — its AGVFactory row legitimately binds a model
    // plugin, and dropping it would break the delivered document.
    const glb = writeGlb('m.glb', Buffer.from('m'), 1_600_000_000);
    const base = { documents: [{ id: 'd', path: 'm.glb', scriptRef: 'plugins/agv-factory.js', sizeBytes: 0, mtimeMs: 0, sha256: '' }] };

    const kept = writeManifest(base);
    updateDocumentRow(kept, { id: 'd' }, { glbPath: glb, mtimeRounding: 'round' });
    expect(readManifest(kept).documents[0].scriptRef).toBe('plugins/agv-factory.js');

    const stripped = writeManifest(base);
    updateDocumentRow(stripped, { id: 'd' }, { glbPath: glb, mtimeRounding: 'floor', removeScriptRef: true });
    const row = readManifest(stripped).documents[0];
    expect('scriptRef' in row).toBe(false);
    // The removal must not cost the later keys, which is precisely what the
    // old `lines.splice` risked: it shortened the array the 14-line window was
    // measured against.
    expect(row.sizeBytes).toBe(1);
    expect(row.sha256).toHaveLength(64);
  });

  it('Test_UpdateDocumentRow_SetModifiedAt_OnlyWhereTheAgvCallerHasIt', () => {
    const glb = writeGlb('m.glb', Buffer.from('m'), 1_600_000_000);
    const base = { documents: [{ id: 'd', path: 'm.glb', modifiedAt: '2020-01-01T00:00:00.000Z', sizeBytes: 0, mtimeMs: 0, sha256: '' }] };

    // PLC does not touch it.
    const untouched = writeManifest(base);
    updateDocumentRow(untouched, { id: 'd' }, { glbPath: glb, mtimeRounding: 'floor' });
    expect(readManifest(untouched).documents[0].modifiedAt).toBe('2020-01-01T00:00:00.000Z');

    // AGV sets it to now; `true` means "now", a string is written verbatim.
    const stamped = writeManifest(base);
    const before = Date.now();
    updateDocumentRow(stamped, { id: 'd' }, { glbPath: glb, mtimeRounding: 'round', setModifiedAt: true });
    const written = readManifest(stamped).documents[0].modifiedAt as string;
    expect(Date.parse(written)).toBeGreaterThanOrEqual(before - 1000);
    expect(written).toMatch(/Z$/);

    const fixed = writeManifest(base);
    updateDocumentRow(fixed, { id: 'd' }, { glbPath: glb, mtimeRounding: 'round', setModifiedAt: '2026-10-11T12:00:00.000Z' });
    expect(readManifest(fixed).documents[0].modifiedAt).toBe('2026-10-11T12:00:00.000Z');
  });

  it('Test_UpdateDocumentRow_MtimeRounding_FloorForPlcRoundForAgv', () => {
    // The two callers measured: PLC `Math.floor`, AGV `Math.round`. A fractional
    // millisecond mtime makes them differ by one, so no default can satisfy both.
    const glb = writeGlb('m.glb', Buffer.from('m'), 1_600_000_000.0007);
    const exact = statSync(glb).mtimeMs;
    expect(Math.floor(exact)).not.toBe(Math.round(exact)); // the fraction really is there

    const floored = writeManifest({ documents: [{ id: 'd', mtimeMs: 0, sizeBytes: 0, sha256: '' }] });
    updateDocumentRow(floored, { id: 'd' }, { glbPath: glb, mtimeRounding: 'floor' });
    expect(readManifest(floored).documents[0].mtimeMs).toBe(Math.floor(exact));

    const rounded = writeManifest({ documents: [{ id: 'd', mtimeMs: 0, sizeBytes: 0, sha256: '' }] });
    updateDocumentRow(rounded, { id: 'd' }, { glbPath: glb, mtimeRounding: 'round' });
    expect(readManifest(rounded).documents[0].mtimeMs).toBe(Math.round(exact));
  });

  it('Test_UpdateDocumentRow_MtimeRounding_IsRequired', () => {
    // No default on purpose: a default would silently give one of the two
    // committed manifests a different mtimeMs than it has today.
    const glb = writeGlb('m.glb', Buffer.from('m'), 1_600_000_000);
    const file = writeManifest({ documents: [{ id: 'd' }] });
    expect(() => updateDocumentRow(file, { id: 'd' }, { glbPath: glb } as never)).toThrow(/mtimeRounding/);
    expect(() => updateDocumentRow(file, { id: 'd' }, { glbPath: glb, mtimeRounding: 'ceil' } as never)).toThrow(/mtimeRounding/);
    expect(() => updateDocumentRow(file, { id: 'd' }, { mtimeRounding: 'floor' } as never)).toThrow(/glbPath/);
  });

  it('Test_UpdateDocumentRow_MissingRow_ThrowsForPlcIgnoresForAgv', () => {
    const glb = writeGlb('m.glb', Buffer.from('m'), 1_600_000_000);
    const file = writeManifest({ documents: [{ id: 'other', path: 'other.glb' }] });
    const original = readFileSync(file, 'utf8');

    expect(() => updateDocumentRow(file, { id: 'absent' }, { glbPath: glb, mtimeRounding: 'floor' }))
      .toThrow(/row id absent not found/);

    expect(updateDocumentRow(file, { path: 'absent.glb' }, { glbPath: glb, mtimeRounding: 'round', ifMissing: 'ignore' }))
      .toBeNull();
    // `ignore` writes NOTHING — the AGV caller only logs when a row was hit.
    expect(readFileSync(file, 'utf8')).toBe(original);
  });

  it('Test_UpdateDocumentRow_TrailingNewline_FollowsTheFile', () => {
    // The PLC manifest ends with a newline and its old updater preserved it
    // (`lines.join('\n')`); the AGV one has none, because its old updater wrote
    // a bare `JSON.stringify`. Both artefacts must stay byte-identical.
    const glb = writeGlb('m.glb', Buffer.from('m'), 1_600_000_000);
    const base = { documents: [{ id: 'd', sizeBytes: 0, mtimeMs: 0, sha256: '' }] };

    const withNl = writeManifest(base, { trailingNewline: true });
    updateDocumentRow(withNl, { id: 'd' }, { glbPath: glb, mtimeRounding: 'floor' });
    expect(readFileSync(withNl, 'utf8').endsWith('}\n')).toBe(true);

    const withoutNl = writeManifest(base, { trailingNewline: false });
    updateDocumentRow(withoutNl, { id: 'd' }, { glbPath: glb, mtimeRounding: 'round', trailingNewline: 'none' });
    expect(readFileSync(withoutNl, 'utf8').endsWith('}')).toBe(true);
    expect(readFileSync(withoutNl, 'utf8').endsWith('}\n')).toBe(false);
  });
});
