// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Emits the public editions data `features.json` into the build output (plan-646 Phase 2).
 *
 * The file is produced BEFORE the build by `scripts/gen-features-json.mjs` (canonical tree,
 * original manifest) and staged as `generated/features.json`. This plugin only copies it: no
 * catalog, no manifest, no imports beyond node:fs. Without the file (Community clone, plain
 * dev build) it emits nothing and says nothing.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const FEATURES_JSON_SOURCE = 'generated/features.json';
export const FEATURES_JSON_OUTPUT = 'features.json';

//! Vite plugin: copies `<rootDir>/generated/features.json` to `dist/features.json` when present.
export function featuresJsonPlugin(rootDir) {
  const source = join(rootDir, FEATURES_JSON_SOURCE);
  return {
    name: 'rv-features-json',
    apply: 'build',
    generateBundle() {
      if (!existsSync(source)) return;
      this.emitFile({ type: 'asset', fileName: FEATURES_JSON_OUTPUT, source: readFileSync(source) });
    },
  };
}
