// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Separate vitest config for Node-environment tests.
 *
 * Use case: tests that need Node-only APIs (fs, glob, ESLint instance) and
 * thus cannot run in the Playwright browser-mode used by the default config.
 *
 * Convention: file extension `*.node.test.ts` (vs `*.test.ts` for browser tests).
 *
 * Invocation: `npm run test:node` (see package.json).
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defaultExclude, defineConfig } from 'vitest/config';

// Same @rv-private convention as vite.config.ts: resolve to the private repo
// when present, otherwise to the public stubs (plan-237 — the onshape-url
// node test imports from @rv-private).
const PRIVATE_DIR = [
  resolve(__dirname, '../realvirtual-WebViewer-Private~/src'),
  resolve(__dirname, '../realvirtual-web-pro/src'),
].find((candidate) => existsSync(candidate)) ?? resolve(__dirname, '../realvirtual-WebViewer-Private~/src');
const HAS_PRIVATE = existsSync(PRIVATE_DIR);

// COMMUNITY edition (no private sibling): tests that import private modules can
// never resolve them, so they are excluded here. The list is generated — see
// scripts/gen-private-test-excludes.mjs; the guard test
// tests/private-test-excludes.node.test.ts fails when it drifts.
const PRIVATE_DEPENDENT_TESTS: string[] = HAS_PRIVATE
  ? []
  : JSON.parse(readFileSync(resolve(__dirname, 'tests/private-dependent-tests.json'), 'utf8'));

export default defineConfig({
  // Same build-time flag vite.config.ts defines for the app bundle: node tests
  // that (transitively) import rv-model-plugin-manager need it resolved too.
  define: {
    __RV_HAS_PRIVATE__: JSON.stringify(HAS_PRIVATE),
    __RV_EMBED__: 'false',
  },
  resolve: {
    alias: {
      '@rv': resolve(__dirname, 'src'),
      '@rv-private': HAS_PRIVATE ? PRIVATE_DIR : resolve(__dirname, 'src/private-stubs'),
    },
  },
  test: {
    name: 'node',
    environment: 'node',
    // Internal ops tooling (Forgejo hub onboarding, CONNECT fetch, Influx
    // provisioning) lives in the private sibling repo so it never reaches the
    // public AGPL remote. Its tests run here when that repo is present; the
    // glob simply matches nothing in a public-only checkout.
    include: ['tests/**/*.node.test.ts', '../realvirtual-WebViewer-Private~/tests/**/*.node.test.ts'],
    exclude: [...defaultExclude, ...PRIVATE_DEPENDENT_TESTS],
    pool: 'forks',
  },
});
