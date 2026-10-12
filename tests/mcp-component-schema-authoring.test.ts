// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-517 §9.1a (F7) — every type `web_component_schema` lists as
 * `authorable: true` is really accepted by the `editor.addComponent` command,
 * and a type it lists as NOT authorable (Kinematic) is really refused there.
 *
 * PRIVATE-DEPENDENT: the command implementation lives in the private sibling
 * (`@rv-private/plugins/asset-editor/editor-commands`). Listed in
 * `tests/private-dependent-tests.json` (`npm run gen:private-excludes`), so the
 * community run skips this file while `mcp-component-schema-tool.test.ts`
 * stays independent of it.
 */

import { describe, it, expect, vi } from 'vitest';
import { Group, type Object3D } from 'three';
// Registers every built-in component type, as in a running viewer.
import '../src/core/engine/rv-scene-loader';
import { impls } from '@rv-private/plugins/asset-editor/editor-commands';
import { listComponentTypes } from '../src/core/engine/rv-component-schema-info';
import type { CommandContext } from '../src/core/hmi/rv-command-registry';

interface AddArgs { path: string; type: string; propsJson?: string | null }
interface AddImpl {
  enabled(ctx: CommandContext, args: AddArgs): unknown;
  run(ctx: CommandContext, args: AddArgs): Promise<{ component: string }>;
}

function contextFor(node: Object3D, root: Object3D, addComponent = vi.fn((_p: string, t: string) => t)): CommandContext {
  return {
    // plan-525: BoxCollider / WebPhysicsZone add inside ONE transaction.
    doc: { lockOwner: null, addComponent, whenIdle: async () => {}, withTransaction: async (_l: string, fn: () => Promise<void>) => fn() },
    viewer: {
      registry: { getNode: (p: string) => (p === 'Root/Part' ? node : null) },
      currentModelRoot: root,
    },
    selection: [],
  } as unknown as CommandContext;
}

function freshNode(): { node: Object3D; root: Object3D } {
  const root = new Group(); root.name = 'Root';
  const node = new Group(); node.name = 'Part';
  root.add(node);
  return { node, root };
}

const addImpl = impls['editor.addComponent'] as unknown as AddImpl;

describe('web_component_schema list ↔ editor.addComponent (plan-517 F7)', () => {
  it('the command implementation is present', () => {
    expect(addImpl).toBeTruthy();
  });

  it('every authorable list entry is accepted and added', async () => {
    const authorable = listComponentTypes().filter((s) => s.authorable);
    expect(authorable.length).toBeGreaterThan(10);
    for (const { type } of authorable) {
      const { node, root } = freshNode();
      const add = vi.fn((_p: string, t: string) => t);
      const ctx = contextFor(node, root, add);
      expect(addImpl.enabled(ctx, { path: 'Root/Part', type }), type).toBe(true);
      const res = await addImpl.run(ctx, { path: 'Root/Part', type });
      expect(res.component, type).toBe(type);
      expect(add, type).toHaveBeenCalledWith('Root/Part', type, expect.any(Object));
    }
  });

  it('every NON-authorable list entry is refused, and names the tool to use instead', () => {
    const special = listComponentTypes().filter((s) => !s.authorable);
    expect(special.map((s) => s.type)).toContain('Kinematic');
    for (const { type, createVia } of special) {
      const { node, root } = freshNode();
      const verdict = addImpl.enabled(contextFor(node, root), { path: 'Root/Part', type });
      expect(verdict, type).not.toBe(true);
      expect(createVia, type).toMatch(/^web_editor_/);
    }
  });
});
