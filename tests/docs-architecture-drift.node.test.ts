// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * docs-architecture-drift — the architecture docs must not outlive the code
 * they describe (plan-754 Phase 1c).
 *
 * Two deletions in a row (plan-753 Phase 4b: the BatchedMesh arenas; plan-754
 * Phase 1c: the in-place bake) each left the docs describing machinery that was
 * no longer in the tree. Nobody notices, because prose does not fail to
 * compile: `doc-webviewer.md` still listed `rv-chunk-visibility.ts` in its file
 * tree, and `doc-render-picking.md` still explained masked source meshes as a
 * live mechanism. A reader — or an agent — then plans against a world that does
 * not exist.
 *
 * This test makes that a failure. It checks two things a doc CAN get wrong in a
 * way a machine can see:
 *
 *  1. **Every engine module a doc points at exists.** A deleted module cited
 *     in a file tree, a link or a "the canonical source is …" sentence is
 *     caught the moment it is deleted.
 *  2. **Deleted concepts are named only as history.** The identifiers below were
 *     removed on purpose; a doc may still mention them — the past is worth
 *     recording — but only on a line that says so. A sentence that presents one
 *     of them as current machinery fails here.
 *
 * It deliberately does NOT try to verify prose against behaviour. It verifies
 * the two things drift shows up in first: dead module paths and dead vocabulary.
 *
 * When you delete something, the fix is one of:
 *  - update the doc (usually right), or
 *  - mark the sentence as history with one of {@link HISTORY_MARKERS}, or
 *  - if the identifier came back, take it out of {@link DELETED_IDENTIFIERS}.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** The private design note lives in a sibling repo that is not always checked out. */
const privateDoc = resolve(repoRoot, '..', 'realvirtual-WebViewer-Private~', 'doc-render-picking.md');

/**
 * Concepts plan-753/754 deleted. Each entry is the name as a doc would write
 * it. Keep this list short and specific: it is a tripwire for the things whose
 * disappearance actually misleads a reader about how the pipeline works.
 */
const DELETED_IDENTIFIERS = [
  // plan-754 Phase 1c — the in-place bake and everything that served it.
  'instantiateInPlace',
  'hideStaticData',
  'ChunkVisibilityService',
  'notifyNodeVisibilityChanged',
  'rv-ghost-detach',
  'rv-chunk-visibility',
  'rv-bake-destructive-flag',
  'isDestructiveBakeEnabled',
  'rv.bake.destructive',
  '_rvBakeInPlace',
  '_rvBakeSource',
  // plan-753 Phase 4b — the BatchedMesh arenas.
  'rv-batched-render',
  'rv-batch-table',
  'rv-arena-planner',
  'rv-highlight-proxy',
  // plan-754 Phase 2 — the projected hierarchy.
  "hierarchyScope: 'composition'",
  // plan-756 step 1d — the chunk BVHs, the index-window tables and their backend.
  // Spelled the way a doc writes them: `ChunkPickBackend` covers the module name
  // `rv-chunk-pick-backend.ts` only in prose, so the module itself is listed too.
  'ChunkPickBackend',
  'rv-chunk-pick-backend',
  'bsearchNode',
  '_windowIndexOf',
  // Both spellings of the deleted readiness promise. `asset.ready` is specific
  // enough to be safe: `whenSceneReady`, `raycast-ready` and `scene-ready` do not
  // contain it, and no live field is named that way any more.
  'asset.ready',
  'BakedAsset.ready',
  'ChunkNodeRange',
  'ChunkSourceRange',
  'bakeBvhPort',
  // plan-757 Phase 1 — the placement bake runs the ONE recipe (`prepareAndBake`),
  // hooks included, and placement groups reach the viewer's registry. These
  // are the sentences the docs used to state the gap with; a doc may keep them
  // only as history.
  'runs no prepare hooks',
  'wiring them is a follow-up',
  'placements get none yet',
  'placement groups are not in the Groups panel',
  // plan-757 Phase 1b — one resolver. The three separate readers are gone.
  'resolveComponentRef()',
  // plan-757 Phase 2b — a reference is a placement, always. A runtime load
  // grafts nothing; the `composition === null` bake gate and the sentence that
  // said placements run no hooks are history.
  'grafts in immediately',
  'composition === null',
  'run no pre-bake hooks today',
  // plan-757 Phase 3 commit A — the Visual-tab switch is gone and a failed bake
  // is a load error.
  'Static mesh batching',
  'falling back to the unbaked tree',
  // plan-757 Phase 3 commit B — the unbaked runtime is deleted: the
  // localStorage override and its module, the init's runtime re-parent pass and
  // the home-pose modes that protected it. A doc may name them only as history.
  'rv-static-merge-flag',
  'isStaticMeshMergingEnabled',
  'rv-webviewer-static-merge',
  'applyKinematicParenting',
  'skipReparent',
  'restoreDriveHomePose',
  'DriveHomePoseMode',
  "driveHomePose: 'defer'",
  "driveHomePose: 'bracket'",
  'bake-no-bake-fallbacks',
];

/** The settings tab that carried the loader-bake switch until commit A. */
const VISUAL_TAB = join(repoRoot, 'src', 'core', 'hmi', 'settings', 'VisualTab.tsx');

/** Source files a resurrected override or re-parent pass would have to touch. */
const LOADER = join(repoRoot, 'src', 'core', 'engine', 'rv-scene-loader.ts');
const VIEWER = join(repoRoot, 'src', 'core', 'rv-viewer.ts');

/**
 * A PARAGRAPH that contains one of these is talking about the past, which is
 * allowed (and usually valuable — it explains why the current shape is what it
 * is). The unit is the paragraph, not the line: "Phase 1c deleted the in-place
 * half and everything that served it:" followed by a list is one statement, and
 * the marker sits on the first line of it.
 */
const HISTORY_MARKERS = [
  'deleted', 'Deleted', 'DELETED',
  'removed', 'Removed',
  'no longer', 'used to', 'is gone', 'are gone', 'went with',
  'History', 'history', 'historic',
  'until Phase', 'Phase 1c', 'Phase 4b',
  'stale', 'was ', 'were ', 'had ',
  'Plans 745', 'plan-745', 'plan-752',
];

/** Doc files this test governs — the ones that describe the architecture. */
function architectureDocs(): string[] {
  const docs = readdirSync(repoRoot)
    .filter((f) => f.startsWith('doc-') && f.endsWith('.md'))
    .map((f) => join(repoRoot, f));
  if (existsSync(privateDoc)) docs.push(privateDoc);
  return docs;
}

/**
 * Engine modules a doc cites, however it spells the citation.
 *
 * Scoped to `src/core/engine/rv-*.ts` on purpose. The guides are full of
 * illustrative paths that are meant NOT to exist (`src/plugins/my-plugin.ts`,
 * `src/behaviors/MyMachine.ts`), so a repo-wide path check is noise. The engine
 * modules are the ones plans delete wholesale, and they are always written out
 * in full — that is the drift this catches.
 */
function citedEngineModules(text: string): string[] {
  const out = new Set<string>();
  const re = /(?:^|[\s`(\[|])(src\/core\/engine\/rv-[A-Za-z0-9_.-]+\.(?:ts|tsx))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    // `rv-my-component.ts` and friends are worked examples, not modules.
    if (!/\bmy-/.test(m[1])) out.add(m[1]);
  }
  return [...out];
}

describe('architecture docs do not drift from the code (plan-754)', () => {
  it('every engine module the docs cite exists', () => {
    const missing: string[] = [];
    for (const doc of architectureDocs()) {
      const text = readFileSync(doc, 'utf8');
      for (const p of citedEngineModules(text)) {
        // Private-repo docs cite the public repo through a `../` hop.
        const candidates = [
          join(repoRoot, p),
          resolve(dirname(doc), p),
          resolve(dirname(doc), '..', 'realvirtual-WebViewer~', p),
        ];
        if (!candidates.some(existsSync)) missing.push(`${doc.replace(repoRoot, '.')}: ${p}`);
      }
    }
    expect(missing, 'docs cite engine modules that do not exist').toEqual([]);
  });

  it('deleted concepts appear only in paragraphs marked as history', () => {
    const offenders: string[] = [];
    for (const doc of architectureDocs()) {
      const lines = readFileSync(doc, 'utf8').split(/\r?\n/);
      // Paragraph = contiguous run of non-blank lines. A table is one paragraph,
      // which is what we want: its header row can carry the marker.
      let start = 0;
      while (start < lines.length) {
        if (lines[start].trim() === '') { start++; continue; }
        let end = start;
        while (end < lines.length && lines[end].trim() !== '') end++;
        const paragraph = lines.slice(start, end);
        const isHistory = paragraph.some((l) => HISTORY_MARKERS.some((h) => l.includes(h)));
        if (!isHistory) {
          paragraph.forEach((line, k) => {
            for (const id of DELETED_IDENTIFIERS) {
              if (line.includes(id)) {
                offenders.push(`${doc.replace(repoRoot, '.')}:${start + k + 1}: "${id}" — ${line.trim().slice(0, 100)}`);
              }
            }
          });
        }
        start = end;
      }
    }
    expect(offenders, 'a deleted concept is described as if it still existed').toEqual([]);
  });

  it('the deleted identifiers really are gone from src/ (the list stays honest)', () => {
    // A tripwire is worthless once it guards something that came back. Only the
    // module and symbol names are checked — `src` comments may discuss history.
    const modules = DELETED_IDENTIFIERS.filter((id) => id.startsWith('rv-'));
    const resurrected = modules.filter((m) => existsSync(join(repoRoot, 'src', 'core', 'engine', `${m}.ts`)));
    expect(resurrected, 'DELETED_IDENTIFIERS lists a module that exists again').toEqual([]);
  });

  it('the Static mesh batching switch is gone from the Visual tab (plan-757 Phase 3 commit A)', () => {
    // A switch that came back would hand every user an unbaked runtime again —
    // the exact thing D7 deletes.
    const source = readFileSync(VISUAL_TAB, 'utf8');
    expect(source, 'VisualTab.tsx offers the loader-bake switch again').not.toContain('label="Static mesh batching"');
    expect(source, 'VisualTab.tsx writes the static-merge override again').not.toContain('STATIC_MERGE_LS_KEY');
    expect(source, 'VisualTab.tsx reads the static-merge flag again').not.toContain('isStaticMeshMergingEnabled');
  });

  it('the unbaked runtime stays deleted: no override gate, no runtime re-parent pass, no home-pose mode (plan-757 Phase 3 commit B)', () => {
    expect(existsSync(join(repoRoot, 'src', 'core', 'engine', 'rv-static-merge-flag.ts')), 'rv-static-merge-flag.ts is back').toBe(false);
    const loader = readFileSync(LOADER, 'utf8');
    const viewer = readFileSync(VIEWER, 'utf8');
    for (const id of ['isStaticMeshMergingEnabled', 'rv-webviewer-static-merge\'', 'restoreDriveHomePose', 'DriveHomePoseMode', 'applyKinematicParenting(', 'skipReparent']) {
      expect(loader, `rv-scene-loader.ts spells "${id}" as code again`).not.toContain(id);
      expect(viewer, `rv-viewer.ts spells "${id}" as code again`).not.toContain(id);
    }
    // The destructive gate reads the authoring flag and the registry — nothing else.
    expect(loader).toMatch(/const destructivePipeline = !preserveHierarchy\r?\n\s+&& !!options\?\.bakeRegistry/);
  });
});
