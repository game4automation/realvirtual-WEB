// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChildVitest } from './_child-vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const WV = resolve(HERE, '../..');
const ASSETS = join(HERE, 'fixtures/s10');

/** Same real-scene M3 browser process as S10; counts after model initialization.
 * The legacy constructor calls next() during warmup, so install spies only after
 * startDesRuntime. Handle.next() counts floating-point model outputs, not discards.
 * S10's existing comparison test separately checks the M3 and soak baselines.
 */
describe('PalletYard default model draws', () => {
  it('uses zero RNG draws during the S10 M3 run', () => {
    const manifest = JSON.parse(readFileSync(join(ASSETS, 's10-manifest.json'), 'utf8')) as {
      m3: { script: string; config: string; scriptPathPrefix: string };
    };
    let script = readFileSync(resolve(ASSETS, manifest.m3.script), 'utf8');
    const config = readFileSync(resolve(ASSETS, manifest.m3.config), 'utf8');
    const imports = "import { describe, expect, it } from 'vitest';";
    const initialized = '    const rt = startDesRuntime(r.backend, () => {});';
    const finished = '    const c = rt.counters;';
    // A changed fixture must fail visibly rather than silently losing the spies.
    for (const anchor of [imports, initialized, finished]) expect(script).toContain(anchor);
    script = script.replace(imports, `import { describe, expect, it, vi } from 'vitest';
import { SFC32Legacy } from '__PUBLIC_ROOT__/src/core/rv-rng-distribution';
import { RngStreamHandle } from '__PUBLIC_ROOT__/src/core/rv-rng-streams';`);
    script = script.replace(initialized, initialized + `
    const legacyDraws = vi.spyOn(SFC32Legacy.prototype, 'next');
    const handleDraws = vi.spyOn(RngStreamHandle.prototype, 'next');`);
    script = script.replace(finished, `    const modelDraws = legacyDraws.mock.calls.length + handleDraws.mock.calls.length;
    legacyDraws.mockRestore(); handleDraws.mockRestore();
    console.log('RNG_S10_DRAWS ' + JSON.stringify({ modelDraws }));
    expect(modelDraws).toBe(0);
` + finished);
    const dir = join(WV, 'node_modules', '.m3-rng-s10');
    mkdirSync(dir, { recursive: true });
    const rewrite = (s: string): string => s.split(manifest.m3.scriptPathPrefix).join(WV.replace(/\\/g, '/') + '/')
      .split('__PUBLIC_ROOT__').join(WV.replace(/\\/g, '/'))
      .split('node_modules/.m3').join('node_modules/.m3-rng-s10');
    const scriptPath = join(dir, 'm3-palletyard.test.ts');
    const configPath = join(dir, 'vitest.m3.config.ts');
    writeFileSync(scriptPath, rewrite(script));
    writeFileSync(configPath, rewrite(config));
    const out = runChildVitest('s10-rng-draws', ['--config', configPath, scriptPath]);
    const match = out.match(/RNG_S10_DRAWS (\{.*\})/);
    expect(match, 'child must report the model draw count').not.toBeNull();
    expect(JSON.parse(match![1])).toEqual({ modelDraws: 0 });
  }, 960_000);
});
