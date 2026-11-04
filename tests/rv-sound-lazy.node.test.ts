// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2019 §9.3 — the audio path is LAZY.
 *
 * The component (`rv-sound.ts`) and the slim SoundSystem plugin are in the
 * static entry graph of `src/main.ts`; nothing of `src/core/audio/` (context,
 * voice pool, synthesis, sampler) is — it is loaded by the plugin's dynamic
 * `import()` on the first activation only.
 *
 * Fix round 1 (#2): the ONE eager audio piece is the tiny context starter
 * `src/core/rv-audio-context.ts` — the context must be created and resumed inside
 * the user gesture, which cannot wait for a chunk. It imports nothing.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dynamicSpecifiers, eagerGraphPaths, REPO_ROOT as ROOT } from './helpers/static-import-graph';

describe('drive sounds: lazy audio path (plan-2019 9.3)', () => {
  const graph = eagerGraphPaths(resolve(ROOT, 'src/main.ts'));

  it('walks a real graph', () => {
    expect(graph.length).toBeGreaterThan(100);
  });

  it('the Sound component and the SoundSystem plugin are eager', () => {
    expect(graph.some((f) => f.endsWith('src/core/engine/rv-sound.ts'))).toBe(true);
    expect(graph.some((f) => f.endsWith('src/plugins/sound-system-plugin.ts'))).toBe(true);
  });

  it('no file of src/core/audio/ is in the entry graph', () => {
    expect(graph.filter((f) => f.includes('/src/core/audio/'))).toEqual([]);
  });

  it('only the tiny context starter is eager: no imports, small (fix-1 #2)', () => {
    expect(graph.some((f) => f.endsWith('src/core/rv-audio-context.ts'))).toBe(true);
    const src = readFileSync(resolve(ROOT, 'src/core/rv-audio-context.ts'), 'utf8');
    expect(/^\s*import\s/m.test(src)).toBe(false);
    expect(Buffer.byteLength(src, 'utf8')).toBeLessThan(8000);
  });

  it('the plugin reaches the engine through a dynamic import', () => {
    const src = readFileSync(resolve(ROOT, 'src/plugins/sound-system-plugin.ts'), 'utf8');
    expect(dynamicSpecifiers(src)).toContain('../core/audio/rv-audio-engine');
  });
});
