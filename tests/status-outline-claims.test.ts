// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * status-outline-claims.test.ts — plan-2022 Phase 0.
 *
 * The OutlinePass status channel used to hold exactly ONE persistent owner, so
 * a second one silently evicted the first (collision vs. runtime-instruction
 * step highlight — a real defect, measured before the feature that would have
 * made it a third). These tests pin the register that replaced it: same style →
 * union, different style → youngest wins LOUDLY, and taking one claim out
 * disposes exactly that claim's proxies.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { Scene, Mesh, BoxGeometry, MeshBasicMaterial, Group } from 'three';
import type { Object3D } from 'three';
import {
  showStatusOutline,
  hideStatusOutline,
  clearAllStatusOutlines,
  statusOutlineClaimOwners,
  type StatusOutlineHost,
} from '../src/core/engine/rv-status-outline';
import type { RVOutlineManager, OutlineStyle } from '../src/core/engine/rv-outline-manager';

const WARN = 0xffa726;
const PULSE = 0.6;
const INSTRUCTION = 0x9c27b0;

function renderedMesh(name: string): Mesh {
  const m = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
  m.name = name;
  return m;
}

function batchedMesh(name: string): Mesh {
  const m = renderedMesh(name);
  m.layers.mask = 0; // batched source contract: visible = true, mask = 0
  return m;
}

function makeHost() {
  const scene = new Scene();
  const styles: Partial<OutlineStyle>[] = [];
  const outlined: Object3D[][] = [];
  let clears = 0;
  const fake = {
    setStatusStyle: (s: Partial<OutlineStyle>) => styles.push(s),
    setStatusOutlined: (objs: readonly Object3D[]) => outlined.push([...objs]),
    clearStatus: () => { clears++; },
  };
  const host: StatusOutlineHost = { scene, outlineManager: fake as unknown as RVOutlineManager };
  return {
    host, scene, styles, outlined,
    get clears() { return clears; },
    resetRecording() { clears = 0; styles.length = 0; outlined.length = 0; },
  };
}

/** The proxy groups currently parented to the scene (one per batched claim). */
function proxyGroups(scene: Scene): Group[] {
  return scene.children.filter((c) => c.name.startsWith('__statusOutlineProxy_')) as Group[];
}

describe('status outline — claim register (plan-2022 Phase 0)', () => {
  let ctx: ReturnType<typeof makeHost>;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    ctx = makeHost();
    clearAllStatusOutlines(ctx.host);
    // AFTER the reset — `clearAllStatusOutlines` clears the channel itself, and
    // counting that call would make every `clears` assertion off by one.
    ctx.resetRecording();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
    clearAllStatusOutlines(ctx.host);
  });

  it('unions two claims that ask for the same style', () => {
    const a = renderedMesh('A');
    const b = renderedMesh('B');
    ctx.scene.add(a, b);
    showStatusOutline(ctx.host, [a], WARN, { ownerKey: 'collision', pulsePeriod: PULSE });
    showStatusOutline(ctx.host, [b], WARN, { ownerKey: 'drop', pulsePeriod: PULSE });
    expect(ctx.outlined.at(-1)).toEqual([a, b]);
    expect(ctx.styles.at(-1)?.visibleEdgeColor).toBe(WARN);
    expect(statusOutlineClaimOwners()).toEqual(['collision', 'drop']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('REGRESSION: the second claim no longer evicts the first', () => {
    const a = renderedMesh('A');
    const b = renderedMesh('B');
    ctx.scene.add(a, b);
    showStatusOutline(ctx.host, [a], WARN, { ownerKey: 'collision', pulsePeriod: PULSE });
    showStatusOutline(ctx.host, [b], WARN, { ownerKey: 'drop', pulsePeriod: PULSE });
    // Before the register this was `[b]` — the collision silhouette was gone.
    expect(ctx.outlined.at(-1)).toContain(a);
  });

  it('youngest wins on a style conflict, and warns exactly once per pairing', () => {
    const a = renderedMesh('A');
    const b = renderedMesh('B');
    ctx.scene.add(a, b);
    showStatusOutline(ctx.host, [a], WARN, { ownerKey: 'collision', pulsePeriod: PULSE });
    showStatusOutline(ctx.host, [b], INSTRUCTION, { ownerKey: 'instr', pulsePeriod: 0.5 });
    expect(ctx.outlined.at(-1)).toEqual([b]);
    expect(ctx.styles.at(-1)?.visibleEdgeColor).toBe(INSTRUCTION);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('collision');
    // Re-publishing the losing claim must not repeat the warning.
    showStatusOutline(ctx.host, [a], WARN, { ownerKey: 'collision', pulsePeriod: PULSE });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a re-show by the same owner does not make it the youngest', () => {
    const a = renderedMesh('A');
    const b = renderedMesh('B');
    ctx.scene.add(a, b);
    showStatusOutline(ctx.host, [a], WARN, { ownerKey: 'collision', pulsePeriod: PULSE });
    showStatusOutline(ctx.host, [b], INSTRUCTION, { ownerKey: 'instr', pulsePeriod: 0.5 });
    showStatusOutline(ctx.host, [a], WARN, { ownerKey: 'collision', pulsePeriod: PULSE });
    // The instruction still owns the style — a per-tick re-publish must not
    // let the collision keep stealing it back.
    expect(ctx.styles.at(-1)?.visibleEdgeColor).toBe(INSTRUCTION);
    expect(statusOutlineClaimOwners()).toEqual(['collision', 'instr']);
  });

  it('removing one of three claims leaves the other two standing', () => {
    const a = renderedMesh('A');
    const b = renderedMesh('B');
    const c = renderedMesh('C');
    ctx.scene.add(a, b, c);
    showStatusOutline(ctx.host, [a], WARN, { ownerKey: 'collision', pulsePeriod: PULSE });
    showStatusOutline(ctx.host, [b], WARN, { ownerKey: 'drop', pulsePeriod: PULSE });
    showStatusOutline(ctx.host, [c], WARN, { ownerKey: 'third', pulsePeriod: PULSE });
    expect(ctx.outlined.at(-1)).toEqual([a, b, c]);
    hideStatusOutline(ctx.host, 'drop');
    expect(ctx.outlined.at(-1)).toEqual([a, c]);
    expect(ctx.clears).toBe(0);
    expect(statusOutlineClaimOwners()).toEqual(['collision', 'third']);
  });

  it('removing one of three claims disposes exactly its proxies', () => {
    const a = batchedMesh('A');
    const b = batchedMesh('B');
    const c = batchedMesh('C');
    ctx.scene.add(a, b, c);
    showStatusOutline(ctx.host, [a], WARN, { ownerKey: 'collision', pulsePeriod: PULSE });
    showStatusOutline(ctx.host, [b], WARN, { ownerKey: 'drop', pulsePeriod: PULSE });
    showStatusOutline(ctx.host, [c], WARN, { ownerKey: 'third', pulsePeriod: PULSE });
    expect(proxyGroups(ctx.scene).length).toBe(3);
    hideStatusOutline(ctx.host, 'drop');
    const left = proxyGroups(ctx.scene).map((g) => g.name);
    expect(left.length).toBe(2);
    expect(left).toEqual(['__statusOutlineProxy_A', '__statusOutlineProxy_C']);
  });

  it('the last claim leaving clears the channel', () => {
    const a = renderedMesh('A');
    ctx.scene.add(a);
    showStatusOutline(ctx.host, [a], WARN, { ownerKey: 'drop', pulsePeriod: PULSE });
    hideStatusOutline(ctx.host, 'drop');
    expect(ctx.clears).toBe(1);
    expect(statusOutlineClaimOwners()).toEqual([]);
  });

  it('a transient pulse sits on top and restores the UNION when it ends', () => {
    const a = renderedMesh('A');
    const b = renderedMesh('B');
    const p = renderedMesh('P');
    ctx.scene.add(a, b, p);
    showStatusOutline(ctx.host, [a], WARN, { ownerKey: 'collision', pulsePeriod: PULSE });
    showStatusOutline(ctx.host, [b], WARN, { ownerKey: 'drop', pulsePeriod: PULSE });
    showStatusOutline(ctx.host, [p], WARN, { ownerKey: 'pulse', pulsePeriod: PULSE, transient: true });
    expect(ctx.outlined.at(-1)).toEqual([p]);
    hideStatusOutline(ctx.host, 'pulse');
    expect(ctx.clears).toBe(0);
    expect(ctx.outlined.at(-1)).toEqual([a, b]);
  });

  it('a claim registered while a pulse runs shows up when the pulse ends', () => {
    const a = renderedMesh('A');
    const b = renderedMesh('B');
    const p = renderedMesh('P');
    ctx.scene.add(a, b, p);
    showStatusOutline(ctx.host, [a], WARN, { ownerKey: 'collision', pulsePeriod: PULSE });
    showStatusOutline(ctx.host, [p], WARN, { ownerKey: 'pulse', pulsePeriod: PULSE, transient: true });
    showStatusOutline(ctx.host, [b], WARN, { ownerKey: 'drop', pulsePeriod: PULSE });
    expect(ctx.outlined.at(-1)).toEqual([p]);
    hideStatusOutline(ctx.host, 'pulse');
    expect(ctx.outlined.at(-1)).toEqual([a, b]);
  });

  it('clearAllStatusOutlines drops every claim and proxy', () => {
    const a = batchedMesh('A');
    const b = batchedMesh('B');
    ctx.scene.add(a, b);
    showStatusOutline(ctx.host, [a], WARN, { ownerKey: 'collision', pulsePeriod: PULSE });
    showStatusOutline(ctx.host, [b], WARN, { ownerKey: 'drop', pulsePeriod: PULSE });
    clearAllStatusOutlines(ctx.host);
    expect(proxyGroups(ctx.scene).length).toBe(0);
    expect(statusOutlineClaimOwners()).toEqual([]);
  });
});
