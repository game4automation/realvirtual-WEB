// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * root-demo-semantics — "the deploy root" and "the demo" are two questions
 * (plan-737 §2.4 / test 9.7).
 *
 * Until plan-737 they were one variable, because they were one file:
 * `public/project.json` was simultaneously the demo's manifest and the deploy
 * root's. Moving the demo into `demo-realvirtual/` split them, and THREE
 * consumers of `deployedManifest`/`hasDeployedManifest` were reading the demo
 * probe to answer a question about the root:
 *
 *  (a) the F9 workspace-collision guard,
 *  (b) the root fallback branch, where backend and manifest must be paired,
 *  (c) `main.ts`'s "no project.json at the deploy root" boot diagnosis.
 *
 * The failure mode they share is silence: after the move the demo probe is true
 * on virtually every channel, so each of the three would simply have stopped
 * distinguishing anything. This file is the net under that.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectStore, resetProjectStore } from '../src/core/project/project-store';
import {
  BundledBackend,
  DEMO_BASE_PATH,
} from '../src/core/project/backends/bundled-backend';

const DEMO_MANIFEST = {
  schemaVersion: 2,
  id: 'prj_sample',
  name: 'DemoRealvirtual',
  canonicalName: 'demorealvirtual',
  kind: 'demo',
  settings: { defaultModel: 'DemoRealvirtualWeb.glb' },
  documents: [{ id: 'doc_demo', name: 'Web Demo', path: 'DemoRealvirtualWeb.glb' }],
};

/** A customer's OWN manifest at the deploy root — NOT the demo. */
const CUSTOMER_MANIFEST = {
  schemaVersion: 2,
  id: 'prj_delivery_standard',
  name: 'ACME Line 4',
  canonicalName: 'acme-line-4',
  kind: 'delivery',
  settings: { defaultModel: 'models/Line4.glb' },
  documents: [{ id: 'doc_line4', name: 'Line 4', path: 'models/Line4.glb' }],
};

/**
 * A `fetch` that serves a table of exact paths and 404s everything else.
 *
 * Keyed by the FULL url each backend composes, which is the point: it is the
 * only way to prove that the root backend asked for `/project.json` and the
 * demo backend asked for `/demo-realvirtual/project.json`.
 */
function routes(table: Record<string, unknown>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = Object.prototype.hasOwnProperty.call(table, url) ? table[url] : undefined;
    if (body === undefined) {
      return { ok: false, status: 404, json: async () => null } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  }) as typeof fetch;
}

function backends(table: Record<string, unknown>) {
  const fetchImpl = routes(table);
  return {
    bundledBackend: new BundledBackend({ baseUrl: '/', basePath: DEMO_BASE_PATH, fetchImpl }),
    rootBackend: new BundledBackend({ baseUrl: '/', fetchImpl }),
  };
}

/** Resolution with the workspace branch out of the way — this is about the root. */
const RESOLVE_OPTS = { workspaceDefault: false, migrateScenes: false } as const;

describe('root vs demo semantics (plan-737 §2.4)', () => {
  beforeEach(() => { resetProjectStore(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('(b) a root customer manifest is paired with the ROOT backend, never the demo one', async () => {
    // The consumer-2 bug in one assertion. If the fallback paired
    // `deployedManifest` (root) with `bundled` (demo), the customer's
    // `models/Line4.glb` would resolve to `/demo-realvirtual/models/Line4.glb`
    // and 404 — while everything here still looked healthy.
    const store = new ProjectStore();
    const resolved = await store.resolveActiveProject({
      ...RESOLVE_OPTS,
      ...backends({
        '/project.json': CUSTOMER_MANIFEST,
        '/demo-realvirtual/project.json': DEMO_MANIFEST,
      }),
    });

    expect(resolved.project?.id).toBe('prj_delivery_standard');
    expect((resolved.backend as BundledBackend).basePath).toBe('');
    const doc = await resolved.backend!.readDocumentUrl({ path: 'models/Line4.glb' });
    expect(doc?.url).toBe('/models/Line4.glb');
  });

  it('(a) a deploy that carries ONLY the demo folder is not treated as having a root manifest', async () => {
    // The F9 guard's condition. `hasDeployedManifest` must stay false here, or
    // the guard fires on every channel and its else-branch — the one that lets
    // a developer's workspace demo folder win — becomes unreachable.
    const store = new ProjectStore();
    const b = backends({ '/demo-realvirtual/project.json': DEMO_MANIFEST });
    const resolved = await store.resolveActiveProject({ ...RESOLVE_OPTS, ...b });

    expect(b.rootBackend.hasDeployedManifest()).toBe(false);
    expect(b.bundledBackend.hasDeployedManifest()).toBe(true);
    // …and the demo still opens: that is the hosted-demo channel.
    expect(resolved.project?.id).toBe('prj_sample');
    expect((resolved.backend as BundledBackend).basePath).toBe(DEMO_BASE_PATH);
  });

  it('(c) the boot diagnosis reads the ROOT probe, so a rootless deploy is still reported', async () => {
    // `main.ts` asks `getRootBackend().hasDeployedManifest()` for the sentence
    // "this deploy root serves no project.json". Asking the demo instance would
    // answer true on the very channel the sentence is about.
    const store = new ProjectStore();
    const b = backends({ '/demo-realvirtual/project.json': DEMO_MANIFEST });
    await store.resolveActiveProject({ ...RESOLVE_OPTS, ...b });
    expect(store.getRootBackend({ fetchImpl: routes({}) }).hasDeployedManifest()).toBe(false);
  });

  it('a deploy with neither manifest resolves no bundled project at all', async () => {
    const store = new ProjectStore();
    const resolved = await store.resolveActiveProject({ ...RESOLVE_OPTS, ...backends({}) });
    expect(resolved.project).toBeNull();
  });
});
