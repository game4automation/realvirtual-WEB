// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * root-manifest-boot.test — plan-726 follow-up (F9, F14, and the boot switch).
 *
 * What a deploy-published root manifest changes inside resolveActiveProject,
 * pinned at the boot level. F11b lives in project-backend.test.ts and the F12
 * matcher in find-start-document.test.ts; the cross-project hop that lets an
 * old ?scene= link reach a workspace document is carried end-to-end by
 * e2e/scene-link-migration.spec.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LS_KEY_LAST_PROJECT,
  ProjectStore,
  resetProjectStore,
} from '../src/core/project/project-store';
import { BundledBackend, SAMPLE_PROJECT_ID } from '../src/core/project/backends/bundled-backend';
import { clearAllScenes, setDraftScope } from '../src/core/hmi/scene/rv-scene-storage';

// ─── Fixtures ───────────────────────────────────────────────────────────

/** The authored manifest, in the shape `public/project.json` actually has. */
const DEMO_MANIFEST = {
  schemaVersion: 2,
  id: 'prj_sample',
  name: 'DemoRealvirtual',
  canonicalName: 'demorealvirtual',
  kind: 'demo',
  settings: { defaultModel: 'models/DemoRealvirtualWeb.glb' },
  documents: [
    { id: 'doc_a', name: 'Web Demo', path: 'models/DemoRealvirtualWeb.glb', section: 'models' },
    { id: 'doc_b', name: 'Robot IK', path: 'models/DemoRobotIK.glb', section: 'models' },
  ],
};

/** A backend whose deploy root serves `body` as `project.json`. */
function serving(body: unknown, opts: { unparseable?: boolean } = {}): BundledBackend {
  return new BundledBackend({
    fetchImpl: (async (input: RequestInfo | URL) => {
      if (!String(input).endsWith('project.json')) {
        return { ok: false, status: 404, json: async () => null } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => {
          if (opts.unparseable) throw new SyntaxError('Unexpected token in JSON at position 0');
          return body;
        },
      } as unknown as Response;
    }) as typeof fetch,
  });
}

/** A backend whose deploy root has no manifest at all — the pre-726 world. */
function bare(): BundledBackend {
  return new BundledBackend({
    fetchImpl: (async () => (
      { ok: false, status: 404, json: async () => null } as unknown as Response
    )) as typeof fetch,
  });
}

// ─── F9 / F14: what a root manifest changes in resolveActiveProject ─────

describe('resolveActiveProject with a root manifest (F9, F14)', () => {
  let store: ProjectStore;

  beforeEach(() => {
    clearAllScenes();
    setDraftScope(null);
    localStorage.removeItem(LS_KEY_LAST_PROJECT);
    resetProjectStore();
    store = new ProjectStore();
  });

  afterEach(async () => {
    await store.closeProject();
    clearAllScenes();
    setDraftScope(null);
    localStorage.removeItem(LS_KEY_LAST_PROJECT);
  });

  it('F9: the workspace demo folder is not even consulted', async () => {
    const spy = vi.fn(async () => null);
    (store as unknown as Record<string, unknown>)._resolveWorkspaceDemoProject = spy;
    await store.resolveActiveProject({ bundledBackend: serving(DEMO_MANIFEST) });
    expect(spy).not.toHaveBeenCalled();
  });

  it('F9 control: without a root manifest it still is', async () => {
    const spy = vi.fn(async () => null);
    (store as unknown as Record<string, unknown>)._resolveWorkspaceDemoProject = spy;
    await store.resolveActiveProject({ bundledBackend: bare() });
    expect(spy).toHaveBeenCalled();
  });

  it('F14: the eager scn_ migration still runs — it did not fall out of the boot', async () => {
    const spy = vi.fn(async () => {});
    (store as unknown as Record<string, unknown>)._migrateWorkspaceScenes = spy;
    await store.resolveActiveProject({ bundledBackend: serving(DEMO_MANIFEST) });
    expect(spy).toHaveBeenCalled();
  });

  it('F14 control: migrateScenes:false still switches it off', async () => {
    const spy = vi.fn(async () => {});
    (store as unknown as Record<string, unknown>)._migrateWorkspaceScenes = spy;
    await store.resolveActiveProject({
      bundledBackend: serving(DEMO_MANIFEST),
      migrateScenes: false,
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it('DOCUMENTS THE PHASE-1 CONSEQUENCE: a served manifest becomes the active project', async () => {
    // Not a cosmetic detail. plan-716 F2 made "My Workspace" the answer to a
    // projectless boot; a root manifest takes that back, and shipping
    // `public/project.json` is therefore NOT the behaviour-neutral step the
    // plan called Phase 1 additive. Pinned here so the switch is a decision
    // somebody made, not a surprise somebody finds in production.
    const resolved = await store.resolveActiveProject({ bundledBackend: serving(DEMO_MANIFEST) });
    expect(resolved.backend.kind).toBe('bundled');
    expect(resolved.project?.id).toBe(SAMPLE_PROJECT_ID);
  });
});
