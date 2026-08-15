// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * glb-reference-trust.test.ts — plan-397 Phase 3b, plan §9.10. Blocker-2 regression.
 *
 * Before this plan, `logicGated` was ONE flag derived from the top-level file's
 * signature and applied to every component in the scene. With references that is
 * a privilege escalation: whoever can put an unsigned GLB where a signed scene
 * points would have their logic executed under the signed scene's trust.
 *
 * The rule these tests pin down:
 *
 *  - trust never flows downhill — a frame's effective state is the WEAKEST along
 *    its resolution path;
 *  - a broken state (`invalid` / `unverifiable`) gates, as it always did;
 *  - a signed root additionally gates anything below it that is not itself
 *    signed, because that is exactly the dilution the attack relies on;
 *  - an UNSIGNED root behaves exactly as before — nothing claimed trust there,
 *    so nothing is taken away;
 *  - `allowUntrustedLogic` is the user's explicit release and overrides all of it.
 */

import { describe, it, expect } from 'vitest';
import { Scene, Group, Mesh, BoxGeometry, MeshStandardMaterial, Object3D } from 'three';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { loadGLB } from '../src/core/engine/rv-scene-loader';
import { setAssetReference } from '../src/core/engine/rv-asset-reference';
import {
  compose, collectGatedNodes, isFrameGated, weakestSignatureState,
  type ReferenceResolver,
} from '../src/core/engine/rv-glb-compose';
import type { SignatureState } from '../src/core/persistence/rv-sig-verify';

const material = new MeshStandardMaterial({ color: 0x8899aa });

function meshNamed(name: string, extras?: Record<string, unknown>): Mesh {
  const mesh = new Mesh(new BoxGeometry(1, 1, 1), material);
  mesh.name = name;
  if (extras) mesh.userData.realvirtual = extras;
  return mesh;
}

function referenceNode(name: string, assetId: string): Object3D {
  const node = new Object3D();
  node.name = name;
  setAssetReference(node, { assetId });
  return node;
}

function findByName(root: Object3D, name: string): Object3D | null {
  let found: Object3D | null = null;
  root.traverse((n) => { if (!found && n.name === name) found = n; });
  return found;
}

/**
 * An asset whose only job is to carry logic that either runs or does not.
 *
 * A `Sensor` rather than a `Drive`, because `RVSensor.init()` has an observable
 * effect (`onChanged` is only wired there) while `RVDrive.init()` is a no-op —
 * a component that cannot tell the two states apart cannot test a gate.
 */
function buildLogicAsset(name: string, sensorName: string): Group {
  const root = new Group();
  root.name = name;
  root.add(meshNamed(sensorName, { Sensor: { UseRaycast: false } }));
  root.add(meshNamed(`${name}_Body`));
  return root;
}

/** The `RVSensor` at `nodeName`, or null. */
function sensorAt(registry: { getAll: (t: string) => { path: string; instance: unknown }[] }, nodeName: string): { onChanged?: unknown } | null {
  const hit = registry.getAll('Sensor').find((e) => e.path.split('/').pop() === nodeName);
  return (hit?.instance as { onChanged?: unknown }) ?? null;
}

/** A table-driven resolver where each asset carries its own signature state. */
function stateResolver(table: Record<string, { bytes: ArrayBuffer; state: SignatureState }>): ReferenceResolver {
  return async (ref) => {
    const hit = table[ref.assetId];
    if (!hit) return null;
    return {
      bytes: hit.bytes,
      url: `lib/${ref.assetId}.glb`,
      sha256: `sha-${ref.assetId}`,
      signatureState: hit.state,
      signaturePresent: hit.state === 'valid' || hit.state === 'invalid',
    };
  };
}

// ─── The rule itself ─────────────────────────────────────────────────────

describe('weakestSignatureState', () => {
  it('orders invalid < unverifiable < none < valid', () => {
    expect(weakestSignatureState('valid', 'none')).toBe('none');
    expect(weakestSignatureState('none', 'unverifiable')).toBe('unverifiable');
    expect(weakestSignatureState('unverifiable', 'invalid')).toBe('invalid');
    expect(weakestSignatureState('valid', 'valid')).toBe('valid');
  });
});

describe('isFrameGated', () => {
  it('leaves an unsigned scene behaving exactly as before', () => {
    // The whole pre-existing corpus is unsigned. Gating it now would break every
    // model that works today, for no security gain — nothing claimed trust.
    expect(isFrameGated('none', 'none', false)).toBe(false);
  });

  it('gates a broken signature regardless of the root', () => {
    expect(isFrameGated('invalid', 'none', false)).toBe(true);
    expect(isFrameGated('unverifiable', 'none', false)).toBe(true);
  });

  it('gates an unsigned frame inside a SIGNED root', () => {
    expect(isFrameGated('none', 'valid', false)).toBe(true);
  });

  it('does not gate a signed frame inside a signed root', () => {
    expect(isFrameGated('valid', 'valid', false)).toBe(false);
  });

  it('is released by allowUntrustedLogic — the user decision, as today', () => {
    expect(isFrameGated('invalid', 'valid', true)).toBe(false);
    expect(isFrameGated('none', 'valid', true)).toBe(false);
  });
});

// ─── The chain, over a real composition ──────────────────────────────────

describe('Vertrauenskette über eine echte Composition', () => {
  it('führt in einer signierten Wurzel KEINE Logik einer unsignierten Referenz aus', async () => {
    const unsigned = await objectToGlb(buildLogicAsset('Unsigned', 'Sensor_A'));
    const plant = new Group();
    plant.name = 'Plant';
    plant.add(meshNamed('Floor'));
    plant.add(referenceNode('UnsignedRef', 'unsigned'));

    const result = await compose(plant, {
      baseUrl: 'plant.glb',
      signatureState: 'valid',
      signaturePresent: true,
      resolve: stateResolver({ unsigned: { bytes: unsigned, state: 'none' } }),
    });

    const gated = result.frames.filter((f) => isFrameGated(f.effectiveState, 'valid', false));
    expect(gated).toHaveLength(1);

    const gatedNodes = collectGatedNodes(result, 'valid', false);
    expect(gatedNodes.has(findByName(plant, 'Sensor_A')!)).toBe(true);
    // The scene's OWN nodes keep their trust — the gate is per subtree.
    expect(gatedNodes.has(findByName(plant, 'Floor')!)).toBe(false);
    result.dispose();
  });

  it('vergibt den schwächsten Status entlang des Auflösungspfads', async () => {
    // signed → unsigned → signed: the innermost file is signed, yet it is only
    // reachable THROUGH an unsigned one, so it stays gated.
    const innerTree = buildLogicAsset('Inner', 'InnerSensor');
    const inner = await objectToGlb(innerTree);
    const middleTree = buildLogicAsset('Middle', 'MiddleSensor');
    middleTree.add(referenceNode('InnerRef', 'inner'));
    const middle = await objectToGlb(middleTree);

    const plant = new Group();
    plant.name = 'Plant';
    plant.add(meshNamed('Floor'));
    plant.add(referenceNode('MiddleRef', 'middle'));

    const result = await compose(plant, {
      baseUrl: 'plant.glb',
      signatureState: 'valid',
      signaturePresent: true,
      resolve: stateResolver({
        middle: { bytes: middle, state: 'none' },
        inner: { bytes: inner, state: 'valid' },
      }),
    });

    const innerFrame = result.frames.find((f) => f.assetId === 'inner')!;
    expect(innerFrame.ownSignatureState).toBe('valid');
    expect(innerFrame.effectiveState).toBe('none');
    expect(isFrameGated(innerFrame.effectiveState, 'valid', false)).toBe(true);
    result.dispose();
  });

  it('erlaubt Ausführung nach expliziter Freigabe (allowUntrustedLogic)', async () => {
    const unsigned = await objectToGlb(buildLogicAsset('Unsigned', 'Sensor_A'));
    const plant = new Group();
    plant.name = 'Plant';
    plant.add(referenceNode('UnsignedRef', 'unsigned'));

    const result = await compose(plant, {
      baseUrl: 'plant.glb',
      signatureState: 'valid',
      resolve: stateResolver({ unsigned: { bytes: unsigned, state: 'none' } }),
    });
    expect(collectGatedNodes(result, 'valid', true).size).toBe(0);
    result.dispose();
  });
});

// ─── End to end through loadGLB ──────────────────────────────────────────

describe('Vertrauenskette im Ladepfad', () => {
  it('initialisiert die Komponenten eines manipulierten referenzierten GLBs nicht', async () => {
    // An unsigned root — today's normal case — plus a referenced file whose
    // signature does not verify. The root's own logic must still run; the
    // tampered file's must not.
    const tampered = await objectToGlb(buildLogicAsset('Tampered', 'BadSensor'));
    const plantTree = new Group();
    plantTree.name = 'Plant';
    plantTree.add(meshNamed('GoodSensor', { Sensor: { UseRaycast: false } }));
    plantTree.add(referenceNode('TamperedRef', 'tampered'));
    const plantBytes = await objectToGlb(plantTree);

    const scene = new Scene();
    const result = await loadGLB('plant.glb', scene, {
      data: plantBytes,
      preserveHierarchy: true,
      loadKinematicsSidecar: false,
      referenceResolver: stateResolver({ tampered: { bytes: tampered, state: 'invalid' } }),
    });

    expect(result.logicGated).toBe(false); // the ROOT is fine
    expect(result.gatedFrames).toHaveLength(1);
    expect(result.gatedFrames[0].assetId).toBe('tampered');

    // Both components were CONSTRUCTED — the tree is complete either way. Only
    // `init()` was withheld from the untrusted one, which is exactly what the
    // wired/unwired `onChanged` shows.
    expect(sensorAt(result.registry, 'GoodSensor')?.onChanged).toBeTypeOf('function');
    expect(sensorAt(result.registry, 'BadSensor')).not.toBeNull();
    expect(sensorAt(result.registry, 'BadSensor')?.onChanged).toBeUndefined();
  });

  it('initialisiert eine vertrauenswürdige Referenz normal', async () => {
    const trusted = await objectToGlb(buildLogicAsset('Trusted', 'GoodRefSensor'));
    const plantTree = new Group();
    plantTree.name = 'Plant';
    plantTree.add(meshNamed('Floor'));
    plantTree.add(referenceNode('TrustedRef', 'trusted'));
    const plantBytes = await objectToGlb(plantTree);

    const scene = new Scene();
    const result = await loadGLB('plant.glb', scene, {
      data: plantBytes,
      preserveHierarchy: true,
      loadKinematicsSidecar: false,
      referenceResolver: stateResolver({ trusted: { bytes: trusted, state: 'none' } }),
    });

    expect(result.gatedFrames).toHaveLength(0);
    expect(sensorAt(result.registry, 'GoodRefSensor')?.onChanged).toBeTypeOf('function');
  });
});
