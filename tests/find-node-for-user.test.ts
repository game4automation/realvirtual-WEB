// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-769 9.16 — `NodeRegistry.findNodeForUser(path)` (F9): a PATH as a person or
 * a caller types it — runtime registry path → AUTHORED path of the file it lies in →
 * exact legacy Three.js spelling → (until plan-770) a guessing stage, flagged and
 * warned. An address comes back for the authored / legacy hits — what a writer
 * stores (Phase 3). An ambiguous authored path is no hit at all.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Scene } from 'three';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';
import { identityIdOf } from '../src/core/engine/rv-decode-identity';
import { box, buildMauserCoreGlb, driveNodeBySpeed, node, sceneToGlb } from './helpers/migrate-769-fixtures';
import { INNER_URL, OUTER_URL, bootNestedViewer, documentBytes, findByName, type Booted } from './helpers/nested-placement-fixture';

describe('plan-769 9.16 — findNodeForUser', () => {
  let h: TestViewerHandle | null = null;
  let booted: Booted | null = null;
  afterEach(() => { h?.dispose(); h = null; booted?.h.dispose(); booted = null; vi.restoreAllMocks(); });

  it('runtime → authored → legacy Three spelling, each with its address', async () => {
    h = await createTestViewer('webgl');
    await h.viewer.loadModel('mauser-core.glb', { data: await buildMauserCoreGlb() });
    const reg = h.viewer.registry!;
    const sep = driveNodeBySpeed(h.viewer.currentModelRoot!, 222)!;
    // 1. The runtime path as the hierarchy shows it.
    expect(reg.findNodeForUser('Cell/Mount/Sep_1')).toEqual({ node: sep, via: 'runtime' });
    // 2. The authored path (Unity spelling, before rename + re-parent) — root-prefixed or not.
    const authored = reg.findNodeForUser('CadB/Sep');
    expect(authored?.node).toBe(sep);
    expect(authored?.via).toBe('authored');
    expect(authored?.address).toBe(`#${identityIdOf(sep)}`);
    expect(reg.findNodeForUser('Cell/CadB/Sep/Pin')?.via).toBe('authored');
    // 3. The exact loader spelling where it differs (renamed, at its authored place).
    const legacy = reg.findNodeForUser('CadB/Sep_1');
    expect(legacy?.node).toBe(sep);
    expect(legacy?.via).toBe('legacy-three');
  });

  it('a guess still answers until plan-770 — flagged and warned, so it is not stored unnoticed', async () => {
    h = await createTestViewer('webgl');
    await h.viewer.loadModel('mauser-core.glb', { data: await buildMauserCoreGlb() });
    const reg = h.viewer.registry!;
    const warn = vi.spyOn(console, 'warn');
    // The loader's leaf name alone: no runtime path, no authored or legacy path of
    // the file — only the registry's suffix stage finds it. A guess.
    const hit = reg.findNodeForUser('Sep_1');
    expect(hit?.via).toBe('guess');
    expect(hit?.stage).toBe('suffix');
    expect(hit?.node).toBe(reg.getNode('Cell/Mount/Sep_1'));
    expect(warn.mock.calls.some((c) => String(c[0]).includes('findNodeForUser') && String(c[0]).includes('guess'))).toBe(true);
  });

  it('an ambiguous authored path is no hit — never guessed past', async () => {
    const scene = new Scene();
    scene.name = 'Cell';
    const a = node('A');
    a.add(box('Pin', 0.1), box('Pin', 0.2), node('Probe', { Drive: { Direction: 'LinearX' } }));
    scene.add(a);
    h = await createTestViewer('webgl');
    await h.viewer.loadModel('amb.glb', { data: await sceneToGlb(scene) });
    expect(h.viewer.registry!.findNodeForUser('A/Pin')).toBeNull();
    expect(h.viewer.registry!.findNodeForUser('Cell/A/Probe')?.via).toBe('runtime');
  });

  it('a path into a placement: the placement prefix, then the asset-relative path', async () => {
    booted = await bootNestedViewer();
    await booted.h.viewer.loadModel('doc.glb', { data: await documentBytes([{ id: 'nid-m', name: 'Machine_1', url: OUTER_URL }]) });
    await booted.h.viewer.whenSceneReady();
    const reg = booted.h.viewer.registry!;
    const root = booted.h.viewer.currentModelRoot!;
    const slide = findByName(findByName(root, 'Machine_1')!, 'Slide')!;
    const runtimePath = reg.getPathForNode(slide)!;
    expect(reg.findNodeForUser(runtimePath)).toEqual({ node: slide, via: 'runtime' });
    void INNER_URL;
  });
});
