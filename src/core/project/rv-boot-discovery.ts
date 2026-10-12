// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-boot-discovery — the boot's model catalogue, NETWORK in parallel, MERGE in
 * the old serial order (plan-598 F2).
 *
 * `main.ts` used to discover the catalogue with four awaited fetches in a row
 * (`/__api/private-models`, `models.json`, the demo project's `project.json`,
 * the CONNECT gateway's `/model/manifest`), each one only starting when the
 * previous one had answered — and the whole chain sat in front of the first
 * GLB request. The four requests are independent; only the MERGE has an order:
 *
 *   1. private project models (dev only)            — pushed
 *   2. `models.json`, when it answers                — AUTHORITATIVE: clears 1.
 *   3. the demo project's own documents              — additive, deduped by filename
 *   4. the local working folder (File System Access) — pushed
 *   5. models published to a CONNECT gateway         — additive, deduped by filename
 *
 * So {@link startBootDiscovery} starts all network reads at once and
 * {@link mergeDiscoveredEntries} folds the answers in exactly that order — which
 * makes the result independent of which response happened to arrive first
 * (`tests/boot-discovery-merge-order.test.ts`).
 *
 * The demo manifest is read THROUGH the demo backend (`BundledBackend.readManifest()`)
 * instead of a second raw `fetch` of the same file: the project resolution reads
 * that backend again later, and the backend memoises its one request, so the
 * boot fetches `demo-realvirtual/project.json` exactly once (plan-598 F3).
 */

import type { RvProject } from './rv-project-types';

/** One catalogue row, as `main.ts` keeps it. */
export interface DiscoveryEntry {
  filename: string;
  url: string;
  /** Set only for models discovered inside a private project folder (dev). */
  project?: string;
}

/** A model a CONNECT gateway reports, already canonicalised by the caller. */
export interface GatewayModelEntry {
  filename: string;
  url: string;
}

/** The raw shape CONNECT publishes on `/model/manifest` (its contract, not ours). */
export interface GatewayManifest {
  models?: Array<{ name?: string; url?: string; revision?: string }>;
}

/** The in-flight network reads of one boot. Every promise resolves; none rejects. */
export interface BootDiscoveryFetches {
  privateModels: Promise<unknown | null>;
  modelsJson: Promise<unknown | null>;
  demoManifest: Promise<RvProject | null>;
  gatewayManifest: Promise<GatewayManifest | null>;
}

export interface StartBootDiscoveryOptions {
  /** `import.meta.env.DEV` — the private-models endpoint exists only on the dev server. */
  dev: boolean;
  /** `import.meta.env.BASE_URL`. */
  baseUrl: string;
  /** Whether a CONNECT gateway can be this page's origin at all. */
  mayHaveGatewayOrigin: boolean;
  /** The demo backend's (memoised) manifest read. */
  readDemoManifest: () => Promise<RvProject | null>;
  fetchImpl?: typeof fetch;
}

/** `resp.json()` of an OK response, else null. Never throws. */
async function jsonOrNull(fetchImpl: typeof fetch, url: string, init?: RequestInit): Promise<unknown | null> {
  try {
    const resp = await fetchImpl(url, init);
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

/**
 * Start every discovery request NOW. Nothing is merged here — see
 * {@link mergeDiscoveredEntries}. Request options are the ones `main.ts` used.
 */
export function startBootDiscovery(opts: StartBootDiscoveryOptions): BootDiscoveryFetches {
  const f = opts.fetchImpl ?? fetch.bind(globalThis);
  return {
    privateModels: opts.dev ? jsonOrNull(f, '/__api/private-models') : Promise.resolve(null),
    modelsJson: jsonOrNull(f, `${opts.baseUrl}models.json`, { cache: 'no-store' }),
    demoManifest: opts.readDemoManifest().catch(() => null),
    gatewayManifest: opts.mayHaveGatewayOrigin
      ? (jsonOrNull(f, '/model/manifest', { cache: 'no-store' }) as Promise<GatewayManifest | null>)
      : Promise.resolve(null),
  };
}

export interface DiscoveryMergeInput {
  /** Answer of `/__api/private-models` (null = none / failed). */
  privateModels: unknown | null;
  /** Answer of `models.json` (null = absent / failed / not JSON). */
  modelsJson: unknown | null;
  /** `documents[]` of the demo project manifest (null = no demo folder). */
  demoDocuments: ReadonlyArray<{ path?: unknown }> | null;
  /** `<BASE_URL><DEMO_BASE_PATH>`. */
  demoBase: string;
  baseUrl: string;
  /** Local working-folder models, already turned into blob URLs. */
  localFiles: ReadonlyArray<{ filename: string; url: string }>;
  /** Gateway models, canonicalised. */
  gatewayModels: ReadonlyArray<GatewayModelEntry>;
}

const sameFile = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * Fold the discovery answers into the catalogue, in the order `main.ts` always
 * used (see the module comment). Pure — the same input gives the same list no
 * matter in which order the network delivered it.
 */
export function mergeDiscoveredEntries(input: DiscoveryMergeInput): DiscoveryEntry[] {
  const entries: DiscoveryEntry[] = [];

  // 1. Private project models (dev). `project` is carried through: every private
  //    project's models come down this one endpoint.
  if (Array.isArray(input.privateModels)) {
    for (const pm of input.privateModels as Array<{ project: string; filename: string; url: string }>) {
      entries.push({ filename: pm.filename, url: pm.url, project: pm.project });
    }
  }

  // 2. `models.json` is AUTHORITATIVE where it exists: it replaces what was found.
  if (input.modelsJson !== null && input.modelsJson !== undefined) {
    entries.length = 0;
    if (Array.isArray(input.modelsJson)) {
      for (const filename of input.modelsJson as string[]) {
        entries.push({ filename, url: `${input.baseUrl}models/${filename}` });
      }
    }
  }

  // 3. The demo project's own GLB documents — additive, after `models.json`,
  //    deduped by filename; `library/` rows are not models.
  for (const doc of input.demoDocuments ?? []) {
    const path = typeof doc?.path === 'string' ? doc.path.replace(/^\.?\//, '') : '';
    if (!path.toLowerCase().endsWith('.glb')) continue;
    if (/^library\//i.test(path)) continue;
    const filename = path.split('/').pop() ?? path;
    if (entries.some(e => sameFile(e.filename, filename))) continue;
    entries.push({ filename, url: `${input.demoBase}${path}` });
  }

  // 4. Local working folder.
  for (const f of input.localFiles) entries.push({ filename: f.filename, url: f.url });

  // 5. CONNECT gateway — deliberately last and additive.
  for (const m of input.gatewayModels) {
    if (!entries.some(e => sameFile(e.filename, m.filename))) {
      entries.push({ filename: m.filename, url: m.url });
    }
  }
  return entries;
}
