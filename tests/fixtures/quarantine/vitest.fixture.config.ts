// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Fixture config of tests/quarantine.node.test.ts (plan-602 § 9.5): real vitest child runs
 * of the quarantine fixtures in Node. Never part of a suite — the browser suite excludes
 * `tests/fixtures/quarantine/**` and the node config only takes `*.node.test.ts`.
 * No globalSetup: the parent node run already holds the machine-wide test lock.
 */
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    name: 'quarantine-fixture',
    root: here,
    include: ['*.test.ts'],
    environment: 'node',
    pool: 'forks',
  },
});
