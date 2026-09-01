// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Test 9.2 of plan-733 — the `Chain` component lifecycle.
 *
 * What matters here is not "was a method called" but the state of the SCENE
 * GRAPH afterwards: how many element nodes exist, what they carry, and what a
 * later save would find. Three of the tests below encode findings the plan
 * review made explicit (R4 authoring, R13 inert fallbacks, R14 edge cases).
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { Object3D } from 'three';
import { constructComponentOnNode } from '../src/core/engine/rv-scene-loader';
import { RVChain } from '../src/core/engine/rv-chain';
import { RV_CHAIN_ELEMENT } from '../src/core/engine/rv-traverse-utils';
import { pruneRuntimeHelpers } from '../src/core/editor/rv-asset-glb-export';
import { chainHarness, straightSpline, transformRef, type ChainHarness } from './chain-fixture';

/** Build the component through the loader path that constructs immediately. */
function build(h: ChainHarness, overrides: Record<string, unknown> = {}): RVChain {
  const data = h.chainExtras(overrides);
  h.chain.userData.realvirtual = { Chain: data };
  return constructComponentOnNode(h.deps, h.chain, 'Chain', data) as RVChain;
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { warn.mockRestore(); });

describe('Chain element construction', () => {
  it('clones the template NumberOfElements times and registers with the manager', () => {
    const h = chainHarness();
    const chain = build(h, { NumberOfElements: 4 });

    expect(chain.isActive).toBe(true);
    expect(chain.elements).toHaveLength(4);
    expect(h.chainManager.size).toBe(1);
    // The template survives alongside the clones.
    expect(h.chain.children).toContain(h.template);
    expect(h.chain.children).toHaveLength(5);
    expect(chain.elements.map((e) => e.name)).toEqual(['Carrier_1', 'Carrier_2', 'Carrier_3', 'Carrier_4']);
  });

  it('strips the cloned rv_extras and stamps the runtime marker', () => {
    const h = chainHarness();
    const chain = build(h);
    for (const element of chain.elements) {
      // Object3D.clone() JSON-round-trips userData — without the strip these
      // clones would be re-instantiated as live ChainElements by processExtras.
      expect(element.userData.realvirtual).toBeUndefined();
      expect(element.userData[RV_CHAIN_ELEMENT]).toBe(true);
      // The clone root is the node posed every tick: its matrix must be rebuilt.
      expect(element.matrixAutoUpdate).toBe(true);
    }
    // The template keeps its authored extras.
    expect(h.template.userData.realvirtual).toBeDefined();
  });

  it('spaces the elements by the calculated pitch (length / N)', () => {
    // 2 m curve, 4 elements => 500 mm pitch => 0.5 m along +Z.
    const h = chainHarness();
    const chain = build(h, { NumberOfElements: 4, CalculatedDeltaPosition: true });
    expect(chain.lengthMm).toBeCloseTo(2000, 6);
    expect(chain.deltaPositionMm).toBeCloseTo(500, 6);
    const z = chain.elements.map((e) => e.position.z);
    expect(z[0]).toBeCloseTo(0, 6);
    expect(z[1]).toBeCloseTo(0.5, 6);
    expect(z[2]).toBeCloseTo(1.0, 6);
    expect(z[3]).toBeCloseTo(1.5, 6);
  });

  it('honours a manual DeltaPosition and StartPosition', () => {
    const h = chainHarness();
    const chain = build(h, {
      NumberOfElements: 2,
      CalculatedDeltaPosition: false,
      DeltaPosition: 200,
      StartPosition: 100,
    });
    expect(chain.deltaPositionMm).toBe(200);
    expect(chain.elements[0].position.z).toBeCloseTo(0.1, 6);
    expect(chain.elements[1].position.z).toBeCloseTo(0.3, 6);
  });
});

describe('Chain guards and inert fallbacks (F5)', () => {
  it('builds nothing for NumberOfElements 0 and stays crash-free', () => {
    const h = chainHarness();
    const chain = build(h, { NumberOfElements: 0 });
    expect(chain.elements).toHaveLength(0);
    expect(chain.deltaPositionMm).toBe(0);
    expect(() => chain.updatePose()).not.toThrow();
    expect(chain.updatePose()).toBe(false);
  });

  it('builds exactly one element for NumberOfElements 1', () => {
    const h = chainHarness();
    const chain = build(h, { NumberOfElements: 1 });
    expect(chain.elements).toHaveLength(1);
    // delta = length / 1; with a single element it is never applied.
    expect(chain.elements[0].position.z).toBeCloseTo(0, 6);
  });

  it('goes inert with a warning when the Spline block is missing or degenerate', () => {
    for (const spline of [undefined, { closed: false, length: 1, samples: [0, 0, 0, 0, 0, 1, 0, 1, 0] }]) {
      const h = chainHarness();
      const chain = build(h, { Spline: spline });
      expect(chain.isActive).toBe(false);
      expect(chain.elements).toHaveLength(0);
      expect(chain.updatePose()).toBe(false);
    }
    expect(warn).toHaveBeenCalled();
  });

  it('goes inert with a warning when the ChainElement template cannot be resolved', () => {
    const h = chainHarness();
    const chain = build(h, { ChainElement: transformRef('Root/DoesNotExist') });
    expect(chain.isActive).toBe(false);
    expect(chain.elements).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
  });

  it('still places the elements when ConnectedDrive is unresolvable, but never moves them', () => {
    const h = chainHarness();
    const chain = build(h, { ConnectedDrive: null, NumberOfElements: 3 });
    expect(chain.elements).toHaveLength(3);
    expect(chain.elements[1].position.z).toBeCloseTo(2 / 3, 6);
    // No drive => the position never changes, so no tick ever reports movement.
    expect(chain.updatePose()).toBe(false);
    expect(warn).toHaveBeenCalled();
  });
});

describe('Chain drops stale editor-generated elements', () => {
  it('removes children named <prefix>_<n>, tolerating _N and (N) suffixes', () => {
    const h = chainHarness();
    for (const name of ['Carrier_1', 'Carrier_2_1', 'Carrier_3 (1)', 'Carrier_4(2)']) {
      const stale = new Object3D();
      stale.name = name;
      h.chain.add(stale);
    }
    const chain = build(h, { NumberOfElements: 2 });
    // 1 template + 2 fresh clones — every stale node is gone.
    expect(h.chain.children).toHaveLength(3);
    expect(chain.elements).toHaveLength(2);
  });

  it('never drops the template itself, even when its name matches', () => {
    const h = chainHarness();
    h.template.name = 'Carrier_1';
    h.registry.registerNode('Root/Chain/Carrier_1', h.template);
    const chain = build(h, {
      NumberOfElements: 1,
      ChainElement: transformRef('Root/Chain/Carrier_1'),
    });
    expect(h.chain.children).toContain(h.template);
    expect(chain.elements).toHaveLength(1);
  });

  it('leaves user nodes that do not follow the convention alone', () => {
    const h = chainHarness();
    const keep = new Object3D();
    keep.name = 'Guardrail_left'; // matches no <prefix>_<digits> pattern
    const keep2 = new Object3D();
    keep2.name = 'CarrierFrame_2'; // different prefix
    h.chain.add(keep, keep2);
    build(h, { NumberOfElements: 1 });
    expect(h.chain.children).toContain(keep);
    expect(h.chain.children).toContain(keep2);
  });
});

describe('Chain in an authoring load (R4)', () => {
  it('never clones while ComponentContext.authoring is set', () => {
    const h = chainHarness();
    const chain = new RVChain(h.chain);
    Object.assign(chain, h.chainExtras({ NumberOfElements: 6 }));
    const ctx = {
      registry: h.registry, signalStore: h.signalStore, scene: h.scene,
      transportManager: h.transportManager, root: h.root,
      chainManager: h.chainManager,
      expectSceneReady: true,
      authoring: true,
    };
    chain.init(ctx as never);
    chain.onSceneReady(ctx as never);

    expect(chain.elements).toHaveLength(0);
    // Nothing was added to the document, so a save writes the template only.
    expect(h.chain.children).toEqual([h.template]);
  });

  it('does not DELETE authored elements either — an authoring load touches nothing', () => {
    const h = chainHarness();
    const authored = new Object3D();
    authored.name = 'Carrier_1'; // matches the generated-element convention
    h.chain.add(authored);

    const chain = new RVChain(h.chain);
    Object.assign(chain, h.chainExtras({ NumberOfElements: 6 }));
    const ctx = {
      registry: h.registry, signalStore: h.signalStore, scene: h.scene,
      transportManager: h.transportManager, root: h.root,
      chainManager: h.chainManager, expectSceneReady: true, authoring: true,
    };
    chain.init(ctx as never);
    chain.onSceneReady(ctx as never);

    // Pruning it would silently drop the node from the next save.
    expect(h.chain.children).toContain(authored);
    // And the chain does not occupy a tick slot it has nothing to do in.
    expect(h.chainManager.size).toBe(0);
  });

  it('has its clones pruned by pruneRuntimeHelpers as the second line of defence', () => {
    const h = chainHarness();
    const chain = build(h, { NumberOfElements: 3 });
    expect(chain.elements).toHaveLength(3);
    // Simulate the export path seeing a tree from a SIMULATING load.
    pruneRuntimeHelpers(h.root);
    expect(h.chain.children).toEqual([h.template]);
  });
});

describe('Chain teardown', () => {
  it('dispose() removes every clone and unregisters from the manager', () => {
    const h = chainHarness();
    const chain = build(h, { NumberOfElements: 5 });
    const clones = [...chain.elements];
    chain.dispose();

    expect(chain.elements).toHaveLength(0);
    expect(h.chainManager.size).toBe(0);
    for (const clone of clones) expect(clone.parent).toBeNull();
    expect(h.chain.children).toEqual([h.template]);
    expect(chain.updatePose()).toBe(false);
  });

  it('manager clear() disposes every chain (model switch)', () => {
    const h = chainHarness({ spline: straightSpline(3, 7) });
    build(h, { NumberOfElements: 4 });
    expect(h.chainManager.size).toBe(1);
    h.chainManager.clear();
    expect(h.chainManager.size).toBe(0);
    expect(h.chain.children).toEqual([h.template]);
  });
});
