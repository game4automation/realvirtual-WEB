// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { Object3D } from 'three';
import { DESComponent } from '@rv/plugins/des/rv-des-component';
import { DESManager } from '@rv/plugins/des/rv-des-manager';
import { registerAction } from '@rv/plugins/des/rv-des-named-actions';

// Manager-level fixture: real statistics accumulator, serializable model actions.
const work = registerAction('Plan2006.Statistics.Work', ctx => {
  const component = ctx.manager.getComponentByEntityId(0) as DESComponent;
  component.recordOutput();
  component.setState(ctx.simTime % 20 === 0 ? 'Working' : 'Empty');
});

export function statisticsFixture(warmup = 0) {
  const manager = new DESManager();
  const root = new Object3D();
  const node = new Object3D();
  node.name = 'Machine';
  root.add(node);
  const component = new DESComponent(node);
  manager.setMasterSeed(42);
  manager.statResetTime = warmup;
  manager.registerComponent(component);
  function schedule(end = 300) {
    for (let time = 10; time <= end; time += 10) {
      manager.scheduleEventByIndex(time, work, component.entityId);
    }
  }
  return { manager, component, schedule };
}
