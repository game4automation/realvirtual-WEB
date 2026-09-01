// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * find-start-document — the one rule that turns `settings.defaultModel` into a
 * document (plan-726 F12, §9.4).
 *
 * ## Why this net exists at all
 *
 * The rule used to be written inline at two call sites and was about to be
 * written at a third. It is also about to be CONSUMED for the first time on the
 * unlocked boot — before plan-726 the `defaultModel` branch of
 * `resolveResumeTarget()` was resolved and then dropped, so a manifest whose
 * start-document reference did not match its own document paths was harmless.
 *
 * It stops being harmless the moment the branch is switched on, and five
 * delivered customer manifests are in exactly that state. The fixtures at the
 * bottom are their real shapes.
 *
 * ## What is deliberately NOT tested here
 *
 * The boot itself. `main.ts`'s `init()` has no harness — the existing "boot"
 * nets (`kiosk-mode-lock`, `rv-share-boot`) import it with `?raw` and match
 * source patterns — so F2 is covered by the E2E specs and by this unit net
 * over the decision the boot delegates to.
 */

import { describe, it, expect } from 'vitest';
import { findStartDocument } from '../src/core/project/rv-project-documents';
import type { RvDocumentEntry, RvProject } from '../src/core/project/rv-project-types';

function doc(id: string, path: string, section = 'models'): RvDocumentEntry {
  return { id, name: path.split('/').pop()!, path, section } as RvDocumentEntry;
}

function project(documents: RvDocumentEntry[], defaultModel?: string): RvProject {
  return {
    schemaVersion: 2,
    id: 'prj_test',
    name: 'Test',
    documents,
    ...(defaultModel === undefined ? {} : { settings: { defaultModel } }),
  } as unknown as RvProject;
}

const DOCS = [
  doc('doc_a', 'models/Line.glb'),
  doc('doc_b', 'models/Robot.glb'),
  doc('doc_c', 'scenes/Planner.glb', 'scenes'),
];

describe('findStartDocument — the three ways a document can be named', () => {
  it('matches an exact path', () => {
    expect(findStartDocument(DOCS, 'models/Robot.glb')?.id).toBe('doc_b');
  });

  it('matches an id', () => {
    expect(findStartDocument(DOCS, 'doc_c')?.id).toBe('doc_c');
  });

  it('matches a bare filename when exactly one document carries it', () => {
    expect(findStartDocument(DOCS, 'Robot.glb')?.id).toBe('doc_b');
  });

  it('matches a scene document by filename too — a document is a document', () => {
    expect(findStartDocument(DOCS, 'Planner.glb')?.id).toBe('doc_c');
  });
});

describe('findStartDocument — where it refuses', () => {
  it('refuses an AMBIGUOUS filename rather than guessing', () => {
    const ambiguous = [
      doc('doc_x', 'models/Line.glb'),
      doc('doc_y', 'library/Line.glb', 'library'),
    ];
    // Both are plausible and neither is right. Null falls through to the
    // caller's existing fallback; a guess would open the wrong machine.
    expect(findStartDocument(ambiguous, 'Line.glb')).toBeNull();
  });

  it('does not resolve a reference that already names a folder', () => {
    // `library/Line.glb` says where it means. Answering with `models/Line.glb`
    // would be the lenient branch overreaching.
    expect(findStartDocument([doc('doc_a', 'models/Line.glb')], 'library/Line.glb')).toBeNull();
    expect(findStartDocument([doc('doc_a', 'models/Line.glb')], 'other\\Line.glb')).toBeNull();
  });

  it('an EXACT path wins over a filename coincidence', () => {
    const both = [
      doc('doc_deep', 'library/sub/Line.glb', 'library'),
      doc('doc_exact', 'models/Line.glb'),
    ];
    expect(findStartDocument(both, 'models/Line.glb')?.id).toBe('doc_exact');
  });

  it('an exact path wins even when it is listed after an id collision', () => {
    const colliding = [
      doc('models/Line.glb', 'models/Other.glb'), // an id that LOOKS like a path
      doc('doc_real', 'models/Line.glb'),
    ];
    expect(findStartDocument(colliding, 'models/Line.glb')?.id).toBe('doc_real');
  });

  it('is null for an empty, blank, null or undefined reference', () => {
    expect(findStartDocument(DOCS, '')).toBeNull();
    expect(findStartDocument(DOCS, '   ')).toBeNull();
    expect(findStartDocument(DOCS, null)).toBeNull();
    expect(findStartDocument(DOCS, undefined)).toBeNull();
  });

  it('is null for an empty or absent project rather than throwing', () => {
    expect(findStartDocument([], 'models/Line.glb')).toBeNull();
    expect(findStartDocument(null, 'models/Line.glb')).toBeNull();
    expect(findStartDocument(undefined, 'models/Line.glb')).toBeNull();
  });
});

describe('findStartDocument accepts a manifest as well as a document list', () => {
  it('reads documents[] out of a project', () => {
    expect(findStartDocument(project(DOCS), 'models/Line.glb')?.id).toBe('doc_a');
  });
});

// ─── The regression this function exists for (plan-726 finding 1) ────────

/**
 * The five delivered manifests, reduced to the shape that matters: a
 * `settings.defaultModel` holding a BARE FILENAME against a `models/`-prefixed
 * document path. Correcting the files upstream would not have been enough —
 * the deploys already shipped carry the old value.
 */
describe('the five real customer manifest shapes still resolve', () => {
  it.each([
    ['Toray', 'ToraySlitter.glb', 'models/ToraySlitter.glb'],
    ['festo', 'FestoLine.glb', 'models/FestoLine.glb'],
    ['mauser3dhmi', 'MauserCageline30.glb', 'models/MauserCageline30.glb'],
    ['wmyb', 'WmybLine.glb', 'models/WmybLine.glb'],
    ['demo-process-industry', 'ProcessIndustry.glb', 'models/ProcessIndustry.glb'],
  ])('%s: defaultModel "%s" resolves to "%s"', (_name, defaultModel, path) => {
    const manifest = project([doc('doc_1', path)], defaultModel);
    const found = findStartDocument(manifest, manifest.settings!.defaultModel as string);
    expect(found?.path).toBe(path);
  });
});
