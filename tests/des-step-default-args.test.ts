// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * C3 / tutorial gap #22 — `des.step` without arguments (the recording seam passes none) steps once
 * instead of throwing "Cannot destructure property 'count' of undefined".
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RVViewer } from '../src/core/rv-viewer';
import { installRecordingSeam } from '../src/core/engine/rv-recording-targets';
import { commandRegistry } from '../src/core/hmi/rv-command-registry';
import { ensureDesPlcCommandsRegistered } from '../src/core/hmi/des-plc-commands';

let originalUrl: string;
beforeEach(() => {
  originalUrl = window.location.href;
  delete window.__rvRecording;
  const url = new URL(window.location.href);
  url.searchParams.set('recording', '1');
  window.history.replaceState(window.history.state, '', url);
  ensureDesPlcCommandsRegistered();
});
afterEach(() => {
  window.__rvRecording?.stopCommandWatch();
  delete window.__rvRecording;
  window.history.replaceState(window.history.state, '', originalUrl);
});

function desViewer() {
  let stepped = 0;
  const ctl = { step: () => { stepped++; return true; }, eventStats: () => ({ processed: stepped }) };
  const viewer = { modes: { activeMode: 'des' }, simulationKernel: { desControl: () => ctl } } as unknown as RVViewer;
  return { viewer, stepped: () => stepped };
}

describe('des.step default args (C3 #22)', () => {
  it('steps once through the registry when args are undefined', async () => {
    const { viewer, stepped } = desViewer();
    const r = await commandRegistry.execute('des.step', undefined, { origin: 'mcp', viewer });
    expect(r).toMatchObject({ ok: true, value: { stepped: 1 } });
    expect(stepped()).toBe(1);
  });

  it('steps once through the recording seam called without args', async () => {
    const { viewer, stepped } = desViewer();
    await installRecordingSeam(viewer);
    const r = await window.__rvRecording!.execute('des.step');
    expect(r).toMatchObject({ ok: true, value: { stepped: 1 } });
    expect(stepped()).toBe(1);
  });
});
