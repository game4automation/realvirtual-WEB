// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-499 §9.12 — lazy discipline of the command registry.
 *
 * Walks the STATIC import graph from `src/main.ts` (type-only imports and
 * dynamic `import()` do not count — they never put code into the entry
 * chunk) and asserts: the registry core is reachable (the open `ActionSegment`
 * is eager), the private command IMPLEMENTATIONS are not — they stay behind the
 * descriptors' `import()`. The descriptors themselves ride with their
 * consumers: the MCP bridge (itself a lazy chunk of `main.ts`) imports them
 * statically, so labels, button keys and capabilities exist before any call and
 * before the editor (measured 2026-09-26: they are not in the entry graph).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// The graph walker moved to tests/helpers/static-import-graph.ts with plan-773
// Phase 5, when the robot program export needed the same walk. One copy, so
// neither guard can drift away from what the other calls 'eager'.
import { eagerGraph, eagerGraphPaths, lfBytes, norm, REPO_ROOT as ROOT } from './helpers/static-import-graph';
import BUDGETS from './bundle-budgets.json';

describe('bundle: command registry lazy discipline', () => {
  const graph = eagerGraphPaths(resolve(ROOT, 'src/main.ts'));
  const has = (suffix: string): boolean => graph.some((f) => f.endsWith(suffix));

  it('walks a real graph', () => {
    expect(graph.length).toBeGreaterThan(100);
  });

  it('the registry core is in the entry graph; the descriptors ride with the (lazy) bridge', () => {
    expect(has('src/core/hmi/rv-command-registry.ts')).toBe(true);
    const bridge = [...eagerGraph(resolve(ROOT, 'src/plugins/mcp-bridge-plugin.ts'))].map(norm);
    expect(bridge.some((f) => f.endsWith('src/core/hmi/editor-command-descriptors.ts'))).toBe(true);
    expect(bridge.some((f) => f.includes('realvirtual-WebViewer-Private~') && f.endsWith('/asset-editor/editor-commands.ts')))
      .toBe(false);
  });

  it('the private command implementations are NOT (they stay behind import())', () => {
    expect(graph.filter((f) => f.includes('realvirtual-WebViewer-Private~') && f.endsWith('/asset-editor/editor-commands.ts')))
      .toEqual([]);
  });
});

/**
 * plan-779 — the EAGER-SOURCE RATCHET.
 *
 * ## Why this exists
 *
 * This file used to walk the whole eager graph and then assert four things about
 * ONE feature: that it has more than 100 files, and that two named modules are /
 * are not in it. It computed the number that would have caught every startup-path
 * regression of the last three months and threw it away.
 *
 * On 25.10.2026 the dist entry was 314_528 B over its budget with NO single leak:
 * four deliberately eager features, a grown schema and diffuse growth. Measured at
 * the commits that introduced them, each of the four moved the sum below by
 * +221_407, +363_333, +93_287 and +153_530 B — all of them visible WITHOUT a build,
 * in seconds, at the moment they landed, by a number this file was already computing
 * and discarding. (How well a single absolute threshold can tell such a cluster from
 * an ordinary day on this trunk is a separate question, answered honestly under
 * *Tolerance* below: not very.)
 *
 * ## What it measures, and what it does NOT
 *
 * The bytes of SOURCE statically reachable from `src/main.ts` — the same walk the
 * suite above uses, so `eager` means one thing in this file. It is deliberately not
 * a bundle measurement: no minification, no tree-shaking, no npm packages (a bare
 * specifier is not an edge). It therefore does not predict the entry chunk's size
 * and must never be confused with the `entry-chunk` pin. What it DOES track is the
 * only thing a lazy-loading rule is about: how much code the startup path can reach
 * without crossing an `import()`.
 *
 * ## WHEN THIS TEST GOES RED
 *
 * It is red because the startup path grew. There are exactly two honest answers,
 * and raising the number quietly is neither:
 *
 *  1. **Make the new code lazy.** Put it behind `import()` (a feature stub, a
 *     `lazy(() => import(...))` panel, a plugin body) so the boot path no longer
 *     reaches it. The failure message names the ten biggest files in the graph and
 *     the delta, which is usually enough to see what arrived.
 *  2. **Turn the ratchet on purpose.** If the growth is wanted in the boot path,
 *     re-pin `eager-source-graph` in `tests/bundle-budgets.json` — WITH the commit
 *     it was measured at, a note saying what grew, and `onMergeTarget: true`.
 *     `bundle-budget-provenance.node.test.ts` checks that record; a pin taken on a
 *     feature branch is refused there, for the reason that file's $note explains.
 *
 * ## Tolerance — and what it can and cannot do
 *
 * 150_153 B above the 25.10.2026 measurement (0.95 %), the number and its reasoning
 * in `tests/bundle-budgets.json`. It is ONE median day of trunk growth, not a noise
 * band, and the difference matters:
 *
 * The eager graph was measured at every first-parent commit of main between
 * 2026-10-13 and 2026-10-25 (14_068_445 -> 15_874_627 B). The twelve daily deltas are
 * 226 / 1_972 / 41_010 / 53_891 / 56_002 / 99_517 / 144_547 / 197_847 / 210_009 /
 * 214_180 / 312_794 / 474_187 B — median ~122 kB. The smallest of the four clusters
 * this guard exists for is +93_287 B. So ordinary trunk movement and a cluster are
 * the SAME SIZE on this metric, and no absolute threshold separates them: loose
 * enough for a quiet week means blind to a cluster.
 *
 * The consequence is deliberate and should not be filed as a bug: this ratchet trips
 * every few days of normal work. When it does, the startup path really has grown by
 * more than a day's worth, which is the cheapest possible moment to ask lazy-or-eager.
 * The variant that WOULD separate the two is a per-change guard — the eager sum of
 * the worktree against the eager sum of the merge-base tree, which needs no build
 * either. That is the recommended successor, not a bigger number here.
 */
describe('bundle: eager-source ratchet (plan-779)', () => {
  const PIN = BUDGETS.pins['eager-source-graph'];

  it('the eager source graph stays inside its ratchet', () => {
    const files = [...eagerGraph(resolve(ROOT, 'src/main.ts'))].sort();
    expect(files.length, 'the walk returned no graph — resolution broken, not a size result')
      .toBeGreaterThan(100);

    // LF-normalised bytes (CRLF counts as one byte), so the number is the same in a CRLF
    // worktree (core.autocrlf=true) as in the canonical LF tree. Raw on-disk sizes made this
    // test falsely red in worktrees (+2_234 B, measured 2026-11-04).
    //
    // Two independent measurements of the same quantity: the byte count of the file with
    // CRLF dropped, and the size the decoded text occupies when LF-normalised and re-encoded.
    // The oracle must not compute the way the subject does — a mistake in one path
    // (counting UTF-16 code units, say, which is the bug the dist-entry budget had
    // until 2026-08-08) shows up as a disagreement instead of as a wrong budget.
    let onDisk = 0;
    let reEncoded = 0;
    for (const f of files) {
      onDisk += lfBytes(f);
      reEncoded += new TextEncoder().encode(readFileSync(f, 'utf8').replace(/\r\n/g, '\n')).length;
    }
    expect(
      reEncoded,
      'a file in the eager graph is not valid UTF-8 (its bytes and its re-encoded text differ) — '
      + 'fix the file; this is not a size regression',
    ).toBe(onDisk);

    if (onDisk >= PIN.budgetBytes) {
      const biggest = files
        .map((f) => ({ f: norm(f).replace(/^.*?\/(realvirtual-WebViewer[^/]*\/)/, '$1'), b: lfBytes(f) }))
        .sort((a, b) => b.b - a.b)
        .slice(0, 10)
        .map((x) => `  ${String(x.b).padStart(7)}  ${x.f}`)
        .join('\n');
      throw new Error(
        `eager source graph: ${onDisk} B in ${files.length} files, budget ${PIN.budgetBytes} B `
        + `(+${onDisk - PIN.budgetBytes} B over; pinned ${PIN.measuredBytes} B at ${PIN.measuredAt.commit}).\n`
        + 'The startup path grew. Either make the new code lazy (put it behind import()), or turn the\n'
        + 'ratchet on purpose: re-pin `eager-source-graph` in tests/bundle-budgets.json, measured on the\n'
        + 'merge target (no build needed — this walk IS the measurement), with a note saying what grew\n'
        + `and onMergeTarget: true. Ten biggest files in the eager graph:\n${biggest}`,
      );
    }
    expect(onDisk).toBeLessThan(PIN.budgetBytes);
  });
});
