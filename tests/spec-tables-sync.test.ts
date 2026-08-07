// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * spec-tables-sync.test.ts — SSOT drift guard (plan-187, F14).
 *
 * specification.md Section 7 contains human-readable field tables per component.
 * They are declared NON-normative (rv-odt.json is normative), but they must not
 * drift: this test parses every Section-7 table and checks field names, types,
 * defaults and enum values against rv-odt.json. When it fails, fix the spec
 * prose (or, for an intentional format change, update JSON + baseline + prose
 * together).
 */

import { describe, it, expect } from 'vitest';
import specText from '../schema/v1/specification.md?raw';
import rvOdt from '../schema/v1/rv-odt.json';

interface OdtProperty {
  type?: string;
  $ref?: string;
  items?: { $ref?: string; type?: string };
  enum?: string[];
  default?: unknown;
}
interface OdtDef { properties?: Record<string, OdtProperty> }
const doc = rvOdt as unknown as {
  $defs: Record<string, OdtDef>;
  components: Record<string, unknown>;
  signals: Record<string, unknown>;
  logicSteps: Record<string, unknown>;
  structure: Record<string, unknown>;
  recording: Record<string, unknown>;
  connections: Record<string, unknown>;
};
const DEFS = doc.$defs;
/** All spec'd types across the six index groups (Section 7a-7e, 7g). */
const ALL_TYPES = [
  ...Object.keys(doc.components),
  ...Object.keys(doc.logicSteps),
  ...Object.keys(doc.signals),
  ...Object.keys(doc.structure),
  ...Object.keys(doc.recording),
  ...Object.keys(doc.connections),
];

/** Expected type-cell text for a JSON property (the table grammar). */
function expectedTypeCell(p: OdtProperty): string {
  if (p.$ref === '#/$defs/ComponentReference') return 'ComponentReference';
  if (p.$ref === '#/$defs/Vector3') return 'Vector3';
  if (p.$ref === '#/$defs/ActiveOnly') return 'ActiveOnly';
  if (p.type === 'array') {
    if (p.items?.$ref === '#/$defs/ComponentReference') return 'ComponentReference[]';
    if (p.items?.type) return `${p.items.type}[]`;
    return 'array';
  }
  if (Array.isArray(p.enum)) return `enum(${p.enum.join(', ')})`;
  return p.type ?? '?';
}

/** Expected default-cell text: JSON literal, or '-' when no default. */
function expectedDefaultCell(p: OdtProperty): string {
  return p.default === undefined ? '-' : JSON.stringify(p.default);
}

interface ParsedRow { field: string; type: string; def: string; desc: string }

/** Heading regex for a Section-7 subsection: `#### 7a.3 <Name>` (groups 7a-7g). */
function headingRegexFor(name: string): RegExp {
  return new RegExp(`^#### 7[a-g]\\.\\d+ ${name}\\s*$`, 'm');
}

/** Parse the Section-7 subsection for one component: heading `#### 7x.N <Name>`
 *  followed (eventually) by a markdown table `| Field | Type | Default | ... |`. */
function parseComponentTable(name: string): ParsedRow[] | null {
  const m = headingRegexFor(name).exec(specText);
  if (!m) return null;
  const start = m.index + m[0].length;
  const boundaries = [
    specText.indexOf('\n#### ', start),
    specText.indexOf('\n### ', start),
    specText.indexOf('\n## 8.', start),
  ].filter((i) => i !== -1);
  const end = boundaries.length > 0 ? Math.min(...boundaries) : Infinity;
  const section = specText.slice(start, end === Infinity ? undefined : end);

  const rows: ParsedRow[] = [];
  let inTable = false;
  for (const line of section.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('|')) { if (inTable) break; continue; }
    const cells = t.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 3) continue;
    if (cells[0] === 'Field') { inTable = true; continue; }       // header
    if (/^-+$/.test(cells[0].replace(/\s/g, ''))) continue;        // separator
    if (!inTable) continue;
    rows.push({
      field: cells[0].replace(/`/g, ''),
      type: cells[1],
      def: cells[2],
      desc: cells[3] ?? '',
    });
  }
  return rows;
}

describe('specification.md Section 7 tables match rv-odt.json (SSOT drift guard)', () => {
  it('spec documents every type in the rv-odt.json index groups', () => {
    for (const name of ALL_TYPES) {
      expect(headingRegexFor(name).test(specText),
        `specification.md Section 7 is missing a subsection for '${name}'`).toBe(true);
    }
  });

  it.each(ALL_TYPES.map((n) => [n] as const))('Section-7 table for %s matches rv-odt.json', (name) => {
    const props = DEFS[name]?.properties ?? {};
    const fieldNames = Object.keys(props);
    const rows = parseComponentTable(name);

    if (fieldNames.length === 0) {
      // Empty component (Sink): no table required.
      expect(rows === null || rows.length === 0).toBe(true);
      return;
    }

    expect(rows, `no field table found for '${name}'`).not.toBeNull();
    const byField = new Map(rows!.map((r) => [r.field, r]));

    // 1. Same field set (no missing, no extra rows).
    expect([...byField.keys()].sort()).toEqual([...fieldNames].sort());

    // 2. Type cell and default cell match the JSON definition exactly.
    //    Description texts are informative (F13) — only checked for presence,
    //    NOT compared, so rewording never becomes a CI failure.
    for (const [field, p] of Object.entries(props)) {
      const row = byField.get(field)!;
      expect(row.type, `type cell for ${name}.${field}`).toBe(expectedTypeCell(p));
      expect(row.def, `default cell for ${name}.${field}`).toBe(expectedDefaultCell(p));
      expect(row.desc.length, `description cell for ${name}.${field} must not be empty`).toBeGreaterThan(0);
    }
  });
});
