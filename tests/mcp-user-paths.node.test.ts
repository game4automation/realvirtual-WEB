// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * `normalizeUserPathArgs` over path LISTS (rv-path-list): a JSON-array element is
 * looked up as ONE path, never as the fragments its commas would split it into,
 * and a changed list keeps a form the shared parser reads back exactly.
 */
import { describe, expect, it } from 'vitest';
import { normalizeUserPathArgs } from '../src/plugins/mcp-bridge/rv-mcp-user-paths';
import { parsePathList } from '../src/core/hmi/rv-path-list';
import type { NodeRegistry } from '../src/core/engine/rv-node-registry';

/**
 * A registry stand-in with the three calls the normalizer makes. `canonical` are
 * registry paths; `authored` maps an authored spelling to the canonical path it
 * names (found by `findNodeForUser` via 'authored'). Every lookup is recorded.
 */
function fakeRegistry(canonical: string[], authored: Record<string, string> = {}) {
  const nodes = new Map(canonical.map((p) => [p, { p }]));
  const looked: string[] = [];
  const reg = {
    getNode: (p: string) => { looked.push(p); return nodes.get(p) ?? null; },
    getPathForNode: (n: { p: string }) => n.p,
    findNodeForUser: (p: string) => {
      looked.push(p);
      const target = authored[p];
      return target ? { node: nodes.get(target)!, via: 'authored' } : null;
    },
  };
  return { reg: reg as unknown as NodeRegistry, looked };
}

describe('normalizeUserPathArgs — path lists', () => {
  it('never resolves a fragment of a quoted path', () => {
    const { reg, looked } = fakeRegistry(['Asset/LINK,PLATE', 'Asset/LINK', 'PLATE']);
    const args = { paths: '["Asset/LINK,PLATE"]' };
    expect(normalizeUserPathArgs(reg, args)).toBe(args);
    expect(looked).toContain('Asset/LINK,PLATE');
    expect(looked).not.toContain('Asset/LINK');
    expect(looked).not.toContain('PLATE');
  });

  it('normalises each JSON element and writes the list back as JSON', () => {
    const { reg } = fakeRegistry(['Asset/LINK_PLATE_1', 'Asset/B'], { 'Asset/LINK,PLATE': 'Asset/LINK_PLATE_1' });
    const out = normalizeUserPathArgs(reg, { paths: '["Asset/LINK,PLATE", "Asset/B"]' })!;
    expect(out.paths).toBe('["Asset/LINK_PLATE_1","Asset/B"]');
    expect(parsePathList(out.paths)).toEqual(['Asset/LINK_PLATE_1', 'Asset/B']);
  });

  it('a canonical path that contains a comma is written as JSON, so it does not split on the next parse', () => {
    const { reg } = fakeRegistry(['Asset/LINK,PLATE'], { 'Asset/LinkPlate': 'Asset/LINK,PLATE' });
    const out = normalizeUserPathArgs(reg, { paths: 'Asset/LinkPlate' })!;
    expect(parsePathList(out.paths)).toEqual(['Asset/LINK,PLATE']);
  });

  it('legacy comma lists keep their form and their meaning ("A,B" = two paths)', () => {
    const { reg } = fakeRegistry(['Asset/A_1', 'Asset/B'], { 'Asset/A': 'Asset/A_1' });
    expect(normalizeUserPathArgs(reg, { paths: 'Asset/A,Asset/B' })!.paths).toBe('Asset/A_1,Asset/B');
    const untouched = { paths: 'Asset/A_1,Asset/B' };
    expect(normalizeUserPathArgs(reg, untouched)).toBe(untouched);
  });

  it('a multi-line list keeps commas literal and is re-joined with newlines', () => {
    const { reg, looked } = fakeRegistry(['Asset/X,Y_1', 'Asset/B'], { 'Asset/X,Y': 'Asset/X,Y_1' });
    const out = normalizeUserPathArgs(reg, { paths: 'Asset/X,Y\nAsset/B' })!;
    expect(out.paths).toBe('Asset/X,Y_1\nAsset/B');
    expect(looked).not.toContain('Asset/X');
  });

  it('a native array stays an array; an invalid JSON list is left for the tool to refuse', () => {
    const { reg } = fakeRegistry(['Asset/A_1'], { 'Asset/A': 'Asset/A_1' });
    expect(normalizeUserPathArgs(reg, { paths: ['Asset/A'] })!.paths).toEqual(['Asset/A_1']);
    const broken = { paths: '["Asset/A"' };
    expect(normalizeUserPathArgs(reg, broken)).toBe(broken);
  });
});
