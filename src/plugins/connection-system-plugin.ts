// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * ConnectionSystemPlugin — lifecycle + engine dispatch for typed connections
 * (plan-259).
 *
 * Responsibilities:
 *  - Model load: traverse the loaded root for the rv-ODT `Connections` block
 *    (`userData.realvirtual.Connections`) and feed it into the session's
 *    `RVConnectionRegistry`. Deliberately a PLUGIN traverse (plan-210 pattern)
 *    — rv-scene-loader.ts stays untouched.
 *  - Scene load: apply the edit-op connections/types (`materialise()` output)
 *    additively on `scene-loaded`.
 *  - StopOnExit engine dispatch: on a sensor `component-event` with an MU
 *    reference (plan-259 sensor→MU bridge), hold the MU according to the
 *    surface's `Accumulate` flag (single-MU hold or belt stop, decision O1)
 *    and deliver `onArrival(mu)` to every connected station endpoint.
 *  - Reset coupling (§5.2): `simulation-reset` invalidates open reply handles
 *    and releases every connection hold; model clear drops everything.
 */

import type { RVViewerPlugin } from '../core/rv-plugin';
import type { RVViewer } from '../core/rv-viewer';
import type { LoadResult } from '../core/engine/rv-scene-loader';
import {
  getConnectionSystem,
  parseConnectionsExtras,
  STOP_ON_EXIT_TYPE,
  type ParsedConnections,
  type RvConnection,
} from '../core/engine/rv-connection-registry';
import { getConnectionHolds } from '../core/engine/rv-connection-hold';
import { materialise } from '../core/hmi/scene/rv-scene-edits';
import { setNodeLinkDropFallback } from '../core/hmi/node-link-drag-store';
import { applyAddConnection, freshConnectionId } from '../core/hmi/scene/rv-connection-edits';
import type { ScriptMuRef } from '../core/sdk/rv-script-hook';

/** Sensor `component-event` payload slice this plugin consumes (additive). */
interface SensorEventPayload {
  occupied?: boolean;
  mu?: { id: number; type?: string } | null;
}

export class ConnectionSystemPlugin implements RVViewerPlugin {
  readonly id = 'connection-system';
  readonly core = true;

  private viewer: RVViewer | null = null;
  private readonly unsubs: Array<() => void> = [];

  init(viewer: RVViewer): void {
    this.viewer = viewer;
    this.unsubs.push(
      viewer.on('component-event', (e) => {
        if (e.componentType !== 'sensor' || e.kind !== 'changed') return;
        const payload = e.payload as SensorEventPayload | undefined;
        if (!payload?.occupied || !payload.mu) return;
        this.handleSensorEnter(e.path, payload.mu);
      }),
      viewer.on('scene-loaded', ({ scene }) => {
        // Edit-op connections/types (addConnection/removeConnection/
        // setConnectionType ops) — applied ADDITIVELY on top of the
        // GLB-authored set loaded in onModelLoaded.
        const mat = materialise(scene.edits.ops);
        if (mat.connections.length > 0 || mat.connectionTypes.length > 0) {
          getConnectionSystem().applyEdits(mat.connections, mat.connectionTypes);
        }
      }),
      viewer.on('simulation-reset', () => {
        // Ghost-reply / ghost-hold guard (plan-259 §5.2): a reply or release
        // scheduled before the reset can never act on the restarted sim.
        getConnectionSystem().resetRuntime();
        getConnectionHolds().releaseAll();
      }),
    );

    // 3D drop fallback (Shift+Drag onto the scene, scene-drag-open pattern):
    // when a node-link drag ends over the canvas without a DOM target, the
    // node under the cursor becomes the TARGET of a new connection edge.
    setNodeLinkDropFallback((x, y, payload) => {
      const v = this.viewer;
      const rm = v?.raycastManager;
      if (!v || !rm) return false;
      if (document.elementFromPoint(x, y) !== v.renderer.domElement) return false;
      const hit = rm.raycastForRVNodeDetailed({ clientX: x, clientY: y });
      if (!hit?.path || hit.path === payload.sourcePath) return false;
      applyAddConnection({
        id: freshConnectionId(),
        source: payload.sourcePath,
        target: hit.path,
        type: payload.linkType,
      });
      return true;
    });
    this.unsubs.push(() => setNodeLinkDropFallback(null));
  }

  onModelLoaded(result: LoadResult, viewer: RVViewer): void {
    this.viewer = viewer;
    const registry = getConnectionSystem();
    const parsed: ParsedConnections = { connections: [], connectionTypes: [] };
    result.root.traverse((node) => {
      const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
      if (!rv || rv.Connections === undefined) return;
      const p = parseConnectionsExtras(rv.Connections);
      parsed.connections.push(...p.connections);
      parsed.connectionTypes.push(...p.connectionTypes);
    });
    registry.loadModel(parsed);
  }

  onModelCleared(): void {
    getConnectionHolds().releaseAll();
    getConnectionSystem().clearModel();
  }

  dispose(): void {
    this.onModelCleared();
    for (const unsub of this.unsubs) unsub();
    this.unsubs.length = 0;
  }

  // ── StopOnExit dispatch ─────────────────────────────────────────────────

  /** Edges whose SOURCE matches the sensor event path (exact, then suffix —
   *  the event path is the registry path expression, edge paths are authored). */
  private edgesFor(sensorPath: string): RvConnection[] {
    const registry = getConnectionSystem();
    const exact = registry.outOf(sensorPath);
    if (exact.length > 0) return exact;
    return registry.all().filter((e) =>
      e.source.endsWith(`/${sensorPath}`) || sensorPath.endsWith(`/${e.source}`));
  }

  private handleSensorEnter(sensorPath: string, muRef: { id: number; type?: string }): void {
    const edges = this.edgesFor(sensorPath).filter((e) => e.type === STOP_ON_EXIT_TYPE);
    if (edges.length === 0) return;

    const tm = this.viewer?.transportManager;
    if (!tm) return;
    const holds = getConnectionHolds();
    const registry = getConnectionSystem();

    // Hold FIRST (per Accumulate / O1) so onArrival always sees a stopped MU.
    const mode = holds.hold(muRef.id, tm);
    if (mode === 'none') return;

    const scriptMu: ScriptMuRef = { id: muRef.id, type: muRef.type ?? '' };
    let delivered = 0;
    for (const edge of edges) {
      if (registry.deliverArrival(edge, scriptMu)) delivered++;
    }
    if (delivered === 0) {
      // No station endpoint (script missing/disabled) — never strand the MU.
      console.warn(`[connections] StopOnExit at '${sensorPath}': no station endpoint reachable — releasing MU #${muRef.id}`);
      holds.release(muRef.id);
    }
  }
}
