// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * demos-passthrough — the manifest states which documents the demo links open
 * (plan-744 §9.4, F8).
 *
 * The WelcomeModal used to pick them by SECTION: "the first document under
 * `models/`" for the HMI button, "the first under `scenes/`" for the planner.
 * That made a folder name part of the product's behaviour, and it answered
 * nothing at all for a project that files its documents anywhere else — which
 * the demo project does, at the deploy root.
 *
 * Three properties, and the first is the one that costs data if it breaks: a
 * field this build does not touch has to SURVIVE a save. `mergeManifest` is
 * read-modify-write over the parsed original precisely so an unknown or
 * untouched key rides through, and `demos` is now one of those keys.
 */

import { describe, it, expect } from 'vitest';
import { mergeManifest } from '../src/core/project/rv-project-storage';
import { withDerivedDocuments } from '../src/core/project/rv-project-documents';
import { projectDemos, withDerivedDocuments as withDerivedDocumentsNode }
  from '../scripts/_rv-manifest.mjs';
import type { RvProject } from '../src/core/project/rv-project-types';

const PROJECT = {
  schemaVersion: 3,
  id: 'prj_demo',
  name: 'Demo',
  demos: { hmi: 'doc_hmi', planner: 'doc_planner' },
  documents: [
    { id: 'doc_hmi', name: 'HMI', path: 'DemoRealvirtualWeb.glb' },
    { id: 'doc_planner', name: 'Planner', path: 'DemoPlanner.glb' },
  ],
} as unknown as RvProject;

describe('demos — the manifest field survives every write path', () => {
  it('rides through a save that never mentions it', () => {
    const saved = mergeManifest(PROJECT, {
      documents: [{ id: 'doc_hmi', name: 'HMI renamed', path: 'DemoRealvirtualWeb.glb' }],
    });
    expect(saved.demos).toEqual({ hmi: 'doc_hmi', planner: 'doc_planner' });
  });

  it('rides through the legacy-array derivation, browser side', () => {
    const derived = withDerivedDocuments({
      schemaVersion: 1, id: 'p', name: 'P',
      demos: { hmi: 'scn_a' },
      scenes: [{ id: 'scn_a', name: 'Cell', path: 'scenes/a.scene.glb' }],
    } as unknown as RvProject);
    expect(derived?.demos).toEqual({ hmi: 'scn_a' });
    // …and the legacy arrays are still dropped around it.
    expect((derived as unknown as { scenes?: unknown }).scenes).toBeUndefined();
  });

  it('rides through the Node twin too', () => {
    const derived = withDerivedDocumentsNode({
      schemaVersion: 1, id: 'p', name: 'P',
      demos: { hmi: 'scn_a' },
      scenes: [{ id: 'scn_a', name: 'Cell', path: 'scenes/a.scene.glb' }],
    }) as { demos?: unknown };
    expect(derived.demos).toEqual({ hmi: 'scn_a' });
  });
});

describe('projectDemos — the Node twin reads the field', () => {
  it('returns both ids when the manifest states them', () => {
    expect(projectDemos(PROJECT)).toEqual({ hmi: 'doc_hmi', planner: 'doc_planner' });
  });

  it('returns an empty object for every ordinary project', () => {
    // Which is every project but the demo one — the field is optional and
    // its absence must not be an error the delivery pipeline reports.
    expect(projectDemos({ schemaVersion: 3, id: 'p', name: 'P' })).toEqual({});
    expect(projectDemos(null)).toEqual({});
    expect(projectDemos({ demos: 'nonsense' })).toEqual({});
  });

  it('drops a half-stated field rather than passing an empty id on', () => {
    expect(projectDemos({ demos: { hmi: '  ', planner: 'doc_p' } }))
      .toEqual({ planner: 'doc_p' });
  });
});

describe('the demo deploy states its own demo documents', () => {
  it('names ids that exist in its own document list', async () => {
    // The link is only as good as the id, and an id that has drifted from the
    // manifest produces a button that opens nothing. Read the SHIPPED file —
    // over `fetch`, the way the app reads it, because Vite refuses a
    // `public/` import — so a document rename has to update both halves.
    const manifest = await (await fetch('/demo-realvirtual/project.json')).json() as {
      demos?: { hmi?: string; planner?: string };
      documents: Array<{ id: string }>;
    };
    const ids = new Set(manifest.documents.map(d => d.id));
    expect(manifest.demos?.hmi).toBeDefined();
    expect(manifest.demos?.planner).toBeDefined();
    expect(ids.has(manifest.demos!.hmi!)).toBe(true);
    expect(ids.has(manifest.demos!.planner!)).toBe(true);
  });
});
