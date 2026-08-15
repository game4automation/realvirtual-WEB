// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-435 T10 / F9 — the drift guard.
 *
 * Every plugin implementation with an `onModelLoaded` must either
 *   (a) declare `onDeactivate`,          → a real, deliberate teardown
 *   (b) declare `onModelCleared`,        → the fallback teardown applies
 *   (c) or stand in the allow-list below with a reason.
 *
 * It fails in BOTH directions on purpose: an entry that no longer needs its
 * exemption is just as much drift as a new plugin that quietly widens the gap.
 * When it fails, the author decides — hook, Group D, or PROTECTED — instead of
 * the gap growing unnoticed.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(__dirname, '../src');

/** Every `.ts`/`.tsx` under `src/`, recursively. */
function collectSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectSources(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Interface and base classes — they declare the hooks, they do not implement them. */
const NOT_IMPLEMENTATIONS = [
  'core/rv-plugin.ts',
  'core/rv-base-plugin.ts',
  'core/rv-behavior.ts',
];

/**
 * Group D (§2.5) — the fallback genuinely has nothing to do.
 * The value is the reason, kept next to the exemption so it can be challenged.
 */
const ALLOWED_WITHOUT_TEARDOWN: Record<string, string> = {
  'plugins/camera-events-plugin.ts':
    'onModelLoaded only stores the viewer reference — no resources, no slots (Group D)',
  'plugins/models/model-option-plugin.ts':
    'One-shot application of a model option into node.userData; there is no previous state to return to (Group D)',
};

const HAS_MODEL_LOADED = /^\s*(?:override\s+|public\s+|async\s+)*onModelLoaded\s*\??\s*\(/m;
const HAS_MODEL_CLEARED = /^\s*(?:override\s+|public\s+|async\s+)*onModelCleared\s*\??\s*\(/m;
const HAS_DEACTIVATE = /^\s*(?:override\s+|public\s+|async\s+)*onDeactivate\s*\??\s*\(/m;

function relative(file: string): string {
  return file.slice(SRC.length + 1).replace(/\\/g, '/');
}

describe('plugin teardown drift guard', () => {
  const files = collectSources(SRC)
    .filter((file) => !NOT_IMPLEMENTATIONS.includes(relative(file)));

  const withModelLoaded = files
    .map((file) => ({ file: relative(file), src: readFileSync(file, 'utf8') }))
    .filter((entry) => HAS_MODEL_LOADED.test(entry.src));

  it('finds plugin implementations to check at all', () => {
    // A refactor that moves the plugins elsewhere must not silently turn this
    // guard into a no-op.
    expect(withModelLoaded.length).toBeGreaterThan(20);
  });

  it('has a teardown path for every plugin with onModelLoaded', () => {
    const offenders = withModelLoaded
      .filter((entry) => !HAS_MODEL_CLEARED.test(entry.src) && !HAS_DEACTIVATE.test(entry.src))
      .map((entry) => entry.file)
      .filter((file) => !(file in ALLOWED_WITHOUT_TEARDOWN));

    expect(offenders, [
      'These plugins define onModelLoaded but no teardown path.',
      'Add onDeactivate (preferred), add onModelCleared, or put the file in',
      'ALLOWED_WITHOUT_TEARDOWN with a reason — see plan-435 §2.5.',
    ].join(' ')).toEqual([]);
  });

  it('fails in the other direction too — no stale allow-list entries', () => {
    const stale = Object.keys(ALLOWED_WITHOUT_TEARDOWN).filter((file) => {
      const entry = withModelLoaded.find((candidate) => candidate.file === file);
      // Gone, renamed, or it has grown a teardown of its own.
      return !entry || HAS_MODEL_CLEARED.test(entry.src) || HAS_DEACTIVATE.test(entry.src);
    });

    expect(stale, 'Allow-list entries that no longer need their exemption').toEqual([]);
  });
});
