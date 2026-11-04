// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * mujoco-walker-floor-penetration.node.test.ts — the walker must not sink into
 * the floor (plan-673 O19).
 *
 * Thomas, 2026-10-25: *"sometimes the walker body sinks too much into bottom -
 * please align more the body with the original dimensions - the collider."*
 *
 * ## What was actually wrong, because it was not the dimensions
 *
 * Measured first, in the production build. In the stand pose the lowest VISUAL
 * point of the duck is 2.90 mm and the lowest floor-colliding COLLIDER point is
 * 2.82 mm — the soles match the shell to 0.08 mm — and the trunk's
 * floor-colliding hull reaches 13.4 mm BELOW the visible trunk, so it is larger
 * downwards rather than smaller. There was nothing to align.
 *
 * The sinking is CONTACT COMPLIANCE, which is exactly why it only happened
 * "sometimes": it scales with load. MuJoCo's own contact distances, robot geoms
 * against the floor, medians of three runs each:
 *
 *                      stock       stiffened
 *     standing        1.64 mm       0.14 mm
 *     walking         3.09 mm       1.22 mm
 *     landing a push 10.22 mm       6.81 mm
 *
 * `prepared-scene.xml` declares only `<option timestep="0.005"/>`, so contacts
 * ran on MuJoCo's stock `solimp` (width 1 mm, dmax 0.95 — 5 % compliant even
 * saturated) and stock `solref` (0.02 s, four timesteps). The fixture states the
 * right stiffness one line away, on `<equality>`, which this model does not use.
 * `spikes/659/duck/build-collision-primitives.mjs` now puts it on the
 * `collision` default class and the floor geom.
 *
 * ## Why this test is about the EFFECT and not the attributes
 *
 * Asserting `solimp="…"` is in the file would be a declaration test, and three
 * of those guarded the wrong thing earlier the same day. So this measures what
 * the solver does: it seeds the duck in its trained stand pose, holds it with
 * the position servos, and reads `contact.dist` — MuJoCo's own penetration.
 *
 * No policy and no ONNX: gravity and the position servos are enough to load the
 * feet, which keeps the test deterministic and quick. The second case STRIPS the
 * two attributes from the same XML and requires the limit to be exceeded, so the
 * test cannot pass vacuously — it proves the limit discriminates, and that these
 * attributes are what moves it.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RVMuJoCoWorld } from '@rv-private/mujoco/rv-mujoco-world';

const WEB_ROOT = resolve(__dirname, '..');
const WALKER = resolve(WEB_ROOT, 'public/demo-realvirtual/mujoco-walker');
const XML = readFileSync(resolve(WALKER, 'robot.xml'), 'utf8');
const CONTRACT = JSON.parse(readFileSync(resolve(WALKER, 'contract.json'), 'utf8')) as
  { meta?: { contract?: Contract } } & Partial<Contract>;
interface Contract { default_pose: number[]; init_base_z_m: number; timestep: number }
const contract = (CONTRACT.meta?.contract ?? CONTRACT) as Contract;

/**
 * THE discriminating limit. Headless, after settling: 0.005 mm with the
 * stiffness and 0.250 mm without — a factor of 50. At 0.05 mm the shipped scene
 * passes with 10x of room and the stock scene fails by 5x, so neither solver
 * jitter nor a MuJoCo point release can decide the outcome.
 */
const LIMIT_STAND_MM = 0.05;
/**
 * A SANITY bound on the landing, deliberately loose, and not a discriminator.
 *
 * Measured: 7.01 mm stiffened against 9.21 mm stock — only 24 % apart, because a
 * 60 mm free fall is dominated by inertia and geometry rather than by contact
 * compliance. A limit threaded between those two would be a 12 % margin test,
 * and a thin margin dressed up as a contract is how three assertions guarded the
 * wrong thing earlier the same day. So this one only catches a gross collapse
 * (the duck sinking a whole sole, 13.5 mm, or more) and the discrimination is
 * left entirely to the standing case above, which has the 50x separation.
 */
const LIMIT_DROP_MM = 12.0;

/**
 * Max depth any robot geom reaches into the floor, in mm.
 *
 * `settleS` is stepped BEFORE measuring and is not counted. That separation is
 * the whole point of the two numbers: seeding the duck at its stand height drops
 * it the last few millimetres onto its feet, and the first version of this
 * helper counted that landing as "standing" — 5.7 mm, against 0.14 mm measured
 * in the viewer for a duck that was already standing. Settling is a load case of
 * its own, and the drop test below is where it belongs.
 */
async function measure(
  xml: string, dropM: number, settleS: number, measureS: number,
): Promise<number> {
  const world = await RVMuJoCoWorld.load(xml, []);
  try {
    const floor = world.mustFind('geom', 'floor');
    const freeAdr = world.jointQposAdr(world.mustFind('joint', 'trunk_base_freejoint'));
    const jointAdr = world.actuatorQposAdr();
    const pose = contract.default_pose;

    world.reset();
    world.writeQpos(freeAdr, [0, 0, contract.init_base_z_m + dropM, 1, 0, 0, 0]);
    for (let i = 0; i < jointAdr.length; i++) world.writeQpos(jointAdr[i], [pose[i]]);
    // The position servos hold the trained pose, so the feet carry the weight
    // exactly as they do under the policy — without needing the policy.
    world.setCtrl(pose);
    world.forward();

    const settle = Math.round(settleS / world.timestep);
    if (settle > 0) world.step(settle);

    let worst = 0;
    const steps = Math.round(measureS / world.timestep);
    for (let s = 0; s < steps; s++) {
      world.step(1);
      for (const c of world.readContacts()) {
        if (c.geom1 !== floor && c.geom2 !== floor) continue;
        if (c.dist < worst) worst = c.dist;
      }
    }
    return -worst * 1000;
  } finally {
    world.dispose();
  }
}

/** The shipped XML with the O19 attributes taken back out — the stock contact. */
function stripStiffness(xml: string): string {
  const out = xml.replace(/ solref="0\.01 1" solimp="0\.99 0\.999 0\.0005 0\.5 2"/g, '');
  if (out === xml) throw new Error('the O19 contact attributes are not in robot.xml at all');
  return out;
}

describe('walker floor penetration — the body must stay on top of the floor', () => {
  it('holds its stand pose without sinking in', async () => {
    const mm = await measure(XML, 0, 2, 2);
    // eslint-disable-next-line no-console
    console.log(`[O19] standing penetration ${mm.toFixed(3)} mm (limit ${LIMIT_STAND_MM})`);
    expect(mm).toBeLessThan(LIMIT_STAND_MM);
  }, 120_000);

  it('survives a drop onto its feet without sinking in', async () => {
    // 60 mm up and released: an impact load without a policy in the loop.
    const mm = await measure(XML, 0.06, 0, 2);
    // eslint-disable-next-line no-console
    console.log(`[O19] drop penetration ${mm.toFixed(3)} mm (limit ${LIMIT_DROP_MM})`);
    expect(mm).toBeLessThan(LIMIT_DROP_MM);
  }, 120_000);

  it('the standing limit discriminates — stock contact parameters exceed it', async () => {
    // Without this case the standing assertion could pass for any reason at all
    // — including the attributes doing nothing. With it, that test measures the
    // thing it names.
    const stock = stripStiffness(XML);
    const stand = await measure(stock, 0, 2, 2);
    const drop = await measure(stock, 0.06, 0, 2);
    // eslint-disable-next-line no-console
    console.log(`[O19] stock contact: standing ${stand.toFixed(3)} mm, drop ${drop.toFixed(3)} mm`);
    expect(stand).toBeGreaterThan(LIMIT_STAND_MM);
    // The drop is REPORTED, not asserted against the stock value: 24 % apart is
    // not a contract (see LIMIT_DROP_MM). It is logged so a future change to the
    // contact model can be read off the two lines side by side.
    expect(drop).toBeGreaterThan(stand);
  }, 120_000);
});
