// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { checkLinks, checkApi, eventTable, headingIds } from './community-docs.mjs';

test('rejects outward links even when their label is inline code', () => {
  assert.equal(checkLinks(resolve('fixture'), 'doc-example.md', '[`source`](../../Packages/private.cs)').length, 1);
});

test('validates headings and duplicate heading suffixes, ignoring fenced examples', () => {
  const text = '# Guide\n## Save `GLB`\n## Save `GLB`\n```md\n## Invisible\n```\n';
  assert.deepEqual([...headingIds(text)], ['guide', 'save-glb', 'save-glb-1']);
  const read = () => text;
  assert.equal(checkLinks(resolve('fixture'), 'doc-example.md', '[save](other.md#save-glb-1)', read).length, 0);
  assert.equal(checkLinks(resolve('fixture'), 'doc-example.md', '[save](other.md#invisible)', read).length, 1);
});

test('missing Markdown and unknown anchors fail, external product URLs are allowed', () => {
  const root = resolve('fixture');
  assert.equal(checkLinks(root, 'doc-example.md', '[missing](missing.md)', () => null).length, 1);
  assert.equal(checkLinks(root, 'doc-example.md', '[product](https://example.org/doc#section)', () => null).length, 0);
});

test('API drift includes both added events and missing toggle callbacks', () => {
  const events = "export interface ViewerEvents { 'loaded': { value: string | null }; }";
  const plugins = 'export interface RVViewerPlugin { onActivate?(viewer: Viewer): void; }';
  const guide = eventTable(events) + '\n| `onActivate(viewer)` | enabled |';
  assert.deepEqual(checkApi(events, plugins, guide), []);
  assert.equal(checkApi(events.replace('}; }', "}; 'saved': void; }"), plugins, guide).length, 1);
  assert.equal(checkApi(events, plugins.replace('onActivate', 'onDeactivate'), guide).length, 1);
  assert.ok(guide.includes('string \\| null'));
});
