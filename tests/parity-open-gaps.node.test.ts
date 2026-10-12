// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * parity-open-gaps — the open-gap counter of plan-757 (Phase 0).
 *
 * `tests/pipeline-parity.test.ts` commits every dimension on which the main
 * model and a placement differ TODAY as a literal `it.todo(...)` inside its
 * fixture block. vitest reports a todo as neither passed nor failed, and
 * `scripts/test-inventory-diff.mjs` only sees `passed → todo` transitions —
 * so the NUMBER of todos per fixture is pinned here, from the source text, and
 * changes only by editing this table on purpose. Phase 1 exit: every count 0.
 *
 * Counting technique: the file is split at its `describe('fixture (x) —`
 * headers; inside each block `it.todo(` occurrences are counted. No reporter,
 * no IPC, no browser.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, 'pipeline-parity.test.ts'), 'utf8');
const nestedSource = readFileSync(resolve(here, 'pipeline-parity-nested.test.ts'), 'utf8');

/**
 * plan-757 Phase 2 (spike S2): the same counter for `pipeline-parity-nested.test.ts`
 * — an asset INSIDE an asset, two levels. Every block carries 18 checks (the 17
 * of the flat fixtures + "nested drive moves on both paths"). Spike baseline
 * (2026-09-22): the nested mechanism itself was at parity (behaviour, pick,
 * driveHome, aliases identical on (n1)); every open gap was on the MAIN path,
 * where `loadGLB` still composed — (n1)/(n3) 4 each (the outer asset was not
 * baked: `destructivePipeline` required `composition === null` although compose
 * only DEFERRED), (n2) 7 (a hand-authored reference was GRAFTED: extra `Cell`
 * level, no pre-bake hooks, unbaked in-place pipeline). Phase 2b (2026-09-22)
 * closed all 15: a runtime load defers EVERY non-embedded reference and a
 * composition without frames bakes. The Phase 2 exit criterion is this table
 * at 0; a gap that opens again is added here on purpose, with its reason.
 */
export const EXPECTED_OPEN_GAPS_NESTED: Readonly<Record<string, number>> = Object.freeze({
  n1: 0,
  n2: 0,
  // Phase 2a (2026-09-22): (n3) planner reference under a STATIC intermediate
  // ancestor (`Machine/Mount/Cell_1`, review F15).
  n3: 0,
});

/**
 * Expected open gaps per fixture. Phase 0 baseline (2026-09-22): a 9, b 7, c 3,
 * d 6, e 3, f 2, g 6, h 1, i 7 = 44. Phase 1a closed all of them (one recipe,
 * whole-template instances, one init context, aliases on the asset, home-stamp
 * re-take + pivot shift, static freeze on placements) — the Phase 1 exit
 * criterion of plan-757 is this table at 0. A gap that opens again is added
 * here on purpose, with its reason next to the count.
 */
export const EXPECTED_OPEN_GAPS: Readonly<Record<string, number>> = Object.freeze({
  a: 0,
  b: 0,
  c: 0,
  d: 0,
  e: 0,
  f: 0,
  g: 0,
  h: 0,
  i: 0,
});

/** The per-fixture block sources, keyed by fixture id. */
function fixtureBlocks(text: string): Record<string, string> {
  const re = /describe\('fixture \(([a-z])\) — /g;
  const starts: Array<{ id: string; index: number }> = [];
  for (let m: RegExpExecArray | null; (m = re.exec(text)) !== null;) starts.push({ id: m[1], index: m.index });
  const out: Record<string, string> = {};
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1].index : text.indexOf("describe('parity allow-list'");
    out[starts[i].id] = text.slice(starts[i].index, end === -1 ? undefined : end);
  }
  return out;
}

/** The per-fixture block sources of the NESTED file, keyed by `n1` / `n2`. */
function nestedFixtureBlocks(text: string): Record<string, string> {
  const re = /describe\('nested fixture \((n\d)\) — /g;
  const starts: Array<{ id: string; index: number }> = [];
  for (let m: RegExpExecArray | null; (m = re.exec(text)) !== null;) starts.push({ id: m[1], index: m.index });
  const out: Record<string, string> = {};
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1].index : text.indexOf("describe('nested parity fixtures — table'");
    out[starts[i].id] = text.slice(starts[i].index, end === -1 ? undefined : end);
  }
  return out;
}

const count = (block: string, needle: RegExp): number => (block.match(needle) ?? []).length;

describe('plan-757 open-gap counter (pipeline-parity.test.ts)', () => {
  const blocks = fixtureBlocks(source);

  it('has one block per fixture (a)–(i)', () => {
    expect(Object.keys(blocks).sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']);
  });

  for (const [id, expected] of Object.entries(EXPECTED_OPEN_GAPS)) {
    it(`fixture (${id}) has exactly ${expected} it.todo( gap(s)`, () => {
      expect(count(blocks[id], /\bit\.todo\(/g)).toBe(expected);
    });
  }

  it('every fixture block still asserts 17 dimensions (15 structure + behaviour + pick), as it() or it.todo()', () => {
    for (const [id, block] of Object.entries(blocks)) {
      const its = count(block, /\bit\('(structure: |behaviour after|pick: )/g);
      const todos = count(block, /\bit\.todo\('(structure: |behaviour after|pick: )/g);
      expect(its + todos, `fixture (${id})`).toBe(17);
    }
  });

  it('never uses it.fails or it.skip (vitest 4 reports it.fails as passed)', () => {
    expect(source).not.toMatch(/\bit\.(fails|skip)\(/);
    expect(source).not.toMatch(/\bdescribe\.skip\(/);
  });

  it('every todo names its gap', () => {
    for (const line of Object.values(blocks).join('\n').split('\n')) {
      if (/\bit\.todo\(/.test(line)) expect(line, line).toMatch(/— GAP: \S/);
    }
  });

  it('total open gaps — 44 at the Phase 0 baseline, 0 since Phase 1a (the Phase 1 exit criterion)', () => {
    const total = Object.values(EXPECTED_OPEN_GAPS).reduce((a, b) => a + b, 0);
    // Summed over the fixture BLOCKS: the file header mentions `it.todo()` as prose.
    const inBlocks = Object.values(blocks).reduce((n, block) => n + count(block, /\bit\.todo\(/g), 0);
    expect(inBlocks).toBe(total);
    expect(total).toBe(0);
  });
});

describe('plan-757 open-gap counter — nested (pipeline-parity-nested.test.ts, Phase 2)', () => {
  const blocks = nestedFixtureBlocks(nestedSource);

  it('has one block per nested fixture (n1), (n2), (n3)', () => {
    expect(Object.keys(blocks).sort()).toEqual(['n1', 'n2', 'n3']);
  });

  for (const [id, expected] of Object.entries(EXPECTED_OPEN_GAPS_NESTED)) {
    it(`nested fixture (${id}) has exactly ${expected} it.todo( gap(s)`, () => {
      expect(count(blocks[id], /\bit\.todo\(/g)).toBe(expected);
    });
  }

  it('every nested block asserts 18 checks (17 dimensions + nested drive moves), as it() or it.todo()', () => {
    for (const [id, block] of Object.entries(blocks)) {
      const its = count(block, /\bit\('(structure: |behaviour after|pick: |nested drive moves)/g);
      const todos = count(block, /\bit\.todo\('(structure: |behaviour after|pick: |nested drive moves)/g);
      expect(its + todos, `nested fixture (${id})`).toBe(18);
    }
  });

  it('never uses it.fails or it.skip; every todo names its gap', () => {
    expect(nestedSource).not.toMatch(/\bit\.(fails|skip)\(/);
    for (const line of Object.values(blocks).join('\n').split('\n')) {
      if (/\bit\.todo\(/.test(line)) expect(line, line).toMatch(/— GAP: \S/);
    }
  });

  it('total open nested gaps — 11 at the spike S2 baseline, 15 with (n3) after Phase 2a, 0 since Phase 2b (the Phase 2 exit criterion)', () => {
    const total = Object.values(EXPECTED_OPEN_GAPS_NESTED).reduce((a, b) => a + b, 0);
    const inBlocks = Object.values(blocks).reduce((n, block) => n + count(block, /\bit\.todo\(/g), 0);
    expect(inBlocks).toBe(total);
    expect(total).toBe(0);
  });
});
