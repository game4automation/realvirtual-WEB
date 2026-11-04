// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-628 8.6 (E80–E82) — generated (composition-owned) path content in the REAL viewer with
 * the REAL scene document: blocks built through `layout.path.*`, then marked on their SCENE
 * NODES with `extras.realvirtual.Generated = { owner }` exactly as a generator writes them.
 *  (a) the node marker reaches the snapshot as `owner` (blocks and paths);
 *  (b) remove / move / setParams / replace / reset / junction on a generated block or path are
 *      refused with `composition-owned` — scene and undo history unchanged;
 *  (c) a mixed delete (generated + author block) is refused atomically — by command and by the
 *      UI (selection + Delete key); a mixed Ctrl+C copies only the author block;
 *  (d) indirect writes: attaching at a generated END is refused (E81); an author block in front
 *      of a generated START is fine and stays fully editable (move, delete, undo / redo);
 *  (e) MCP `layout.path.copy` skips generated blocks and names them in `skipped` (E82).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
vi.setConfig({ hookTimeout: 90_000, testTimeout: 120_000 });
import type { Object3D } from 'three';
import { commandRegistry } from '../../src/core/hmi/rv-command-registry';
import { snapshotNetwork } from '../../src/plugins/path-network/path-network-scene';
import {
  blockIdsOf,
  bootRealRig,
  clickPath,
  disposeRealRig,
  execCmd,
  frame,
  key,
  netOf,
  succOf,
  undoLen,
  type RealRig,
} from './path-network-real-rig';

let rig: RealRig | null = null;

afterEach(() => {
  disposeRealRig(rig);
  rig = null;
});

const OWNER = 'palletYard';

/** Mark a block node and its path nodes as generated content (what the generator writes). */
function markGenerated(r: RealRig, blockId: string): void {
  const { input, locator } = snapshotNetwork(r.v as never);
  const reg = r.v.registry as unknown as { getNode(path: string): Object3D | null };
  const nodes = [locator.blockNodes.get(blockId)!, ...input.paths.filter((p) => p.block === blockId).map((p) => locator.pathNodes.get(p.id)!)];
  for (const path of nodes) {
    const n = reg.getNode(path)!;
    const rv = ((n.userData as Record<string, unknown>).realvirtual ??= {}) as Record<string, unknown>;
    rv.Generated = { owner: OWNER };
  }
}

/** Run a command without throwing: ok or the refusal reason. */
async function tryCmd(r: RealRig, id: string, args: Record<string, unknown>): Promise<{ ok: boolean; reason: string; value?: Record<string, unknown> }> {
  const res = await commandRegistry.execute<Record<string, unknown>>(id, args, { origin: 'mcp', viewer: r.v });
  return res.ok ? { ok: true, reason: '', value: res.value as Record<string, unknown> } : { ok: false, reason: String(res.reason) };
}

const fingerprint = (r: RealRig): string => JSON.stringify({
  blocks: (netOf(r).blocks ?? []).map((b) => [b.id, b.extras]),
  paths: netOf(r).paths.map((p) => [p.id, p.block, p.segments, p.successors]),
});

/** Generated straight PN_Block_1 / PN_S1 from (0,0,0) to (4,0,0); author straight PN_Block_2 / PN_S2 far away. */
async function scene(r: RealRig): Promise<void> {
  await execCmd(r, 'layout.path.place', { block: 'straight', lengthM: 4, x: 0, z: 0, headingDeg: 0 });
  await execCmd(r, 'layout.path.place', { block: 'straight', lengthM: 2, x: 0, z: 5, headingDeg: 0 });
  markGenerated(r, 'PN_Block_1');
}

describe('plan-628 8.6 composition-owned path content (real viewer, real document)', () => {
  it('(a) the Generated marker on the scene nodes propagates to owner in the snapshot', async () => {
    const r = rig = await bootRealRig('planner');
    await scene(r);
    const net = netOf(r);
    expect(net.blocks!.find((b) => b.id === 'PN_Block_1')!.owner).toBe(OWNER);
    expect(net.paths.find((p) => p.id === 'PN_S1')!.owner).toBe(OWNER);
    expect(net.blocks!.find((b) => b.id === 'PN_Block_2')!.owner).toBeUndefined();
    expect(net.paths.find((p) => p.id === 'PN_S2')!.owner).toBeUndefined();
    const list = await execCmd(r, 'layout.path.list', {}) as { blocks: { id: string; owner?: string }[] };
    expect(list.blocks.find((b) => b.id === 'PN_Block_1')!.owner).toBe(OWNER);
  });

  it('(b) every write to a generated block or path is refused; scene and undo history unchanged', async () => {
    const r = rig = await bootRealRig('planner');
    await scene(r);
    const before = fingerprint(r);
    const undo0 = undoLen(r);
    for (const [id, args] of [
      ['layout.path.remove', { ids: 'PN_Block_1' }],
      ['layout.path.remove', { ids: 'PN_S1' }],
      ['layout.path.move', { blockId: 'PN_Block_1', dx: 1 }],
      ['layout.path.setParams', { blockId: 'PN_Block_1', lengthM: 6 }],
      ['layout.path.replace', { blockId: 'PN_Block_1', block: 'curve', side: 'right' }],
      ['layout.path.reset', { blockId: 'PN_Block_1' }],
      ['layout.path.junction', { kind: 'stub', pathId: 'PN_S1', s: 2.5 }],
    ] as const) {
      const res = await tryCmd(r, id, args as Record<string, unknown>);
      expect(res.ok, `${id} ${JSON.stringify(args)}`).toBe(false);
      expect(res.reason, id).toContain('composition-owned');
    }
    expect(fingerprint(r)).toBe(before);
    expect(undoLen(r)).toBe(undo0);
  });

  it('(c) a mixed delete is refused atomically (command and UI), a mixed Ctrl+C copies only the author block', async () => {
    const r = rig = await bootRealRig('planner');
    await scene(r);
    const before = fingerprint(r);
    const undo0 = undoLen(r);
    const res = await tryCmd(r, 'layout.path.remove', { ids: 'PN_Block_2,PN_Block_1' });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('composition-owned');
    expect(fingerprint(r)).toBe(before);
    expect(undoLen(r)).toBe(undo0);
    // UI: click the generated block, Shift-click the author block, Delete.
    await clickPath(r, 'PN_S1');
    await clickPath(r, 'PN_S2', { shift: true });
    expect([...r.ui.getState().selectedBlocks].sort()).toEqual(['PN_Block_1', 'PN_Block_2']);
    key('Delete');
    for (let i = 0; i < 30; i++) await frame();
    expect(blockIdsOf(r)).toEqual(['PN_Block_1', 'PN_Block_2']);
    expect(undoLen(r)).toBe(undo0);
    expect(r.ui.getState().lastError ?? '').toContain('composition-owned');
    // Ctrl+C with both selected: only the author block lands in the clipboard.
    expect(r.ui.copySelected()).toBe(1);
  });

  it('(d) attaching at a generated end is refused (E81); an author block before a generated start stays fully editable', async () => {
    const r = rig = await bootRealRig('planner');
    await scene(r);
    const undo0 = undoLen(r);
    const atEnd = await tryCmd(r, 'layout.path.place', { block: 'straight', lengthM: 1, atPath: 'PN_S1', atEnd: 'end' });
    expect(atEnd.ok).toBe(false);
    expect(atEnd.reason).toContain('composition-owned');
    expect(undoLen(r)).toBe(undo0);
    // In front of the generated START: only the author's path is written (its successor → PN_S1).
    const head = await tryCmd(r, 'layout.path.place', { block: 'straight', lengthM: 1, atPath: 'PN_S1', atEnd: 'start' });
    expect(head.ok, head.reason).toBe(true);
    const authorBlock = String((head.value as { blockId?: string }).blockId);
    const authorPath = netOf(r).paths.find((p) => p.block === authorBlock)!.id;
    expect(succOf(r, authorPath)).toEqual(['PN_S1']);
    const gen = JSON.stringify(netOf(r).paths.find((p) => p.id === 'PN_S1'));
    // Move it away: its edge into the generated path is released (author write only).
    const undoBeforeMove = undoLen(r);
    const mv = await tryCmd(r, 'layout.path.move', { blockId: authorBlock, dz: 2 });
    expect(mv.ok, mv.reason).toBe(true);
    expect(succOf(r, authorPath)).toEqual([]);
    expect(undoLen(r)).toBe(undoBeforeMove + 1);
    // Undo / redo of the move.
    await r.doc.undo();
    expect(succOf(r, authorPath)).toEqual(['PN_S1']);
    await r.doc.redo();
    expect(succOf(r, authorPath)).toEqual([]);
    // Delete it, undo restores it.
    const del = await tryCmd(r, 'layout.path.remove', { ids: authorBlock });
    expect(del.ok, del.reason).toBe(true);
    expect(blockIdsOf(r)).not.toContain(authorBlock);
    await r.doc.undo();
    expect(blockIdsOf(r)).toContain(authorBlock);
    // The generated path was never written.
    expect(JSON.stringify(netOf(r).paths.find((p) => p.id === 'PN_S1'))).toBe(gen);
  });

  it('(e) MCP layout.path.copy skips generated blocks and names them in skipped (E82)', async () => {
    const r = rig = await bootRealRig('planner');
    await scene(r);
    const res = await execCmd(r, 'layout.path.copy', { ids: 'PN_Block_1,PN_Block_2' }) as { clip: string; blocks: number; skipped?: string[] };
    expect(res.blocks).toBe(1);
    expect(res.skipped).toEqual(['PN_Block_1']);
    const clip = JSON.parse(res.clip) as { blocks: { id: string }[] };
    expect(clip.blocks.map((b) => b.id)).toEqual(['PN_Block_2']);
    const only = await execCmd(r, 'layout.path.copy', { ids: 'PN_Block_1' }) as { blocks: number; skipped?: string[] };
    expect(only.blocks).toBe(0);
    expect(only.skipped).toEqual(['PN_Block_1']);
  });
});
