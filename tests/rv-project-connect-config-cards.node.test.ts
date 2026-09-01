// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * CONNECT configs in the project dashboard — classification and tree sourcing.
 *
 * The rule under test is plan-718's reference model applied to the UI: a file
 * is a CONNECT config **by its ending** (`*.connect.json`), never by the folder
 * it sits in. `connect/` is where CONNECT happens to write its profiles, but a
 * config next to its model is exactly as much a config — so the classifier
 * takes only the path string, and the tree source lists configs as their own
 * ref kind wherever they were found.
 */

import { describe, it, expect } from 'vitest';
import {
  CONNECT_CONFIG_SUFFIX,
  KNOWLEDGE_FILE_SUFFIX,
  isConnectConfigPath,
  isKnowledgeFilePath,
  stripConnectConfigSuffix,
  stripKnowledgeFileSuffix,
} from '../src/core/project/rv-project-refs';
import { buildDashboardTree } from '../src/core/project/rv-project-tree-sources';
import { buildProjectTree, canRenameInTree } from '../src/core/project/rv-project-tree';

describe('isConnectConfigPath — the ending is the classification', () => {
  it('accepts the suffix wherever the file sits', () => {
    expect(isConnectConfigPath('connect/line1.connect.json')).toBe(true);
    expect(isConnectConfigPath('models/line1.connect.json')).toBe(true);
    expect(isConnectConfigPath('plant.connect.json')).toBe(true);
  });

  it('is case-insensitive, like every other extension check in the tree', () => {
    expect(isConnectConfigPath('Line1.Connect.JSON')).toBe(true);
  });

  it('rejects everything that merely lives near a config', () => {
    expect(isConnectConfigPath('connect/secrets.local.json')).toBe(false);
    expect(isConnectConfigPath('connect/readme.md')).toBe(false);
    expect(isConnectConfigPath('settings.json')).toBe(false);
    expect(isConnectConfigPath('x.connectjson')).toBe(false);
    expect(isConnectConfigPath('')).toBe(false);
    expect(isConnectConfigPath(null)).toBe(false);
    expect(isConnectConfigPath(undefined)).toBe(false);
  });

  it('suffix constant and classifier cannot drift apart', () => {
    expect(isConnectConfigPath(`any${CONNECT_CONFIG_SUFFIX}`)).toBe(true);
  });
});

describe('knowledge files — the same by-ending rule (*.knowledge.md)', () => {
  it('classifies by the ending, wherever the file sits', () => {
    expect(isKnowledgeFilePath('docs/filler.knowledge.md')).toBe(true);
    expect(isKnowledgeFilePath('filler.knowledge.md')).toBe(true);
    expect(isKnowledgeFilePath('Filler.Knowledge.MD')).toBe(true);
    expect(isKnowledgeFilePath('docs/manual.md')).toBe(false);
    expect(isKnowledgeFilePath(`any${KNOWLEDGE_FILE_SUFFIX}`)).toBe(true);
  });

  it('strips the ending for display and passes everything else through', () => {
    expect(stripKnowledgeFileSuffix('docs/filler.knowledge.md')).toBe('docs/filler');
    expect(stripKnowledgeFileSuffix('docs/manual.md')).toBe('docs/manual.md');
  });

  it('becomes its own ref kind in the dashboard tree, name stripped', () => {
    const tree = buildDashboardTree({
      project: {
        id: 'p1', name: 'Demo', writable: true,
        documents: [{ id: 'd1', path: 'models/machine.glb', name: 'Machine' }],
        knowledge: ['filler.knowledge.md'],
      },
    });
    expect(tree.refs.get('p1/filler.knowledge.md'))
      .toEqual({ kind: 'knowledgeFile', path: 'filler.knowledge.md' });
    const roots = buildProjectTree(tree.roots);
    expect(roots[0]!.children.find(c => c.relPath === 'filler.knowledge.md')?.name)
      .toBe('filler');
  });

  it('rename restores the compound ending, like the config twin', () => {
    const tree = buildDashboardTree({
      project: {
        id: 'p1', name: 'Demo', writable: true, documents: [],
        knowledge: ['filler.knowledge.md'],
      },
    });
    const roots = buildProjectTree(tree.roots);
    const verdict = canRenameInTree(roots, 'p1/filler.knowledge.md', 'sealing');
    expect(verdict).toEqual({
      ok: true, from: 'filler.knowledge.md', to: 'sealing.knowledge.md',
    });
  });
});

describe('stripConnectConfigSuffix — the ending never reaches the user', () => {
  it('removes the suffix, case-insensitively, and keeps the folder half', () => {
    expect(stripConnectConfigSuffix('connect/line1.connect.json')).toBe('connect/line1');
    expect(stripConnectConfigSuffix('Cell2.Connect.JSON')).toBe('Cell2');
  });

  it('passes non-config paths through unchanged', () => {
    expect(stripConnectConfigSuffix('models/machine.glb')).toBe('models/machine.glb');
    expect(stripConnectConfigSuffix('connect/secrets.local.json'))
      .toBe('connect/secrets.local.json');
  });
});

describe('buildDashboardTree — configs become their own ref kind', () => {
  const project = {
    id: 'p1',
    name: 'Demo',
    writable: true,
    documents: [{ id: 'd1', path: 'models/machine.glb', name: 'Machine' }],
    attachments: ['docs/manual.pdf'],
    configs: ['connect/line1.connect.json', 'cell2.connect.json'],
  };

  it('lists every config with kind "connectConfig"', () => {
    const tree = buildDashboardTree({ project });
    expect(tree.refs.get('p1/connect/line1.connect.json'))
      .toEqual({ kind: 'connectConfig', path: 'connect/line1.connect.json' });
    expect(tree.refs.get('p1/cell2.connect.json'))
      .toEqual({ kind: 'connectConfig', path: 'cell2.connect.json' });
    // The other listings keep their kinds — configs are additive.
    expect(tree.refs.get('p1/models/machine.glb')?.kind).toBe('document');
    expect(tree.refs.get('p1/docs/manual.pdf')?.kind).toBe('attachment');
  });

  it('a path already listed as document or attachment is not listed twice', () => {
    const tree = buildDashboardTree({
      project: { ...project, configs: ['docs/manual.pdf', 'cell2.connect.json'] },
    });
    // First listing wins; the config loop must not overwrite the ref kind.
    expect(tree.refs.get('p1/docs/manual.pdf')?.kind).toBe('attachment');
    expect(tree.refs.get('p1/cell2.connect.json')?.kind).toBe('connectConfig');
  });

  it('the dashboard filter applies to configs like to every other row', () => {
    const tree = buildDashboardTree({
      project,
      accept: ({ name }) => name.includes('line1'),
    });
    expect(tree.refs.get('p1/connect/line1.connect.json')).toBeDefined();
    expect(tree.refs.get('p1/cell2.connect.json')).toBeUndefined();
  });

  it('a root-level config becomes an ordinary writable file node', () => {
    const tree = buildDashboardTree({ project });
    const roots = buildProjectTree(tree.roots);
    const node = roots[0]!.children.find(c => c.relPath === 'cell2.connect.json');
    expect(node?.kind).toBe('file');
    expect(node?.writable).toBe(true);
  });

  it('renaming a config restores the COMPOUND ending, whatever was typed', () => {
    const tree = buildDashboardTree({ project });
    const roots = buildProjectTree(tree.roots);
    // The dialog is seeded with the stripped display name — a user typing
    // "line1" must not declassify the file down to "line1.json".
    const verdict = canRenameInTree(roots, 'p1/cell2.connect.json', 'line1');
    expect(verdict).toEqual({ ok: true, from: 'cell2.connect.json', to: 'line1.connect.json' });
    // A name that already carries the ending (any case) is kept verbatim.
    const explicit = canRenameInTree(roots, 'p1/cell2.connect.json', 'Line1.Connect.JSON');
    expect(explicit.ok).toBe(true);
    if (explicit.ok) expect(explicit.to).toBe('Line1.Connect.JSON');
  });

  it('rows and cards show the name WITHOUT the .connect.json ending', () => {
    const tree = buildDashboardTree({ project });
    const roots = buildProjectTree(tree.roots);
    const node = roots[0]!.children.find(c => c.relPath === 'cell2.connect.json');
    expect(node?.name).toBe('cell2');
    // The path keeps the ending — it is the identity, only the display drops it.
    expect(tree.refs.get('p1/cell2.connect.json')?.kind).toBe('connectConfig');
  });
});
