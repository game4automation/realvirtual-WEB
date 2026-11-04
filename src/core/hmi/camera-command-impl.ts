// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { Vector3, type Box3, type InstancedMesh, type Mesh, type Object3D, type PerspectiveCamera } from 'three';
import type { CameraFollowPluginAPI, FpvPluginAPI } from '../types/plugin-types';
import { CommandError, type CommandContext, type CommandEnabled, type CommandImpl } from './rv-command-registry';
import { finiteNumber, stringArg, vec3 } from './command-arg-validation';
import { resolveCommandNode, selectCommandNode } from './selection-command-impl';
import type { CameraFitArgs, CameraFlyToArgs, CameraFollowArgs } from './camera-commands';
import { boxCorners, fitPoseInRegion, largestFreeRect, type PixelRect } from './camera-fit';

function cameraEnabled({ viewer }: CommandContext): CommandEnabled {
  if (!viewer) return { reason: 'No viewer available' };
  if (viewer.getPlugin<{ id: string; isPresenting?: boolean }>('webxr')?.isPresenting) {
    return { reason: 'Camera commands are unavailable during an immersive XR session' };
  }
  return true;
}

export const cameraFlyTo: CommandImpl<CameraFlyToArgs> = {
  enabled: cameraEnabled,
  run: (ctx, args) => {
    const duration = args?.durationSec === undefined ? 0.6 : args.durationSec;
    finiteNumber('durationSec', duration);
    if (duration < 0) throw new CommandError('durationSec must be >= 0');
    const position = new Vector3();
    const target = new Vector3();
    let updateEndpoint: ((position: Vector3, target: Vector3) => void) | undefined;
    if (args?.node !== undefined) {
      stringArg('node', args.node);
      if (args.position !== undefined || args.target !== undefined) {
        throw new CommandError('Specify either node or position and target');
      }
      const offset = args.offset === undefined ? [-1.6, 2.1, -4.2] : args.offset;
      const lookAhead = args.lookAhead === undefined ? 1.5 : args.lookAhead;
      vec3('offset', offset);
      finiteNumber('lookAhead', lookAhead);
      const node = resolveCommandNode(ctx.viewer, args.node);
      const localOffset = new Vector3().fromArray(offset);
      const forward = new Vector3();
      updateEndpoint = (pos, tgt) => {
        node.updateWorldMatrix(true, false);
        pos.copy(localOffset).applyMatrix4(node.matrixWorld);
        forward.set(0, 0, 1).transformDirection(node.matrixWorld);
        tgt.setFromMatrixPosition(node.matrixWorld).addScaledVector(forward, lookAhead);
      };
      updateEndpoint(position, target);
    } else {
      vec3('position', args?.position);
      vec3('target', args?.target);
      if (args.offset !== undefined || args.lookAhead !== undefined) {
        throw new CommandError('offset and lookAhead require node');
      }
      position.fromArray(args.position!);
      target.fromArray(args.target!);
    }
    const enabled = cameraEnabled(ctx);
    if (enabled !== true) throw new CommandError(enabled.reason);
    ctx.viewer.getPlugin<CameraFollowPluginAPI>('camera-follow')?.exit();
    // FPV moves and ground-snaps the camera every frame and would fight the flight: leave it first.
    const fpv = ctx.viewer.getPlugin<FpvPluginAPI>('fpv');
    if (fpv?.isActive) {
      fpv.exit?.();
      if (fpv.isActive) throw new CommandError('Cannot fly the camera while first-person view is active; leave it first');
    }
    ctx.viewer.animateCameraTo(position, target, duration, 'easeInOut', 'camera.flyTo', updateEndpoint);
    return { durationSec: duration, animating: true };
  },
};

/** Upper bound of sampled vertices; the silhouette of a station needs far fewer. */
const FRAME_POINT_BUDGET = 60000;

/**
 * World points describing what the nodes draw: sampled vertices of their
 * visible meshes, so the frame follows the silhouette instead of an
 * axis-aligned box. A node without own meshes (geometry baked into an
 * ancestor chunk) and instanced or batched meshes contribute box corners.
 */
function collectFramePoints(nodes: Object3D[], boundsOf: (node: Object3D) => Box3): Vector3[] {
  const meshes: Mesh[] = [];
  const points: Vector3[] = [];
  for (const node of nodes) {
    node.updateWorldMatrix(true, true);
    const before = meshes.length;
    let boxed = false;
    node.traverseVisible((o) => {
      const m = o as Mesh;
      if (!m.isMesh || !m.geometry) return;
      if ((m as InstancedMesh).isInstancedMesh || (m as unknown as { isBatchedMesh?: boolean }).isBatchedMesh) {
        const b = boundsOf(m);
        if (!b.isEmpty()) { points.push(...boxCorners(b)); boxed = true; }
        return;
      }
      if (m.geometry.getAttribute('position')) meshes.push(m);
    });
    if (meshes.length === before && !boxed) {
      const b = boundsOf(node);
      if (!b.isEmpty()) points.push(...boxCorners(b));
    }
  }
  let total = 0;
  for (const m of meshes) total += m.geometry.getAttribute('position').count;
  const stride = Math.max(1, Math.ceil(total / FRAME_POINT_BUDGET));
  for (const m of meshes) {
    const pos = m.geometry.getAttribute('position');
    for (let i = 0; i < pos.count; i += stride) {
      points.push(new Vector3().fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld));
    }
  }
  return points;
}

function rectOf(el: Element): PixelRect {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

export const cameraFit: CommandImpl<CameraFitArgs> = {
  enabled: cameraEnabled,
  run: (ctx, args) => {
    const enabled = cameraEnabled(ctx);
    if (enabled !== true) throw new CommandError(enabled.reason);
    const viewer = ctx.viewer;
    const camera = viewer.camera as PerspectiveCamera;
    if (!camera.isPerspectiveCamera) throw new CommandError('camera.fit needs the perspective camera');
    const fill = args?.fill === undefined ? 1 : args.fill;
    finiteNumber('fill', fill);
    if (fill <= 0) throw new CommandError('fill must be > 0');
    const duration = args?.durationSec === undefined ? 0.6 : args.durationSec;
    finiteNumber('durationSec', duration);
    if (duration < 0) throw new CommandError('durationSec must be >= 0');

    let nodes: Object3D[];
    if (args?.paths !== undefined) {
      if (!Array.isArray(args.paths) || args.paths.length === 0) throw new CommandError('paths must be a non-empty string array');
      nodes = args.paths.map((p, i) => { stringArg(`paths[${i}]`, p); return resolveCommandNode(viewer, p); });
    } else {
      const root = viewer.currentModelRoot;
      if (!root) throw new CommandError('No model loaded');
      nodes = [root];
    }
    const points = collectFramePoints(nodes, n => viewer.computeNodeBounds([n]));
    if (points.length === 0) throw new CommandError('The nodes have no geometry to frame');

    const canvas = rectOf(viewer.renderer.domElement);
    if (canvas.w <= 0 || canvas.h <= 0) throw new CommandError('The viewport has no size');
    let region: PixelRect;
    if (args?.rect !== undefined) {
      const r = args.rect;
      if (!Array.isArray(r) || r.length !== 4 || r.some(v => typeof v !== 'number' || !Number.isFinite(v))) {
        throw new CommandError('rect must be [x, y, w, h] in page pixels');
      }
      region = { x: r[0], y: r[1], w: r[2], h: r[3] };
    } else if (args?.region === undefined || args.region === 'free') {
      const panels = [...document.querySelectorAll('[data-ui-panel]')].map(rectOf).filter(r => r.w > 0 && r.h > 0);
      region = largestFreeRect(canvas, panels);
    } else if (args.region === 'canvas') {
      region = canvas;
    } else {
      throw new CommandError("region must be 'free' or 'canvas'");
    }
    if (region.w < 1 || region.h < 1) throw new CommandError('The free region is empty');

    const viewDir = new Vector3().subVectors(camera.position, viewer.controls.target);
    if (viewDir.lengthSq() === 0) viewDir.set(1, 1, 1);
    const pose = fitPoseInRegion({ points, viewDir, up: camera.up, fovDeg: camera.fov, canvas, region, fill });
    viewer.getPlugin<CameraFollowPluginAPI>('camera-follow')?.exit();
    viewer.animateCameraTo(pose.position, pose.target, duration, 'easeInOut', 'camera.fit');
    return {
      region: [region.x, region.y, region.w, region.h].map(Math.round),
      position: pose.position.toArray(), target: pose.target.toArray(), durationSec: duration,
    };
  },
};

export const cameraFollow: CommandImpl<CameraFollowArgs> = {
  enabled: (ctx, args) => {
    const enabled = cameraEnabled(ctx);
    if (enabled !== true) return enabled;
    const plugin = ctx.viewer.getPlugin<CameraFollowPluginAPI>('camera-follow');
    if (!plugin) return { reason: 'Camera follow plugin unavailable' };
    // A supplied path is selected in run(), never in an availability query.
    return args?.mode === 'off' || args?.path !== undefined || plugin.canFollow()
      ? true : { reason: 'The current selection cannot be followed' };
  },
  run: (ctx, args) => {
    stringArg('mode', args?.mode);
    if (!['follow', 'siton', 'off'].includes(args.mode)) {
      throw new CommandError('mode must be follow, siton, or off');
    }
    if (args.path !== undefined) stringArg('path', args.path);
    const enabled = cameraEnabled(ctx);
    if (enabled !== true) throw new CommandError(enabled.reason);
    const plugin = ctx.viewer.getPlugin<CameraFollowPluginAPI>('camera-follow');
    if (!plugin) throw new CommandError('Camera follow plugin unavailable');
    if (args.path !== undefined) selectCommandNode(ctx.viewer, args.path);
    if (args.mode === 'off') plugin.exit();
    else {
      if (!plugin.canFollow()) throw new CommandError('The selected node cannot be followed');
      plugin.enter(args.mode);
    }
    return { mode: args.mode };
  },
};
