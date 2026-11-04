// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-517 §9.2 — the rule annotations in specification.md stay anchored to
 * rv-odt.json (STRUCTURAL check; the semantic assertions live in
 * mcp-component-schema-tool.test.ts).
 *
 *  - every `**Authoring rules:**` / `**Reference implementation notes
 *    (informative):**` marker sits under a `#### 7x.N <Type>` heading of a type
 *    rv-odt.json defines, and the parser picked it up;
 *  - every identifier a rule puts in backticks exists: a `$def`, a field or enum
 *    value of the section's type, `Type.Field` of an existing def, an announced
 *    `web_*` tool, or the `Group_N` key family;
 *  - the F5 types have at least one rule;
 *  - every `refType` keyword points at an existing `$def` and sits only on a
 *    non-signal ComponentReference.
 */

import { describe, it, expect } from 'vitest';
import specText from '../schema/v1/specification.md?raw';
import rvOdt from '../schema/v1/rv-odt.json';
import {
  NOTES_MARKER,
  RULES_MARKER,
  parseSpecRules,
} from '../src/core/engine/rv-component-schema-info';
import { allSchemas } from './helpers/mcp-schemas';
import { CommandRegistry } from '../src/core/hmi/rv-command-registry';
import { ensureEditorCommandsRegistered } from '../src/core/hmi/editor-command-descriptors';

interface OdtProp {
  $ref?: string;
  items?: { $ref?: string };
  enum?: string[];
  signal?: string;
  refType?: string;
}
const DEFS = (rvOdt as unknown as { $defs: Record<string, { properties?: Record<string, OdtProp> }> }).$defs;

const F5_TYPES = ['Drive', 'Drive_Cylinder', 'Drive_Simple', 'Drive_Gear', 'Kinematic', 'Group',
  'TransportSurface', 'Sensor', 'Source', 'MU', 'Grip'];

/** Identifiers that are neither schema names nor tools, used deliberately:
 *  the reference implementation's hierarchy walk and the serialization flag
 *  Section 7 defines for group entries. */
const CODE_IDENTIFIERS = new Set([
  'findInParent', '_enabled',
  // Keys INSIDE the `WebOperatorPanel.Config` JSON document and the two value
  // forms its rules quote (`--` is the empty readout, `signal * scale` the
  // displayed expression). They are content of a blob field, not schema fields,
  // so no `$def` can carry them — the rules still have to be able to name them.
  'sliders', 'readouts', 'signals', 'componentLabels', 'decimals',
  'min', 'max', 'step', 'signal', 'signal * scale', '--',
]);
const GROUP_KEY = /^Group_?(\d+|N)$/;

/** Names of FOREIGN APIs a rule may quote. A rule sometimes states that a
 *  behaviour deliberately matches a named API of another system, and naming it
 *  is clearer than paraphrasing it. Only real, public API names of a system
 *  realvirtual mirrors belong here, and each needs a reason — never a schema
 *  field or enum value, which has to resolve through the checks above. */
const EXTERNAL_APIS = new Set([
  // plan-2047: raycast sensors mirror Unity's raycast semantics (spec § 7, Sensor).
  'Physics.Raycast',
]);

/** Words a value EXPRESSION may use beside in-scope field names: maths helpers
 *  and the local-axis vocabulary Section 7 writes its conventions in. An
 *  expression is resolved identifier by identifier (see `knownToken`), so a
 *  misspelled FIELD inside one is still reported. */
const EXPRESSION_WORDS = new Set(['sign', 'forward']);

const rules = parseSpecRules(specText);
const toolNames = new Set(allSchemas().map((s) => s.name));
// plan-2007: a rule may name a registry command (`editor.setField`) — the agent's door since the tools moved.
const commandRegistryForRules = new CommandRegistry();
ensureEditorCommandsRegistered(commandRegistryForRules);
const commandIds = new Set(commandRegistryForRules.list().map((d) => d.id));

/**
 * A bare field / enum token must belong to a type in scope: the section's own
 * type, a `$def` the same bullet names in backticks (a Drive_Cylinder rule may
 * speak of the drive's `Direction`), or `ComponentReference` (its `path` /
 * `componentType` are the vocabulary of every reference).
 */
function knownToken(token: string, scope: readonly string[]): boolean {
  if (DEFS[token]) return true;
  if (GROUP_KEY.test(token) || CODE_IDENTIFIERS.has(token)) return true;
  if (EXTERNAL_APIS.has(token)) return true;
  if (token.startsWith('web_')) return toolNames.has(token);
  if (commandIds.has(token)) return true;
  const qualified = /^(\w+)\.(\w+)$/.exec(token);
  if (qualified) return !!DEFS[qualified[1]]?.properties?.[qualified[2]];
  // A value expression (`-forward * sign(Angle) * Radius`) is resolved name by
  // name instead of being allowlisted whole: every identifier in it must itself
  // be known, so the gate keeps catching a typo in a field name.
  if (/[*+\-/()]/.test(token)) {
    const ids = [...token.matchAll(/[A-Za-z_]\w*/g)].map((m) => m[0]);
    if (ids.length > 0 && ids.every((id) => EXPRESSION_WORDS.has(id) || knownToken(id, scope))) return true;
  }
  return scope.some((type) => {
    const props = DEFS[type]?.properties ?? {};
    return !!props[token] || Object.values(props).some((p) => p.enum?.includes(token));
  });
}

describe('specification.md rule annotations ↔ rv-odt.json (plan-517 §9.2)', () => {
  it('every marker line sits under a valid Section-7 heading of a spec\'d type', () => {
    let type: string | null = null;
    let markers = 0;
    for (const raw of specText.split(/\r?\n/)) {
      const line = raw.trim();
      if (line.startsWith('#')) {
        // Second copy of HEADING_RE from rv-component-schema-info.ts — the
        // letter suffix (`7a.11b`) must be accepted on BOTH sides: a product-only
        // fix leaves this gate red, a test-only fix hides the product hole
        // behind the `rules.has(type)` assertion below (plan-2047).
        type = /^#### 7[a-g]\.\d+[a-z]? (\S+)$/.exec(line)?.[1] ?? null;
        continue;
      }
      if (line !== RULES_MARKER && line !== NOTES_MARKER) continue;
      markers++;
      expect(type, `marker "${line}" outside a #### 7x.N <Type> section`).not.toBeNull();
      expect(DEFS[type!], `marker under "${type}", which rv-odt.json does not define`).toBeTruthy();
      expect(rules.has(type!), `parser missed the block under ${type}`).toBe(true);
    }
    expect(markers).toBeGreaterThanOrEqual(F5_TYPES.length);
  });

  it('every block has at least one bullet', () => {
    for (const [type, block] of rules) {
      expect(block.rules.length + block.notes.length, type).toBeGreaterThan(0);
    }
  });

  it('every backticked identifier in a rule or note exists', () => {
    const unknown: string[] = [];
    for (const [type, block] of rules) {
      for (const line of [...block.rules, ...block.notes]) {
        const tokens = [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
        const scope = [type, 'ComponentReference', ...tokens.filter((t) => DEFS[t])];
        for (const token of tokens) {
          if (!knownToken(token, scope)) unknown.push(`${type}: \`${token}\``);
        }
      }
    }
    expect(unknown).toEqual([]);
  });

  // plan-2047 §9.5 — the two vocabulary additions above widen what a rule may
  // name. They must not widen what a TYPO may be: the value of this gate is
  // that it rejects a field name that does not exist.
  it('external API names and value expressions pass, invented field names do not', () => {
    expect(knownToken('Physics.Raycast', ['Sensor'])).toBe(true);
    expect(knownToken('-forward * sign(Angle) * Radius', ['TransportGuided'])).toBe(true);
    // Same expression, one field misspelled — still reported.
    expect(knownToken('-forward * sign(Angel) * Radius', ['TransportGuided'])).toBe(false);
    // A foreign API name that is not on the list stays unknown.
    expect(knownToken('Physics.Spherecast', ['Sensor'])).toBe(false);
    // A plain invented field name is unaffected by either addition.
    expect(knownToken('TransportDirektion', ['TransportSurface'])).toBe(false);
    expect(knownToken('Angle', ['TransportGuided'])).toBe(true);
  });

  it('the F5 types have at least one authoring rule', () => {
    for (const type of F5_TYPES) {
      expect(rules.get(type)?.rules.length ?? 0, `${type} has no authoring rule`).toBeGreaterThan(0);
    }
  });

  it('refType names an existing $def and sits only on a non-signal ComponentReference', () => {
    const seen: string[] = [];
    for (const [type, def] of Object.entries(DEFS)) {
      for (const [field, p] of Object.entries(def.properties ?? {})) {
        if (p.refType === undefined) continue;
        seen.push(`${type}.${field}`);
        const isRef = p.$ref === '#/$defs/ComponentReference' || p.items?.$ref === '#/$defs/ComponentReference';
        expect(isRef, `${type}.${field} carries refType but is no ComponentReference`).toBe(true);
        expect(p.signal, `${type}.${field} is a signal slot — refType is for component references`).toBeUndefined();
        expect(DEFS[p.refType], `${type}.${field}.refType "${p.refType}" is not a $def`).toBeTruthy();
      }
    }
    expect(seen).toEqual(expect.arrayContaining(['TransportSurface.DriveReference', 'Drive_Gear.MasterDrive']));
  });

  it('refType is documented in Section 8', () => {
    const s8 = specText.slice(specText.indexOf('## 8. Vocabulary'));
    expect(s8).toContain('**`refType`**');
  });
});
