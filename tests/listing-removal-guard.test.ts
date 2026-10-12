// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * listing-removal-guard — the retired listings stay retired (plan-744 F10).
 *
 * Modelled on `scene-removal-guard.test.ts`, and for the same reason: a
 * deletion that nothing pins comes back. Somebody adds "just one more"
 * `listLibrary()` call because the folder happens to be the one they mean, and
 * six months later the product has two listings again, disagreeing about how
 * deep they walk.
 *
 * What is pinned, and why each one:
 *
 *  - **`listModels(` / `listLibrary(`** — the two backend listings. They asked
 *    "which documents live in this FOLDER", which the caller can answer off
 *    the row it already has, and they disagreed about depth: models walked one
 *    level, library walked the tree.
 *  - **`sceneDocumentsOf(` / `assetDocumentsOf(`** — the section projections.
 *    A projection over a path heuristic is wrong from the start for a browser
 *    project, whose document paths are bare ids.
 *  - **`sectionOfDocument` / `documentsInSection` / `documentsFromLists`** —
 *    kept, but pinned to `rv-project-documents.ts`. They are the Legacy-v1
 *    migration and must keep working, or an unmigrated customer manifest loses
 *    its documents. A caller anywhere else is a live path reading a heuristic.
 *  - **the `section:` stamp** — no module may write the field again.
 *
 * COMMENTS ARE EXEMPT, deliberately. Half the value of a removal is the note
 * saying what went and why, and a guard that forbids naming the dead symbol
 * forces those notes to be written in riddles.
 */

import { describe, it, expect } from 'vitest';

// Vite's `?raw` gives the guard the actual shipped text of each module. A
// reflective check would only see what survived tree-shaking.
import projectBackendSrc from '../src/core/project/backends/project-backend.ts?raw';
import folderBackendSrc from '../src/core/project/backends/folder-backend.ts?raw';
import bundledBackendSrc from '../src/core/project/backends/bundled-backend.ts?raw';
import browserBackendSrc from '../src/core/project/backends/browser-backend.ts?raw';
import projectStoreSrc from '../src/core/project/project-store.ts?raw';
import sceneStoreSrc from '../src/core/hmi/scene/scene-store.ts?raw';
import sceneGlbIoSrc from '../src/core/hmi/scene/rv-scene-glb-io.ts?raw';
import folderWriterSrc from '../src/core/project/rv-project-folder-writer.ts?raw';
import projectMigrationSrc from '../src/core/project/rv-project-migration.ts?raw';
import projectStorageSrc from '../src/core/project/rv-project-storage.ts?raw';
import documentsMigrationSrc from '../src/core/project/rv-project-documents-migration.ts?raw';
import assetIdentitySrc from '../src/core/project/rv-asset-identity.ts?raw';
import workspaceMigrationSrc from '../src/core/project/rv-workspace-migration.ts?raw';
import libraryProviderSrc from '../src/core/library/project-library-provider.ts?raw';
import saveDocumentSrc from '../src/core/editor/rv-save-document.ts?raw';
import welcomeModalSrc from '../src/core/hmi/WelcomeModal.tsx?raw';
import mcpProjectToolsSrc from '../src/plugins/mcp-bridge/rv-mcp-project-tools.ts?raw';
import mcpEditorToolsSrc from '../src/plugins/mcp-bridge/rv-mcp-editor-tools.ts?raw';
import manifestTwinSrc from '../scripts/_rv-manifest.mjs?raw';

/** Every module the retirement touched, by the name the failure should name. */
const MODULES: Array<[string, string]> = [
  ['backends/project-backend.ts', projectBackendSrc],
  ['backends/folder-backend.ts', folderBackendSrc],
  ['backends/bundled-backend.ts', bundledBackendSrc],
  ['backends/browser-backend.ts', browserBackendSrc],
  ['project-store.ts', projectStoreSrc],
  ['scene/scene-store.ts', sceneStoreSrc],
  ['scene/rv-scene-glb-io.ts', sceneGlbIoSrc],
  ['rv-project-folder-writer.ts', folderWriterSrc],
  ['rv-project-migration.ts', projectMigrationSrc],
  ['rv-project-storage.ts', projectStorageSrc],
  ['rv-project-documents-migration.ts', documentsMigrationSrc],
  ['rv-asset-identity.ts', assetIdentitySrc],
  ['rv-workspace-migration.ts', workspaceMigrationSrc],
  ['library/project-library-provider.ts', libraryProviderSrc],
  ['editor/rv-save-document.ts', saveDocumentSrc],
  ['hmi/WelcomeModal.tsx', welcomeModalSrc],
  ['mcp-bridge/rv-mcp-project-tools.ts', mcpProjectToolsSrc],
  ['mcp-bridge/rv-mcp-editor-tools.ts', mcpEditorToolsSrc],
];

/**
 * The source with every comment removed.
 *
 * Block comments first, then line comments — and the line pass deliberately
 * runs over what the block pass left, so a `//` inside a block comment is
 * already gone. String literals containing `//` survive as text, which is
 * harmless here: none of the pinned identifiers appear in one.
 */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/[ \t]\/\/.*$/gm, '');
}

describe('plan-744 F10 — the retired listings stay retired', () => {
  it.each(MODULES)('%s calls no listModels() or listLibrary()', (_name, src) => {
    const code = codeOnly(src);
    expect(code).not.toMatch(/\blistModels\s*\(/);
    expect(code).not.toMatch(/\blistLibrary\s*\(/);
  });

  it.each(MODULES)('%s uses no section projection', (_name, src) => {
    const code = codeOnly(src);
    expect(code).not.toMatch(/\bsceneDocumentsOf\s*\(/);
    expect(code).not.toMatch(/\bassetDocumentsOf\s*\(/);
  });

  it('the Legacy-v1 helpers have no caller outside their own module', () => {
    // `rv-project-documents.ts` is not in MODULES: it is where they live.
    // Anywhere else, a call to one of these is a LIVE path asking a path
    // heuristic what kind of thing a document is.
    for (const [name, src] of MODULES) {
      const code = codeOnly(src);
      expect(code, `${name} calls sectionOfDocument`).not.toMatch(/\bsectionOfDocument\s*\(/);
      expect(code, `${name} calls documentsInSection`).not.toMatch(/\bdocumentsInSection\s*\(/);
      expect(code, `${name} calls documentsFromLists`).not.toMatch(/\bdocumentsFromLists\s*\(/);
    }
  });

  it('the Node twin lifts without a section argument', () => {
    // The TS and Node halves must stay identical (plan-736 F6). The twin's
    // lift lost its `section` parameter with the stamp; a call that still
    // passes one is the two sides drifting apart again.
    const code = codeOnly(manifestTwinSrc);
    expect(code).not.toMatch(/documentOfLegacyEntry\s*\([^)]*,/);
  });
});

describe('plan-744 Phase 2 — nothing stamps `section`', () => {
  /**
   * A WRITE of the field, as opposed to a read of one somebody else wrote.
   *
   * Two shapes only: `section:` in an object literal, and `x.section =`.
   * Everything else that mentions the word is legal and has to stay legal —
   * `entry.section` and `d.section` are READS (a delivered manifest carries
   * the field and this build never strips it, §F4), a local `const section =`
   * is the Legacy-v1 migration naming which array it is walking, and
   * `counts[section]` is it counting them.
   */
  const STAMPS = [
    /(^|[^.\w])section\s*:/,     // { …, section: 'scenes' }
    /\.section\s*=[^=]/,         // row.section = 'scenes'
  ];

  function assertNoStamp(name: string, src: string): void {
    // Type positions are declarations, not stamps: an interface saying
    // `section?: string` describes what may ARRIVE. Nothing declares one any
    // more, but the guard must not fire on a future reader either.
    const code = codeOnly(src)
      .replace(/section\??\s*:\s*(string|DocumentSection|unknown)\b/g, '');
    for (const stamp of STAMPS) expect(code, `${name} stamps section`).not.toMatch(stamp);
  }

  it.each(MODULES)('%s writes no section field', (name, src) => { assertNoStamp(name, src); });

  it('the Node twin writes no section field either', () => {
    assertNoStamp('_rv-manifest.mjs', manifestTwinSrc);
  });
});
