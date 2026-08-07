// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/** Dependency-free parser for the safe Markdown subset used by HMI content. */

export type SafeMarkdownInlineNode =
  | { kind: 'text'; text: string }
  | { kind: 'strong'; text: string }
  | { kind: 'link'; text: string; href: string };

export type SafeMarkdownBlock =
  | { kind: 'heading'; level: 1 | 2 | 3; children: SafeMarkdownInlineNode[] }
  | { kind: 'paragraph'; children: SafeMarkdownInlineNode[] }
  | { kind: 'list'; items: SafeMarkdownInlineNode[][] };

/** Parses headings, unordered lists, paragraphs, bold text, and safe HTTP(S) links. */
export function parseSafeMarkdown(markdown: string): SafeMarkdownBlock[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: SafeMarkdownBlock[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push({ kind: 'paragraph', children: parseInline(paragraph.join(' ')) });
    paragraph = [];
  };
  const flushList = () => {
    if (list.length === 0) return;
    blocks.push({ kind: 'list', items: list.map(parseInline) });
    list = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({
        kind: 'heading',
        level: heading[1].length as 1 | 2 | 3,
        children: parseInline(heading[2]),
      });
      continue;
    }
    const listItem = /^[-*]\s+(.+)$/.exec(line);
    if (listItem) {
      flushParagraph();
      list.push(listItem[1]);
      continue;
    }
    flushList();
    paragraph.push(line);
  }

  flushParagraph();
  flushList();
  return blocks;
}

/** Returns true only for absolute HTTP and HTTPS URLs. */
export function isSafeHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function parseInline(value: string): SafeMarkdownInlineNode[] {
  // Images are never materialized. Keeping their alt text makes them inert and readable.
  const text = value.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  const token = /(\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g;
  const nodes: SafeMarkdownInlineNode[] = [];
  let cursor = 0;

  for (const match of text.matchAll(token)) {
    const index = match.index ?? 0;
    if (index > cursor) nodes.push({ kind: 'text', text: text.slice(cursor, index) });
    const raw = match[0];
    if (raw.startsWith('**')) {
      nodes.push({ kind: 'strong', text: raw.slice(2, -2) });
    } else {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(raw);
      if (link && isSafeHttpUrl(link[2].trim())) {
        nodes.push({ kind: 'link', text: link[1], href: link[2].trim() });
      } else {
        nodes.push({ kind: 'text', text: link?.[1] ?? raw });
      }
    }
    cursor = index + raw.length;
  }

  if (cursor < text.length) nodes.push({ kind: 'text', text: text.slice(cursor) });
  return nodes;
}
