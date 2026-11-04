// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * The DES toolbar re-renders every 200 ms while the sim clock moves (`useKernelSnapshot` poll) and
 * mounts the experiment window host with the same `viewer` every time. A toolbar re-render must
 * not reach the opener's window (DES profile 2026-11-04: an un-memoized window chain re-rendered
 * the whole experiment matrix per tick and halved the batch throughput); the opener's own state
 * change still does.
 */
import { afterEach, expect, it } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { useState } from 'react';
import type { RVViewer } from '../../src/core/rv-viewer';
import { DesExperimentWindowHost } from '../../src/plugins/sim-controller/DesExperimentsButton';
import { registerDesExperimentWindowProvider, type DesExperimentWindowState } from '../../src/core/hmi/des-experiment-window';

let off: (() => void) | null = null;
afterEach(() => { cleanup(); off?.(); off = null; });

it('a re-rendering toolbar does not re-render the window host; the opener state does', () => {
  let hostRenders = 0;
  const listeners = new Set<() => void>();
  let state: DesExperimentWindowState = { open: true };
  off = registerDesExperimentWindowProvider({
    toggle() { state = { open: !state.open }; for (const fn of [...listeners]) fn(); },
    subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    getState: () => state,
    Host: () => { hostRenders++; return <div data-testid="experiment-window" />; },
  });
  const viewer = { on: () => () => {} } as unknown as RVViewer;
  let tick!: () => void;
  let toolbarRenders = 0;
  function Toolbar() {
    const [, setN] = useState(0);
    tick = () => setN(n => n + 1);
    toolbarRenders++;
    return <DesExperimentWindowHost viewer={viewer} />;
  }
  render(<Toolbar />);
  const before = hostRenders;
  for (let i = 0; i < 10; i++) act(() => tick());
  expect(toolbarRenders).toBe(11);
  expect(hostRenders - before, 'window host renders on 10 toolbar ticks').toBe(0);

  act(() => { state = { open: false }; for (const fn of [...listeners]) fn(); });
  expect(hostRenders - before, 'the opener state change reaches the host').toBe(1);
});
