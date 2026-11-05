// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-781 §9.8b — touching is no collision (F3), at any distance from the
 * origin (F20).
 *
 * A box riding FLUSH on a conveyor body is the most common contact of all; it
 * must never raise a card, however long it rides. Ten times the touch tolerance
 * of real penetration must. The same flush ride 1 km from the origin must stay
 * just as quiet over 600 ticks: the tolerance follows the coordinate magnitude.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { TOUCH_EPS } from '../src/core/engine/rv-collision-tri-tri';
import { __resetCollisionAlertStore } from '../src/core/hmi/collision-alert-store';
import { bakeCollisionScene, bodyNode, plainGroup } from './collision-fixture';

const DT = 1 / 60;

/** Belt (Machine, static, top at y = 0.1) and a 0.4 m box (Workpiece, mover) resting on it. */
async function beltScene(originX = 0) {
  const s = await bakeCollisionScene(plainGroup('Asset',
    bodyNode('Belt', { role: 'Machine', size: [4, 0.2, 1] }),
    bodyNode('Box', { role: 'Workpiece', mover: true, at: [-1.5, 0.3, 0], size: [0.4, 0.4, 0.4] }),
  ));
  s.template.position.x = originX;
  const box = s.node('Box');
  s.manager.register(s.node('Belt'), 'Machine');
  s.manager.register(box, 'Workpiece');
  return { ...s, box };
}

beforeEach(() => __resetCollisionAlertStore());

describe('touching ≠ collision', () => {
  it('a box riding flush on the conveyor raises no card; 10 × eps of penetration raises one', async () => {
    const s = await beltScene();
    s.manager.update(DT);
    expect(s.manager.pairStateOf(s.manager.bodies[0].key, s.manager.bodies[1].key)?.state).toBe('armed');
    for (let i = 0; i < 120; i++) {
      s.box.position.x = -1.5 + i * 0.02;          // the transport moves it along the belt
      s.manager.update(DT);
    }
    expect(s.manager.activePairs).toHaveLength(0);

    s.box.position.y = 0.3 - 10 * TOUCH_EPS;       // pressed 0.1 mm into the belt
    s.manager.update(DT);
    expect(s.manager.activePairs).toHaveLength(1);
  });

  it('the same flush ride 1000 m from the origin stays stable over 600 ticks (F20)', async () => {
    const s = await beltScene(1000);
    s.manager.update(DT);
    for (let i = 0; i < 600; i++) {
      s.box.position.x = -1.5 + (i % 150) * 0.02;
      s.box.position.z = Math.sin(i * 0.1) * 0.2;
      s.manager.update(DT);
      if (s.manager.activePairs.length > 0) break;
    }
    expect(s.manager.activePairs).toHaveLength(0);
    // ... and a real penetration is still seen out there.
    s.box.position.y = 0.25;
    s.manager.update(DT);
    expect(s.manager.activePairs).toHaveLength(1);
  });
});
