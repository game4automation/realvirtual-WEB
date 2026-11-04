// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * idle-soak — load a model, optionally open panels / start the simulation via
 * commands, then do nothing but measure for the whole duration.
 *
 * The cheapest leak detector there is: a viewer that grows while NOTHING
 * happens has a polling loop, a re-render storm or a cache that never evicts.
 * Tonight's critical DES finding (renderer +0.2 GB/min with the Experiments
 * window open, idle) is exactly this shape, so it is the first generic
 * scenario and the template for "panel X open, does it leak?".
 *
 *   rv-stress-run.mjs idle-soak --serve --duration 15m
 *   rv-stress-run.mjs idle-soak --serve --url-doc doc_palletyard_hzmdb6 --url-mode des \
 *       --commands '[["experiment.window",{"open":true}]]'
 *   rv-stress-run.mjs idle-soak --serve --play        (simulation running instead of paused)
 */

export const scenario = {
  id: 'idle-soak',
  title: 'Idle soak (leak detector)',
  description: 'Loads a model, runs optional setup commands, then idles and measures memory/responsiveness for the whole duration.',
  status: 'ready',
  requires: {
    build: 'any',
    url: { projectUrl: '/demo-realvirtual/', doc: 'doc_demorealvirtualweb_7l7hfw' },
  },
  defaults: { duration: '15m' },
  checks: [
    'no sustained growth of renderer private bytes, JS heap, embedder heap or DOM nodes (generic trend analysis)',
    'no UI stall (frame round-trip) above the stall threshold',
    'every setup command is accepted',
    'no uncaught exceptions / console errors while idle',
  ],

  async run(ctx) {
    let commands = [];
    if (ctx.args.commands) {
      try { commands = JSON.parse(ctx.args.commands); } catch (e) { throw new Error(`--commands is not JSON: ${e}`); }
    }
    ctx.phase('setup');
    for (const [id, args] of commands) {
      const r = await ctx.cmd(id, args ?? {});
      ctx.check(`setup command ${id}`, r.ok, r.ok ? `${r.ms} ms` : `${r.kind}: ${r.reason}`, { severity: 'medium', classification: 'unclear' });
      if (r.kind === 'HARNESS-TIMEOUT') ctx.hang(id, r);
    }
    if (ctx.args.play) {
      const r = await ctx.cmd('sim.playPause', { paused: false });
      ctx.check('simulation started', r.ok, r.reason ?? '');
    }
    await ctx.sample('after-setup');
    ctx.phase(ctx.args.play ? 'idle-playing' : 'idle');
    while (!ctx.stopRequested()) await ctx.sleep(5000);
  },
};
