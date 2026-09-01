// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * vite.embed.config.ts — rv-embed library build (plan-326).
 *
 * ESM lib-mode build of the embed entry (`src/embed/index.ts`) into
 * `dist-embed/` (own output dir — no collision with `dist/` and the
 * bundle-chunk.node.test.ts that runs against it).
 *
 * Hard rules (plan 3.1 P.3):
 *  - NO `inlineDynamicImports`, ESM format only — the dynamic-import chunk
 *    boundary of `src/core/engine/materials/material-factory.ts` MUST survive
 *    so `three/webgpu`/`three/tsl` never land in the entry chunk.
 *  - `@rv-private` resolves to the public stubs (public-tier semantics).
 *    AP4 additionally routes this build through stageFilteredSourceTree +
 *    VITE_PUBLIC_BUILD before anything is deployed — the alias here is the
 *    spike-level equivalent, NOT the final private-leak gate.
 *  - AGPL + corresponding-source banner baked into every emitted chunk.
 *
 * Build:  npx vite build --config vite.embed.config.ts
 */

import { defineConfig } from 'vite';
import {
  existsSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
// @ts-expect-error — plain JavaScript workspace helper has no declaration file.
import { stageFilteredSourceTree } from './scripts/_workspace-lib.mjs';

const SOURCE_ROOT = __dirname;
const PRIVATE_ROOT = resolve(SOURCE_ROOT, '..', 'realvirtual-WebViewer-Private~');
// The staging root must be a REAL path: the community precheck stages the
// tracked tree into a temp dir whose node_modules is a symlink back into the
// primary checkout. Vite/Rollup resolve importers through realpath, so a
// symlink-spelled staging root would mix two spellings of the same tree and
// dynamic imports (the model-plugin glob) fail to resolve.
const FILTERED_STAGE_ROOT = join(
  realpathSync(resolve(SOURCE_ROOT, 'node_modules')),
  '.cache/rv-embed-filtered-stage',
);

// This is a public CDN artifact. Set the public build flag before any source is
// resolved, then build exclusively from the allowlisted staged core tree.
process.env.VITE_PUBLIC_BUILD = '1';
rmSync(FILTERED_STAGE_ROOT, { recursive: true, force: true });
const staged = stageFilteredSourceTree({
  coreRoot: SOURCE_ROOT,
  privateRoot: PRIVATE_ROOT,
  profile: { tier: 'core', restrictedFeatures: [] },
  // A stable staging path keeps Rollup chunk hashes reproducible. The default
  // mkdtemp path would make module IDs (and therefore file hashes) vary per run.
  destinationRoot: FILTERED_STAGE_ROOT,
});
const BUILD_ROOT = staged.coreRoot;
const stagedNodeModules = resolve(BUILD_ROOT, 'node_modules');
if (!existsSync(stagedNodeModules)) {
  symlinkSync(
    realpathSync(resolve(SOURCE_ROOT, 'node_modules')),
    stagedNodeModules,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
}

let stageCleaned = false;
function cleanupFilteredStage(): void {
  if (stageCleaned) return;
  stageCleaned = true;
  rmSync(staged.workspaceRoot, { recursive: true, force: true });
}

function filteredStageCleanupPlugin() {
  return {
    name: 'rv-embed-filtered-stage-cleanup',
    buildEnd(error?: Error) {
      if (error) cleanupFilteredStage();
    },
    closeBundle() {
      cleanupFilteredStage();
    },
  };
}

const RV_VERSION = JSON.parse(
  readFileSync(resolve(SOURCE_ROOT, 'package.json'), 'utf-8'),
).version as string;

/** AGPL compliance: corresponding source of the embedded AGPL engine build.
 *  The public GitHub mirror is an unfiltered 1:1 mirror of `main`, so as long
 *  as `src/embed/` + this config live in `main` the source is fully public. */
const RV_SOURCE_URL = 'https://github.com/game4automation/realvirtual-WEB';

// `/*!` + `@license` marks the banner as a legal comment — esbuild's minifier
// strips plain comments during renderChunk, which would silently delete the
// AGPL/corresponding-source header (verified in the first AP1 build).
const BANNER =
  `/*! @license rv-embed v${RV_VERSION} | realvirtual WEB | AGPL-3.0-only | ` +
  `Copyright (C) 2026 realvirtual GmbH | https://realvirtual.io | ` +
  `Corresponding Source: ${RV_SOURCE_URL} */`;

const DRACO_FILES = [
  'draco_decoder.js',
  'draco_decoder.wasm',
  'draco_wasm_wrapper.js',
] as const;

/**
 * Emit only the decoder required by the AP3 Draco vignette. `publicDir: false`
 * remains intentional: copying all of public/ previously produced 282 MB.
 */
function embedDracoDecoderPlugin() {
  const sourceDir = resolve(SOURCE_ROOT, 'node_modules/three/examples/jsm/libs/draco/gltf');
  return {
    name: 'rv-embed-draco-decoder',
    apply: 'build' as const,
    generateBundle(this: {
      emitFile: (asset: {
        type: 'asset';
        fileName: string;
        source: Buffer;
      }) => void;
    }) {
      for (const name of DRACO_FILES) {
        const sourcePath = join(sourceDir, name);
        if (!existsSync(sourcePath)) {
          throw new Error(`[rv-embed-draco-decoder] missing required decoder: ${sourcePath}`);
        }
        this.emitFile({
          type: 'asset',
          fileName: `draco/${name}`,
          source: readFileSync(sourcePath),
        });
      }
    },
  };
}

/**
 * Copy only the public embed payload from the tier-filtered tree. The library
 * build intentionally keeps `publicDir: false`, so no unrelated public assets
 * can enter the CDN artifact.
 */
function embedPublicAssetsPlugin() {
  const assets = [
    ['public/embed/vignettes/conveyor-sensor.glb', 'vignettes/conveyor-sensor.glb'],
    ['public/embed/test/index.html', 'test/index.html'],
    ['public/embed/test/poster.svg', 'test/poster.svg'],
  ] as const;
  return {
    name: 'rv-embed-public-assets',
    apply: 'build' as const,
    generateBundle(this: {
      emitFile: (asset: {
        type: 'asset';
        fileName: string;
        source: Buffer;
      }) => void;
    }) {
      for (const [sourceName, outputName] of assets) {
        const sourcePath = resolve(BUILD_ROOT, sourceName);
        if (!existsSync(sourcePath)) {
          throw new Error(`[rv-embed-public-assets] missing required asset: ${sourcePath}`);
        }
        this.emitFile({
          type: 'asset',
          fileName: outputName,
          source: readFileSync(sourcePath),
        });
      }
    },
  };
}

export default defineConfig({
  root: BUILD_ROOT,
  base: './',
  plugins: [
    embedDracoDecoderPlugin(),
    embedPublicAssetsPlugin(),
    filteredStageCleanupPlugin(),
  ],
  // Do NOT copy public/ (models, presets, pdf worker, …) into the lib output —
  // the first AP1 build produced a 282 MB dist-embed/ this way. The embed
  // build ships ONLY the JS artefacts (+ later: decoder files, AP3/AP4).
  publicDir: false,
  resolve: {
    dedupe: ['three'],
    alias: {
      '@rv': resolve(BUILD_ROOT, 'src'),
      // Public-tier semantics: private imports resolve to stubs.
      '@rv-private': resolve(BUILD_ROOT, 'src/private-stubs'),
      '@rv-projects': resolve(BUILD_ROOT, 'src/private-stubs/projects'),
    },
  },
  define: {
    // Engine closure does not reference the __RV_* flags today (verified in
    // AP1), but define them anyway so a future engine-side gate cannot break
    // the lib build silently.
    __RV_HAS_PRIVATE__: 'false',
    // Drops the model-plugin glob: its lazy chunks would otherwise be emitted
    // into dist-embed, React and all (plan-326 AP1 guard).
    __RV_EMBED__: 'true',
    __RV_INTERNAL__: 'false',
    __RV_COMMERCIAL__: 'false',
    __RV_VERSION__: JSON.stringify(RV_VERSION),
    // Dev-server session badge gate — always off here: the embed build is a
    // library artifact, never a dev server.
    __RV_SERVE_INFO__: 'null',
  },
  // Same as the main config: worker sub-builds (e.g. the signature-verify
  // worker in rv-sig-verify.ts) code-split and thus require the ES format.
  worker: {
    format: 'es',
  },
  build: {
    target: 'esnext',
    outDir: resolve(SOURCE_ROOT, 'dist-embed'),
    emptyOutDir: true,
    sourcemap: false,
    lib: {
      entry: resolve(BUILD_ROOT, 'src/embed/index.ts'),
      formats: ['es'],
      fileName: () => 'rv-embed.js',
    },
    rollupOptions: {
      output: {
        banner: BANNER,
        // Explicitly NOT set: inlineDynamicImports. The ESM lib build keeps
        // the material-factory dynamic-import boundary as separate chunks.
        chunkFileNames: 'chunks/[name]-[hash].js',
      },
    },
  },
});
