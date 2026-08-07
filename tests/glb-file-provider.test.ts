// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * GLB-file provider tests (plan-238 §8.2 glbFileProvider_Imports).
 * The core provider present in every build (public + private).
 */

import { describe, it, expect } from 'vitest';
import { createGlbFileProvider, resolveGlbFiles, glbBaseName } from '../src/plugins/unified-import/glb-file-provider';
import { remediationFor } from '../src/plugins/unified-import/UnifiedImportDialog';
import { resolveProviderSafe } from '../src/core/import/rv-import-provider';
import { UnifiedImportPlugin } from '../src/plugins/unified-import';
import { evaluateVisibilityRule } from '../src/core/hmi/ui-context-store';

function makeFile(name: string, content: string): File {
  return new File([content], name, { type: 'model/gltf-binary' });
}

describe('glb-file provider', () => {
  it('is always ready', () => {
    const p = createGlbFileProvider();
    expect(p.id).toBe('glb-file');
    expect(p.availability()).toBe('ready');
  });

  it('resolves files to GLB items with the stripped base name', async () => {
    const res = await resolveGlbFiles([makeFile('BeltConveyor_2m.glb', 'glTF-data')]);
    expect(res.failed).toEqual([]);
    expect(res.ok).toHaveLength(1);
    const item = res.ok[0];
    expect(item.kind).toBe('glb');
    if (item.kind === 'glb') {
      expect(item.suggestedName).toBe('BeltConveyor_2m');
      expect(item.bytes.byteLength).toBeGreaterThan(0);
    }
  });

  it('reports empty files as per-file failures (partial success)', async () => {
    const res = await resolveGlbFiles([
      makeFile('good.glb', 'data'),
      makeFile('empty.glb', ''),
    ]);
    expect(res.ok).toHaveLength(1);
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0].id).toBe('empty.glb');
  });

  it('resolve() without a file selection yields a defined failure', async () => {
    const p = createGlbFileProvider();
    const res = await p.resolve({ kind: 'custom', data: null });
    expect(res.ok).toEqual([]);
    expect(res.failed[0].error).toMatch(/No file/i);
  });

  it('glbBaseName strips path and extension', () => {
    expect(glbBaseName('C:\\models\\Robot.glb')).toBe('Robot');
    expect(glbBaseName('robot.GLB')).toBe('robot');
    expect(glbBaseName('.glb')).toBe('model');
  });

  it('an aborted signal cancels between files and is not reported as a failure', async () => {
    const controller = new AbortController();
    controller.abort();
    // Direct call throws AbortError…
    await expect(resolveGlbFiles([makeFile('a.glb', 'data')], controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
    // …and the safe wrapper normalizes a cancel to "nothing happened".
    const p = createGlbFileProvider();
    const res = await resolveProviderSafe(
      p, { kind: 'files', files: [makeFile('a.glb', 'data')] }, undefined, controller.signal,
    );
    expect(res.ok).toEqual([]);
    expect(res.failed).toEqual([]);
  });
});

describe('unified-import button visibility', () => {
  it('is editor-only: hidden in HMI, planner and DES', () => {
    const rule = new UnifiedImportPlugin().slots[0].visibilityRule!;
    expect(evaluateVisibilityRule(rule, new Set(['mode:editor']))).toBe(true);
    expect(evaluateVisibilityRule(rule, new Set(['mode:hmi']))).toBe(false);
    expect(evaluateVisibilityRule(rule, new Set(['mode:planner']))).toBe(false);
    expect(evaluateVisibilityRule(rule, new Set(['mode:des']))).toBe(false);
    expect(evaluateVisibilityRule(rule, new Set())).toBe(false);
  });
});

describe('remediationFor', () => {
  it('maps known engine failures to an actionable next step', () => {
    expect(remediationFor('RuntimeError: memory access out of bounds')).toMatch(/tessellation quality|CONNECT/);
    expect(remediationFor('TypeError: Failed to fetch')).toMatch(/CONNECT is running/);
    expect(remediationFor('Unknown format: not a GLB')).toMatch(/valid, uncorrupted/);
  });

  it('returns null for messages it cannot improve', () => {
    expect(remediationFor('Nothing to import — the source resolved to no items.')).toBeNull();
  });
});
