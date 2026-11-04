// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Bodies of the agent-only view commands `view.isolate` / `view.sourceMarkers` (plan-2007
 * Phase 1). Loaded lazily by `view-commands.ts` so the framing math stays out of the eager
 * startup graph (`tests/bundle-eager-imports.node.test.ts`).
 */

import { Box3, Vector3, type Object3D } from 'three';
import type { CommandImpl } from './rv-command-registry';
import { computeSubtreeAABB } from '../engine/rv-traverse-utils';
import { parsePathsParam } from '../../plugins/mcp-bridge/rv-object-analyzer-math';
import { frameEyeToBox } from './agent-eye-frame';

export const viewIsolate: CommandImpl<{ paths?: string }> = {
  enabled: ({ viewer }) => viewer ? true : { reason: 'No viewer' },
  run: async ({ viewer }, { paths }) => {
    const v = viewer;
    if (!v) return { error: 'No viewer' };
    const requested = parsePathsParam(paths ?? '');
    if (requested.length === 0) {
      v.exitIsolate();
      return { isolated: 0, active: false };
    }
    const nodes: Object3D[] = [];
    const unresolved: string[] = [];
    for (const p of requested) {
      const n = v.registry?.getNode(p);
      if (n) nodes.push(n); else unresolved.push(p);
    }
    if (nodes.length === 0) {
      return { error: `Node(s) not found: ${unresolved.join(', ')}` };
    }
    // Dimming yes, viewport flight no (plan-740 D-U3): the isolation itself is
    // shared scene state, the framing belongs to whoever asked for it.
    v.isolateNodes(nodes, false);
    let framed = false;
    const eye = v.agentEye;
    eye?.ensure();
    if (eye) {
      const box = new Box3().makeEmpty();
      for (const n of nodes) { n.updateMatrixWorld(true); box.union(computeSubtreeAABB(n, new Box3()).box); }
      if (!box.isEmpty()) {
        const pose = eye.pose;
        const dir = new Vector3(pose.px - pose.tx, pose.py - pose.ty, pose.pz - pose.tz);
        if (dir.lengthSq() < 1e-12) dir.set(0, 0, 1);
        dir.normalize();
        frameEyeToBox(eye, box, dir, nodes);
        framed = true;
      }
    }
    return {
      isolated: nodes.length, active: true, framed,
      ...(unresolved.length ? { unresolved } : {}),
    };
  },
};

export const viewSourceMarkers: CommandImpl<{ visible: boolean }> = {
  enabled: ({ viewer }) => viewer ? true : { reason: 'No viewer' },
  run: async ({ viewer }, { visible }) => {
    if (!viewer) return { error: 'No viewer' };
    viewer.setSourceMarkersVisible(visible);
    const sources = viewer?.transportManager?.sources ?? [];
    return {
      ok: true,
      visible,
      affectedSources: sources.length,
    };
  },
};
