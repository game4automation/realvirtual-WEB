// SPDX-License-Identifier: AGPL-3.0-only
import { FleetDispatcher } from '../../src/core/fleet/core/dispatcher';
import { createBatteryModel } from '../../src/core/fleet/core/battery';
import type { FleetStation } from '../../src/core/fleet/core/orders';

export function dispatcherFixture(onLate = (_order: unknown): void => {}) {
  const stations: FleetStation[] = (['pick', 'drop', 'charger', 'storage', 'storage'] as const)
    .map((role, i) => ({ id: 's' + i, pathId: 'p' + i, role, storageGroup: 'g', approachM: 0, handlingHeightMm: 0 }));
  return new FleetDispatcher({ stations, onLate,
    battery: createBatteryModel({ drivePerMin: 1, liftPerM: 1, idlePerMin: 1,
      chargePerMin: 10, threshold: 20, target: 80, reserveToCharger: 0, chargerWaitReserveSec: 0 }),
    consumption: { order: () => ({ driveSec: 1, liftM: 0, idleSec: 0 }),
      toCharger: () => ({ driveSec: 1, liftM: 0, idleSec: 0 }) } });
}
export const dispatchEnv = { t: 5, distanceM: () => 1, canReceive: () => true };
export const vehicles = [{ id: 'v', soc: 100, at: 'p0' }];

