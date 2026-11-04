// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * gen-feature-chunks.mjs — the build table `dist/feature-chunks.json` (plan-652).
 *
 * For every feature adapter / body chunk (`src/features/<id>.register.ts` or
 * `<id>.body.ts`) it lists the JS files a first activation fetches and their
 * bytes: the chunk itself plus every chunk it statically imports, MINUS what
 * the entry already loaded. The table feeds the byte column of the `[feature]`
 * console line and DevTools (Safari reports no cross-origin Resource-Timing
 * bytes), the prefetch URLs (Phase 4) and the bundle guard.
 *
 * Pure: `featureChunksFromBundle()` takes a plain chunk list, so a test runs it
 * on a fixture. The Vite plugin `rvFeatureChunksPlugin()` feeds it the Rollup
 * bundle in `generateBundle` and emits the JSON — no `build.manifest`, so no
 * `.vite/` folder lands in a deployed `dist/` (plan deviation, 2026-10-21).
 */

const FEATURE_FACADE = /[\\/]features[\\/]([a-z0-9][a-z0-9-]*)\.(register|body)\.tsx?$/;

/**
 * @typedef {{ fileName: string, isEntry: boolean, facadeModuleId: string | null,
 *             imports: string[], bytes: number }} PlainChunk
 */

//! Returns the feature id of a chunk facade (`…/features/des.body.ts` → `des`), or null.
export function featureIdOf(facadeModuleId) {
  const m = typeof facadeModuleId === 'string' ? FEATURE_FACADE.exec(facadeModuleId) : null;
  return m ? m[1] : null;
}

/**
 * Builds `{ <featureId>: { files, bytes } }` from a plain chunk list.
 * @param {PlainChunk[]} chunks
 */
export function featureChunksFromBundle(chunks) {
  const byFile = new Map(chunks.map((c) => [c.fileName, c]));
  const closure = (start) => {
    const seen = new Set();
    const stack = [start];
    while (stack.length) {
      const file = stack.pop();
      if (seen.has(file) || !byFile.has(file)) continue;
      seen.add(file);
      for (const dep of byFile.get(file).imports) stack.push(dep);
    }
    return seen;
  };
  const entryLoaded = new Set();
  for (const c of chunks) if (c.isEntry) for (const f of closure(c.fileName)) entryLoaded.add(f);

  /** @type {Record<string, { files: string[], bytes: number }>} */
  const table = {};
  for (const c of chunks) {
    const id = featureIdOf(c.facadeModuleId);
    if (!id || c.isEntry) continue;
    const row = table[id] ?? (table[id] = { files: [], bytes: 0 });
    for (const file of closure(c.fileName)) {
      if (entryLoaded.has(file) || row.files.includes(file)) continue;
      row.files.push(file);
      row.bytes += byFile.get(file).bytes;
    }
  }
  for (const row of Object.values(table)) row.files.sort();
  return Object.fromEntries(Object.entries(table).sort(([a], [b]) => a.localeCompare(b)));
}

//! Vite plugin: emits `feature-chunks.json` next to `index.html` in every production build.
export function rvFeatureChunksPlugin() {
  return {
    name: 'rv-feature-chunks',
    apply: 'build',
    generateBundle(_options, bundle) {
      const chunks = Object.values(bundle)
        .filter((item) => item.type === 'chunk')
        .map((c) => ({
          fileName: c.fileName,
          isEntry: !!c.isEntry,
          facadeModuleId: c.facadeModuleId ?? null,
          imports: [...(c.imports ?? [])],
          bytes: Buffer.byteLength(c.code ?? '', 'utf8'),
        }));
      this.emitFile({
        type: 'asset',
        fileName: 'feature-chunks.json',
        source: `${JSON.stringify(featureChunksFromBundle(chunks), null, 2)}\n`,
      });
    },
  };
}
