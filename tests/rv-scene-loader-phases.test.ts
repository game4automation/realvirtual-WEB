// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Tests for loadGLB phase functions — verifies the extracted functions
 * exist, are properly typed, and return the correct data structures.
 */

import { describe, it, expect } from 'vitest';

describe('loadGLB phase functions', () => {
  it('exports loadAndPrepareGLTF as an async function', async () => {
    const mod = await import('../src/core/engine/rv-scene-loader');
    expect(mod.loadAndPrepareGLTF).toBeDefined();
    expect(typeof mod.loadAndPrepareGLTF).toBe('function');
  });

  it('exports processMeshes as a function', async () => {
    const mod = await import('../src/core/engine/rv-scene-loader');
    expect(mod.processMeshes).toBeDefined();
    expect(typeof mod.processMeshes).toBe('function');
  });

  it('exports detectRenamedNodes as a function', async () => {
    const mod = await import('../src/core/engine/rv-scene-loader');
    expect(mod.detectRenamedNodes).toBeDefined();
    expect(typeof mod.detectRenamedNodes).toBe('function');
  });

  it('exports traverseAndRegister as a function', async () => {
    const mod = await import('../src/core/engine/rv-scene-loader');
    expect(mod.traverseAndRegister).toBeDefined();
    expect(typeof mod.traverseAndRegister).toBe('function');
  });

  it('exports registerNodeAliases as a function', async () => {
    const mod = await import('../src/core/engine/rv-scene-loader');
    expect(mod.registerNodeAliases).toBeDefined();
    expect(typeof mod.registerNodeAliases).toBe('function');
  });

  it('exports initializeComponents as a function', async () => {
    const mod = await import('../src/core/engine/rv-scene-loader');
    expect(mod.initializeComponents).toBeDefined();
    expect(typeof mod.initializeComponents).toBe('function');
  });

  it('exports buildGroups as a function', async () => {
    const mod = await import('../src/core/engine/rv-scene-loader');
    expect(mod.buildGroups).toBeDefined();
    expect(typeof mod.buildGroups).toBe('function');
  });

  it('exports buildPlayback as a function', async () => {
    const mod = await import('../src/core/engine/rv-scene-loader');
    expect(mod.buildPlayback).toBeDefined();
    expect(typeof mod.buildPlayback).toBe('function');
  });

  it('exports buildReplayRecordings as a function', async () => {
    const mod = await import('../src/core/engine/rv-scene-loader');
    expect(mod.buildReplayRecordings).toBeDefined();
    expect(typeof mod.buildReplayRecordings).toBe('function');
  });

  it('exports buildLogicEngine as a function', async () => {
    const mod = await import('../src/core/engine/rv-scene-loader');
    expect(mod.buildLogicEngine).toBeDefined();
    expect(typeof mod.buildLogicEngine).toBe('function');
  });

  it('exports applyWebGPUFixes as a function', async () => {
    const mod = await import('../src/core/engine/rv-scene-loader');
    expect(mod.applyWebGPUFixes).toBeDefined();
    expect(typeof mod.applyWebGPUFixes).toBe('function');
  });

  it('exports applyKinematicParenting as a function', async () => {
    const mod = await import('../src/core/engine/rv-scene-loader');
    expect(mod.applyKinematicParenting).toBeDefined();
    expect(typeof mod.applyKinematicParenting).toBe('function');
  });

  it('still exports loadGLB as the main orchestrator', async () => {
    const mod = await import('../src/core/engine/rv-scene-loader');
    expect(mod.loadGLB).toBeDefined();
    expect(typeof mod.loadGLB).toBe('function');
  });

  it('still exports processExtras for runtime subtree processing', async () => {
    const mod = await import('../src/core/engine/rv-scene-loader');
    expect(mod.processExtras).toBeDefined();
    expect(typeof mod.processExtras).toBe('function');
  });
});

// ── matrixAutoUpdate classification (Drive geometry must stay dynamic) ──
// Regression: a Drive authored directly ON a mesh node (CAD imports like
// Toray, where every moving part is a single mesh) was classified static —
// isUnderDrive() only walks the PARENT chain — so it got matrixAutoUpdate=false
// and the renderer never rebuilt its matrix from the quaternion applyToNode()
// sets. The drive reported running/rotating but the geometry never visibly moved.
describe('processMeshes — Drive geometry stays dynamic', () => {
  it('keeps matrixAutoUpdate=true on a mesh that IS the Drive node', async () => {
    const { processMeshes } = await import('../src/core/engine/rv-scene-loader');
    const { Group, Mesh, BoxGeometry, MeshStandardMaterial } = await import('three');

    const root = new Group();

    // Drive authored directly on a mesh (Toray shape).
    const driveMesh = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
    driveMesh.name = 'part_000_1';
    driveMesh.userData.realvirtual = { Drive: { Direction: 'RotationX' } };
    root.add(driveMesh);

    // A mesh UNDER a (transform) drive node — the shape that already worked.
    const driveXform = new Group();
    driveXform.userData.realvirtual = { Drive: { Direction: 'RotationY' } };
    const childMesh = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
    driveXform.add(childMesh);
    root.add(driveXform);

    // A plain static mesh — must be frozen.
    const staticMesh = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
    root.add(staticMesh);

    processMeshes(root);

    expect(driveMesh.matrixAutoUpdate).toBe(true);   // was false before the fix
    expect(childMesh.matrixAutoUpdate).toBe(true);
    expect(staticMesh.matrixAutoUpdate).toBe(false); // static stays frozen
  });
});

describe('parseCompactRecording and parseScriptableObjectRecording moved to rv-drives-playback', () => {
  it('exports parseCompactRecording from rv-drives-playback', async () => {
    const mod = await import('../src/core/engine/rv-drives-playback');
    expect(mod.parseCompactRecording).toBeDefined();
    expect(typeof mod.parseCompactRecording).toBe('function');
  });

  it('exports parseScriptableObjectRecording from rv-drives-playback', async () => {
    const mod = await import('../src/core/engine/rv-drives-playback');
    expect(mod.parseScriptableObjectRecording).toBeDefined();
    expect(typeof mod.parseScriptableObjectRecording).toBe('function');
  });

  it('parseCompactRecording returns null for empty data', async () => {
    const { parseCompactRecording } = await import('../src/core/engine/rv-drives-playback');
    expect(parseCompactRecording({})).toBeNull();
  });

  it('parseCompactRecording returns valid recording for compact format', async () => {
    const { parseCompactRecording } = await import('../src/core/engine/rv-drives-playback');
    const data = {
      fixedDeltaTime: 0.02,
      numberFrames: 2,
      driveCount: 1,
      drives: [{ id: 0, path: 'Drive1' }],
      positions: [0, 100],
    };
    const result = parseCompactRecording(data);
    expect(result).not.toBeNull();
    expect(result!.numberFrames).toBe(2);
    expect(result!.driveCount).toBe(1);
    expect(result!.positions).toEqual([0, 100]);
  });

  it('parseScriptableObjectRecording returns null for empty data', async () => {
    const { parseScriptableObjectRecording } = await import('../src/core/engine/rv-drives-playback');
    expect(parseScriptableObjectRecording({})).toBeNull();
  });
});
