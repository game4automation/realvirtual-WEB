// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-published-scenes — the `published:<urlName>` ALIAS (plan-731 Phase 2, F3).
 *
 * This file used to specify a CATALOGUE: an `index.json` parser, a glob-fallback
 * entry builder and a deep-link resolver that decided from the catalogue whether
 * a name existed. All three were the second document identity space, and all
 * three are gone — the parser survives only as a foreign-format reader inside
 * `bundled-backend` (a system boundary, tested there with the `discover` path).
 *
 * What is specified here is what replaced them: a pure mapping from an old
 * `published:<urlName>` link onto a row of `documents[]`. The rule to hold is
 * "the manifest decides, and only the manifest" — the same authority `?doc=`
 * answers to, which is the whole point of collapsing the two spaces into one.
 */
import { describe, it, expect } from 'vitest';
import {
  PUBLISHED_ID_PREFIX,
  parsePublishedToken,
  publishedFileFromUrlName,
  publishedTokenOf,
  publishedUrlNameOf,
  resolvePublishedAlias,
  resolvePublishedSceneParam,
  urlNameFromFile,
} from '../src/core/hmi/scene/rv-published-scenes';
import type { RvDocumentEntry } from '../src/core/project/rv-project-types';

const doc = (id: string, path: string, name = id): RvDocumentEntry =>
  ({ id, path, name });

/** The demo's own rows, as `public/project.json` carries them. */
const DEMO_DOCUMENTS: RvDocumentEntry[] = [
  doc('doc_demorealvirtualweb_7l7hfw', 'DemoRealvirtualWeb.glb', 'realvirtual WEB Demo'),
  doc('doc_demoplanner_gf4m6v', 'DemoPlanner.glb', 'Layout Planner Demo'),
];

describe('urlNameFromFile', () => {
  it('strips the .glb suffix', () => {
    expect(urlNameFromFile('DemoPlanner.glb')).toBe('DemoPlanner');
  });
  it('is case-insensitive on the suffix', () => {
    expect(urlNameFromFile('Foo.GLB')).toBe('Foo');
  });
  it('round-trips with publishedFileFromUrlName', () => {
    expect(urlNameFromFile(publishedFileFromUrlName('DemoPlanner'))).toBe('DemoPlanner');
  });
});

describe('publishedUrlNameOf / publishedTokenOf', () => {
  it('is the path BASENAME without the extension', () => {
    expect(publishedUrlNameOf({ path: 'DemoPlanner.glb' })).toBe('DemoPlanner');
    expect(publishedUrlNameOf({ path: 'scenes/DemoPlanner.glb' })).toBe('DemoPlanner');
  });

  it('is the same name whichever folder the file sits in', () => {
    // The load-bearing property of the whole alias: plan-731 2a moved the
    // turntable fixture OUT of `scenes/`, and a link minted before that move
    // must still find it.
    expect(publishedUrlNameOf({ path: 'scenes/Test-DES-Turntable-Loop.glb' }))
      .toBe(publishedUrlNameOf({ path: 'Test-DES-Turntable-Loop.glb' }));
  });

  it('a missing or empty path yields an empty name rather than throwing', () => {
    expect(publishedUrlNameOf({})).toBe('');
    expect(publishedUrlNameOf({ path: '' })).toBe('');
  });

  it('publishedTokenOf spells the legacy address of a row', () => {
    expect(publishedTokenOf({ path: 'DemoPlanner.glb' })).toBe('published:DemoPlanner');
  });
});

describe('parsePublishedToken', () => {
  it('extracts the name from a published: value', () => {
    expect(parsePublishedToken('published:DemoPlanner')).toBe('DemoPlanner');
  });

  it('decodes percent-escapes so a name with a space survives the URL', () => {
    expect(parsePublishedToken('published:My%20Demo')).toBe('My Demo');
  });

  it('returns null for every other shape — the caller can chain it', () => {
    expect(parsePublishedToken('builtin:Foo.glb')).toBeNull();
    expect(parsePublishedToken('empty')).toBeNull();
    expect(parsePublishedToken('scn_abc')).toBeNull();
    expect(parsePublishedToken('doc_abc')).toBeNull();
    expect(parsePublishedToken(null)).toBeNull();
    expect(parsePublishedToken(undefined)).toBeNull();
  });

  it('an empty name is not a name', () => {
    expect(parsePublishedToken(PUBLISHED_ID_PREFIX)).toBeNull();
  });

  it('a malformed escape falls back to the literal rather than throwing', () => {
    expect(parsePublishedToken('published:100%')).toBe('100%');
  });
});

describe('resolvePublishedAlias — the manifest decides', () => {
  it('maps an old name onto the document row that carries it', () => {
    const hit = resolvePublishedAlias('DemoPlanner', DEMO_DOCUMENTS);
    expect(hit?.id).toBe('doc_demoplanner_gf4m6v');
    expect(hit?.path).toBe('DemoPlanner.glb');
  });

  it('matches case-insensitively', () => {
    expect(resolvePublishedAlias('demoplanner', DEMO_DOCUMENTS)?.id)
      .toBe('doc_demoplanner_gf4m6v');
  });

  it('finds a row whose path still sits under scenes/', () => {
    // A customer deploy that kept its examples in a folder resolves the same.
    const rows = [doc('doc_x', 'scenes/DemoPlanner.glb')];
    expect(resolvePublishedAlias('DemoPlanner', rows)?.id).toBe('doc_x');
  });

  it('an unknown name is null — the caller falls through to its normal boot', () => {
    // Replaces `catalogued: false` + a probe candidate. There is nothing to
    // probe any more: a name the manifest does not carry is not a document.
    expect(resolvePublishedAlias('Nope', DEMO_DOCUMENTS)).toBeNull();
  });

  it('an empty document list resolves nothing', () => {
    expect(resolvePublishedAlias('DemoPlanner', [])).toBeNull();
  });

  it('an empty or absent name resolves nothing', () => {
    expect(resolvePublishedAlias('', DEMO_DOCUMENTS)).toBeNull();
    expect(resolvePublishedAlias(null, DEMO_DOCUMENTS)).toBeNull();
  });

  it('survives a malformed row instead of throwing on it', () => {
    const rows = [
      null, undefined, 'nonsense', doc('doc_ok', 'DemoPlanner.glb'),
    ] as unknown as RvDocumentEntry[];
    expect(resolvePublishedAlias('DemoPlanner', rows)?.id).toBe('doc_ok');
  });
});

describe('resolvePublishedSceneParam — only a published: value resolves', () => {
  it('resolves a legacy deep link to its document row', () => {
    expect(resolvePublishedSceneParam('published:DemoPlanner', DEMO_DOCUMENTS)?.id)
      .toBe('doc_demoplanner_gf4m6v');
  });

  it('does NOT resolve a bare name — that is a document id lookup, not this', () => {
    expect(resolvePublishedSceneParam('DemoPlanner', DEMO_DOCUMENTS)).toBeNull();
  });

  it('leaves every other ?scene= shape to its own branch', () => {
    expect(resolvePublishedSceneParam('empty', DEMO_DOCUMENTS)).toBeNull();
    expect(resolvePublishedSceneParam('builtin:DemoPlanner.glb', DEMO_DOCUMENTS)).toBeNull();
  });
});
