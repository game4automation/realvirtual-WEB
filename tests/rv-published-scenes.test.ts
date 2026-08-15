// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-published-scenes — catalogue parser tests.
 *
 * Covers the curated index.json parser, the glob-fallback entry builder and
 * the deep-link resolver that feed the Models panel's "Examples" section.
 * Examples are GLBs since plan-413 phase 3; the `.scene.json` spellings that
 * used to be asserted here are now the rejected case.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  parsePublishedIndex,
  publishedEntryFromFile,
  publishedFileFromUrlName,
  resolvePublishedDeepLink,
  urlNameFromFile,
  type PublishedSceneEntry,
} from '../src/core/hmi/scene/rv-published-scenes';

afterEach(() => { vi.restoreAllMocks(); });

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

describe('publishedEntryFromFile', () => {
  it('derives urlName and label from the filename, no mode', () => {
    expect(publishedEntryFromFile('DemoPlanner.glb')).toEqual({
      file: 'DemoPlanner.glb',
      urlName: 'DemoPlanner',
      label: 'DemoPlanner',
    });
  });
});

describe('parsePublishedIndex', () => {
  it('maps curated entries with name → label and carries mode', () => {
    const out = parsePublishedIndex([
      { file: 'DemoPlanner.glb', name: 'Planner Demo', mode: 'planner' },
    ]);
    expect(out).toEqual([
      { file: 'DemoPlanner.glb', urlName: 'DemoPlanner', label: 'Planner Demo', mode: 'planner' },
    ]);
  });

  it('carries the classification level, and only a legal one (plan-413 phase 4)', () => {
    // The catalogue is the classification CACHE for a bundled deploy: §2.5
    // says a read-only source is never scanned, so this is where the level of
    // an example comes from. A bad value is dropped rather than shown — the
    // dashboard would otherwise offer a chip that matches one document and
    // nothing else in the product knows the word.
    const out = parsePublishedIndex([
      { file: 'A.glb', level: 'scene' },
      { file: 'B.glb', level: 'model' },        // the pre-413 spelling
      { file: 'C.glb', level: 'nonsense' },
      { file: 'D.glb' },
    ]);
    expect(out.map(e => e.level)).toEqual(['scene', 'plant', undefined, undefined]);
  });

  it('falls back to the url name when name is missing/blank', () => {
    const out = parsePublishedIndex([
      { file: 'A.glb' },
      { file: 'B.glb', name: '   ' },
    ]);
    expect(out.map(e => e.label)).toEqual(['A', 'B']);
    expect(out.every(e => e.mode === undefined)).toBe(true);
  });

  it('ignores non-array input', () => {
    expect(parsePublishedIndex(null)).toEqual([]);
    expect(parsePublishedIndex({})).toEqual([]);
    expect(parsePublishedIndex('nope')).toEqual([]);
  });

  it('skips entries without a valid .glb file field', () => {
    const out = parsePublishedIndex([
      { file: 'ok.glb' },
      { file: 'bad.json' },
      { file: 42 },
      { name: 'no file' },
      null,
      'string',
    ]);
    expect(out.map(e => e.file)).toEqual(['ok.glb']);
  });

  it('drops a non-string mode', () => {
    const out = parsePublishedIndex([{ file: 'A.glb', mode: 123 }]);
    expect(out[0].mode).toBeUndefined();
  });

  it('skips a legacy .scene.json entry and says why', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = parsePublishedIndex([
      { file: 'Old.scene.json', name: 'Old' },
      { file: 'New.glb', name: 'New' },
    ]);
    expect(out.map(e => e.file)).toEqual(['New.glb']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/Old\.scene\.json/);
  });
});

// ─── 9.10: the deep-link half that is testable without the boot routine ───

describe('resolvePublishedDeepLink', () => {
  const catalogue: PublishedSceneEntry[] = [
    { file: 'DemoPlanner.glb', urlName: 'DemoPlanner', label: 'Planner Demo', mode: 'planner' },
  ];

  it('resolves a catalogued name to its file, label and mode', () => {
    expect(resolvePublishedDeepLink('DemoPlanner', catalogue)).toEqual({
      file: 'DemoPlanner.glb',
      label: 'Planner Demo',
      mode: 'planner',
      catalogued: true,
    });
  });

  it('an unknown name is not catalogued — the caller must probe or fall through', () => {
    expect(resolvePublishedDeepLink('Nope', catalogue)).toEqual({
      file: 'Nope.glb',
      catalogued: false,
    });
  });

  it('never resolves to a .scene.json — the JSON deep link is gone', () => {
    expect(resolvePublishedDeepLink('Anything', []).file).not.toMatch(/\.scene\.json$/i);
  });

  it('an empty catalogue still yields a probe candidate', () => {
    expect(resolvePublishedDeepLink('DemoPlanner', [])).toEqual({
      file: 'DemoPlanner.glb',
      catalogued: false,
    });
  });
});
