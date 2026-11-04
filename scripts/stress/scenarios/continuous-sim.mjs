// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * continuous-sim — STUB. Long-running standalone (continuous, non-DES)
 * simulation of a demo model. Not implemented: the runner refuses to start a
 * stub and prints the checklist below. Implementing it = turning each TODO into
 * a phase in `run(ctx)` (see idle-soak.mjs and the private des-experiments
 * scenario for the pattern), then flipping `status` to 'ready'.
 */

export const scenario = {
  id: 'continuous-sim',
  title: 'Continuous simulation soak',
  description: 'Hours of standalone continuous simulation on a demo model: MU balance, drive drift, sensor flapping, frame time, memory.',
  status: 'stub',
  requires: {
    build: 'any',
    url: { projectUrl: '/demo-realvirtual/', doc: 'doc_demorealvirtualweb_7l7hfw' },
  },
  defaults: { duration: '60m' },
  checks: [
    'MU balance: spawned − sunk − alive == 0 at every sample (no lost / duplicated MUs)',
    'alive MU count bounded (no unbounded accumulation on a blocked conveyor)',
    'drive positions return to the same values after N identical cycles (no drift)',
    'sensors do not flap (state changes per second below a bound)',
    'frame time p95 stable over the run (no creeping slowdown)',
    'generic: no memory growth, no stalls, no console errors',
  ],
  todo: [
    'Find the read commands that expose MU counts (web_commands "mu" / "source" / "sink"); fall back to a page.evaluate on viewer registries only if no command exists — and record that as a gap finding',
    'Start the sim via sim.playPause {paused:false}; optionally raise speed (sim speed command) and record the factor in metrics',
    'Every sample: read Source spawn counters, Sink counters, alive MUs → check the balance; add a high finding on mismatch with the counts as evidence',
    'Pick 3 drives (drive.list), record position at a cycle marker (a sensor rising edge), compare across cycles → drift finding with mm values',
    'Count sensor edges per window; flag > N toggles/s as medium (flapping) with the sensor path',
    'Frame time: sample renderer frame stats (web_status detail=render, or rAF deltas over 2 s) → trend; flag creeping p95',
    'sim.reset in the middle once and verify the MU balance restarts from zero (reset leak / ghost MUs)',
    'Teardown: sim.playPause {paused:true}',
  ],
};
