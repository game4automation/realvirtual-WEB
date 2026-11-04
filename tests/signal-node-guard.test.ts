// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-610 Phase 2 (9.3, F6) — the signal-node guard.
 *
 * A signal node whose signal name hangs on its node name (`Name` missing or
 * empty, `resolveSignalName`) must not be renamed by a node rename — neither
 * directly nor as the collision auto-rename of a move. The whole action is
 * refused, the document stays unchanged, the message names
 * `editor.signalRename`. With a non-empty `Name` the node renames freely
 * and the signal name stays; a move without a rename is always fine.
 *
 * (The Private callers — `swapSignalComponent`, `web_editor_add_signal` — are
 * covered by tests/signal-node-guard-commands.test.ts in the private WebViewer
 * repo. Named without its folder on purpose: a literal private path in this file
 * would make scripts/gen-private-test-excludes.mjs list it as private-dependent,
 * although it imports nothing private.)
 */
import { describe, it, expect } from 'vitest';
import { scratchAssetDocument } from './helpers/scratch-asset-document';
import { makeSpikeViewer } from './helpers/spike-610-ref-fixture';
import { RenameRefusedError } from '../src/core/editor/rv-asset-document';
import { signalNameFollowsNodeName } from '../src/core/engine/rv-signal-construction';

function signalFixture() {
  const f = makeSpikeViewer({ signals: true });
  const signals = f.add(f.model, 'Signals');
  const bare = f.signalNode(signals, 'Bare');            // no Name → name = node name
  const empty = f.signalNode(signals, 'Empty', '');      // Name: '' → name = node name
  const named = f.signalNode(signals, 'Named', 'DB.Go'); // explicit symbol
  const target = f.add(f.model, 'Target');
  // Collision partners under the target.
  f.add(target, 'Bare');
  f.add(target, 'Named');
  f.register();
  return { ...f, signals, bare, empty, named, target };
}

describe('plan-610 F6 — signalNameFollowsNodeName', () => {
  it('true for a missing or empty Name, false for an explicit one and for plain nodes', () => {
    const f = signalFixture();
    expect(signalNameFollowsNodeName(f.bare)).toBe(true);
    expect(signalNameFollowsNodeName(f.empty)).toBe(true);
    expect(signalNameFollowsNodeName(f.named)).toBe(false);
    expect(signalNameFollowsNodeName(f.target)).toBe(false);
  });
});

describe('plan-610 F6 — direct rename of a name-dependent signal node is refused', () => {
  for (const which of ['bare', 'empty'] as const) {
    it(`${which}: rejected with editor.signalRename, document unchanged`, async () => {
      const f = signalFixture();
      const node = f[which];
      const path = `Asset/Signals/${node.name}`;
      const signalName = node.name;
      expect(f.store!.getPath(signalName)).toBe(path);
      const doc = scratchAssetDocument(f.viewer);
      const err = await doc.renameNodeAwaited(path, 'Renamed').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RenameRefusedError);
      expect((err as RenameRefusedError).reason).toBe('signal-node');
      expect((err as Error).message).toContain('editor.signalRename');
      expect(node.name).toBe(signalName);
      expect(doc.ops).toHaveLength(0);
      expect(f.store!.getPath(signalName)).toBe(path);
      doc.dispose();
    });
  }

  it('the void renameNode logs and does nothing (also inside a transaction, which still commits)', async () => {
    const f = signalFixture();
    const doc = scratchAssetDocument(f.viewer);
    await doc.withTransaction('Mixed', async () => {
      doc.renameNode('Asset/Signals/Bare', 'Renamed', 'Bare');
      doc.renameNode('Asset/Target', 'Target2', 'Target');
    });
    expect(f.bare.name).toBe('Bare');
    expect(f.target.name).toBe('Target2');
    expect(doc.ops).toHaveLength(1);
    doc.dispose();
  });
});

describe('plan-610 F6 — a move that would auto-rename such a node is refused as a whole', () => {
  it('reparentNodes: refused, nothing moved (also the other, harmless member)', async () => {
    const f = signalFixture();
    const doc = scratchAssetDocument(f.viewer);
    await expect(doc.reparentNodes(['Asset/Signals/Empty', 'Asset/Signals/Bare'], 'Asset/Target'))
      .rejects.toMatchObject({ reason: 'signal-node' });
    expect(f.bare.parent).toBe(f.signals);
    expect(f.empty.parent).toBe(f.signals);
    expect(f.bare.name).toBe('Bare');
    expect(doc.ops).toHaveLength(0);
    doc.dispose();
  });

  it('reparentNodesBatch: refused, nothing moved', async () => {
    const f = signalFixture();
    const doc = scratchAssetDocument(f.viewer);
    const err = await doc.reparentNodesBatch(['Asset/Signals/Bare'], 'Asset/Target').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RenameRefusedError);
    expect((err as Error).message).toContain('editor.signalRename');
    expect(f.bare.parent).toBe(f.signals);
    expect(doc.ops).toHaveLength(0);
    doc.dispose();
  });
});

describe('plan-610 F6 — what stays allowed', () => {
  it('a signal node WITH a Name renames; the signal name stays, its path follows', async () => {
    const f = signalFixture();
    const doc = scratchAssetDocument(f.viewer);
    const res = await doc.renameNodeAwaited('Asset/Signals/Named', 'GoNode');
    expect(res.path).toBe('Asset/Signals/GoNode');
    expect(f.store!.getPath('DB.Go')).toBe('Asset/Signals/GoNode');
    expect(f.store!.get('GoNode')).toBeUndefined();
    await doc.undo();
    expect(f.store!.getPath('DB.Go')).toBe('Asset/Signals/Named');
    doc.dispose();
  });

  it('moving a name-dependent signal node WITHOUT a collision is fine (name unchanged)', async () => {
    const f = signalFixture();
    const doc = scratchAssetDocument(f.viewer);
    const moved = await doc.reparentNodes(['Asset/Signals/Empty'], 'Asset/Target');
    expect(moved).toEqual(['Asset/Target/Empty']);
    expect(f.empty.name).toBe('Empty');
    expect(f.store!.getPath('Empty')).toBe('Asset/Target/Empty');
    doc.dispose();
  });

  it('a named signal node colliding under the target is auto-renamed (its signal name is its Name)', async () => {
    const f = signalFixture();
    const doc = scratchAssetDocument(f.viewer);
    const res = await doc.reparentNodesDetailed(['Asset/Signals/Named'], 'Asset/Target');
    expect(res.moved).toEqual(['Asset/Target/Named_1']);
    expect(f.store!.getPath('DB.Go')).toBe('Asset/Target/Named_1');
    doc.dispose();
  });
});
