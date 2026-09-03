// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-713 Phase 2 — T8/T9/T10 plus the pure guards the three tools share.
 *
 * Backend mocking follows the established pattern (`opfs-blobs.test.ts`,
 * `mcp-project-capture.test.ts`): a `ProjectBackend` double, never real OPFS.
 * What is NOT mocked is the decision layer — `decideSaveVerb`, the path guard
 * and the glob/cap helpers all run for real, because they are what the tests are
 * about.
 *
 * ## Why the write tools are tested through their guards, not their writes
 *
 * `web_document_update`'s value is in what it REFUSES: the file of the open
 * document, reserved system rows, invalid names. The open-document comparison
 * (`samePath`) is pinned here; the tree verdicts themselves
 * (`canRenameInTree` / `canMoveInTree`) are covered where they live. The happy
 * path underneath is `retireDocument` / `applyTreeMove` — already covered where
 * they live, and re-testing them through a fourth mock would pin the mock, not
 * the behaviour. (The old `library/Custom/` whitelist guard was retired with
 * the 2026-08-19 project-tree rework.)
 */

import { describe, it, expect } from 'vitest';
import {
  capRows,
  inDirectory,
  matchesAssetFilter,
  matchesGlob,
  samePath,
} from '../src/plugins/mcp-bridge/rv-mcp-asset-listing';
import { decideSaveVerb } from '../src/core/editor/rv-save-document';
import { glbNodeCensus, readGlbJson } from '../src/core/import/rv-glb-inspect';
import { parseGlbChunks, rebuildGlbWithJson } from '../src/core/persistence/rv-glb-chunks';
import type { ProjectBackend } from '../src/core/project/backends/project-backend';
import { folderFields } from '../src/plugins/mcp-bridge/rv-mcp-project-tools';

// ─── T9 — the open-document guard of web_document_update ────────────────

describe('T9 — web_document_update open-document guard', () => {
  it('the open-document guard compares paths, not strings', () => {
    // R10: the refusal must fire whichever spelling the editor happens to hold.
    expect(samePath('library/Custom/A.glb', 'library/Custom/A.glb')).toBe(true);
    expect(samePath('library/Custom/A.glb', '/library/Custom/a.glb')).toBe(true);
    expect(samePath('library/Custom/A.glb', 'library/Custom/B.glb')).toBe(false);
    expect(samePath(null, 'library/Custom/A.glb')).toBe(false);
    expect(samePath('library/Custom/A.glb', undefined)).toBe(false);
  });
});

// ─── T10 — project-files filtering and truncation ───────────────────────

describe('T10 — web_editor_project_files filters and cap', () => {
  it('dir narrows by folder prefix, never by substring', () => {
    expect(inDirectory('library/Custom/A.glb', 'library/Custom')).toBe(true);
    expect(inDirectory('library/Custom/Deep/A.glb', 'library/Custom')).toBe(true);
    // "library/CustomOther" must not be matched by dir="library/Custom".
    expect(inDirectory('library/CustomOther/A.glb', 'library/Custom')).toBe(false);
    expect(inDirectory('models/A.glb', 'library/Custom')).toBe(false);
    // The folder itself is not one of its own children.
    expect(inDirectory('library/Custom', 'library/Custom')).toBe(false);
    // No dir means no filter.
    expect(inDirectory('anything/at/all.glb')).toBe(true);
    expect(inDirectory('anything/at/all.glb', '  ')).toBe(true);
  });

  it('glob is anchored over the whole path and crosses folders', () => {
    expect(matchesGlob('library/Custom/A.glb', '*.glb')).toBe(true);
    expect(matchesGlob('library/Custom/A.glb', 'library/*')).toBe(true);
    expect(matchesGlob('library/Custom/A.json', '*.glb')).toBe(false);
    expect(matchesGlob('models/A.glb', 'A.glb')).toBe(false); // anchored, not a suffix test
    expect(matchesGlob('models/AB.glb', 'models/A?.glb')).toBe(true);
    expect(matchesGlob('models/A.glb')).toBe(true);
    // Regex metacharacters in a caller's pattern are literals, not syntax.
    expect(matchesGlob('a+b.glb', 'a+b.glb')).toBe(true);
    expect(matchesGlob('aab.glb', 'a+b.glb')).toBe(false);
  });

  it('truncation keeps valid rows and names the narrowing parameters', () => {
    const rows = Array.from({ length: 500 }, (_, i) => ({ path: `models/File${i}.glb`, size: i }));
    const capped = capRows(rows, 2_000, 'Narrow with dir= or glob=.');
    expect(capped.truncated).toBe(true);
    expect(capped.rows.length).toBeGreaterThan(0);
    expect(capped.rows.length).toBeLessThan(rows.length);
    expect(JSON.stringify(capped.rows).length).toBeLessThanOrEqual(2_000);
    expect(capped.note).toContain('500');
    expect(capped.note).toContain('dir=');
    // Rows survive intact — a truncated listing is shorter, never lossy per row.
    expect(capped.rows[0]).toEqual(rows[0]);
  });

  it('a listing that fits is not touched', () => {
    const rows = [{ path: 'a.glb' }, { path: 'b.glb' }];
    const capped = capRows(rows, 60_000, 'x');
    expect(capped.truncated).toBe(false);
    expect(capped.note).toBeUndefined();
    expect(capped.rows).toEqual(rows);
  });

  it('an empty listing is an empty array, never an error', () => {
    expect(capRows([], 10, 'x')).toEqual({ rows: [], truncated: false });
  });
});

// ─── F2 — the filter and the header-only node count ─────────────────────

describe('F2 — web_document_list metadata (formerly web_library_assets)', () => {
  it('an absent filter matches everything; a present one matches name or path', () => {
    const row = { name: 'Gripper', relPath: 'library/Custom/Gripper.glb' };
    expect(matchesAssetFilter(row)).toBe(true);
    expect(matchesAssetFilter(row, '')).toBe(true);
    expect(matchesAssetFilter(row, '  ')).toBe(true);
    expect(matchesAssetFilter(row, 'grip')).toBe(true);   // name, case-insensitive
    expect(matchesAssetFilter(row, 'CUSTOM')).toBe(true); // path
    expect(matchesAssetFilter(row, 'conveyor')).toBe(false);
  });

  it('nodeCount comes from the JSON chunk with the BIN chunk untouched', () => {
    // Build a minimal GLB whose BIN chunk is deliberate junk: if anything on the
    // read path decoded geometry, this would throw rather than count.
    const json = {
      asset: { version: '2.0' },
      scenes: [{ nodes: [0] }],
      nodes: [{ name: 'Root', children: [1] }, { name: 'Arm', mesh: 0 }],
      meshes: [{ name: 'ArmMesh', primitives: [] }],
    };
    const bin = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01, 0x02, 0x03]);
    const glb = makeGlb(json, bin);

    const parsed = readGlbJson(glb);
    expect(glbNodeCensus(parsed)).toEqual({ nodeCount: 2, meshCount: 1 });
    // And the reader really did leave the tail alone — re-emitting the same JSON
    // reproduces the source byte for byte.
    const round = rebuildGlbWithJson(parseGlbChunks(glb));
    expect(new Uint8Array(glb).length).toBe(round.length);
  });

  it('an empty GLB counts zero rather than throwing', () => {
    const glb = makeGlb({ asset: { version: '2.0' } }, new Uint8Array(4));
    expect(glbNodeCensus(readGlbJson(glb))).toEqual({ nodeCount: 0, meshCount: 0 });
  });
});

// ─── T8 — the save-verb matrix ──────────────────────────────────────────

describe('T8 — save verb matrix', () => {
  const writable = { writable: true } as ProjectBackend;
  const readOnly = { writable: false } as ProjectBackend;

  /**
   * Some open document — WHICH one is beside the point in the refusal tests
   * below, because a read-only or absent project is answered before the
   * identity is ever looked at. It used to be `{kind:'empty'}`; that kind is
   * gone (plan-719 F3), and it only survived the typecheck here because of an
   * `as never` cast, which is exactly the kind of stale fixture a cast hides.
   */
  const anyOpenDocument = {
    kind: 'document', documentId: 'doc_a', path: 'A.glb', name: 'A',
  } as const;

  it('a named asset in a writable project saves in place', () => {
    const d = decideSaveVerb(
      { lineage: 'asset', base: { kind: 'document', path: 'library/Custom/A.glb' } as never, name: 'A' },
      writable,
    );
    expect(d.verb).toBe('save');
  });

  /**
   * plan-719 F3 retired the case this used to state. There is no "Untitled
   * document" that has to be given a home at its first save — `web_editor_open
   * source=new` creates the document WITH a path, so what `web_editor_save`
   * writes is that path, and the verb is the ordinary in-place `save`.
   *
   * `library/Custom/` did not disappear with it: it is still where the
   * explicit "Save as…" verb places a new asset, which is pinned in
   * `save-document-routing.test.ts`.
   */
  it('a document created by source=new saves to its own path', () => {
    const d = decideSaveVerb(
      {
        lineage: 'asset',
        base: { kind: 'document', documentId: 'doc_fresh', path: 'Fresh.glb', name: 'Fresh' },
        name: 'Fresh',
      },
      writable,
    );
    expect(d.verb).toBe('save');
    expect(d.relPath).toBe('Fresh.glb');
    // Not a copy: the document is already the user's.
    expect(d.copies).toBeUndefined();
  });

  it('a provider asset saves as a COPY, and says so with `copies`', () => {
    // The one case where the MCP result must not read as "saved in place":
    // the document's identity changes, which is exactly what F6 wants reported.
    const d = decideSaveVerb(
      { lineage: 'asset', base: { kind: 'providerAsset', providerId: 'p' } as never, name: 'Belt' },
      writable,
    );
    expect(d.verb).toBe('save-into-project');
    expect(d.copies).toBe(true);
  });

  it('nothing open is blocked in both lineages, with the same sentence', () => {
    const asset = decideSaveVerb({ lineage: 'asset', base: null, name: 'A' }, writable);
    const scene = decideSaveVerb({ lineage: 'scene', open: false, transient: false }, writable);
    expect(asset.verb).toBe('blocked');
    expect(asset.reason).toBe(scene.reason);
  });

  it('a read-only project blocks both lineages, and says so the same way', () => {
    // Both subjects must be OPEN, or the earlier "nothing is open" branch answers
    // first and the shared read-only wording is never reached.
    const asset = decideSaveVerb(
      { lineage: 'asset', base: anyOpenDocument, name: 'A' }, readOnly,
    );
    const scene = decideSaveVerb({ lineage: 'scene', open: true, transient: false }, readOnly);
    expect(asset.verb).toBe('blocked');
    expect(scene.verb).toBe('blocked');
    // plan-710 F5: one function, so the refusals cannot drift apart.
    expect(asset.reason).toBe(scene.reason);
    expect(asset.reason).toContain('read-only');
  });

  it('no project at all is blocked in both lineages, identically', () => {
    const asset = decideSaveVerb(
      { lineage: 'asset', base: anyOpenDocument, name: 'A' }, null,
    );
    const scene = decideSaveVerb({ lineage: 'scene', open: true, transient: false }, null);
    expect(asset.verb).toBe('blocked');
    expect(asset.reason).toBe(scene.reason);
  });

  it('a scene with nothing open is blocked', () => {
    expect(decideSaveVerb({ lineage: 'scene', open: false, transient: false }, writable).verb)
      .toBe('blocked');
  });

  it('an open scene in a writable project is saveable', () => {
    const d = decideSaveVerb({ lineage: 'scene', open: true, transient: false }, writable);
    expect(d.verb).not.toBe('blocked');
  });

  it('every verb is one of the three the type declares', () => {
    for (const d of [
      decideSaveVerb({ lineage: 'asset', base: null, name: 'A' }, writable),
      decideSaveVerb({ lineage: 'asset', base: null, name: 'A' }, null),
      decideSaveVerb({ lineage: 'scene', open: true, transient: true }, writable),
      decideSaveVerb({ lineage: 'scene', open: false, transient: false }, null),
    ]) {
      expect(['save', 'save-into-project', 'blocked']).toContain(d.verb);
      if (d.verb === 'blocked') expect(d.reason).toBeTruthy();
    }
  });
});

// ─── helpers ────────────────────────────────────────────────────────────

/** Assemble a spec-shaped GLB with the given JSON and BIN chunk. */
function makeGlb(json: unknown, bin: Uint8Array): ArrayBuffer {
  const enc = new TextEncoder();
  let jsonBytes = enc.encode(JSON.stringify(json));
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  if (jsonPad) {
    const padded = new Uint8Array(jsonBytes.length + jsonPad).fill(0x20);
    padded.set(jsonBytes);
    jsonBytes = padded;
  }
  const binPad = (4 - (bin.length % 4)) % 4;
  const binBytes = new Uint8Array(bin.length + binPad);
  binBytes.set(bin);

  const total = 12 + 8 + jsonBytes.length + 8 + binBytes.length;
  const buf = new ArrayBuffer(total);
  const view = new DataView(buf);
  const out = new Uint8Array(buf);
  view.setUint32(0, 0x46546c67, true); // 'glTF'
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonBytes.length, true);
  view.setUint32(16, 0x4e4f534a, true); // 'JSON'
  out.set(jsonBytes, 20);
  const binHeader = 20 + jsonBytes.length;
  view.setUint32(binHeader, binBytes.length, true);
  view.setUint32(binHeader + 4, 0x004e4942, true); // 'BIN\0'
  out.set(binBytes, binHeader + 8);
  return buf;
}


// ─── plan-736 F7 — `folder` replaces `section` in the MCP file contract ────

describe('plan-736 F7 — the MCP document row names its folder, not a section', () => {
  it('folder is the first path segment, and the project root is the empty string', () => {
    expect(folderFields('models/Press.glb').folder).toBe('models');
    expect(folderFields('library/Custom/Belt.glb').folder).toBe('library');
    expect(folderFields('scenes/Line.scene.glb').folder).toBe('scenes');
    // The case the old field could not express. `sectionOfDocument` answered
    // `'library'` for a root-level file because `library` was its fallback, so
    // an agent filtering on it filed the project root under the library.
    expect(folderFields('Root.glb').folder).toBe('');
    // A folder nobody named a section after is simply its own name now.
    expect(folderFields('cad/Imported.step').folder).toBe('cad');
    expect(folderFields('knowledge/Sheet.pdf').folder).toBe('knowledge');
  });

  it('the deprecated `section` alias carries the IDENTICAL value as `folder`', () => {
    // The alias exists so an agent prompt written against the old field keeps
    // working for one release. Two fields that are meant to be one value must
    // never be able to drift, which is what this pins.
    for (const path of [
      'models/Press.glb', 'library/Custom/Belt.glb', 'scenes/Line.scene.glb',
      'cad/Imported.step', 'Root.glb', '', 'a/b/c/d.glb',
    ]) {
      const row = folderFields(path);
      expect(row.section, path).toBe(row.folder);
    }
  });

  it('a non-string path is the root, never a crash', () => {
    for (const bad of [null, undefined, 42, {}, []]) {
      expect(folderFields(bad)).toEqual({ folder: '', section: '' });
    }
  });
});
