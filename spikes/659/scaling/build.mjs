// plan-659 scaling spike — bundle worker.ts to worker.cjs.
//
// A worker must boot in one `node worker.cjs`, with no ts-node/tsx in the hot
// path: process start is excluded from the measurement anyway, but a TS loader
// in each of 32 processes is pure noise. esbuild resolves the `@rv-private`
// alias the vitest config also uses, and leaves the two out-of-band native
// packages external so each process `require`s them from node_modules (keeping
// their own `__dirname` for the native binary lookup).
//
// `__dirname` note: the bundled `rv-microduck-runtime.ts` resolves FIXTURE_DIR
// from `__dirname`, which after bundling would point at THIS directory instead
// of `spikes/659`. The define below rewrites every bundled `__dirname` to the
// banner's RV_SPIKE_DIR (= the parent dir). Banners are inserted verbatim and
// are not themselves subject to `define`, so the banner's own `__dirname` is
// still the real CJS one.

import { build } from 'esbuild';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const W_ROOT = resolve(HERE, '../../..');
const PRIVATE_DIR = resolve(W_ROOT, '../realvirtual-WebViewer-Private~/src');
if (!existsSync(PRIVATE_DIR)) throw new Error(`private src not found: ${PRIVATE_DIR}`);

await build({
  entryPoints: [resolve(HERE, 'worker.ts')],
  outfile: resolve(HERE, 'worker.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: false,
  logLevel: 'info',
  external: ['@mujoco/mujoco', 'onnxruntime-node'],
  alias: {
    '@rv-private': PRIVATE_DIR,
    '@rv': resolve(W_ROOT, 'src'),
  },
  banner: {
    js: "const RV_SPIKE_DIR = require('node:path').resolve(__dirname, '..');",
  },
  define: {
    __dirname: 'RV_SPIKE_DIR',
    __RV_HAS_PRIVATE__: 'true',
    __RV_EMBED__: 'false',
  },
});
console.log('built worker.cjs');
