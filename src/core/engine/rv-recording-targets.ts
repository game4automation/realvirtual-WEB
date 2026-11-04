// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import type { Object3D, Vector3 } from 'three';
import type { RVViewer } from '../rv-viewer';
import { commandRegistry, type ExecuteResult } from '../hmi/rv-command-registry';

type ScreenPoint = { x: number; y: number };
type TargetResolver = (key: string) => ScreenPoint | null;
type PickResult = { path: string } | { error: 'pick-no-match' };
type WatchedCommand = { id: string; args: unknown; ok?: boolean };
const targets = new Map<string, { resolve: TargetResolver }>();

/** Registration is cheap and independent of the opt-in page seam. */
export function registerRecordingTarget(id: string, resolve: TargetResolver): () => void {
  const entry = { resolve };
  targets.set(id, entry);
  return () => { if (targets.get(id) === entry) targets.delete(id); };
}

/** Path glob: * stays inside a segment; ** crosses segments (including zero). */
function pathPattern(glob: string): RegExp {
  let pattern = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') { pattern += '(?:.*/)?'; i++; }
      else pattern += '.*';
    } else if (c === '*') pattern += '[^/]*';
    else pattern += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(pattern + '$');
}

/** Snapshot values at the boundary, so callers never receive live engine objects. */
function serialisable<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_key, item) => {
    if (typeof item === 'bigint') return String(item);
    return item === undefined ? null : item;
  })) as T;
}

declare global {
  interface Window {
    __rvRecording?: ReturnType<typeof createRecordingSeam>;
  }
}

/** No globals, subscriptions or scene work unless explicitly opted in. */
export async function installRecordingSeam(viewer: RVViewer): Promise<void> {
  if (typeof window === 'undefined' || new URLSearchParams(window.location.search).get('recording') !== '1') return;
  if (window.__rvRecording) return;
  // Keep the static seam dependency limited to the command registry and types.
  const math = await import('three');
  if (!window.__rvRecording) window.__rvRecording = createRecordingSeam(viewer, math);
}

function createRecordingSeam(viewer: RVViewer, { Box3, Vector3 }: typeof import('three')) {
  let nextToken = 0;
  const samples = new Map<number, Array<{ path: string; node: Object3D; position: Vector3 }>>();
  let watched: WatchedCommand[] = [];
  let stopWatching: (() => void) | undefined;

  function pickBegin(rule: 'moving-vehicle', among: string): number {
    const token = ++nextToken;
    const entries: Array<{ path: string; node: Object3D; position: Vector3 }> = [];
    if (rule === 'moving-vehicle') {
      const pattern = pathPattern(among);
      viewer.registry?.forEachNode((path, node) => {
        const components = node.userData.realvirtual;
        // Inspect only this node: descendants must not inherit vehicle eligibility.
        if (pattern.test(path) && (components?.Agv != null || components?.AgvBehavior != null)) {
          entries.push({ path, node, position: node.getWorldPosition(new Vector3()) });
        }
      });
    }
    samples.set(token, entries);
    return token;
  }

  function pickEnd(token: number, dtSec: number): PickResult {
    const entries = samples.get(token);
    samples.delete(token);
    if (!entries || !Number.isFinite(dtSec) || dtSec <= 0) return { error: 'pick-no-match' };
    const moved: Array<{ path: string; distance: number }> = [];
    const position = new Vector3();
    for (const entry of entries) {
      if (viewer.registry?.getNode(entry.path) !== entry.node) continue;
      const distance = entry.node.getWorldPosition(position).distanceTo(entry.position);
      if (Number.isFinite(distance) && distance > 1e-6) moved.push({ path: entry.path, distance });
    }
    // All samples share dtSec: greatest distance is greatest distance / dtSec.
    const fastest = moved.reduce((max, entry) => Math.max(max, entry.distance), 0);
    const tied = moved.filter((entry) => fastest - entry.distance <= 1e-6);
    tied.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    return tied.length ? { path: tied[0].path } : { error: 'pick-no-match' };
  }

  return {
    version: 1 as const,
    async execute(id: string, args?: unknown): Promise<ExecuteResult> {
      const result = await commandRegistry.execute(id, args, { origin: 'ui', viewer });
      try { return serialisable(result); }
      catch { return { ok: false, kind: 'threw', reason: 'Recording command result is not serialisable' }; }
    },
    target(id: string, key: string): ScreenPoint | null {
      return targets.get(id)?.resolve(key) ?? null;
    },
    nodeScreen(path: string, anchor: 'center' | 'top' = 'center'): ScreenPoint | null {
      const registry = viewer.registry;
      const node = registry?.findNodeForUser
        ? registry.findNodeForUser(path)?.node
        : registry?.getNode(path);
      if (!node) return null;
      node.updateWorldMatrix(true, true);
      const bounds = new Box3().setFromObject(node);
      if (bounds.isEmpty()) return null;
      const point = bounds.getCenter(new Vector3());
      if (anchor === 'top') point.y = bounds.max.y;
      const camera = viewer.camera;
      camera.updateWorldMatrix(true, false);
      if (point.clone().applyMatrix4(camera.matrixWorldInverse).z >= 0) return null;
      point.project(camera);
      if (![point.x, point.y, point.z].every(Number.isFinite)) return null;
      const rect = viewer.renderer.domElement.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      return {
        x: rect.left + (point.x + 1) * rect.width / 2,
        y: rect.top + (1 - point.y) * rect.height / 2,
      };
    },
    pickBegin,
    pickEnd,
    async pick(rule: 'moving-vehicle', among: string, sampleSec = 0.3): Promise<PickResult> {
      if (!Number.isFinite(sampleSec) || sampleSec <= 0) return { error: 'pick-no-match' };
      const token = pickBegin(rule, among);
      await new Promise<void>((resolve) => setTimeout(resolve, sampleSec * 1000));
      return pickEnd(token, sampleSec);
    },
    /** Read-only DES clock snapshot for the tutorial runner; null without a DES kernel. */
    desClock(): { renderClock: number | null; simTime: number; subMode: string; multiplier: number } | null {
      const ctl = viewer.simulationKernel?.desControl?.() ?? null;
      if (!ctl) return null;
      const rc = ctl.renderClock;
      return {
        renderClock: typeof rc === 'number' && Number.isFinite(rc) ? rc : null,
        simTime: ctl.simTime, subMode: String(ctl.subMode), multiplier: ctl.multiplier,
      };
    },
    armCommandWatch(): void {
      stopWatching?.();
      watched = [];
      // onExecuted fires after the command promise settles: an event is completion.
      stopWatching = commandRegistry.onExecuted(({ id, args, result }) => {
        watched.push({ id, args: serialisable(args), ok: result.ok });
      });
    },
    takeCommandWatch(): WatchedCommand[] {
      const events = watched;
      watched = [];
      return events;
    },
    stopCommandWatch(): void {
      stopWatching?.();
      stopWatching = undefined;
      watched = [];
    },
  };
}
