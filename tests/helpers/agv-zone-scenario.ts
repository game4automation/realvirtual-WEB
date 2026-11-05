// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { getDefaultAgvFleet } from '../../src/core/engine/rv-agv-fleet';
import { getDefaultPathDockRegistry } from '../../src/core/engine/rv-path-dock';
import { getDefaultZoneRegistry } from '../../src/core/engine/rv-zone-registry';
import { setReverseGateOpen } from '../../src/core/engine/rv-movement-authority';
import { RVTransportManager } from '../../src/core/engine/rv-transport-manager';
import { ProgressWiring } from '../../src/core/diagnostics/rv-progress-wiring';
import { BudgetResolver } from '../../src/core/diagnostics/rv-blockage-budget';
import type { BlockageCheckerContext } from '../../src/core/diagnostics/rv-blockage-checker';
import { clearShared } from './agv-harness';
import { stubLayout, makeStubWorld, delay, forkCfg, carCfg, FORK, FORK_MESH, CAR, type Mode, type StubWorld } from './agv-stub-world';

/** The original regression's task switch, observed while the real world is live. */
export function agvZoneScenario(mode: Mode, opts: { disableStep4?: boolean } = {}) {
  let world: StubWorld | undefined, wiring: ProgressWiring | undefined;
  let heldM2AtSwitch = false;
  let observing = false;
  const budgets = new BudgetResolver({ nodeForUnit: id => getDefaultAgvFleet().get(id)?.node });
  const setup = () => {
    if (world) return;
    clearShared(); setReverseGateOpen(true); stubLayout({ preLen: 6 });
    world = makeStubWorld(mode, [
      { name: 'A', cfg: forkCfg('Turn1', 300), mesh: FORK_MESH, body: FORK },
      { name: 'B', cfg: carCfg('R3', 6000), body: CAR },
    ], 400);
    if (opts.disableStep4) (world.mb as unknown as { releaseStaleClaims(): void }).releaseStaleClaims = () => {};
    const fleet = getDefaultAgvFleet();
    wiring = new ProgressWiring({ fleet, transport: new RVTransportManager(),
      clock: { now: () => world!.now() }, running: () => true, authority: () => world!.mb });
    world.bindDiagnostics?.(wiring.ledger, wiring.waitRegistry);
    getDefaultPathDockRegistry().register('S1', { onVehicleArrive: (_id, release) => release() });
    fleet.get('A')!.assign({ destination: 'R1' }); fleet.get('B')!.assign({ destination: 'R1' });
    const trySwitch = (tries: number): void => {
      if (!getDefaultZoneRegistry().isHolder('M2', 'A') && tries > 0) { delay(0.1, () => trySwitch(tries - 1)); return; }
      heldM2AtSwitch = getDefaultZoneRegistry().isHolder('M2', 'A');
      fleet.get('A')!.assign({ destination: 'S1', approach: 'reverse', serviceSec: 4,
        onServiceEnd: () => fleet.get('A')!.assign({ destination: 'R2' }) });
    };
    delay(0.3, () => trySwitch(8));
    wiring.sample();
    // Fast-forward drains the kernel within one step. The parked timer vehicle
    // schedules sample-time observations inside that run using its simulation clock.
    observing = true;
    const observe = () => {
      if (!observing || !wiring) return;
      wiring.sample();
      delay(1, observe);
    };
    delay(1, observe);
  };
  setup();
  return {
    setup,
    run(simSec: number) {
      if (!world || !wiring) throw new Error('Scenario is disposed');
      const end = world.now() + simSec;
      while (!world.done() && world.now() < end) { world.step(); wiring.sample(); }
    },
    inspect<T>(fn: (ctx: BlockageCheckerContext & { world: StubWorld; heldM2AtSwitch: boolean }) => T): T {
      if (!world || !wiring) throw new Error('Inspect before dispose');
      wiring.sample();
      return fn({ world, heldM2AtSwitch, ledger: wiring.ledger, registry: wiring.waitRegistry, budgets, now: world.now() });
    },
    dispose() {
      if (!world) return;
      observing = false;
      wiring?.dispose();
      if (opts.disableStep4) delete (world.mb as unknown as { releaseStaleClaims?: unknown }).releaseStaleClaims;
      world.dispose(); world = undefined; wiring = undefined;
      setReverseGateOpen(true); clearShared();
    },
  };
}
