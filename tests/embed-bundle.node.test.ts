// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const ROOT = resolve(import.meta.dirname, '..');
const DIST = join(ROOT, 'dist-embed');
const ENTRY = join(DIST, 'rv-embed.js');
const hasDist = existsSync(ENTRY);
const HARD_LIMIT = 2 * 1024 * 1024;
const WARNING_LIMIT = 1.6 * 1024 * 1024;
const TSL_MARKERS = ['WGSLNodeBuilder'];

function staticEntryClosure(entry: string): string[] {
  const pending = [entry];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const code = readFileSync(file, 'utf8');
    const importPattern = /(?:import|export)\s*(?:[^;'"()]*?from\s*)?["']([^"']+\.js)["']/g;
    for (const match of code.matchAll(importPattern)) {
      const specifier = match[1];
      if (specifier.startsWith('.')) pending.push(resolve(dirname(file), specifier));
    }
  }
  return [...seen];
}

describe.skipIf(!hasDist)('rv-embed production bundle', () => {
  it('keeps the static entry closure at or below 2 MiB gzip', () => {
    const files = staticEntryClosure(ENTRY);
    const gzipBytes = files.reduce(
      (total, file) => total + gzipSync(readFileSync(file), { level: 9 }).length,
      0,
    );
    if (gzipBytes > WARNING_LIMIT) {
      console.warn(
        `[rv-embed] WARNING: static entry closure is ${gzipBytes} bytes gzip `
        + `(warning threshold ${WARNING_LIMIT})`,
      );
    }
    console.info(`[rv-embed] static entry closure gzip: ${gzipBytes} bytes`);
    expect(gzipBytes).toBeLessThanOrEqual(HARD_LIMIT);
  });

  it('contains no TSL marker in the entry closure', () => {
    for (const file of staticEntryClosure(ENTRY)) {
      const code = readFileSync(file, 'utf8');
      for (const marker of TSL_MARKERS) {
        expect(code, `${file} contains forbidden TSL marker ${marker}`).not.toContain(marker);
      }
    }
  });

  it('carries the AGPL and Corresponding Source header', () => {
    const entry = readFileSync(ENTRY, 'utf8');
    expect(entry).toContain('AGPL-3.0-only');
    expect(entry).toContain('Corresponding Source:');
    expect(entry).toContain('https://github.com/game4automation/realvirtual-WEB');
  });
});
