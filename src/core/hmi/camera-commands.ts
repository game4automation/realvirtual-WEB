// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { commandRegistry, type CommandRegistry } from './rv-command-registry';

export interface CameraFlyToArgs {
  position?: number[];
  target?: number[];
  node?: string;
  offset?: number[];
  lookAhead?: number;
  durationSec?: number;
}
export interface CameraFollowArgs { mode: 'follow' | 'siton' | 'off'; path?: string }
export interface CameraFitArgs {
  /** Nodes to frame; omitted = the whole model. */
  paths?: string[];
  /** 'free' (default) = largest canvas area no floating panel covers, or 'canvas'. Ignored when `rect` is given. */
  region?: 'free' | 'canvas';
  /** Explicit region [x, y, w, h] in page pixels. */
  rect?: number[];
  /** 1 = the larger side just fits the region, > 1 crops the edges. */
  fill?: number;
  durationSec?: number;
}

const registered = new WeakSet<CommandRegistry>();
export function ensureCameraCommandsRegistered(registry: CommandRegistry = commandRegistry): void {
  if (registered.has(registry)) return;
  registered.add(registry);
  registry.register<CameraFlyToArgs, unknown>({
    id: 'camera.flyTo', label: 'Fly operator camera', readOnly: false,
    scope: 'none', available: true, unavailableReason: 'Camera unavailable',
    argsSchema: { position: 'number[]', target: 'number[]', node: 'string', offset: 'number[]', lookAhead: 'number', durationSec: 'number' },
    impl: () => import('./camera-command-impl').then(m => m.cameraFlyTo),
  });
  registry.register<CameraFitArgs, unknown>({
    id: 'camera.fit', label: 'Frame model in free view area', readOnly: false,
    scope: 'none', available: true, unavailableReason: 'Camera unavailable',
    argsSchema: { paths: 'string[]', region: 'string', rect: 'number[]', fill: 'number', durationSec: 'number' },
    impl: () => import('./camera-command-impl').then(m => m.cameraFit),
  });
  registry.register<CameraFollowArgs, unknown>({
    id: 'camera.follow', label: 'Follow selected part', readOnly: false,
    scope: 'none', available: true, unavailableReason: 'Camera follow unavailable',
    buttonKey: args => args.mode,
    argsSchema: { mode: 'string', path: 'string' },
    impl: () => import('./camera-command-impl').then(m => m.cameraFollow),
  });
}
