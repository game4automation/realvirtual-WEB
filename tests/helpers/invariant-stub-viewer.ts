// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * A minimal viewer-shaped stub for the plan-600 invariant tests.
 *
 * Deliberately NOT `tests/helpers/core-toggle-viewer.ts`: that harness replaces
 * `emit` with a `vi.fn()` and never runs the viewer constructor, so it cannot
 * say anything about the real wiring (which `invariants-checkpoint-wiring`
 * covers separately). This stub carries only what `InvariantSource` reads, plus
 * a real listener table so `installInvariants` can be exercised.
 */

import { Object3D } from 'three';
import type { InvariantSource } from '../../src/core/engine/rv-invariants';

export interface StubViewer extends InvariantSource {
  /** path -> node, iterated by `forEachNode` like the real registry. */
  readonly nodes: Map<string, Object3D>;
  /** Listener counts I3 reads through `signalStore.listenerCounts()`. */
  readonly listeners: Map<string, number>;
  memory: { geometries: number; textures: number };
  programs: number;
  activeMode: string;
  panels: { left: string | null; right: string | null };
  nodeCount: number;
  /** Fires a wired event, like the real event bus. */
  fire(event: string, payload?: unknown): void;
  /** How many handlers are wired for an event. */
  handlerCount(event: string): number;
}

export function makeStubViewer(opts: { nodeCount?: number } = {}): StubViewer {
  const handlers = new Map<string, Array<(p?: unknown) => void>>();
  const nodes = new Map<string, Object3D>();
  const listeners = new Map<string, number>();

  const stub: StubViewer = {
    nodes,
    listeners,
    memory: { geometries: 114, textures: 44 },
    programs: 42,
    activeMode: 'hmi',
    panels: { left: null, right: null },
    nodeCount: opts.nodeCount ?? 1000,

    get modes() { return { activeMode: stub.activeMode }; },
    get registry() {
      return {
        size: { nodes: stub.nodeCount },
        forEachNode: (cb: (path: string, node: Object3D) => void) => {
          for (const [path, node] of nodes) cb(path, node);
        },
      };
    },
    get signalStore() {
      return { listenerCounts: () => new Map(listeners) };
    },
    get renderer() {
      return { info: { memory: stub.memory, programs: { length: stub.programs } } };
    },
    get leftPanelManager() {
      return { getActive: (side: 'left' | 'right') => stub.panels[side] };
    },

    on(event: string, handler: (p?: unknown) => void) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {};
    },
    fire(event: string, payload?: unknown) {
      for (const h of handlers.get(event) ?? []) h(payload);
    },
    handlerCount(event: string) {
      return handlers.get(event)?.length ?? 0;
    },
  };
  return stub;
}

/** Registers a node at `path` with a clean transform. */
export function addStubNode(stub: StubViewer, path: string): Object3D {
  const node = new Object3D();
  node.name = path.split('/').pop() ?? path;
  stub.nodes.set(path, node);
  return node;
}
