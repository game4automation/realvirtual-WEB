// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * connect-update-reasons.node.test.ts — T17 of plan-343, the half that spans two languages.
 *
 * The gateway reports failures as machine-readable tokens from a closed set (`UpdateReasons.All` in
 * `UpdateStateModel.cs`) and the viewer turns each into exactly one sentence. Both halves are tested
 * on their own side, and both would stay green if someone added a sixteenth reason in C# and no
 * sentence in TypeScript — the operator would then be shown a raw token like `pin-write-failed`,
 * which is the single thing the closed set exists to prevent.
 *
 * This test reads the C# source as the authority and requires the viewer to answer for every reason
 * it declares. It is the only place where a drift between the two is visible.
 *
 * `connect-update-store.test.ts` keeps its own literal list on purpose: it runs in the browser
 * suite, where there is no file system, and it asserts the shape of the sentences rather than the
 * completeness of the set.
 *
 * Runs in the Node environment (vitest.node.config.ts).
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CLIENT_REASONS, knownUpdateReasons, updateReasonSentence } from '@rv/core/hmi/connect-update-store';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_MODEL = resolve(
  __dirname,
  '../../realvirtual-Connect~/src/Connect/Update/UpdateStateModel.cs',
);

/**
 * The reasons the gateway can send, read out of the `UpdateReasons.All` initialiser rather than out
 * of the individual constants: `All` is what the service actually hands to the viewer, and a
 * constant missing from it is a C#-side bug that `UpdateReasonSetTests` catches on its own side.
 */
function gatewayReasons(source: string): string[] {
  const list = /All\s*\{\s*get;\s*\}\s*=\s*new\[\]\s*\{([\s\S]*?)\};/.exec(source);
  if (!list) throw new Error('UpdateReasons.All could not be located in UpdateStateModel.cs');
  const constants = new Map<string, string>();
  for (const match of source.matchAll(/public const string (\w+)\s*=\s*"([a-z0-9-]+)";/g)) {
    constants.set(match[1], match[2]);
  }
  return list[1]
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean)
    .map(name => {
      const value = constants.get(name);
      if (!value) throw new Error(`UpdateReasons.${name} has no string constant`);
      return value;
    });
}

const describeWithConnect = existsSync(STATE_MODEL) ? describe : describe.skip;

// A WebViewer-only checkout has no CONNECT sources to compare against.
describeWithConnect('the gateway reason set and the viewer sentences (plan-343 T17)', () => {
  const reasons = existsSync(STATE_MODEL) ? gatewayReasons(readFileSync(STATE_MODEL, 'utf8')) : [];

  it('reads a plausible closed set out of the C# source', () => {
    // Guards the parser itself: a regex that silently matched nothing would make every assertion
    // below vacuously true.
    expect(reasons.length).toBeGreaterThanOrEqual(15);
    expect(reasons).toContain('no-api-key');
    expect(reasons).toContain('health-timeout');
    expect(new Set(reasons).size).toBe(reasons.length);
  });

  it('gives every gateway reason exactly one sentence', () => {
    const missing = reasons.filter(reason => !knownUpdateReasons().includes(reason));
    expect(missing, `no viewer sentence for: ${missing.join(', ')}`).toEqual([]);
    for (const reason of reasons) {
      const sentence = updateReasonSentence(reason)!;
      expect(sentence, reason).toBeTruthy();
      // Never the raw token, never transport detail.
      expect(sentence, reason).not.toContain(reason);
      expect(sentence, reason).not.toMatch(/HTTP|\bstack\b|undefined/);
    }
  });

  it('carries no sentence for a token neither side can produce', () => {
    // The viewer legitimately adds its own reasons (CLIENT_REASONS) for things only it can observe.
    // Anything beyond those is a sentence for a token nothing emits any more — dead UI copy that
    // would quietly outlive the reason it was written for.
    const declared = new Set<string>([...reasons, ...Object.values(CLIENT_REASONS)]);
    const orphans = knownUpdateReasons().filter(reason => !declared.has(reason));
    expect(orphans, `viewer sentences without a source: ${orphans.join(', ')}`).toEqual([]);
  });
});
