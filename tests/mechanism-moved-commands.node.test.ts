// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { CommandRegistry } from '../src/core/hmi/rv-command-registry';
import { createMechanismCommandDescriptors } from '../src/core/hmi/mechanism-command-descriptors';
import { ERR_EDITOR_UNAVAILABLE } from '../src/core/editor/rv-editor-guard-core';
import { commandClassOf } from '../src/plugins/mcp-bridge/rv-mcp-tool-class';
import { impls } from '../src/private-stubs/plugins/asset-editor/mechanism/mechanism-commands';

const authoring = [
  'mechanism.setAnchor', 'mechanism.targetCreate', 'mechanism.pathCreate',
  'mechanism.pathAddWaypoint', 'mechanism.pathRemoveWaypoint', 'mechanism.pathMoveWaypoint',
  'mechanism.trajectoryImport',
];

describe('plan-2007 Phase 3 public mechanism descriptors', () => {
  it('keeps authoring macro-capable and sizing cancellable, long-running and sim-classed', () => {
    const descriptors = createMechanismCommandDescriptors({ available: true, load: async () => ({ impls }) });
    for (const id of authoring) {
      const d = descriptors.find((entry) => entry.id === id)!;
      expect(d, id).toMatchObject({ scope: 'editor', macro: true, readOnly: false });
      expect(d.undoLabel).toBeTruthy();
      expect(commandClassOf(d)).toBe('edit');
      expect(d.timeoutMs).toBeUndefined();
      expect(d.cancellable).not.toBe(true);
    }
    const run = descriptors.find((entry) => entry.id === 'mechanism.trajectoryRun')!;
    expect(run).toMatchObject({ scope: 'editor', readOnly: false, timeoutMs: 600_000, cancellable: true });
    expect(commandClassOf(run)).toBe('sim');
    expect(run.macro).not.toBe(true);
    expect(run.undoLabel).toBeUndefined();
  });

  it('loads no private implementation in the community build and refuses with the edition reason', async () => {
    const registry = new CommandRegistry();
    const descriptors = createMechanismCommandDescriptors({ available: false, load: async () => ({ impls }) });
    for (const d of descriptors) registry.register(d);
    for (const id of [...authoring, 'mechanism.trajectoryRun']) {
      expect(await descriptors.find((d) => d.id === id)!.impl()).toBeNull();
      expect(await registry.execute(id, { path: 'Cell' }, { origin: 'mcp' }))
        .toMatchObject({ ok: false, kind: 'unavailable', reason: ERR_EDITOR_UNAVAILABLE });
    }
  });
});
