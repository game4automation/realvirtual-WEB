// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import {
  linkifyAnswer,
  type AnswerLinkResolvers,
} from '../src/core/hmi/linkify-answer';
import type { DiagnoseSource } from '../src/plugins/diagnose/diagnose-provider';

const SOURCE: DiagnoseSource = {
  title: 'Drawing 12345678',
  url: 'docs/12345678.pdf',
  page: 4,
};

function resolvers(
  part: (token: string) => string | null = () => null,
  doc: (token: string) => DiagnoseSource | null = () => null,
): AnswerLinkResolvers {
  return { resolvePart: part, resolveDoc: doc };
}

describe('linkifyAnswer', () => {
  it('turns an exactly resolvable part token into a part segment', () => {
    const segments = linkifyAnswer(
      'Inspect STD-004591:1 now.',
      resolvers((token) => token === 'STD-004591:1' ? 'Cell/STD-004591:1' : null),
    );

    expect(segments).toEqual([
      { kind: 'text', text: 'Inspect ' },
      { kind: 'part', text: 'STD-004591:1', path: 'Cell/STD-004591:1' },
      { kind: 'text', text: ' now.' },
    ]);
  });

  it('keeps an unresolvable candidate as plain text', () => {
    expect(linkifyAnswer('Inspect STD-004591:1.', resolvers())).toEqual([
      { kind: 'text', text: 'Inspect STD-004591:1.' },
    ]);
  });

  it('turns a 6-8 digit source match into a document segment', () => {
    const segments = linkifyAnswer(
      'See drawing 12345678.',
      resolvers(undefined, (token) => token === '12345678' ? SOURCE : null),
    );

    expect(segments[1]).toEqual({ kind: 'doc', text: '12345678', source: SOURCE });
  });

  it('keeps a document number without a source target as plain text', () => {
    expect(linkifyAnswer('See 12345678.', resolvers())).toEqual([
      { kind: 'text', text: 'See 12345678.' },
    ]);
  });

  it('linkifies inside bold spans after the emphasis split', () => {
    const parts = 'Check **STD-004591:1** first'.split(/\*\*([^*]+)\*\*/g);
    const linked = parts.map((part) => linkifyAnswer(
      part,
      resolvers((token) => token === 'STD-004591:1' ? 'Cell/STD-004591:1' : null),
    ));

    expect(parts[1]).toBe('STD-004591:1');
    expect(linked[1]).toEqual([
      { kind: 'part', text: 'STD-004591:1', path: 'Cell/STD-004591:1' },
    ]);
  });

  it('supports an exact multi-word source title without fuzzy matching', () => {
    const segments = linkifyAnswer(
      'Open Drawing 12345678 for details.',
      resolvers(undefined, (token) => token === SOURCE.title ? SOURCE : null),
    );

    expect(segments[1]).toEqual({ kind: 'doc', text: 'Drawing 12345678', source: SOURCE });
  });
});
