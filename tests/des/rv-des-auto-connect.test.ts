// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

// Legacy distance cases are covered by logical-connections.test.ts and
// connect/rv-connection-resolver.node.test.ts. Keep the live predecessor helper.
import { describe, it, expect, afterEach } from 'vitest';
import { Object3D } from 'three';
import { DESRunner } from '@rv/plugins/des/des-runner';
import { Station } from '@rv/plugins/des/material-flow/Station';
import { createSelf } from '../../src/core/material-flow/material-flow-self';
import { createBindContext, type BindContextHost } from '../../src/core/behavior-runtime';
import { ContextMenuStore } from '../../src/core/hmi/context-menu-store';
import { SignalStore } from '../../src/core/engine/rv-signal-store';
import type { MaterialFlowDefinition } from '../../src/core/material-flow/define-material-flow';
import { computePreviousComponents } from '@rv/plugins/des/logical-connections';

let runner: DESRunner | undefined;
afterEach(() => runner?.dispose());

describe('DES predecessor wiring', () => {
  it('computes PreviousComponents from NextComponents', () => {
    runner = new DESRunner({ subMode: 'animated' });
    const host: BindContextHost = {
      signalStore: new SignalStore(), registry: null, drives: [],
      on: () => () => {}, contextMenu: new ContextMenuStore(),
      getPlugin: () => undefined,
    };
    const def = Station as unknown as MaterialFlowDefinition;
    const [a, b, c] = ['A', 'B', 'C'].map(name => {
      const node = new Object3D(); node.name = name;
      const { ctx } = createBindContext(node, host, {});
      const self = createSelf(ctx, def, { mode: 'des' });
      return runner!.addInstance(def, self, node, undefined, { desId: node.name + '@' + def.type });
    });
    runner.start([def], { root: new Object3D() });
    a.nextComponents = [b];
    b.nextComponents = [c];

    computePreviousComponents([a, b, c]);

    expect(a.previousComponents.length).toBe(0);
    expect(b.previousComponents.length).toBe(1);
    expect(b.previousComponents[0]).toBe(a);
    expect(c.previousComponents.length).toBe(1);
    expect(c.previousComponents[0]).toBe(b);
  });
});
