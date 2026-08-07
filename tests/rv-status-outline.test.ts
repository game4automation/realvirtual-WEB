// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, beforeEach } from 'vitest';
import { Scene, Mesh, BoxGeometry, Group, MeshBasicMaterial } from 'three';
import type { Object3D } from 'three';
import {
  hasRenderedMesh,
  resolveOutlineTargets,
  makeStatusOutlineStyle,
  darkenColor,
  showStatusOutline,
  hideStatusOutline,
  clearAllStatusOutlines,
  type StatusOutlineHost,
} from '../src/core/engine/rv-status-outline';
import type { RVOutlineManager, OutlineStyle } from '../src/core/engine/rv-outline-manager';
import { NO_AO_LAYER } from '../src/core/engine/rv-constants';

function renderedMesh(): Mesh {
  return new Mesh(new BoxGeometry(), new MeshBasicMaterial());
}

function batchedMesh(): Mesh {
  const m = renderedMesh();
  m.layers.mask = 0; // batched source contract: visible=true, mask=0
  return m;
}

interface FakeOutlineManager {
  styles: Partial<OutlineStyle>[];
  outlined: Object3D[][];
  clears: number;
}

function makeHost(): { host: StatusOutlineHost; om: FakeOutlineManager; scene: Scene } {
  const scene = new Scene();
  const om: FakeOutlineManager = { styles: [], outlined: [], clears: 0 };
  const fake = {
    setStatusStyle: (s: Partial<OutlineStyle>) => om.styles.push(s),
    setStatusOutlined: (objs: readonly Object3D[]) => om.outlined.push([...objs]),
    clearStatus: () => om.clears++,
  };
  const host: StatusOutlineHost = { scene, outlineManager: fake as unknown as RVOutlineManager };
  return { host, om, scene };
}

describe('rv-status-outline', () => {
  let ctx: ReturnType<typeof makeHost>;
  beforeEach(() => {
    ctx = makeHost();
    clearAllStatusOutlines(ctx.host);
    ctx.om.clears = 0;
    ctx.om.styles.length = 0;
    ctx.om.outlined.length = 0;
  });

  describe('hasRenderedMesh', () => {
    it('true for a rendered mesh, false for a batched (mask 0) mesh', () => {
      expect(hasRenderedMesh(renderedMesh())).toBe(true);
      expect(hasRenderedMesh(batchedMesh())).toBe(false);
    });
  });

  describe('resolveOutlineTargets', () => {
    it('passes rendered subtrees through unchanged', () => {
      const n = renderedMesh();
      ctx.scene.add(n);
      const { targets, dispose } = resolveOutlineTargets(ctx.scene, [n]);
      expect(targets).toEqual([n]);
      dispose(); // no proxies — must not throw or touch the node
      expect(n.parent).toBe(ctx.scene);
    });

    it('wraps batched subtrees in an invisible proxy group on NO_AO_LAYER', () => {
      const n = batchedMesh();
      ctx.scene.add(n);
      const { targets, dispose } = resolveOutlineTargets(ctx.scene, [n]);
      expect(targets.length).toBe(1);
      const group = targets[0] as Group;
      expect(group).not.toBe(n);
      expect(group.parent).toBe(ctx.scene);
      expect(group.children.length).toBe(1);
      const proxy = group.children[0] as Mesh;
      expect(proxy.geometry).toBe(n.geometry); // shared geometry, no copy
      expect(proxy.layers.mask).toBe(1 << NO_AO_LAYER);
      const mat = proxy.material as MeshBasicMaterial;
      expect(mat.colorWrite).toBe(false);
      expect(mat.depthWrite).toBe(false);
      expect(proxy.castShadow).toBe(false);
      expect(proxy.userData._highlightOverlay).toBe(true);
      dispose();
      expect(group.parent).toBeNull(); // proxies removed, source untouched
      expect(n.parent).toBe(ctx.scene);
      expect(n.layers.mask).toBe(0); // batched source contract preserved
    });

    it('skips nodes with no meshes at all', () => {
      const empty = new Group();
      ctx.scene.add(empty);
      const { targets } = resolveOutlineTargets(ctx.scene, [empty]);
      expect(targets.length).toBe(0);
    });
  });

  describe('makeStatusOutlineStyle', () => {
    it('uses the color, a darkened hidden edge and the given pulse period', () => {
      const s = makeStatusOutlineStyle(0xffb300, 0.5);
      expect(s.visibleEdgeColor).toBe(0xffb300);
      expect(s.hiddenEdgeColor).toBe(darkenColor(0xffb300, 0.55));
      expect(s.pulsePeriod).toBe(0.5);
    });
  });

  describe('show/hide with owner tracking', () => {
    it('persistent show applies style + outlined; hide by owner clears', () => {
      const n = renderedMesh();
      ctx.scene.add(n);
      showStatusOutline(ctx.host, [n], 0x9c27b0, { ownerKey: 'instr', pulsePeriod: 0.5 });
      expect(ctx.om.styles.at(-1)?.visibleEdgeColor).toBe(0x9c27b0);
      expect(ctx.om.outlined.at(-1)).toEqual([n]);
      hideStatusOutline(ctx.host, 'instr');
      expect(ctx.om.clears).toBe(1);
    });

    it('hide with a stale/unknown owner is a no-op', () => {
      const n = renderedMesh();
      ctx.scene.add(n);
      showStatusOutline(ctx.host, [n], 0xe53935, { ownerKey: 'a' });
      hideStatusOutline(ctx.host, 'somebody-else');
      expect(ctx.om.clears).toBe(0);
    });

    it('transient pulse restores the persistent outline when it ends', () => {
      const a = renderedMesh();
      const b = renderedMesh();
      ctx.scene.add(a, b);
      showStatusOutline(ctx.host, [a], 0x9c27b0, { ownerKey: 'instr', pulsePeriod: 0.5 });
      showStatusOutline(ctx.host, [b], 0xffa726, { ownerKey: 'pulse', pulsePeriod: 0.6, transient: true });
      expect(ctx.om.outlined.at(-1)).toEqual([b]); // pulse on top
      hideStatusOutline(ctx.host, 'pulse');
      expect(ctx.om.clears).toBe(0); // NOT cleared — persistent restored
      expect(ctx.om.outlined.at(-1)).toEqual([a]);
      expect(ctx.om.styles.at(-1)?.visibleEdgeColor).toBe(0x9c27b0);
    });

    it('transient pulse ends with no persistent outline -> channel cleared', () => {
      const b = renderedMesh();
      ctx.scene.add(b);
      showStatusOutline(ctx.host, [b], 0xffa726, { ownerKey: 'pulse', transient: true });
      hideStatusOutline(ctx.host, 'pulse');
      expect(ctx.om.clears).toBe(1);
    });

    it('persistent show during a transient pulse defers until the pulse ends', () => {
      const a = renderedMesh();
      const b = renderedMesh();
      ctx.scene.add(a, b);
      showStatusOutline(ctx.host, [b], 0xffa726, { ownerKey: 'pulse', transient: true });
      showStatusOutline(ctx.host, [a], 0x9c27b0, { ownerKey: 'instr' });
      expect(ctx.om.outlined.at(-1)).toEqual([b]); // pulse stays on top
      hideStatusOutline(ctx.host, 'pulse');
      expect(ctx.om.outlined.at(-1)).toEqual([a]); // then the instruction shows
    });

    it('proxies of a replaced persistent outline are removed from the scene', () => {
      const n = batchedMesh();
      ctx.scene.add(n);
      showStatusOutline(ctx.host, [n], 0x9c27b0, { ownerKey: 'instr' });
      const firstGroup = ctx.om.outlined.at(-1)![0];
      expect(firstGroup.parent).toBe(ctx.scene);
      showStatusOutline(ctx.host, [n], 0x9c27b0, { ownerKey: 'instr' }); // re-show (step nav)
      expect(firstGroup.parent).toBeNull(); // old proxies gone
      hideStatusOutline(ctx.host, 'instr');
      expect(ctx.om.outlined.at(-1)![0].parent).toBeNull();
    });
  });
});
