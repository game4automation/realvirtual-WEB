// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * standard-delivery-two-projects — one HTTP deploy root, two projects
 * (plan-737 F5 / test 9.6).
 *
 * A STANDARD customer's delivery is the only channel that carries both halves
 * at once: the vendor-generated root manifest, which is that customer's own
 * (still empty) project, and `demo-realvirtual/` beside it. The dashboard has
 * to list both, the customer's own must be the one that OPENS, and the demo
 * must stay a read-only HTTP carrier rather than becoming the active project.
 *
 * ## What this file pins, and what it deliberately does not
 *
 * The store has no `listProjects()` — the plan's sketch assumed one. Rows are
 * composed in `ProjectsDashboardHost.projectRows`, which is React, so the two
 * halves are pinned where each actually lives:
 *
 *  - everything the STORE decides (which backend is active, which manifest it
 *    is paired with, what each project's documents resolve to) is asserted
 *    against the real `resolveActiveProject()` chain;
 *  - the row-composition RULE is mirrored here as `rowIds()`, in the same shape
 *    the host applies it. A mirror cannot catch the host drifting away from it,
 *    so it asserts the one property that would silently regress: the demo row
 *    is synthesised even though `discoverWorkspaceProjects()` can never find it
 *    on an HTTP install, and the open root project is added beside it rather
 *    than instead of it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectStore, resetProjectStore } from '../src/core/project/project-store';
import {
  BundledBackend,
  DEMO_BASE_PATH,
  DEMO_PROJECT_ID,
  DEMO_PROJECT_NAME,
} from '../src/core/project/backends/bundled-backend';

const DEMO_MANIFEST = {
  schemaVersion: 2,
  id: DEMO_PROJECT_ID,
  name: DEMO_PROJECT_NAME,
  canonicalName: 'demorealvirtual',
  kind: 'demo',
  settings: { defaultModel: 'DemoRealvirtualWeb.glb' },
  documents: [{ id: 'doc_demo', name: 'Web Demo', path: 'DemoRealvirtualWeb.glb' }],
};

/**
 * Exactly what `writeGeneratedDeliveryManifest()` emits since plan-737: the
 * customer's OWN project, declaring nothing, because they have authored
 * nothing yet. The demo is no longer smuggled in here as a reference-model row.
 */
const GENERATED_DELIVERY_MANIFEST = {
  schemaVersion: 2,
  id: 'prj_delivery_standard',
  name: 'ACME',
  canonicalName: 'acme',
  kind: 'delivery',
  settings: {},
  documents: [],
};

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

/** The shape of a standard delivery's deploy root: generated manifest + demo folder. */
function standardDelivery() {
  const fetchImpl = routes({
    '/project.json': GENERATED_DELIVERY_MANIFEST,
    '/demo-realvirtual/project.json': DEMO_MANIFEST,
  });
  return {
    bundledBackend: new BundledBackend({ baseUrl: '/', basePath: DEMO_BASE_PATH, fetchImpl }),
    rootBackend: new BundledBackend({ baseUrl: '/', fetchImpl }),
  };
}

const RESOLVE_OPTS = { workspaceDefault: false, migrateScenes: false } as const;

/**
 * `ProjectsDashboardHost.projectRows`, reduced to the ids it produces.
 *
 * The two rules that matter for this channel: the demo row is synthesised
 * unless an on-disk project already IS the demo, and the open project is
 * prepended when no row carries its id yet.
 */
function rowIds(open: { id: string; name: string } | null, onDisk: Array<{ id: string; name: string }>): string[] {
  const demoOnDisk = onDisk.some(p => p.id === DEMO_PROJECT_ID || p.name === DEMO_PROJECT_NAME);
  const rows = [
    ...(demoOnDisk ? [] : [DEMO_PROJECT_ID]),
    ...onDisk.map(p => p.id),
  ];
  if (open && !rows.includes(open.id)) rows.unshift(open.id);
  return rows;
}

describe('standard delivery: root customer project AND the demo (plan-737 F5)', () => {
  beforeEach(() => { resetProjectStore(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('opens the CUSTOMER project, not the demo', async () => {
    // Ordering, stated as a test: a deploy that carries both is a customer's
    // deploy, and their own project is the answer. The demo branch sits after
    // the root branch in `resolveActiveProject()` precisely for this case.
    const store = new ProjectStore();
    const resolved = await store.resolveActiveProject({ ...RESOLVE_OPTS, ...standardDelivery() });

    expect(resolved.project?.id).toBe('prj_delivery_standard');
    expect((resolved.backend as BundledBackend).basePath).toBe('');
  });

  it('keeps the demo readable beside it, from its own folder', async () => {
    // The second project is not "also open" — the store stays single-active by
    // design. It is READABLE, which is all a second row in the list needs.
    const b = standardDelivery();
    const store = new ProjectStore();
    await store.resolveActiveProject({ ...RESOLVE_OPTS, ...b });

    const demo = await b.bundledBackend.readManifest();
    expect(demo?.id).toBe(DEMO_PROJECT_ID);
    expect(b.bundledBackend.writable).toBe(false);
  });

  it('resolves each project against ITS OWN root — the pairing, end to end', async () => {
    // The failure this whole split exists to prevent, in one pair of
    // assertions: a demo document must never be addressed at the deploy root,
    // and a customer document must never be addressed inside the demo folder.
    const b = standardDelivery();
    const demoDoc = await b.bundledBackend.readDocumentUrl({ path: 'DemoRealvirtualWeb.glb' });
    const rootDoc = await b.rootBackend.readDocumentUrl({ path: 'models/Line4.glb' });

    expect(demoDoc?.url).toBe('/demo-realvirtual/DemoRealvirtualWeb.glb');
    expect(rootDoc?.url).toBe('/models/Line4.glb');
  });

  it('both projects have a row: the open customer one and the synthetic demo one', () => {
    // An HTTP install discovers NO workspace projects — there is no folder
    // handle — so without the synthetic row the demo would be delivered,
    // present and completely invisible.
    const ids = rowIds({ id: 'prj_delivery_standard', name: 'ACME' }, []);
    expect(ids).toEqual(['prj_delivery_standard', DEMO_PROJECT_ID]);
  });

  it('does not list the demo twice when it is also on disk', () => {
    // The development-customer shape: `projects/demo-realvirtual/` is a real
    // folder there, so the on-disk row wins and the synthetic one stands down.
    const ids = rowIds(
      { id: 'prj_delivery_standard', name: 'ACME' },
      [{ id: DEMO_PROJECT_ID, name: DEMO_PROJECT_NAME }],
    );
    expect(ids).toEqual(['prj_delivery_standard', DEMO_PROJECT_ID]);
    expect(ids.filter(id => id === DEMO_PROJECT_ID)).toHaveLength(1);
  });
});
