// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** plan-652 §9.14 — `feature-chunks.json` from a plain Rollup chunk list. */

import { describe, expect, it } from 'vitest';
import { featureChunksFromBundle, featureIdOf } from '../scripts/gen-feature-chunks.mjs';

describe('gen-feature-chunks', () => {
  it('maps feature facades to ids', () => {
    expect(featureIdOf('/w/realvirtual-web-pro/src/features/asset-editor.register.ts')).toBe('asset-editor');
    expect(featureIdOf('E:\\x\\src\\features\\des.body.ts')).toBe('des');
    expect(featureIdOf('/w/src/main.ts')).toBeNull();
    expect(featureIdOf(null)).toBeNull();
  });

  it('counts the feature chunk plus its transitive imports, minus what the entry already loads', () => {
    const table = featureChunksFromBundle([
      { fileName: 'assets/index.js', isEntry: true, facadeModuleId: '/s/src/main.ts', imports: ['assets/vendor.js'], bytes: 1000 },
      { fileName: 'assets/vendor.js', isEntry: false, facadeModuleId: null, imports: [], bytes: 500 },
      { fileName: 'assets/des.register.js', isEntry: false, facadeModuleId: '/p/src/features/des.register.ts', imports: ['assets/vendor.js', 'assets/des-core.js'], bytes: 100 },
      { fileName: 'assets/des-core.js', isEntry: false, facadeModuleId: null, imports: ['assets/shared.js'], bytes: 300 },
      { fileName: 'assets/shared.js', isEntry: false, facadeModuleId: null, imports: [], bytes: 50 },
      { fileName: 'assets/plc.register.js', isEntry: false, facadeModuleId: '/p/src/features/plc.register.ts', imports: ['assets/shared.js'], bytes: 70 },
    ]);
    expect(table).toEqual({
      des: { files: ['assets/des-core.js', 'assets/des.register.js', 'assets/shared.js'], bytes: 450 },
      plc: { files: ['assets/plc.register.js', 'assets/shared.js'], bytes: 120 },
    });
  });

  it('merges register and body chunks of one feature', () => {
    const table = featureChunksFromBundle([
      { fileName: 'a.js', isEntry: true, facadeModuleId: '/main.ts', imports: [], bytes: 1 },
      { fileName: 'ed.register.js', isEntry: false, facadeModuleId: '/features/asset-editor.register.ts', imports: [], bytes: 10 },
      { fileName: 'ed.body.js', isEntry: false, facadeModuleId: '/features/asset-editor.body.ts', imports: [], bytes: 90 },
    ]);
    expect(table['asset-editor']).toEqual({ files: ['ed.body.js', 'ed.register.js'], bytes: 100 });
  });
});
