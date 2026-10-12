// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * `drive.jog` (inspector Jog − / Jog +, MCP `web_drive_jog`) only sets the
 * drive's jog flags — the simulation step moves the axis. In a mode that
 * detaches the runtime (the asset editor while authoring) nothing steps, so the
 * click used to do nothing at all. The command now answers with a reason, which
 * the inspector shows as the disabled button's tooltip and MCP returns as the
 * error. A paused-but-attached runtime still accepts the jog (it moves on resume).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import type { RVViewer } from '../src/core/rv-viewer';
import { commandRegistry } from '../src/core/hmi/rv-command-registry';
import { ensureSimCommandsRegistered, JOG_NEEDS_RUNTIME } from '../src/plugins/sim-controller/sim-commands';

function viewerWith(attached: boolean | undefined): RVViewer {
  const runtime = attached === undefined ? undefined : { isAttached: attached, isPaused: false };
  return { drives: [{ name: 'Axis' }], runtime } as unknown as RVViewer;
}

describe('drive.jog — detached runtime', () => {
  beforeAll(() => { ensureSimCommandsRegistered(); });

  it('is refused with a reason while the runtime is detached', () => {
    expect(commandRegistry.enabled('drive.jog', { name: 'Axis', forward: true }, viewerWith(false)))
      .toEqual({ reason: JOG_NEEDS_RUNTIME });
  });

  it('is enabled while the runtime is attached', () => {
    expect(commandRegistry.enabled('drive.jog', { name: 'Axis', forward: true }, viewerWith(true))).toBe(true);
  });

  it('a viewer without a runtime object (test doubles) is not blocked', () => {
    expect(commandRegistry.enabled('drive.jog', { name: 'Axis', forward: true }, viewerWith(undefined))).toBe(true);
  });

  it('an unknown drive still reports the drive, not the runtime', () => {
    const r = commandRegistry.enabled('drive.jog', { name: 'Nope', forward: true }, viewerWith(false));
    expect(r).toEqual({ reason: 'Drive "Nope" not found' });
  });
});
