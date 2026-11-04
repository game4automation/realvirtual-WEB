// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-513 §9.7 — the boot resume restores the mode a document was last USED
 * in, not the one it was opened in.
 *
 * The remembered pair's mode is written on OPEN and never follows a later
 * switch (`rememberSession`), which is SOL R1 F1. The resume therefore reads
 * the last-mode store before it opens, opens with `modeDecidedByCaller`, and
 * hands `resumeModeOf` to the mode boot — where `?mode=` and a published boot
 * mode still come first.
 *
 * The data half runs against the real store (IndexedDB) through the same
 * tracking `main.ts` wires; main.ts itself cannot be booted in a test, so its
 * wiring and the mode-boot order are pinned over the source.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import MAIN_SOURCE from '../src/main.ts?raw';
import BOOT_MODE_SOURCE from '../src/core/rv-boot-mode.ts?raw';
import {
  DOCUMENT_MODES_DB_NAME,
  __closeDocumentModesDb,
  attachDocumentModeTracking,
  readDocumentMode,
  recordDocumentMode,
} from '../src/core/project/rv-document-mode-store';
import { resumeModeOf } from '../src/core/project/rv-document-mode';

const has = (m: string) => ['viewer', 'hmi', 'planner', 'des', 'editor'].includes(m);

async function dropModeDb() {
  __closeDocumentModesDb();
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(DOCUMENT_MODES_DB_NAME);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}

beforeEach(dropModeDb);
afterEach(dropModeDb);

/** What the resume branch computes, from the store — the same three calls. */
async function resumeMode(declaredMode: string | null, sessionMode: string | null) {
  const lastMode = await readDocumentMode('folder', 'prj_r', 'doc_r');
  return resumeModeOf({ lastMode, declaredMode, isDemo: false, has, sessionMode });
}

describe('the resume target', () => {
  it('opened in the HMI, then switched to the editor: the resume opens in the editor', async () => {
    type L = (d: { from: string | null; to: string }) => void;
    const listeners: L[] = [];
    const host = { on: (_e: 'mode-changed', cb: L) => { listeners.push(cb); return () => {}; } };
    attachDocumentModeTracking(host, () => ({
      projectId: 'prj_r', backend: 'folder', documentId: 'doc_r', isDemo: false,
    }));

    await recordDocumentMode({
      projectId: 'prj_r', backend: 'folder', documentId: 'doc_r',
      activeMode: 'hmi', lockedMode: null, isDemo: false,
    });
    for (const l of listeners) l({ from: 'hmi', to: 'editor' });

    // The session pair still says `hmi` — the mode it was OPENED in.
    await expect.poll(() => resumeMode(null, 'hmi')).toBe('editor');
  });

  it('no store entry, the row declares planner: planner', async () => {
    expect(await resumeMode('planner', 'hmi')).toBe('planner');
  });

  it('no store entry and no declared mode: the session mode', async () => {
    expect(await resumeMode(null, 'des')).toBe('des');
  });
});

describe('main.ts wiring (source)', () => {
  const branch = MAIN_SOURCE.slice(
    MAIN_SOURCE.indexOf("} else if (target.source === 'remembered' && target.asset) {"),
    MAIN_SOURCE.indexOf("} else if (target.source === 'defaultModel' && target.asset) {"),
  );

  it('the remembered branch reads the store BEFORE the open and opens with modeDecidedByCaller', () => {
    const read = branch.indexOf('await readDocumentMode(');
    const open = branch.indexOf('await sceneStore.openDocument(doc.id, { name: doc.name, modeDecidedByCaller: true })');
    expect(read).toBeGreaterThan(0);
    expect(open).toBeGreaterThan(read);
    expect(branch).toMatch(/resumeBootMode = resumeModeOf\(\{[\s\S]*sessionMode: target\.mode,/);
  });

  it('?mode= beats a published boot mode, which beats the resume mode', () => {
    // plan-652: the cascade lives in resolveBootMode (rv-boot-mode.ts).
    expect(MAIN_SOURCE.indexOf('url: urlMode,')).toBeGreaterThan(0);
    expect(MAIN_SOURCE.indexOf('published: publishedBootMode,')).toBeGreaterThan(0);
    expect(MAIN_SOURCE.indexOf('resume: resumeBootMode,')).toBeGreaterThan(0);
    const url = BOOT_MODE_SOURCE.indexOf("['url', candidates.url]");
    const published = BOOT_MODE_SOURCE.indexOf("['published', candidates.published]");
    const resume = BOOT_MODE_SOURCE.indexOf("['resume', candidates.resume]");
    expect(url).toBeGreaterThan(0);
    expect(published).toBeGreaterThan(url);
    expect(resume).toBeGreaterThan(published);
  });

  it('the document-mode tracking is attached before the mode boot', () => {
    const tracking = MAIN_SOURCE.indexOf('attachDocumentModeTracking(viewer,');
    const boot = MAIN_SOURCE.indexOf('const bootTarget = resolveBootMode(');
    expect(tracking).toBeGreaterThan(0);
    expect(tracking).toBeLessThan(boot);
  });
});
