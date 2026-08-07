// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { parseAgentMarkdown } from '../src/plugins/agents/agent-report';

describe('agent report sanitizing', () => {
  it('keeps raw HTML inert and never creates image nodes', () => {
    const blocks = parseAgentMarkdown('<script>alert(1)</script> ![machine](data:image/png;base64,abc)');
    expect(JSON.stringify(blocks)).toContain('<script>alert(1)</script>');
    expect(JSON.stringify(blocks)).toContain('machine');
    expect(JSON.stringify(blocks)).not.toContain('data:image');
  });

  it('discards javascript and data URLs while retaining http/https links', () => {
    const blocks = parseAgentMarkdown('[bad](javascript:alert(1)) [data](data:text/plain,x) [good](https://example.com/report)');
    const nodes = blocks.flatMap((block) => block.kind === 'list' ? block.items.flat() : block.children);
    expect(nodes.filter((node) => node.kind === 'link').map((node) => node.href)).toEqual(['https://example.com/report']);
    expect(nodes.map((node) => node.text).join('')).toContain('bad');
  });

  it('links only source IDs resolved by the server', () => {
    const blocks = parseAgentMarkdown('[[source:approved-1]] [[source:foreign-9]]', [
      { id: 'approved-1', title: 'Manual', url: 'https://connect.local/docs/manual.pdf' },
    ]);
    const nodes = blocks.flatMap((block) => block.kind === 'list' ? block.items.flat() : block.children);
    expect(nodes.find((node) => node.kind === 'source' && node.id === 'approved-1')).toMatchObject({
      href: 'https://connect.local/docs/manual.pdf',
    });
    expect(nodes.find((node) => node.kind === 'source' && node.id === 'foreign-9')).not.toHaveProperty('href');
  });
});
