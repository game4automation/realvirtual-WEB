// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-node-knowledge — the schema, the defaults, and the deliberate absence of a
 * create-factory (plan-394 test 9.1).
 *
 * The factory assertion is the one worth reading twice. It is not a style check:
 * the whole read path of this feature (raw `userData.realvirtual` rather than the
 * component registry) is correct ONLY as long as no factory exists. Register one
 * and the note starts appearing in `web_component_get`, `applySchema` starts
 * running at load, and a note written in the current session becomes invisible
 * until reload. This test is what stops that from happening quietly.
 */

import { describe, it, expect } from 'vitest';
import { Object3D } from 'three';
import {
  MAX_NOTE_CHARS,
  NODE_KNOWLEDGE_FIELD,
  NODE_KNOWLEDGE_FIELDS,
  NODE_KNOWLEDGE_SCHEMA,
  NODE_KNOWLEDGE_TYPE,
  asAuthor,
  asConfidence,
  isEmptyNote,
  readNodeKnowledge,
} from '../src/core/engine/rv-node-knowledge';
import {
  applySchema,
  getCapabilities,
  getFieldDescriptor,
  getRegisteredFactories,
  getRegisteredSchemaTypes,
} from '../src/core/engine/rv-component-registry';

function nodeWith(entry: unknown): Object3D {
  const node = new Object3D();
  node.userData.realvirtual = { [NODE_KNOWLEDGE_TYPE]: entry };
  return node;
}

describe('NodeKnowledge schema', () => {
  it('reads Note, UpdatedAt, Author and Confidence out of rv_extras', () => {
    const target: Record<string, unknown> = {};
    applySchema(target, NODE_KNOWLEDGE_SCHEMA, {
      Note: '- axis 3 has ~0.2deg backlash',
      UpdatedAt: '2026-08-11T10:00:00Z',
      Author: 'agent',
      Confidence: 'inferred',
      NodeIdAtWrite: 'a1b2c3d4e5f60718',
    });
    expect(target.Note).toBe('- axis 3 has ~0.2deg backlash');
    expect(target.UpdatedAt).toBe('2026-08-11T10:00:00Z');
    expect(target.Author).toBe('agent');
    expect(target.Confidence).toBe('inferred');
    expect(target.NodeIdAtWrite).toBe('a1b2c3d4e5f60718');
  });

  it('defaults Confidence to "observed" and Author to "agent" when absent', () => {
    const target: Record<string, unknown> = {};
    applySchema(target, NODE_KNOWLEDGE_SCHEMA, { Note: 'x' });
    expect(target.Confidence).toBe('observed');
    expect(target.Author).toBe('agent');
  });

  it('exposes a 4000 code-unit note limit', () => {
    expect(MAX_NOTE_CHARS).toBe(4000);
  });

  it('names the note field and the full field list as constants', () => {
    expect(NODE_KNOWLEDGE_FIELD).toBe('Note');
    // The delete path unsets each of these; a field missing here would survive
    // as a husk in the GLB because the type hull only goes with the last field.
    expect([...NODE_KNOWLEDGE_FIELDS]).toEqual(Object.keys(NODE_KNOWLEDGE_SCHEMA));
  });
});

describe('NodeKnowledge registration', () => {
  it('registers NO create-factory, so no live instance ever exists', () => {
    expect(getRegisteredFactories().get(NODE_KNOWLEDGE_TYPE)).toBeUndefined();
  });

  it('registers the schema anyway, for field descriptors and Add Component', () => {
    expect(getRegisteredSchemaTypes()).toContain(NODE_KNOWLEDGE_TYPE);
    // Resolvable descriptors matter for one specific reason: the write guard
    // asks `isFieldDisplayReadonly(getFieldDescriptor(...))` before every edit.
    const desc = getFieldDescriptor(NODE_KNOWLEDGE_TYPE, NODE_KNOWLEDGE_FIELD);
    expect(desc?.type).toBe('string');
    expect(desc?.readonly).toBeUndefined();
  });

  it('is authorable but NOT hoverable or selectable — no HMI surface', () => {
    const caps = getCapabilities(NODE_KNOWLEDGE_TYPE);
    expect(caps.authorable).toBe(true);
    // Unlike RuntimeMetadata: an agent note must not become a hover tooltip.
    expect(caps.hoverable).toBe(false);
    expect(caps.selectable).toBe(false);
    expect(caps.tooltipType).toBeNull();
  });
});

describe('readNodeKnowledge', () => {
  it('returns null for a node with no entry at all', () => {
    expect(readNodeKnowledge(new Object3D())).toBeNull();
    expect(readNodeKnowledge(null)).toBeNull();
    expect(readNodeKnowledge(undefined)).toBeNull();
  });

  it('defaults for itself, because applySchema never runs without a factory', () => {
    // A GLB written by an older build carries only the Note. The loader creates
    // no instance for a factory-less type, so nothing upstream fills the rest in.
    const entry = readNodeKnowledge(nodeWith({ Note: 'only the note' }));
    expect(entry).toEqual({
      Note: 'only the note',
      UpdatedAt: '',
      Author: 'agent',
      Confidence: 'observed',
      NodeIdAtWrite: '',
    });
  });

  it('rejects out-of-vocabulary provenance values rather than passing them on', () => {
    const entry = readNodeKnowledge(nodeWith({
      Note: 'n', Author: 'ceo', Confidence: 'absolutely-certain',
    }));
    expect(entry?.Author).toBe('agent');
    expect(entry?.Confidence).toBe('observed');
  });

  it('survives a non-object entry without throwing', () => {
    expect(readNodeKnowledge(nodeWith('a bare string'))).toBeNull();
    expect(readNodeKnowledge(nodeWith(['an array']))).toBeNull();
    expect(readNodeKnowledge(nodeWith(null))).toBeNull();
  });

  it('keeps line breaks in the stored note verbatim', () => {
    const note = '## Axis 3\n- backlash ~0.2deg\n- limit is mechanical, not soft';
    expect(readNodeKnowledge(nodeWith({ Note: note }))?.Note).toBe(note);
  });
});

describe('note emptiness and provenance narrowing', () => {
  it('treats whitespace-only text as empty (F7)', () => {
    expect(isEmptyNote('')).toBe(true);
    expect(isEmptyNote('   \n\t  ')).toBe(true);
    expect(isEmptyNote(undefined)).toBe(true);
    expect(isEmptyNote(null)).toBe(true);
    expect(isEmptyNote('x')).toBe(false);
  });

  it('narrows author and confidence to the documented vocabulary', () => {
    expect(asAuthor('user')).toBe('user');
    expect(asAuthor('agent')).toBe('agent');
    expect(asAuthor('nonsense')).toBe('agent');
    expect(asConfidence('unverified')).toBe('unverified');
    expect(asConfidence('inferred')).toBe('inferred');
    expect(asConfidence(42)).toBe('observed');
  });
});
