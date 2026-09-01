// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-707 T4 — THE documentation drift gate.
 *
 * The tool reference in `webviewer.mcp.md` and the five `help/*.md` guides is
 * generated from the @McpTool decorators and CHECKED IN. Generated-and-checked-in
 * only works if something notices when the two parts disagree, so this test
 * fails in BOTH directions:
 *
 *   - a tool was added, renamed or re-annotated and nobody re-ran the generator
 *   - a generated block was hand-edited
 *
 * Both are the same assertion — "the file equals what the code says it should
 * be" — which is why one comparison covers both and neither can be argued away.
 *
 * `RV_UPDATE_MCP_DOCS=1` (i.e. `npm run gen:mcp-docs`) turns the same test into
 * the writer: it pushes the rendered block back through the `writeMcpDocBlock`
 * Node command and passes. Without the flag it only ever reads.
 *
 * The prose is not this test's business — and that is exactly why it also
 * asserts that `replaceBlock` cannot touch anything outside the fences.
 */

import { describe, it, expect } from 'vitest';
import { commands } from '@vitest/browser/context';
import {
  DOC_FAMILIES,
  beginMarker,
  domainOf,
  endMarker,
  extractBlock,
  renderDocBlocks,
  replaceBlock,
} from '../src/plugins/mcp-bridge/rv-mcp-doc-render';
import type { ToolSchema } from '../src/core/engine/rv-mcp-tools';
import { allSchemas } from './helpers/mcp-schemas';

// The checked-in files, read exactly the way the help tool reads them.
import INSTRUCTIONS from '../webviewer.mcp.md?raw';
import HELP_EDITOR from '../src/plugins/mcp-bridge/help/editor.md?raw';
import HELP_LAYOUT from '../src/plugins/mcp-bridge/help/layout.md?raw';
import HELP_SIMULATION from '../src/plugins/mcp-bridge/help/simulation.md?raw';
import HELP_PLC from '../src/plugins/mcp-bridge/help/plc.md?raw';
import HELP_DES from '../src/plugins/mcp-bridge/help/des.md?raw';

const SOURCES: Record<string, string> = {
  'webviewer.mcp.md': INSTRUCTIONS,
  'src/plugins/mcp-bridge/help/editor.md': HELP_EDITOR,
  'src/plugins/mcp-bridge/help/layout.md': HELP_LAYOUT,
  'src/plugins/mcp-bridge/help/simulation.md': HELP_SIMULATION,
  'src/plugins/mcp-bridge/help/plc.md': HELP_PLC,
  'src/plugins/mcp-bridge/help/des.md': HELP_DES,
};

const schemas = allSchemas();
const blocks = renderDocBlocks(schemas);

/** A document with every `<!-- BEGIN/END GENERATED -->` region removed. */
function stripGeneratedBlocks(source: string): string {
  return source.replace(
    /<!-- BEGIN GENERATED:[\s\S]*?<!-- END GENERATED:[^>]*-->/g, '');
}

/**
 * Offer the rendered block to the Node-side writer.
 *
 * The `RV_UPDATE_MCP_DOCS` gate lives THERE, not here: the variable exists in
 * the Node process, and Vite only forwards `VITE_`-prefixed variables into the
 * browser, so a browser-side check would have to be kept in sync with a second
 * copy of the flag. Asking every time and letting the writer refuse keeps one
 * gate in one place — a plain `npm test` gets `{ written: false }` and fails
 * with the diff, exactly as it should.
 *
 * Never throws: when the write path is unavailable the gate must still be able
 * to REPORT the drift, which is the part that matters.
 */
async function writeBack(file: string, marker: string, body: string): Promise<boolean> {
  try {
    const cmd = (commands as unknown as Record<string, (...a: unknown[]) => Promise<{
      written: boolean; reason?: string;
    }>>)['writeMcpDocBlock'];
    if (typeof cmd !== 'function') return false;
    const out = await cmd(file, marker, body);
    return out.written || out.reason === 'already up to date';
  } catch {
    return false;
  }
}

describe('MCP documentation drift gate', () => {
  for (const family of DOC_FAMILIES) {
    it(`${family.file} — the "${family.marker}" block matches the decorators`, async () => {
      const source = SOURCES[family.file];
      expect(source, `${family.file} is not registered in this test`).toBeTruthy();

      const expected = blocks.find((b) => b.marker === family.marker)!.body.trim();
      const actual = extractBlock(source, family.marker);

      expect(
        actual,
        `No marker pair "${family.marker}" in ${family.file}. Add:\n`
        + `${beginMarker(family.marker)}\n${endMarker(family.marker)}`,
      ).not.toBeNull();

      if (actual === expected) return;

      // Regeneration run (`npm run gen:mcp-docs`) — the writer accepts; a plain
      // test run — the writer refuses and we fall through to the assertion.
      if (await writeBack(family.file, family.marker, expected)) return;

      // The failure message carries the whole expected block, so the fallback
      // (copy it between the markers) is always available even if the write
      // path is not — the value of this feature is the gate, not the comfort.
      expect(
        actual,
        `${family.file} is out of date. Run \`npm run gen:mcp-docs\`, or paste this between the `
        + `"${family.marker}" markers:\n\n${expected}\n`,
      ).toBe(expected);
    });
  }

  it('every tool appears in the generated roster — nothing falls off the end', () => {
    const roster = blocks.find((b) => b.marker === 'tool-domains')!.body;
    const missing = schemas.map((s) => s.name).filter((n) => !roster.includes(`\`${n}\``));
    expect(missing, `not documented anywhere: ${missing.join(', ')}`).toEqual([]);
  });

  it('the roster counts what the schema list holds', () => {
    const roster = blocks.find((b) => b.marker === 'tool-domains')!.body;
    expect(roster).toContain(`${schemas.length} tools across`);
  });

  /**
   * plan-724 T4 — the PROSE, which the generator deliberately never touches.
   *
   * The generated tables above are pinned byte for byte; the hand-written
   * sections around them are not, and that is where a retired tool survives.
   * `web_editor_list_circles` had a whole recipe paragraph in `help/editor.md`
   * outside the fences — regenerating the tables would have removed its row and
   * left the recipe telling agents to call a tool that no longer exists. That is
   * worse than no documentation: the tool is described as working.
   *
   * So every `web_editor_*` name mentioned in the hand-written parts of ANY
   * guide must still be a live schema — not just `help/editor.md`, since the
   * editor tools are cross-referenced from the other guides too. The scope stops
   * at `web_editor_*` on purpose: the other domains carry deliberate "this is
   * retired, use X instead" notes, which this rule would forbid outright.
   */
  it('no guide names an editor tool that no longer exists — the prose included', () => {
    const live = new Set(schemas.map((s) => s.name));
    const offenders: string[] = [];
    for (const [file, source] of Object.entries(SOURCES)) {
      // Everything OUTSIDE the fences. Inside them the byte-exact comparison
      // above already holds, and their descriptions are ellipsis-truncated, so
      // scanning them would only manufacture half-names like
      // `web_editor_mechanism_s`.
      for (const match of stripGeneratedBlocks(source).matchAll(/\bweb_editor_[a-z0-9_]+\b/g)) {
        const name = match[0];
        // A trailing underscore is a wildcard (`web_editor_*`) or a family
        // ("the web_editor_mechanism_ tools"), never a tool name.
        if (name.endsWith('_') || live.has(name)) continue;
        offenders.push(`${file}: ${name}`);
      }
    }
    expect(
      [...new Set(offenders)].sort(),
      'these names are documented in prose but no longer announced — rewrite the passage',
    ).toEqual([]);
  });

  it('renders identically twice — the gate cannot flap (R5)', () => {
    expect(renderDocBlocks(schemas)).toEqual(renderDocBlocks(schemas));
    // …and independently of the order the schemas arrive in, which is the
    // realistic way non-determinism would sneak in (a delegate reordered in
    // _sendDiscover must not rewrite every documentation file).
    const shuffled = [...schemas].reverse();
    expect(renderDocBlocks(shuffled)).toEqual(renderDocBlocks(schemas));
  });
});

describe('the gate catches drift in BOTH directions', () => {
  const fake: ToolSchema = {
    name: 'web_editor_invented',
    description: 'Invent something that does not exist.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    annotations: { readOnlyHint: false },
  };

  it('a new tool with no doc run makes the block differ', () => {
    const withFake = renderDocBlocks([...schemas, fake])
      .find((b) => b.marker === 'tool-reference editor')!.body.trim();
    const checkedIn = extractBlock(HELP_EDITOR, 'tool-reference editor');
    expect(withFake).not.toBe(checkedIn);
    expect(withFake).toContain('web_editor_invented');
  });

  it('a hand-edited block makes the block differ', () => {
    const checkedIn = extractBlock(HELP_EDITOR, 'tool-reference editor')!;
    const tampered = checkedIn.replace('| `web_editor_open` |', '| `web_editor_opne` |');
    expect(tampered).not.toBe(checkedIn);
    // …and the comparison the gate performs would reject it.
    const expected = blocks.find((b) => b.marker === 'tool-reference editor')!.body.trim();
    expect(tampered).not.toBe(expected);
  });
});

describe('replaceBlock — the prose is untouchable', () => {
  const doc = [
    '# Title',
    '',
    'Prose before, which a generator must never touch.',
    '',
    beginMarker('tool-domains'),
    'stale content',
    endMarker('tool-domains'),
    '',
    'Prose after, likewise.',
    '',
  ].join('\n');

  it('replaces only between the fences', () => {
    const out = replaceBlock(doc, { marker: 'tool-domains', body: 'FRESH' });
    expect(out).toContain('Prose before, which a generator must never touch.');
    expect(out).toContain('Prose after, likewise.');
    expect(out).toContain('FRESH');
    expect(out).not.toContain('stale content');
    // Byte-exact on both sides of the block.
    expect(out.slice(0, out.indexOf('<!-- BEGIN'))).toBe(doc.slice(0, doc.indexOf('<!-- BEGIN')));
    expect(out.slice(out.indexOf('<!-- END'))).toBe(doc.slice(doc.indexOf('<!-- END')));
  });

  it('round-trips: extract after replace returns what was written', () => {
    const out = replaceBlock(doc, { marker: 'tool-domains', body: 'FRESH\nmultiline' });
    expect(extractBlock(out, 'tool-domains')).toBe('FRESH\nmultiline');
  });

  it('THROWS on a missing marker instead of appending', () => {
    expect(() => replaceBlock('# Just prose\n', { marker: 'tool-domains', body: 'x' }))
      .toThrow(/not found/);
    // Nothing was appended anywhere — the throw is the whole behaviour.
  });

  it('extractBlock returns null for an unknown marker', () => {
    expect(extractBlock(doc, 'tool-reference editor')).toBeNull();
  });

  it('a CRLF file reads identically to an LF one', () => {
    // This is not hypothetical: on Windows a checkout, an `autocrlf` conversion
    // or a `git stash pop` rewrites these files to CRLF with no content change
    // at all. The renderer emits LF, so without normalisation the gate would go
    // red across all six blocks for a reason that is not drift — and a gate
    // that cries wolf is a gate someone disables.
    const crlf = doc.replace(/\n/g, '\r\n');
    expect(extractBlock(crlf, 'tool-domains')).toBe(extractBlock(doc, 'tool-domains'));
  });

  it('the checked-in blocks match regardless of the files\' line endings', () => {
    for (const family of DOC_FAMILIES) {
      const source = SOURCES[family.file];
      const asCrlf = source.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
      const asLf = source.replace(/\r\n/g, '\n');
      expect(
        extractBlock(asCrlf, family.marker),
        `${family.file} reads differently as CRLF`,
      ).toBe(extractBlock(asLf, family.marker));
    }
  });
});

describe('bounds the generator must respect', () => {
  it('no tool description exceeds the CONNECT limit of 16384 characters', () => {
    // CONNECT's WebViewerBridge.ValidateDiscover rejects a longer description
    // outright, and a rejected tool is invisible rather than verbose. The
    // 110-word convention rule is far stricter and stays the real guard; this
    // is the hard floor underneath it.
    for (const s of schemas) {
      expect(s.description.length, `${s.name} description too long`).toBeLessThanOrEqual(16_384);
    }
  });

  it('the generated instruction block stays small — it is loaded on every connect', () => {
    // The five guides are served on demand and may be detailed; this one is
    // not, so its size is a per-session cost for every agent.
    const roster = blocks.find((b) => b.marker === 'tool-domains')!.body;
    expect(roster.length).toBeLessThan(6_000);
  });

  it('domainOf agrees with the announced names', () => {
    expect(domainOf('web_editor_open')).toBe('editor');
    expect(domainOf('web_status')).toBe('(root)');
    expect(domainOf('web_describe')).toBe('(root)');
    expect(domainOf('web_select')).toBe('select');
  });
});
