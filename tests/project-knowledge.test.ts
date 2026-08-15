// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-718 stage 3.1 — the WEB reader of `documents[].knowledgeRef`.
 *
 * Three properties, and they are the same three the settings loader has:
 * tolerant parsing (a bad row costs the row), strict containment (a reference
 * cannot leave the project), and "absent" as the answer to every failure —
 * including the one that matters most here, a reference the project does not
 * actually contain.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  KNOWLEDGE_SCHEMA,
  knowledgeForDocument,
  knowledgeRefForDocument,
  parseKnowledge,
  type KnowledgeSource,
} from '../src/core/project/rv-project-knowledge';
import type { RvProject } from '../src/core/project/rv-project-types';

const project = {
  schemaVersion: 2,
  id: 'prj_knowledge',
  name: 'Knowledge fixture',
  documents: [
    { id: 'ast_m8x', path: 'models/linie1.glb', name: 'Linie 1', knowledgeRef: 'knowledge/linie-1.json' },
    { id: 'ast_z12', path: 'models/versand.glb', name: 'Versand', knowledgeRef: 'knowledge/versand.json' },
    { id: 'ast_esc', path: 'models/escape.glb', name: 'Escape', knowledgeRef: '../outside/steal.json' },
    { id: 'ast_non', path: 'models/plain.glb', name: 'Plain' },
  ],
} as unknown as RvProject;

const validFile = {
  $schema: KNOWLEDGE_SCHEMA,
  documents: [
    { title: 'Betriebsanleitung', ref: 'docs/linie1/manual.pdf', kind: 'pdf' },
    { path: 'manuals/wiring.pdf' },
    { ref: '../secrets/other-project.pdf' },
    { title: 'no reference at all' },
    'not an object',
  ],
  ragRef: 'bundles/linie1.zip',
};

function source(files: Record<string, unknown>): KnowledgeSource {
  return { readSettings: async (relPath?: string) => files[relPath ?? ''] ?? null };
}

describe('knowledgeRefForDocument', () => {
  it('reads the reference off the row and refuses one that leaves the project', () => {
    expect(knowledgeRefForDocument(project, 'ast_m8x')).toBe('knowledge/linie-1.json');
    // Containment is enforced on the way in, and an escaping ref reads as absent
    // rather than throwing — a broken manifest must not make a project unopenable.
    expect(knowledgeRefForDocument(project, 'ast_esc')).toBeNull();
    expect(knowledgeRefForDocument(project, 'ast_non')).toBeNull();
    expect(knowledgeRefForDocument(project, 'nope')).toBeNull();
    expect(knowledgeRefForDocument(null, 'ast_m8x')).toBeNull();
  });
});

describe('parseKnowledge', () => {
  it('keeps what it understands and drops only the rows it cannot', () => {
    const knowledge = parseKnowledge(validFile);
    expect(knowledge).not.toBeNull();
    expect(knowledge!.documents.map(d => d.ref))
      .toEqual(['docs/linie1/manual.pdf', 'manuals/wiring.pdf']);
    // `path` is accepted beside `ref`, and a missing title falls back to the file name.
    expect(knowledge!.documents[1].title).toBe('wiring.pdf');
    expect(knowledge!.documents[0].kind).toBe('pdf');
    expect(knowledge!.ragRef).toBe('bundles/linie1.zip');
    expect(knowledge!.rejected).toEqual([
      { ref: '../secrets/other-project.pdf', reason: 'escapes' },
      { ref: '', reason: 'not-a-reference' },
    ]);
  });

  it('requires the schema discriminator', () => {
    expect(parseKnowledge({ documents: [] })).toBeNull();
    expect(parseKnowledge({ $schema: 'rv-settings-bundle/1.0', documents: [] })).toBeNull();
    expect(parseKnowledge(null)).toBeNull();
    expect(parseKnowledge([{ $schema: KNOWLEDGE_SCHEMA }])).toBeNull();
    expect(parseKnowledge('{}')).toBeNull();
  });

  it('reports an escaping ragRef instead of resolving it', () => {
    const knowledge = parseKnowledge({ $schema: KNOWLEDGE_SCHEMA, ragRef: '../../rag.zip' });
    expect(knowledge!.ragRef).toBeNull();
    expect(knowledge!.rejected).toEqual([{ ref: '../../rag.zip', reason: 'escapes' }]);
  });

  it('survives a file with nothing in it', () => {
    expect(parseKnowledge({ $schema: KNOWLEDGE_SCHEMA }))
      .toEqual({ documents: [], ragRef: null, rejected: [] });
  });
});

describe('knowledgeForDocument', () => {
  const files = { 'knowledge/linie-1.json': validFile };

  it('resolves the reference through the backend read path', async () => {
    const knowledge = await knowledgeForDocument(project, 'ast_m8x', source(files));
    expect(knowledge!.documents).toHaveLength(2);
    expect(knowledge!.ragRef).toBe('bundles/linie1.zip');
  });

  it('is absent, and quiet, when no reference is set', async () => {
    const warn = vi.fn();
    expect(await knowledgeForDocument(project, 'ast_non', source(files), warn)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns once when the reference is dead', async () => {
    const warn = vi.fn();
    expect(await knowledgeForDocument(project, 'ast_z12', source(files), warn)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('knowledge/versand.json');
  });

  it('never reads a reference that leaves the project', async () => {
    const readSettings = vi.fn(async () => validFile);
    expect(await knowledgeForDocument(project, 'ast_esc', { readSettings })).toBeNull();
    expect(readSettings).not.toHaveBeenCalled();
  });

  it('does not mistake the settings bundle a browser backend answers with', async () => {
    // The browser backend ignores relPath and returns the stored settings blob
    // for every request — the discriminator is the only thing between that and
    // a knowledge file.
    const warn = vi.fn();
    const settings = { readSettings: async () => ({ $schema: 'rv-settings-bundle/1.0' }) };
    expect(await knowledgeForDocument(project, 'ast_m8x', settings, warn)).toBeNull();
    expect(warn.mock.calls[0][0]).toContain(KNOWLEDGE_SCHEMA);
  });

  it('turns a throwing backend into an absent feature', async () => {
    const warn = vi.fn();
    const boom = { readSettings: async () => { throw new Error('offline'); } };
    expect(await knowledgeForDocument(project, 'ast_m8x', boom, warn)).toBeNull();
    expect(warn.mock.calls[0][0]).toContain('offline');
    expect(await knowledgeForDocument(project, 'ast_m8x', null)).toBeNull();
  });
});
