// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-598 §9.3 — discovery runs in parallel, the catalogue does not care.
 *
 * The four discovery reads used to run one after another, which made the merge
 * order the arrival order by construction. Now they are started together; this
 * test pins that the RESULT is the old serial one no matter which answer lands
 * first: `models.json` authoritative (clears the dev private list), the demo
 * project's own GLBs additive and deduped by filename, local files after that,
 * the CONNECT gateway last, additive and deduped.
 */

import { describe, it, expect } from 'vitest';
import {
  mergeDiscoveredEntries,
  startBootDiscovery,
  type DiscoveryMergeInput,
} from '../src/core/project/rv-boot-discovery';
import type { RvProject } from '../src/core/project/rv-project-types';

const BASE = '/demo/';
const DEMO_BASE = `${BASE}demo-realvirtual/`;

/** The old main.ts code, verbatim in its logic — the reference the merge must equal. */
function serialReference(input: DiscoveryMergeInput) {
  const entries: Array<{ filename: string; url: string; project?: string }> = [];
  if (Array.isArray(input.privateModels)) {
    for (const pm of input.privateModels as Array<{ project: string; filename: string; url: string }>) {
      entries.push({ filename: pm.filename, url: pm.url, project: pm.project });
    }
  }
  if (input.modelsJson != null) {
    entries.length = 0;
    for (const filename of input.modelsJson as string[]) entries.push({ filename, url: `${input.baseUrl}models/${filename}` });
  }
  for (const doc of input.demoDocuments ?? []) {
    const path = typeof doc?.path === 'string' ? doc.path.replace(/^\.?\//, '') : '';
    if (!path.toLowerCase().endsWith('.glb')) continue;
    if (/^library\//i.test(path)) continue;
    const filename = path.split('/').pop() ?? path;
    if (entries.some(e => e.filename.toLowerCase() === filename.toLowerCase())) continue;
    entries.push({ filename, url: `${input.demoBase}${path}` });
  }
  for (const f of input.localFiles) entries.push({ filename: f.filename, url: f.url });
  for (const m of input.gatewayModels) {
    if (!entries.some((e) => e.filename.toLowerCase() === m.filename.toLowerCase())) entries.push(m);
  }
  return entries;
}

const PRIVATE = [
  { project: 'mauser3dhmi', filename: 'Mauser.glb', url: '/__private/mauser/Mauser.glb' },
  { project: 'demo-realvirtual', filename: 'Extra.glb', url: '/__private/demo/Extra.glb' },
];
const DEMO_DOCS = [
  { path: './models/DemoRealvirtualWeb.glb' },
  { path: 'models/customer.GLB' },          // case-insensitive dupe of models.json's entry
  { path: 'library/Part.glb' },             // library rows are not models
  { path: 'scenes/notes.json' },            // not a GLB
];
const GATEWAY = [
  { filename: 'demorealvirtualweb.glb', url: '/models/DemoRealvirtualWeb.glb' }, // dupe of the demo row
  { filename: 'Published.glb', url: '/models/Published.glb' },
];

function input(overrides: Partial<DiscoveryMergeInput> = {}): DiscoveryMergeInput {
  return {
    privateModels: PRIVATE,
    modelsJson: null,
    demoDocuments: DEMO_DOCS,
    demoBase: DEMO_BASE,
    baseUrl: BASE,
    localFiles: [{ filename: 'Local.glb', url: 'blob:local-1' }],
    gatewayModels: GATEWAY,
    ...overrides,
  };
}

describe('mergeDiscoveredEntries — the serial order, independent of arrival', () => {
  it('without models.json: private, demo (deduped, no library), local, gateway (deduped)', () => {
    const merged = mergeDiscoveredEntries(input());
    expect(merged).toEqual(serialReference(input()));
    expect(merged.map((e) => e.filename)).toEqual([
      'Mauser.glb', 'Extra.glb', 'DemoRealvirtualWeb.glb', 'customer.GLB', 'Local.glb', 'Published.glb',
    ]);
  });

  it('models.json is authoritative: it clears the private list, the demo stays additive', () => {
    const i = input({ modelsJson: ['Customer.glb', 'Other.glb'] });
    const merged = mergeDiscoveredEntries(i);
    expect(merged).toEqual(serialReference(i));
    expect(merged.map((e) => e.url)).toEqual([
      '/demo/models/Customer.glb', '/demo/models/Other.glb',
      '/demo/demo-realvirtual/models/DemoRealvirtualWeb.glb',
      'blob:local-1', '/models/Published.glb',
    ]);
  });

  it('the result does not depend on which network answer arrives first', async () => {
    const answers = {
      privateModels: PRIVATE,
      modelsJson: ['Customer.glb'],
      demo: { schemaVersion: 2, id: 'demo', name: 'Demo', documents: DEMO_DOCS } as unknown as RvProject,
      gateway: { models: [{ name: 'Published.glb', url: '/models/Published.glb' }] },
    };
    const delays = [[40, 0, 20, 10], [0, 40, 10, 20], [10, 20, 40, 0]];
    const results: unknown[] = [];
    for (const [dPriv, dModels, dDemo, dGw] of delays) {
      const later = <T,>(ms: number, v: T) => new Promise<T>((r) => setTimeout(() => r(v), ms));
      const fetchImpl = (async (url: RequestInfo | URL) => {
        const u = String(url);
        if (u.endsWith('/__api/private-models')) return later(dPriv!, Response.json(answers.privateModels));
        if (u.endsWith('models.json')) return later(dModels!, Response.json(answers.modelsJson));
        if (u.endsWith('/model/manifest')) return later(dGw!, Response.json(answers.gateway));
        return new Response('', { status: 404 });
      }) as typeof fetch;
      const d = startBootDiscovery({
        dev: true, baseUrl: BASE, mayHaveGatewayOrigin: true, fetchImpl,
        readDemoManifest: () => later(dDemo!, answers.demo),
      });
      const [p, m, demo, gw] = await Promise.all([d.privateModels, d.modelsJson, d.demoManifest, d.gatewayManifest]);
      results.push(mergeDiscoveredEntries({
        privateModels: p, modelsJson: m,
        demoDocuments: (demo?.documents as Array<{ path?: unknown }>) ?? null,
        demoBase: DEMO_BASE, baseUrl: BASE, localFiles: [],
        gatewayModels: (gw?.models ?? []).map((x) => ({ filename: x.name!, url: x.url! })),
      }));
    }
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
  });

  it('startBootDiscovery never rejects and skips the dev-only / gateway probes where they cannot exist', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: RequestInfo | URL) => { seen.push(String(url)); throw new TypeError('offline'); }) as typeof fetch;
    const d = startBootDiscovery({
      dev: false, baseUrl: BASE, mayHaveGatewayOrigin: false, fetchImpl,
      readDemoManifest: () => Promise.reject(new Error('cors')),
    });
    expect(await Promise.all([d.privateModels, d.modelsJson, d.demoManifest, d.gatewayManifest]))
      .toEqual([null, null, null, null]);
    expect(seen).toEqual(['/demo/models.json']);
  });
});
